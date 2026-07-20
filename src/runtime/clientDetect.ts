import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import * as path from 'node:path';

export type AiClient = 'cursor' | 'claude' | 'codex';

/** Marker dir each AI client uses inside a project. */
const CLIENT_DIRS: Record<AiClient, string> = {
    cursor: '.cursor',
    claude: '.claude',
    codex: '.codex',
};

/** All clients whose marker dir already exists in the folder. */
export async function detectClients(folderDir: string): Promise<AiClient[]> {
    const found: AiClient[] = [];
    for (const client of Object.keys(CLIENT_DIRS) as AiClient[]) {
        if (await dirExists(path.join(folderDir, CLIENT_DIRS[client]))) {
            found.push(client);
        }
    }
    return found;
}

/**
 * Which client(s) `ironbee install` should target for a folder.
 *
 * If any client dir exists, target those. If **none** exists, default to
 * **`cursor`** (this is a Cursor extension) — passed EXPLICITLY as `--client cursor`.
 * We must NOT rely on the CLI's own no-detection fallback: `REGISTERED_CLIENTS[0]`
 * is `claude`, so an unqualified install would land in `.claude` (design EXT-6).
 */
export async function resolveInstallClients(folderDir: string): Promise<AiClient[]> {
    const detected: AiClient[] = await detectClients(folderDir);
    return detected.length > 0 ? detected : ['cursor'];
}

async function dirExists(p: string): Promise<boolean> {
    try {
        const st: Stats = await fs.stat(p);
        return st.isDirectory();
    } catch {
        return false;
    }
}
