import * as vscode from 'vscode';
import * as path from 'node:path';

interface FolderItem extends vscode.QuickPickItem {
    fsPath: string;
}

/** Dedupe folder paths preserving order (open folders first, then added). */
export function dedupePaths(paths: string[]): string[] {
    const seen: Set<string> = new Set<string>();
    const out: string[] = [];
    for (const p of paths) {
        if (p && !seen.has(p)) {
            seen.add(p);
            out.push(p);
        }
    }
    return out;
}

function toItem(fsPath: string, name?: string): FolderItem {
    return { label: name ?? path.basename(fsPath), description: fsPath, fsPath };
}

/**
 * Multi-select project picker (design EXT-6): a checkbox list of the open workspace folders
 * (pre-checked), plus an "Add folder…" toolbar button that opens a native folder browser to add
 * arbitrary project paths (which need NOT be open in the editor). Returns the chosen folder
 * paths, or undefined if cancelled/none.
 */
export async function pickProjects(): Promise<string[] | undefined> {
    const open: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [];
    const qp: vscode.QuickPick<FolderItem> = vscode.window.createQuickPick<FolderItem>();
    qp.title = 'Set up IronBee — select projects';
    qp.placeholder = 'Check the projects to set up (use ⊕ to add a folder that isn’t open)';
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    const addButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('add'),
        tooltip: 'Add a folder…',
    };
    qp.buttons = [addButton];

    let items: FolderItem[] = open.map((f: vscode.WorkspaceFolder): FolderItem => toItem(f.uri.fsPath, f.name));
    qp.items = items;
    qp.selectedItems = items; // pre-check all open folders

    qp.onDidTriggerButton(async (b: vscode.QuickInputButton): Promise<void> => {
        if (b !== addButton) {
            return;
        }
        const picked: vscode.Uri[] | undefined = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: true,
            openLabel: 'Add project(s)',
            title: 'Add IronBee project folder(s)',
        });
        if (!picked || picked.length === 0) {
            return;
        }
        const existing: Set<string> = new Set(items.map((i: FolderItem): string => i.fsPath));
        const added: FolderItem[] = picked.map((u: vscode.Uri): string => u.fsPath).filter((p: string): boolean => !existing.has(p)).map((p: string): FolderItem => toItem(p));
        if (added.length === 0) {
            return;
        }
        const keepSelected: readonly FolderItem[] = qp.selectedItems; // same object refs survive the items rebuild
        items = [...items, ...added];
        qp.items = items;
        qp.selectedItems = [...keepSelected, ...added]; // keep prior checks + check the new ones
    });

    return await new Promise<string[] | undefined>((resolve: (value: string[] | undefined) => void): void => {
        let done: boolean = false;
        const finish: (val: string[] | undefined) => void = (val: string[] | undefined): void => {
            if (!done) {
                done = true;
                qp.hide();
                qp.dispose();
                resolve(val);
            }
        };
        qp.onDidAccept((): void => {
            const sel: string[] = dedupePaths(qp.selectedItems.map((i: FolderItem): string => i.fsPath));
            finish(sel.length > 0 ? sel : undefined);
        });
        qp.onDidHide((): void => finish(undefined));
        qp.show();
    });
}
