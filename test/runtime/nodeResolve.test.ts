import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveToolPath, hasNpx, staticCandidates } from '../../src/runtime/nodeResolve';

// A fake `spawn` for the login-shell probe: emits `stderr` chunks (to exercise the drain), then
// `stdout` chunks, then `close` — or `error`. Records whether a stderr 'data' listener was attached.
function shellSpawn(opts: { stdout?: string[]; stderr?: string[]; error?: boolean }) {
    const state = { stderrDrained: false };
    const spawn = ((..._a: unknown[]) => {
        const stderr = new EventEmitter();
        const realOn = stderr.on.bind(stderr);
        stderr.on = ((ev: string, fn: (...a: unknown[]) => void) => {
            if (ev === 'data') {
                state.stderrDrained = true;
            }
            return realOn(ev, fn);
        }) as typeof stderr.on;
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
        child.stdout = new EventEmitter();
        child.stderr = stderr;
        child.kill = () => {};
        setImmediate(() => {
            if (opts.error) {
                child.emit('error', new Error('spawn /bin/zsh ENOENT'));
                return;
            }
            for (const chunk of opts.stderr ?? []) {
                child.stderr.emit('data', Buffer.from(chunk));
            }
            for (const chunk of opts.stdout ?? []) {
                child.stdout.emit('data', Buffer.from(chunk));
            }
            child.emit('close', 0);
        });
        return child;
    }) as never;
    return { spawn, state };
}

let home: string;
beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-node-'));
});
afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
});

describe('resolveToolPath', () => {
    it('preserves the current PATH first, then appends candidates, deduped', async () => {
        const sep = path.delimiter;
        const out = await resolveToolPath({ env: { PATH: `/usr/local/bin${sep}/my/custom` }, skipShell: true, homeDir: home });
        const dirs = out.split(sep);
        expect(dirs[0]).toBe('/usr/local/bin'); // current first
        expect(dirs).toContain('/my/custom');
        // deduped: /usr/local/bin appears once even though it's also a static candidate
        expect(dirs.filter((d) => d === '/usr/local/bin').length).toBe(1);
    });

    it('includes nvm version bin dirs that exist at runtime', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v20.11.0', 'bin');
        await fs.mkdir(nvmBin, { recursive: true });
        const out = await resolveToolPath({ env: { PATH: '/bin' }, skipShell: true, homeDir: home });
        expect(out.split(path.delimiter)).toContain(nvmBin);
    });

    it('never throws and returns at least the current PATH', async () => {
        const out = await resolveToolPath({ env: { PATH: '/only' }, skipShell: true, homeDir: home });
        expect(out.split(path.delimiter)).toContain('/only');
    });

    it('appends dirs parsed from the login-shell PATH probe (after the current PATH)', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const { spawn } = shellSpawn({ stdout: ['noise\n__PATH__=/shellonly:/current\n'] });
        const out = await resolveToolPath({ env: { PATH: '/current', SHELL: '/bin/zsh' }, homeDir: home, spawn });
        const dirs = out.split(path.delimiter);
        expect(dirs[0]).toBe('/current'); // current PATH still wins
        expect(dirs).toContain('/shellonly'); // shell-derived dir appended
        expect(dirs.filter((d) => d === '/current').length).toBe(1); // deduped vs the probe output
    });

    it('drains stderr and still parses PATH when the login shell is noisy on stderr', async () => {
        if (process.platform === 'win32') {
            return;
        }
        // A real hazard: a chatty rc file floods stderr; without the drain the pipe fills and the shell
        // hangs until the 3s timeout. Assert the drain is wired (a 'data' listener attached) AND the
        // probe still resolves the PATH promptly.
        const bigStderr = 'x'.repeat(128 * 1024) + '\n';
        const { spawn, state } = shellSpawn({ stderr: [bigStderr], stdout: ['__PATH__=/shellonly:/current\n'] });
        const out = await resolveToolPath({ env: { PATH: '/current', SHELL: '/bin/zsh' }, homeDir: home, spawn });
        expect(state.stderrDrained).toBe(true); // the drain listener was attached
        expect(out.split(path.delimiter)).toContain('/shellonly');
    });

    it('resolves (no throw) when the login shell fails to spawn', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const { spawn } = shellSpawn({ error: true });
        const out = await resolveToolPath({ env: { PATH: '/current', SHELL: '/bin/zsh' }, homeDir: home, spawn });
        expect(out.split(path.delimiter)).toContain('/current');
    });
});

describe('staticCandidates', () => {
    it('lists the Windows node/npm/Volta/fnm dirs on win32', () => {
        const dirs = staticCandidates('C:\\Users\\me', 'win32', {
            ProgramFiles: 'C:\\Program Files',
            APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
            LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
        });
        expect(dirs).toContain(path.join('C:\\Program Files', 'nodejs'));
        expect(dirs).toContain(path.join('C:\\Users\\me\\AppData\\Roaming', 'npm'));
        expect(dirs).toContain(path.join('C:\\Users\\me\\AppData\\Local', 'Volta', 'bin'));
        expect(dirs).toContain(path.join('C:\\Users\\me\\AppData\\Local', 'fnm_multishells'));
    });

    it('lists the POSIX system + user bin dirs on non-win32', () => {
        const dirs = staticCandidates('/home/me', 'linux', {});
        expect(dirs).toContain('/usr/local/bin');
        expect(dirs).toContain('/opt/homebrew/bin');
        expect(dirs).toContain(path.join('/home/me', '.local', 'bin'));
        expect(dirs).toContain(path.join('/home/me', '.volta', 'bin'));
    });
});

describe('hasNpx', () => {
    it('finds npx when present in the given PATH', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const bin = path.join(home, 'bin');
        await fs.mkdir(bin, { recursive: true });
        await fs.writeFile(path.join(bin, 'npx'), '#!/bin/sh\n');
        await fs.chmod(path.join(bin, 'npx'), 0o755);
        expect(await hasNpx(bin, {})).toBe(true);
        expect(await hasNpx('/nonexistent', {})).toBe(false);
    });
});
