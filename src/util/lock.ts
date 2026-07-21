import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import * as path from 'node:path';

/**
 * Best-effort cross-process (cross-window) lock via an atomically-created lock dir.
 * `mkdir` is atomic on POSIX and Windows, so it doubles as a mutex. Stale locks
 * (older than `staleMs`, e.g. a crashed window) are reclaimed. Used to serialize
 * devtools materialization and the execPath-reconcile re-install (design §7).
 */
export interface LockHandle {
    release(): Promise<void>;
}

export async function acquireLock(
    lockPath: string,
    opts: { timeoutMs?: number; staleMs?: number; pollMs?: number } = {},
): Promise<LockHandle> {
    const timeoutMs: number = opts.timeoutMs ?? 30_000;
    const staleMs: number = opts.staleMs ?? 120_000;
    const pollMs: number = opts.pollMs ?? 100;
    const deadline: number = nowMs() + timeoutMs;

    for (;;) {
        try {
            await fs.mkdir(lockPath);
            await fs.writeFile(path.join(lockPath, 'pid'), String(process.pid), 'utf8').catch((): void => {});
            // Heartbeat: refresh the lock dir mtime while held so a healthy long-running
            // holder is never judged stale and reclaimed by another window.
            const heartbeat: NodeJS.Timeout = setInterval((): void => {
                const t: Date = new Date();
                void fs.utimes(lockPath, t, t).catch((): void => {});
            }, Math.max(1000, Math.floor(staleMs / 3)));
            heartbeat.unref?.();
            let released: boolean = false;
            return {
                release: async (): Promise<void> => {
                    if (released) {
                        return;
                    }
                    released = true;
                    clearInterval(heartbeat);
                    await releaseLock(lockPath);
                },
            };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw err;
            }
            // Lock held — check staleness.
            const age: number | null = await lockAgeMs(lockPath);
            if (age !== null && age > staleMs) {
                await releaseLock(lockPath).catch((): void => {});
                continue;
            }
            if (nowMs() >= deadline) {
                throw new Error(`Timed out acquiring lock at ${lockPath}`);
            }
            await sleep(pollMs);
        }
    }
}

async function lockAgeMs(lockPath: string): Promise<number | null> {
    try {
        const st: Stats = await fs.stat(lockPath);
        return Date.now() - st.mtimeMs;
    } catch {
        return null;
    }
}

async function releaseLock(lockPath: string): Promise<void> {
    await fs.rm(lockPath, { recursive: true, force: true });
}

function nowMs(): number {
    return Date.now();
}

function sleep(ms: number): Promise<void> {
    return new Promise((r: () => void): NodeJS.Timeout => setTimeout(r, ms));
}
