import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { resolveInstallClients, type AiClient } from '../runtime/clientDetect';
import { runRefresh, type InstallResult, type RunnerContext } from '../runtime/cliRunner';

/**
 * Upgrade refresh (design EXT-6 follow-up): on the first activation after an extension
 * install/upgrade, silently re-run `ironbee install` for every workspace folder that is ALREADY
 * set up (has `<folder>/.ironbee/config.json`). This re-bakes the version-scoped bundled-devtools
 * path in `.cursor/mcp.json` (stale after an upgrade) and refreshes the IronBee-owned hooks/
 * rules/skills — without touching the folder's verification config (no `--mode`/`--platforms`)
 * and without any UI. Folders that were never set up are skipped, never auto-installed.
 */

export interface FolderRefreshOutcome {
    folder: string;
    /** True when the folder is not set up (no .ironbee/config.json) — nothing was run. */
    skipped: boolean;
    refreshed: AiClient[];
    failed: AiClient[];
}

/** Refresh runs once per (workspace, extension version): only when the stored version differs. */
export function shouldRefreshSetups(storedVersion: string | undefined, currentVersion: string): boolean {
    return currentVersion !== '' && storedVersion !== currentVersion;
}

/** Re-run install for ONE already-set-up folder (all resolved clients, cursor always included). */
export async function refreshFolderSetup(folderDir: string, runner: RunnerContext): Promise<FolderRefreshOutcome> {
    if (!(await isSetUp(folderDir))) {
        return { folder: folderDir, skipped: true, refreshed: [], failed: [] };
    }
    const clients: AiClient[] = await resolveInstallClients(folderDir);
    const refreshed: AiClient[] = [];
    const failed: AiClient[] = [];
    for (const client of clients) {
        const res: InstallResult = await runRefresh(runner, { folderDir, client });
        (res.ok ? refreshed : failed).push(client);
    }
    return { folder: folderDir, skipped: false, refreshed, failed };
}

/** Refresh a whole workspace, sequentially; one folder's failure never stops the rest. */
export async function refreshSetUpFolders(folders: string[], runner: RunnerContext): Promise<FolderRefreshOutcome[]> {
    const outcomes: FolderRefreshOutcome[] = [];
    for (const folder of folders) {
        outcomes.push(await refreshFolderSetup(folder, runner));
    }
    return outcomes;
}

async function isSetUp(folderDir: string): Promise<boolean> {
    try {
        await fs.access(path.join(folderDir, '.ironbee', 'config.json'));
        return true;
    } catch {
        return false;
    }
}
