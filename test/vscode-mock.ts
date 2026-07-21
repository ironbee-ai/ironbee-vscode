// Minimal `vscode` API mock for unit tests (vitest aliases `vscode` to this file).
// Only the surface our modules touch is stubbed; extend as needed.

export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum ProgressLocation { Notification = 15, Window = 10 }
export enum UIKind { Desktop = 1, Web = 2 }

export const Uri = {
    file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
    joinPath: (base: { fsPath: string }, ...segs: string[]) => ({
        fsPath: [base.fsPath, ...segs].join('/'),
        scheme: 'file',
        path: [base.fsPath, ...segs].join('/'),
    }),
};

const memory = new Map<string, unknown>();

export const workspace = {
    workspaceFolders: undefined as unknown[] | undefined,
    getConfiguration: (_section?: string) => ({
        get: <T>(_key: string, def?: T): T | undefined => def,
        update: async () => undefined,
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
};

export const window = {
    createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        command: undefined as unknown,
        show() {},
        hide() {},
        dispose() {},
    }),
    createOutputChannel: () => ({
        appendLine() {},
        append() {},
        show() {},
        dispose() {},
    }),
    showInformationMessage: async (..._a: unknown[]) => undefined,
    showWarningMessage: async (..._a: unknown[]) => undefined,
    showErrorMessage: async (..._a: unknown[]) => undefined,
    showQuickPick: async (..._a: unknown[]) => undefined,
    showOpenDialog: async (..._a: unknown[]) => undefined,
    createQuickPick: () => ({
        title: '',
        placeholder: '',
        canSelectMany: false,
        ignoreFocusOut: false,
        busy: false,
        buttons: [] as unknown[],
        items: [] as unknown[],
        selectedItems: [] as unknown[],
        onDidTriggerButton: () => ({ dispose() {} }),
        onDidAccept: () => ({ dispose() {} }),
        onDidHide: () => ({ dispose() {} }),
        show() {},
        hide() {},
        dispose() {},
    }),
    withProgress: async (_opts: unknown, task: (p: unknown) => Promise<unknown>) =>
        task({ report() {} }),
};

export class ThemeIcon {
    constructor(public readonly id: string) {}
}

export const commands = {
    registerCommand: (_id: string, _cb: (...a: unknown[]) => unknown) => ({ dispose() {} }),
    executeCommand: async (..._a: unknown[]) => undefined,
};

export const env = {
    openExternal: async (_uri: unknown) => true,
    uriScheme: 'cursor',
    appName: 'Cursor',
    uiKind: UIKind.Desktop,
};

export const secretsBacking = memory;
