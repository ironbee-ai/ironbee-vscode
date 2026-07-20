import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Atomically write a file: create the parent dir (restrictive mode), write to a
 * temp sibling created 0600 from the start (never world-readable), then rename
 * over the target. `dirMode`/`fileMode` default to 0700/0600 for secret files.
 */
export async function atomicWriteFile(
    filePath: string,
    data: string,
    opts: { dirMode?: number; fileMode?: number } = {},
): Promise<void> {
    const dirMode: number = opts.dirMode ?? 0o700;
    const fileMode: number = opts.fileMode ?? 0o600;
    const dir: string = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true, mode: dirMode });
    // Best-effort tighten in case the dir already existed with looser perms.
    try {
        await fs.chmod(dir, dirMode);
    } catch {
    /* non-fatal (e.g. Windows) */
    }
    const tmp: string = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${uniqueSuffix()}.tmp`);
    // 'wx' + mode ensures the temp file is created fresh with restrictive perms.
    const handle: fs.FileHandle = await fs.open(tmp, 'wx', fileMode);
    try {
        await handle.writeFile(data, 'utf8');
        await handle.close();
        await fs.rename(tmp, filePath);
        try {
            await fs.chmod(filePath, fileMode);
        } catch {
            /* non-fatal */
        }
    } catch (err) {
        try {
            await handle.close();
        } catch {
            /* already closed */
        }
        try {
            await fs.unlink(tmp);
        } catch {
            /* temp may not exist */
        }
        throw err;
    }
}

let counter: number = 0;
function uniqueSuffix(): string {
    // Date.now()/Math.random() are avoided elsewhere for determinism, but here we only
    // need process-local uniqueness for a temp name; a monotonic counter + hrtime suffices.
    counter += 1;
    return `${counter}${process.hrtime.bigint().toString(36)}`;
}

export function homeIronbeeDir(): string {
    return path.join(os.homedir(), '.ironbee');
}

export function homeIronbeeConfigPath(): string {
    return path.join(homeIronbeeDir(), 'config.json');
}
