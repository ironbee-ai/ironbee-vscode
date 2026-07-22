import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    buildInstallArgs,
    buildUninstallArgs,
    runInstall,
    runUninstall,
    type RunnerContext,
    type InstallRequest,
} from '../../src/runtime/cliRunner';

describe('buildInstallArgs', () => {
    it('passes explicit client, mode, and comma-joined platforms', () => {
        const args = buildInstallArgs('/cli.js', {
            folderDir: '/proj',
            client: 'cursor',
            mode: 'assist',
            platforms: ['node', 'backend'],
        });
        expect(args).toEqual([
            '/cli.js', 'install', '/proj', '--client', 'cursor', '--mode', 'assist', '--platforms', 'node,backend',
        ]);
    });

    it('omits --platforms when none selected', () => {
        const args = buildInstallArgs('/cli.js', {
            folderDir: '/p', client: 'claude', mode: 'monitor', platforms: [],
        });
        expect(args).not.toContain('--platforms');
        expect(args).toContain('--client');
        expect(args[args.indexOf('--client') + 1]).toBe('claude');
    });
});

describe('buildUninstallArgs', () => {
    it('builds a non-interactive uninstall argv with --yes', () => {
        expect(buildUninstallArgs('/cli.js', '/proj')).toEqual(['/cli.js', 'uninstall', '/proj', '--yes']);
    });
});

// Fake child process that emits the given exit code.
function fakeSpawn(exitCode: number, stdout = '') {
    return (() => {
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
            if (stdout) {
                child.stdout.emit('data', Buffer.from(stdout));
            }
            child.emit('close', exitCode);
        });
        return child;
    }) as unknown as RunnerContext['spawn'];
}

describe('runInstall', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-run-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    const req = (): InstallRequest => ({ folderDir: dir, client: 'cursor', mode: 'assist', platforms: ['node'] });

    it('ok when exit 0 AND .ironbee/config.json was written', async () => {
        await fs.mkdir(path.join(dir, '.ironbee'));
        await fs.writeFile(path.join(dir, '.ironbee', 'config.json'), '{}');
        const ctx: RunnerContext = { nodePath: 'node', cliEntry: '/cli.js', spawn: fakeSpawn(0) };
        const res = await runInstall(ctx, req());
        expect(res.ok).toBe(true);
        expect(res.configWritten).toBe(true);
    });

    it('not ok when exit 0 but no config was written', async () => {
        const ctx: RunnerContext = { nodePath: 'node', cliEntry: '/cli.js', spawn: fakeSpawn(0) };
        const res = await runInstall(ctx, req());
        expect(res.ok).toBe(false);
        expect(res.configWritten).toBe(false);
    });

    it('not ok when the CLI exits non-zero', async () => {
        await fs.mkdir(path.join(dir, '.ironbee'));
        await fs.writeFile(path.join(dir, '.ironbee', 'config.json'), '{}');
        const ctx: RunnerContext = { nodePath: 'node', cliEntry: '/cli.js', spawn: fakeSpawn(1) };
        const res = await runInstall(ctx, req());
        expect(res.ok).toBe(false);
        expect(res.code).toBe(1);
    });

    it('resolves not-ok (does not throw) when the child emits an error, so a batch keeps going', async () => {
        const logs: string[] = [];
        const errorSpawn = (() => {
            const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
            return child;
        }) as unknown as RunnerContext['spawn'];
        const ctx: RunnerContext = { nodePath: '/no/such/node', cliEntry: '/cli.js', log: (l) => logs.push(l), spawn: errorSpawn };
        // A single spawn failure must not reject and abort the whole multi-folder loop.
        const res = await runInstall(ctx, req());
        expect(res).toEqual({ ok: false, code: null, configWritten: false });
        expect(logs.join('\n')).toMatch(/failed to start.*ENOENT/);
    });

    it('passes ctx.env (e.g. IRONBEE_DEVTOOLS_MCP) into the spawn env alongside ELECTRON_RUN_AS_NODE', async () => {
        await fs.mkdir(path.join(dir, '.ironbee'));
        await fs.writeFile(path.join(dir, '.ironbee', 'config.json'), '{}');
        let capturedEnv: NodeJS.ProcessEnv | undefined;
        const capturingSpawn = ((_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
            capturedEnv = options.env;
            const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            setImmediate(() => child.emit('close', 0));
            return child;
        }) as unknown as RunnerContext['spawn'];
        const mcpJson = '{"command":"/ed/node","args":["/ext/devtools/dist/index.js"]}';
        const ctx: RunnerContext = {
            nodePath: 'node', cliEntry: '/cli.js', spawn: capturingSpawn,
            env: { IRONBEE_DEVTOOLS_MCP: mcpJson },
        };
        await runInstall(ctx, req());
        expect(capturedEnv?.IRONBEE_DEVTOOLS_MCP).toBe(mcpJson);
        expect(capturedEnv?.ELECTRON_RUN_AS_NODE).toBe('1'); // ours is merged, not clobbering the base
    });

    it('redacts secrets streamed to the log sink', async () => {
        await fs.mkdir(path.join(dir, '.ironbee'));
        await fs.writeFile(path.join(dir, '.ironbee', 'config.json'), '{}');
        const lines: string[] = [];
        const ctx: RunnerContext = {
            nodePath: 'node', cliEntry: '/cli.js', log: (l) => lines.push(l),
            spawn: fakeSpawn(0, 'wrote ibt_supersecretvalue123 to config\n'),
        };
        await runInstall(ctx, req());
        expect(lines.join('\n')).toContain('ibt_***');
        expect(lines.join('\n')).not.toContain('supersecretvalue');
    });

    it('redacts a secret even when split across two stdout chunks', async () => {
        const lines: string[] = [];
        // Emit "ibt_secr" then "etvalue999999 done\n" as two chunks — line-buffering rejoins them.
        const twoChunkSpawn = (() => {
            const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            setImmediate(() => {
                child.stdout.emit('data', Buffer.from('log ibt_secr'));
                child.stdout.emit('data', Buffer.from('etvalue999999 done\n'));
                child.emit('close', 0);
            });
            return child;
        }) as unknown as RunnerContext['spawn'];
        await fs.mkdir(path.join(dir, '.ironbee'), { recursive: true });
        await fs.writeFile(path.join(dir, '.ironbee', 'config.json'), '{}');
        await runInstall({ nodePath: 'node', cliEntry: '/cli.js', log: (l) => lines.push(l), spawn: twoChunkSpawn }, req());
        expect(lines.join('\n')).not.toContain('ibt_secretvalue999999');
        expect(lines.join('\n')).toContain('ibt_***');
    });
});

describe('runUninstall', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-unrun-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('ok on exit 0 and reports the config as removed when it is gone', async () => {
        const ctx: RunnerContext = { nodePath: 'node', cliEntry: '/cli.js', spawn: fakeSpawn(0) };
        const res = await runUninstall(ctx, dir); // no .ironbee/config.json present
        expect(res.ok).toBe(true);
        expect(res.configRemoved).toBe(true);
    });

    it('not ok when the CLI exits non-zero', async () => {
        const ctx: RunnerContext = { nodePath: 'node', cliEntry: '/cli.js', spawn: fakeSpawn(1) };
        const res = await runUninstall(ctx, dir);
        expect(res.ok).toBe(false);
        expect(res.code).toBe(1);
    });

    it('resolves not-ok (does not throw) when the child errors', async () => {
        const errorSpawn = (() => {
            const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
            return child;
        }) as unknown as RunnerContext['spawn'];
        const res = await runUninstall({ nodePath: '/no/node', cliEntry: '/cli.js', spawn: errorSpawn }, dir);
        expect(res).toEqual({ ok: false, code: null, configRemoved: true });
    });
});
