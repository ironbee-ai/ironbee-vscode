import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { refreshFolderSetup, refreshSetUpFolders, shouldRefreshSetups } from '../../src/lifecycle/upgradeRefresh';
import type { RunnerContext } from '../../src/runtime/cliRunner';

let dir: string;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-upref-'));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

async function markSetUp(folder: string): Promise<void> {
    await fs.mkdir(path.join(folder, '.ironbee'), { recursive: true });
    await fs.writeFile(path.join(folder, '.ironbee', 'config.json'), '{}');
}

/** Capturing spawn: records each argv, exits with `code` for every run. */
function capturingSpawn(calls: string[][], code = 0): RunnerContext['spawn'] {
    return ((_cmd: string, args: string[]) => {
        calls.push(args);
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => child.emit('close', code));
        return child;
    }) as unknown as RunnerContext['spawn'];
}

function runner(calls: string[][], code = 0): RunnerContext {
    return { nodePath: 'node', cliEntry: '/cli.js', spawn: capturingSpawn(calls, code) };
}

describe('shouldRefreshSetups', () => {
    it('refreshes on first activation (no stored version)', () => {
        expect(shouldRefreshSetups(undefined, '0.3.0')).toBe(true);
    });

    it('refreshes when the stored version differs (upgrade or downgrade)', () => {
        expect(shouldRefreshSetups('0.2.1', '0.3.0')).toBe(true);
        expect(shouldRefreshSetups('0.3.0', '0.2.1')).toBe(true);
    });

    it('does not refresh again for the same version', () => {
        expect(shouldRefreshSetups('0.3.0', '0.3.0')).toBe(false);
    });

    it('does not refresh when the current version is unknown (empty)', () => {
        expect(shouldRefreshSetups('0.2.1', '')).toBe(false);
    });
});

describe('refreshFolderSetup', () => {
    it('skips a folder that was never set up — no CLI run at all', async () => {
        const calls: string[][] = [];
        const out = await refreshFolderSetup(dir, runner(calls));
        expect(out.skipped).toBe(true);
        expect(out.refreshed).toEqual([]);
        expect(calls).toHaveLength(0);
    });

    it('skips even when a client dir exists but the folder is not set up', async () => {
        await fs.mkdir(path.join(dir, '.claude'));
        const calls: string[][] = [];
        const out = await refreshFolderSetup(dir, runner(calls));
        expect(out.skipped).toBe(true);
        expect(calls).toHaveLength(0);
    });

    it('refreshes cursor for a set-up folder with no client dirs', async () => {
        await markSetUp(dir);
        const calls: string[][] = [];
        const out = await refreshFolderSetup(dir, runner(calls));
        expect(out).toEqual({ folder: dir, skipped: false, refreshed: ['cursor'], failed: [] });
        expect(calls).toEqual([['/cli.js', 'install', dir, '--client', 'cursor', '--yes']]);
    });

    it('refreshes detected clients AND cursor, without --mode/--platforms', async () => {
        await markSetUp(dir);
        await fs.mkdir(path.join(dir, '.claude'));
        const calls: string[][] = [];
        const out = await refreshFolderSetup(dir, runner(calls));
        expect(out.refreshed).toEqual(['claude', 'cursor']);
        expect(calls).toHaveLength(2);
        for (const args of calls) {
            expect(args).toContain('--yes');
            expect(args).not.toContain('--mode');
            expect(args).not.toContain('--platforms');
        }
    });

    it('records failed clients without throwing', async () => {
        await markSetUp(dir);
        const calls: string[][] = [];
        const out = await refreshFolderSetup(dir, runner(calls, 1));
        expect(out.refreshed).toEqual([]);
        expect(out.failed).toEqual(['cursor']);
    });
});

describe('refreshSetUpFolders', () => {
    it('processes every folder; a skipped or failing folder never stops the rest', async () => {
        const setUp = path.join(dir, 'a');
        const notSetUp = path.join(dir, 'b');
        const alsoSetUp = path.join(dir, 'c');
        await fs.mkdir(notSetUp, { recursive: true });
        await markSetUp(setUp);
        await markSetUp(alsoSetUp);
        const calls: string[][] = [];
        const outcomes = await refreshSetUpFolders([setUp, notSetUp, alsoSetUp], runner(calls));
        expect(outcomes.map((o) => o.skipped)).toEqual([false, true, false]);
        expect(calls.map((a) => a[2])).toEqual([setUp, alsoSetUp]);
    });
});
