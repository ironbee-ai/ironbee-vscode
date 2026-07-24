import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setUpFolder, type FolderSetupDeps } from '../../src/ui/setupFlow';
import type { RunnerContext } from '../../src/runtime/cliRunner';

let dir: string;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-setup-'));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

// Spawn that writes .ironbee/config.json (successful install) on code 0, then exits `code`.
function spawnWith(code: number): RunnerContext['spawn'] {
    return ((_cmd: string, args: string[]) => {
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        const folder = args[2];
        const write = code === 0
            ? fs.mkdir(path.join(folder, '.ironbee'), { recursive: true }).then(() =>
                fs.writeFile(path.join(folder, '.ironbee', 'config.json'), '{}'),
            )
            : Promise.resolve();
        void write.then(() => setImmediate(() => child.emit('close', code)));
        return child;
    }) as unknown as RunnerContext['spawn'];
}

function deps(pickPlatforms: FolderSetupDeps['pickPlatforms'], code = 0): FolderSetupDeps {
    return { pickPlatforms, runner: { nodePath: 'node', cliEntry: '/cli.js', spawn: spawnWith(code) } };
}

describe('setUpFolder', () => {
    it('installs the picked platforms into cursor (default) and passes them through', async () => {
        const pick = vi.fn(async () => ['node', 'backend']);
        const out = await setUpFolder(dir, 'assist', deps(pick));
        expect(pick).toHaveBeenCalledWith(dir);
        expect(out.installed).toEqual(['cursor']);
        expect(out.cancelled).toBe(false);
    });

    it('installs into cursor in addition to a detected client', async () => {
        await fs.mkdir(path.join(dir, '.claude'));
        const out = await setUpFolder(dir, 'assist', deps(async () => ['node']));
        expect(out.installed).toEqual(['claude', 'cursor']);
    });

    it('cancels (no install) when the platform pick is cancelled', async () => {
        const out = await setUpFolder(dir, 'assist', deps(async () => undefined));
        expect(out.cancelled).toBe(true);
        expect(out.installed).toEqual([]);
    });

    it('reports the client in `failed` when install exits non-zero', async () => {
        const out = await setUpFolder(dir, 'enforce', deps(async () => ['browser'], 1));
        expect(out.failed).toEqual(['cursor']);
        expect(out.installed).toEqual([]);
        expect(out.cancelled).toBe(false);
    });

    it('carries the folder path on the outcome', async () => {
        const out = await setUpFolder(dir, 'monitor', deps(async () => ['node']));
        expect(out.folder).toBe(dir);
    });
});
