import { resolveInstallClients, type AiClient } from '../runtime/clientDetect';
import { runInstall, type InstallResult, type RunnerContext, type VerificationMode } from '../runtime/cliRunner';

export interface FolderSetupDeps {
    /**
     * Ask for platforms FOR THIS FOLDER and fully own the UI (manual selection by default; an
     * optional on-demand "Suggest" affordance when an agent CLI is available). Undefined = cancel.
     */
    pickPlatforms(folderDir: string): Promise<string[] | undefined>;
    runner: RunnerContext;
}

export interface FolderOutcome {
    folder: string;
    cancelled: boolean;
    installed: AiClient[];
    failed: AiClient[];
}

/**
 * Set up ONE folder with a pre-chosen `mode` (design EXT-6). Platforms are chosen per folder
 * (each project's structure differs) via `deps.pickPlatforms`; then install once per resolved
 * client (defaults to `.cursor` when none is detected).
 */
export async function setUpFolder(
    folderDir: string,
    mode: VerificationMode,
    deps: FolderSetupDeps,
): Promise<FolderOutcome> {
    const platforms: string[] | undefined = await deps.pickPlatforms(folderDir);
    if (!platforms) {
        return { folder: folderDir, cancelled: true, installed: [], failed: [] };
    }

    const clients: AiClient[] = await resolveInstallClients(folderDir);
    const installed: AiClient[] = [];
    const failed: AiClient[] = [];
    for (const client of clients) {
        const res: InstallResult = await runInstall(deps.runner, { folderDir, client, mode, platforms });
        (res.ok ? installed : failed).push(client);
    }
    return { folder: folderDir, cancelled: false, installed, failed };
}
