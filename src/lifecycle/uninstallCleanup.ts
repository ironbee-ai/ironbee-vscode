import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Folder-name prefix identifying any installed version of this extension. */
export const EXTENSION_ID_PREFIX: string = 'ironbee-ai.ironbee-vscode-';

export interface UninstallProbe {
    /** This extension's install dir (context.extensionPath). */
    extensionPath: string;
    /** Parsed <extensionsDir>/.obsolete map (folderName → true), or null if unreadable/absent. */
    readObsolete: () => Record<string, boolean> | null;
    /** Folder names present in the extensions dir. */
    listSiblings: () => string[];
    /** Folder-name prefix identifying any version of this extension. */
    extensionIdPrefix: string;
}

/**
 * True only when the extension is being genuinely UNINSTALLED — not merely reloaded, shut down, or
 * UPDATED. VS Code's `.obsolete` marks a version for removal on BOTH update and uninstall (and even
 * the `vscode:uninstall` hook fires on update — microsoft/vscode#72375), so `.obsolete` alone can't
 * tell them apart. We additionally require that NO other, non-obsolete version of this extension
 * remains: on update the freshly-installed version's folder is present and not obsolete, so we
 * correctly skip destructive cleanup; on a real uninstall no live version is left.
 */
export function isRealUninstall(probe: UninstallProbe): boolean {
    const ourFolder: string = path.basename(probe.extensionPath);
    const obsolete: Record<string, boolean> = probe.readObsolete() ?? {};
    if (obsolete[ourFolder] !== true) {
        return false; // not marked for removal → normal reload/shutdown
    }
    const liveOtherVersion: boolean = probe
        .listSiblings()
        .some(
            (f: string): boolean =>
                f.startsWith(probe.extensionIdPrefix) && f !== ourFolder && obsolete[f] !== true,
        );
    return !liveOtherVersion;
}

/** Read + parse <extensionsDir>/.obsolete; null if absent/unreadable. */
export function readObsoleteMap(extensionsDir: string): Record<string, boolean> | null {
    try {
        const content: string = fs.readFileSync(path.join(extensionsDir, '.obsolete'), 'utf8').trim();
        return content ? (JSON.parse(content) as Record<string, boolean>) : {};
    } catch {
        return null;
    }
}

/**
 * Best-effort: remove IronBee from every registered project using the bundled CLI's own inventory
 * (`ironbee uninstall --all`). Synchronous so it finishes before the host process exits; bounded by
 * a timeout. Runs with the editor's own Node (ELECTRON_RUN_AS_NODE), never a system node.
 */
export function runCliUninstallAll(extensionPath: string, execPath: string): void {
    try {
        const cliEntry: string = path.join(extensionPath, 'node_modules', '@ironbee-ai', 'cli', 'dist', 'index.js');
        if (!fs.existsSync(cliEntry)) {
            return;
        }
        spawnSync(execPath, [cliEntry, 'uninstall', '--all', '--yes'], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            timeout: 15_000,
            stdio: 'ignore',
        });
    } catch {
        /* best-effort — the extension is going away regardless */
    }
}
