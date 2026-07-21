import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireLock } from '../../src/util/lock';

let dir: string;
let lockPath: string;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-lock-'));
    lockPath = path.join(dir, 'x.lock');
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('acquireLock', () => {
    it('acquires and releases; a second acquire then succeeds', async () => {
        const a = await acquireLock(lockPath);
        await a.release();
        const b = await acquireLock(lockPath);
        await b.release();
        await expect(fs.access(lockPath)).rejects.toBeTruthy();
    });

    it('provides mutual exclusion — the second waiter proceeds only after release', async () => {
        const a = await acquireLock(lockPath);
        let bAcquired = false;
        const bP = acquireLock(lockPath, { pollMs: 10 }).then((h) => {
            bAcquired = true;
            return h;
        });
        await new Promise((r) => setTimeout(r, 60));
        expect(bAcquired).toBe(false); // still blocked
        await a.release();
        const b = await bP;
        expect(bAcquired).toBe(true);
        await b.release();
    });

    it('times out when the lock is held past the timeout', async () => {
        const a = await acquireLock(lockPath);
        await expect(acquireLock(lockPath, { timeoutMs: 80, pollMs: 10 })).rejects.toThrow(/Timed out/);
        await a.release();
    });

    it('reclaims a stale lock (older than staleMs)', async () => {
        await fs.mkdir(lockPath); // orphaned lock dir from a "crashed" holder
        const old = new Date(Date.now() - 10_000);
        await fs.utimes(lockPath, old, old);
        const h = await acquireLock(lockPath, { staleMs: 1000, timeoutMs: 2000, pollMs: 10 });
        await h.release();
    });

    it('release is idempotent', async () => {
        const h = await acquireLock(lockPath);
        await h.release();
        await expect(h.release()).resolves.toBeUndefined();
    });
});
