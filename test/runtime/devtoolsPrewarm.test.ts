import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prewarmDevtools } from '../../src/runtime/devtoolsPrewarm';

let dir: string;
let binWithNpx: string;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-prewarm-'));
    binWithNpx = path.join(dir, 'bin');
    await fs.mkdir(binWithNpx, { recursive: true });
    await fs.writeFile(path.join(binWithNpx, 'npx'), '#!/bin/sh\n');
    if (process.platform !== 'win32') {
        await fs.chmod(path.join(binWithNpx, 'npx'), 0o755);
    }
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

function fakeSpawn(exitCode: number | 'error') {
    return (() => {
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
            if (exitCode === 'error') {
                child.emit('error', new Error('spawn npx ENOENT'));
            } else {
                child.emit('close', exitCode);
            }
        });
        return child;
    }) as never;
}

// Captures the (cmd, args, options) the injected spawn receives; child never closes unless told.
function capturingSpawn() {
    const calls: Array<{ cmd: string; args: string[]; options: { env?: NodeJS.ProcessEnv } }> = [];
    const spawn = ((cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ cmd, args, options });
        const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null; kill: (s?: string) => void };
        child.stdout = null; // stdio:'ignore' → no pipes
        child.stderr = null;
        child.kill = () => {};
        return child;
    }) as never;
    return { spawn, calls };
}

const spec = '@ironbee-ai/devtools@0.23.0';

describe('prewarmDevtools', () => {
    it('skips with npx-not-found when npx is not on the resolved PATH', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const res = await prewarmDevtools({
            spec,
            resolvePath: async () => '/definitely/nonexistent',
            env: {},
            spawn: fakeSpawn(0), // should not be reached
        });
        expect(res).toEqual({ ok: false, reason: 'npx-not-found' });
    });

    it('runs npx and returns ok on exit 0', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const res = await prewarmDevtools({
            spec,
            resolvePath: async () => binWithNpx,
            env: {},
            spawn: fakeSpawn(0),
        });
        expect(res).toEqual({ ok: true, code: 0 });
    });

    it('returns failed on a non-zero exit', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const res = await prewarmDevtools({ spec, resolvePath: async () => binWithNpx, env: {}, spawn: fakeSpawn(1) });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.reason).toBe('failed');
        }
    });

    it('returns failed when the child errors (npx vanished)', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const res = await prewarmDevtools({ spec, resolvePath: async () => binWithNpx, env: {}, spawn: fakeSpawn('error') });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.reason).toBe('failed');
        }
    });

    it('invokes npx with the install-then-run-node argv and browser-suppressing env', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const { spawn, calls } = capturingSpawn();
        // Never resolves (child never closes) — we only assert on the captured invocation. Poll until
        // the async npx-resolution completes and spawn is called.
        void prewarmDevtools({ spec, resolvePath: async () => binWithNpx, env: {}, spawn });
        for (let i = 0; i < 50 && calls.length === 0; i++) {
            await new Promise((r) => setImmediate(r));
        }
        expect(calls).toHaveLength(1);
        expect(calls[0].cmd).toBe('npx');
        // -y installs, --package <spec>, then `-- node --version` runs (and thus installs) without starting the server.
        expect(calls[0].args).toEqual(['--yes', '--package', spec, '--', 'node', '--version']);
        expect(calls[0].options.env?.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBe('1');
        expect(calls[0].options.env?.BROWSER_DEVTOOLS_INSTALL_CHROMIUM).toBe('false');
        expect(calls[0].options.env?.PATH).toBe(binWithNpx);
    });

    it('times out to a failed result when the child never closes', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const { spawn } = capturingSpawn();
        const res = await prewarmDevtools({
            spec,
            resolvePath: async () => binWithNpx,
            env: {},
            spawn,
            timeoutMs: 1,
        });
        expect(res).toEqual({ ok: false, reason: 'failed', detail: 'timed out' });
    });
});
