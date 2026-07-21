import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import {
    EXTENSION_ID_PREFIX,
    clearCollectorTokenFromGlobalConfig,
    isRealUninstall,
    readObsoleteMap,
    runCliUninstallAll,
} from './lifecycle/uninstallCleanup';

import { loadEnvConfig, DEFAULT_ENV_CONFIG, type EnvConfig } from './auth/environments';
import { TokenStore } from './auth/tokenStore';
import { AuthManager, NotSignedInError, SignInAbortedError } from './auth/authManager';
import { ConsoleClient, ConsoleError, type Account } from './console/consoleClient';
import { AccountManager } from './accounts/accountManager';
import {
    writeCollectorToken,
    writeDevtoolsEnv,
    writeDevtoolsMcp,
    writeEnvironmentEndpoints,
    writePrivacyMode,
    clearCollectorToken,
    hasLocalCollectorToken,
} from './config/ironbeeConfig';
import { runBrowserInstall, browserNamesForGroups } from './runtime/playwrightBrowsers';
import { prewarmDevtools, type PrewarmResult } from './runtime/devtoolsPrewarm';
import { decideDevtoolsWiring } from './runtime/devtoolsWiring';
import { spawn as nodeSpawn } from 'node:child_process';
import { setUpFolder, type FolderOutcome } from './ui/setupFlow';
import { pickProjects } from './ui/projectPicker';
import { suggestPlatforms, KNOWN_PLATFORMS, type Platform, type SuggestResult } from './runtime/platformSuggest';
import { detectAgentCli, type AgentCli } from './runtime/agentCli';
import { MODE_DESCRIPTIONS, PLATFORM_DESCRIPTIONS } from './ui/descriptions';
import { runUninstall, type RunnerContext, type VerificationMode } from './runtime/cliRunner';
import { StatusBar } from './ui/statusBar';
import { ensureAnonymousId, emitEvent } from './lifecycle/telemetry';
import browserVersions from './generated/browser-versions.json';

const require_: NodeJS.Require = createRequire(__filename);

let statusBar: StatusBar | undefined;
const output: () => vscode.OutputChannel = (): vscode.OutputChannel => outputChannel;
let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext | undefined;
let authManager: AuthManager | undefined; // kept for deactivate (full sign-out on real uninstall)

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel('IronBee');
    // Prod by default; a developer's ~/.ironbee/vscode/config.json overrides it (dev/staging).
    const envConfig: EnvConfig = await loadEnvConfig().catch((e: unknown): EnvConfig => {
        log(`~/.ironbee/vscode/config.json ignored (${(e as Error).message}); using prod defaults`);
        return DEFAULT_ENV_CONFIG;
    });
    log(`environment: ${envConfig.env}`);

    const store: TokenStore = new TokenStore(context.secrets, envConfig.env);
    const auth: AuthManager = new AuthManager({
        env: envConfig,
        store,
        openUrl: async (url: string): Promise<boolean> => vscode.env.openExternal(vscode.Uri.parse(url)),
    });
    authManager = auth;
    const console: ConsoleClient = new ConsoleClient(envConfig.consoleApiBase, (force?: boolean): Promise<string> => auth.getIdToken(force));
    const accounts: AccountManager = new AccountManager({
        console,
        store,
        collectorUrl: envConfig.collectorUrl,
        hostname: os.hostname(),
        writeCollector: writeCollectorToken,
        refreshSession: async (): Promise<void> => {
            await auth.getIdToken(true);
        },
    });

    statusBar = new StatusBar();
    context.subscriptions.push({ dispose: (): void => statusBar?.dispose() }, outputChannel);

    // Point devtools at the bundled copy (platform-specific VSIX) or the npx default (universal
    // VSIX). In both cases tell it NOT to download browsers — the extension pre-installs Chromium.
    const devtoolsMode: 'bundled' | 'npx' = await wireDevtools().catch((e: unknown): 'npx' => {
        log(`could not wire devtools: ${(e as Error).message}`);
        return 'npx' as const;
    });

    const svc: Services = { auth, console, accounts, envConfig };
    registerCommands(context, svc);
    await refreshStatus(auth, console);

    // Mirror the privacy-mode setting into ~/.ironbee/config.json (at activation + on change).
    void syncPrivacyMode();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent): void => {
            if (e.affectsConfiguration('ironbee.privacy.enable')) {
                void syncPrivacyMode();
            }
        }),
    );

    // Non-blocking + guarded so nothing here fails activation (commands are already registered).
    // Chromium is always pre-installed (node-independent); the npx devtools pre-warm only applies
    // to the universal build (the platform-specific build bundles devtools, so nothing to fetch).
    void ensureBrowsersOnUpgrade(context).catch((e: unknown): void => log(`browser pre-install skipped: ${(e as Error).message}`));
    if (devtoolsMode === 'npx') {
        void ensureDevtoolsPrewarmed(context).catch((e: unknown): void => log(`devtools pre-warm skipped: ${(e as Error).message}`));
    }
    // Onboarding nudge — runs INDEPENDENTLY (never chained to the network rotation below, so a slow/
    // hung rotation can't stop it from firing). It gates on the config token, so at worst a valid-
    // session user whose token gets refilled a moment later sees one dismissible prompt.
    void firstRunAndSuggest(context, auth).catch((e: unknown): void => log(`first-run/suggest skipped: ${(e as Error).message}`));
    // Proactively rotate/refill the collector token before its ~90-day expiry (quietly, if signed in).
    void rotateCollectorTokenOnStartup(svc).catch((e: unknown): void => log(`startup token check skipped: ${(e as Error).message}`));
}

/**
 * On activation, if already signed in, quietly check/rotate the collector token so it never lapses
 * for an active user (reuses when far from expiry, rotates within the skew window). No prompt or
 * progress UI — errors go to the output channel only. Never surfaces the sign-in nudge here
 * (firstRunAndSuggest owns that).
 */
async function rotateCollectorTokenOnStartup(svc: Services): Promise<void> {
    if (!(await svc.auth.isSignedIn())) {
        return;
    }
    try {
        const current: Account = await svc.console.currentAccount();
        await svc.accounts.ensureCollectorToken(current.id);
    } catch (err) {
        log(`startup collector-token check failed: ${(err as Error).message}`);
    }
}

/** Bundled devtools entry (present only in the platform-specific VSIX), or undefined (universal). */
function resolveBundledDevtoolsEntry(): string | undefined {
    try {
        return path.join(path.dirname(require_.resolve('@ironbee-ai/devtools/package.json')), 'dist', 'index.js');
    } catch {
        return undefined;
    }
}

/**
 * Wire the CLI's devtools MCP entry. If devtools is bundled (platform-specific VSIX with the
 * correct native deps for this OS/arch), run it via the editor's Node in-place — NO npx/network.
 * Otherwise the CLI keeps its `npx @ironbee-ai/devtools` default and we just suppress its browser
 * download (Chromium is pre-installed by the extension).
 *
 * NOTE (bundled variant): the persisted MCP path is version-scoped to the extension dir, so on an
 * extension upgrade already-set-up projects should be reconfigured to refresh it. TODO for the
 * platform-specific track: re-run `ironbee install` for registered projects when the path changes.
 */
async function wireDevtools(): Promise<'bundled' | 'npx'> {
    const wiring: ReturnType<typeof decideDevtoolsWiring> = decideDevtoolsWiring(resolveBundledDevtoolsEntry(), process.execPath);
    if (wiring.mode === 'bundled') {
        await writeDevtoolsMcp(wiring.mcp);
        log('devtools: bundled (platform-specific) — runs via the editor Node, no npx');
        return 'bundled';
    }
    await writeDevtoolsEnv(wiring.env);
    return 'npx';
}

function telemetryEnabled(): boolean {
    return vscode.workspace.getConfiguration('ironbee').get('telemetry.enable', true);
}

/**
 * Sync `ironbee.privacy.enable` → global config's `privacy.enable`, but ONLY when the user set it
 * explicitly in the editor — otherwise our default would clobber a value set via the CLI's own TUI.
 * Best-effort; never throws.
 */
async function syncPrivacyMode(): Promise<void> {
    const cfg: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('ironbee');
    const inspected: { globalValue?: boolean; workspaceValue?: boolean; workspaceFolderValue?: boolean } | undefined =
        cfg.inspect<boolean>('privacy.enable');
    const explicit: boolean | undefined =
        inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    if (explicit === undefined) {
        return; // not set in the editor — leave whatever the CLI/config has
    }
    await writePrivacyMode(explicit).catch((e: unknown): void => log(`could not sync privacy mode: ${(e as Error).message}`));
}

function track(event: string): void {
    void emitEvent(event, { enabled: telemetryEnabled() }).catch((): void => {});
}

export async function deactivate(): Promise<void> {
    statusBar?.dispose();
    // On a genuine uninstall (not a reload/shutdown/update), remove IronBee from the user's
    // projects via the bundled CLI. See isRealUninstall for the update-vs-uninstall discrimination.
    const extPath: string | undefined = extensionContext?.extensionPath;
    if (!extPath) {
        return;
    }
    try {
        const extensionsDir: string = path.dirname(extPath);
        const real: boolean = isRealUninstall({
            extensionPath: extPath,
            readObsolete: (): Record<string, boolean> | null => readObsoleteMap(extensionsDir),
            listSiblings: (): string[] => {
                try {
                    return fs.readdirSync(extensionsDir);
                } catch {
                    return [];
                }
            },
            extensionIdPrefix: EXTENSION_ID_PREFIX,
        });
        if (real) {
            // Critical clears FIRST (fast, so they finish inside the shutdown budget): exactly what
            // sign-out does — revoke + clear SecretStorage (Cognito session + cached collector tokens),
            // which survives uninstall and would otherwise leave a reinstall "signed in" and refill the
            // token without asking. Then drop the config token. The slow project uninstall runs LAST.
            await authManager?.signOut().catch((): void => undefined);
            clearCollectorTokenFromGlobalConfig(); // drop the extension-managed collector.oauthToken
            runCliUninstallAll(extPath, process.execPath);
        }
    } catch {
        /* non-fatal — never block the host from shutting down */
    }
}

// ── wiring helpers ──────────────────────────────────────────────────────────

interface Services {
    auth: AuthManager;
    console: ConsoleClient;
    accounts: AccountManager;
    envConfig: EnvConfig;
}

function registerCommands(context: vscode.ExtensionContext, svc: Services): void {
    const reg: (id: string, cb: (...a: unknown[]) => unknown) => number = (id: string, cb: (...a: unknown[]) => unknown): number =>
        context.subscriptions.push(vscode.commands.registerCommand(id, cb));

    reg('ironbee.signIn', (): Promise<void> => signIn(svc));
    reg('ironbee.signOut', (): Promise<void> => signOut(svc));
    reg('ironbee.switchAccount', (): Promise<void> => switchAccount(svc));
    reg('ironbee.installIntoProject', (): Promise<void> => installIntoProject(svc));
    reg('ironbee.configureProject', (): Promise<void> => installIntoProject(svc));
    reg('ironbee.uninstallFromProject', (): Promise<void> => uninstallFromProject());
    reg('ironbee.installBrowsers', (): Promise<boolean> => installBrowsers(context, context.extensionPath));
    reg('ironbee.openSettings', (): Thenable<unknown> =>
        vscode.commands.executeCommand('workbench.action.openSettings', 'ironbee'),
    );
    reg('ironbee.showStatus', (): Promise<void> => showStatus(svc));
}

async function signIn(svc: Services): Promise<void> {
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Signing in to IronBee…', cancellable: true },
            (_progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken): Thenable<void> => {
                // Wire the notification's Cancel (✕) to abort the loopback wait so the progress dismisses
                // immediately instead of hanging until the sign-in timeout.
                const ac: AbortController = new AbortController();
                token.onCancellationRequested((): void => ac.abort());
                return svc.auth.signIn(undefined, ac.signal);
            },
        );
        await refreshStatus(svc.auth, svc.console);
        track('sign_in');
        void vscode.window.showInformationMessage('Signed in to IronBee.');
        // Mint + write the collector token (~/.ironbee/config.json → collector.oauthToken) for the
        // active account right away, so the CLI is ready before any project setup. Never throws.
        await ensureCollectorTokenForActiveAccount(svc);
        await maybePromptPendingInvitations(svc);
    } catch (err) {
        if (err instanceof SignInAbortedError) {
            return; // user cancelled — the progress is already gone; no error toast
        }
        void vscode.window.showErrorMessage(`IronBee sign-in failed: ${(err as Error).message}`);
    }
}

/**
 * A user can still reach the Hosted UI's un-removable "Create an account" link and sign up outside
 * their invited team. After sign-in, surface any pending invitation and deep-link to the web console
 * to accept it (accepting can only happen there — the endpoint returns no invitation token). Best-
 * effort; never throws.
 */
async function maybePromptPendingInvitations(svc: Services): Promise<void> {
    let pending: Awaited<ReturnType<ConsoleClient['pendingInvitations']>>;
    try {
        pending = await svc.console.pendingInvitations();
    } catch {
        return; // endpoint unavailable / not entitled — nothing to surface
    }
    if (!pending || pending.length === 0) {
        return;
    }
    const message: string =
        pending.length === 1
            ? `You've been invited to ${pending[0].accountName} — open the console to join.`
            : `You have ${pending.length} pending team invitations — open the console to join.`;
    const choice: string | undefined = await vscode.window.showInformationMessage(message, 'Open Console');
    if (choice === 'Open Console') {
        await vscode.env.openExternal(vscode.Uri.parse(svc.envConfig.consoleUrl));
    }
}

/**
 * The desktop-token access issues from the backend hand-off can only be resolved on the web, so
 * surface them with an actionable "Open Console" prompt. Returns true if it handled the error (the
 * caller should then suppress its own generic message).
 */
function notifyAccessIssue(err: unknown, envConfig: EnvConfig): boolean {
    if (!(err instanceof ConsoleError)) {
        return false;
    }
    let message: string | undefined;
    if (err.status === 403 && err.code === 'USER_NOT_PROVISIONED') {
        message = 'Your IronBee account isn’t set up yet — finish creating it in the web console, then try again.';
    } else if (err.status === 401) {
        // Valid token but no active account — typically an invited user who hasn’t accepted yet.
        message = 'IronBee couldn’t find an active account for you. If you were invited, accept the invitation in the web console.';
    } else if (err.status === 403 && err.code === 'CLIENT_NOT_PERMITTED') {
        message = 'That action isn’t available from the editor — manage it in the web console.';
    }
    if (!message) {
        return false;
    }
    void vscode.window.showWarningMessage(message, 'Open Console').then((choice: string | undefined): void => {
        if (choice === 'Open Console') {
            void vscode.env.openExternal(vscode.Uri.parse(envConfig.consoleUrl));
        }
    });
    return true;
}

async function signOut(svc: Services): Promise<void> {
    await svc.auth.signOut();
    // Design EXT-8b: leave ~/.ironbee/config.json's collector token by default (shared with the
    // CLI), but offer an explicit removal.
    const choice: string | undefined = await vscode.window.showInformationMessage(
        'Signed out of IronBee.',
        'Also remove local CLI token',
    );
    if (choice === 'Also remove local CLI token') {
        await clearCollectorToken().catch((e: unknown): Thenable<string | undefined> =>
            vscode.window.showErrorMessage(`Could not remove local token: ${(e as Error).message}`),
        );
    }
    await refreshStatus(svc.auth, svc.console);
}

async function switchAccount(svc: Services): Promise<void> {
    if (!(await svc.auth.isSignedIn())) {
        void vscode.window.showWarningMessage('Sign in to IronBee to manage accounts.');
        return;
    }
    try {
        // Mark the active account (per the hand-off: use /accounts/current, not the `active` flag)
        // so it's clear which account's role the status view reflects. Each row shows that account's
        // OWN role — a user can be owner of one and admin of another.
        interface AItem extends vscode.QuickPickItem {
            id: string;
            name: string;
        }
        const [list, current]: [Account[], Account | null] = await Promise.all([
            svc.console.listAccounts(),
            svc.console.currentAccount().catch((): Account | null => null),
        ]);
        // Two distinct accounts can share a display name — append the id to disambiguate those, so
        // "owner here / admin there" reads as two accounts rather than one contradictory role.
        const nameCounts: Map<string, number> = new Map<string, number>();
        for (const a of list) {
            const n: string = a.name ?? a.id;
            nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
        }
        const items: AItem[] = list.map((a: Account): AItem => {
            const name: string = a.name ?? a.id;
            const isCurrent: boolean = current?.id === a.id;
            const duplicated: boolean = (nameCounts.get(name) ?? 0) > 1;
            return {
                label: isCurrent ? `$(check) ${name}` : name,
                description: duplicated ? `${a.role} · ${a.id}` : a.role,
                detail: isCurrent ? 'Current account' : undefined,
                id: a.id,
                name,
            };
        });
        const pick: AItem | undefined = await vscode.window.showQuickPick<AItem>(items, {
            title: 'Switch IronBee account',
            placeHolder: 'Select an account',
        });
        if (!pick) {
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Switching account…' },
            (): Promise<void> => svc.accounts.switchTo(pick.id),
        );
        await refreshStatus(svc.auth, svc.console);
        track('switch_account');
        void vscode.window.showInformationMessage(`Switched to ${pick.name}.`);
    } catch (err) {
        if (!notifyAccessIssue(err, svc.envConfig)) {
            void vscode.window.showErrorMessage(`Could not switch account: ${(err as Error).message}`);
        }
    }
}

/**
 * Setup requires a Cognito sign-in (verification is tied to the user's account). Returns true when
 * signed in — prompting once and running the sign-in flow if needed; false if the user declines or
 * sign-in fails, in which case the caller must abort.
 */
async function requireSignIn(svc: Services): Promise<boolean> {
    if (await svc.auth.isSignedIn()) {
        return true;
    }
    const choice: string | undefined = await vscode.window.showInformationMessage(
        'Sign in to IronBee to set up verification for your projects.',
        'Sign In',
    );
    if (choice !== 'Sign In') {
        return false;
    }
    await vscode.commands.executeCommand('ironbee.signIn');
    return svc.auth.isSignedIn();
}

async function installIntoProject(svc: Services): Promise<void> {
    const cliEntry: string | undefined = resolveCliEntry();
    if (!cliEntry) {
        void vscode.window.showErrorMessage('IronBee CLI is not bundled in this build.');
        return;
    }
    // Sign-in is required to set up IronBee — verification is tied to the user's account.
    if (!(await requireSignIn(svc))) {
        return;
    }
    // 1) Which projects — checkbox list of open folders + a folder browser for custom paths.
    const folders: string[] | undefined = await pickProjects();
    if (!folders || folders.length === 0) {
        return;
    }
    const cfg: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('ironbee');
    // 2) Mode — asked ONCE, applied to all selected projects.
    const mode: VerificationMode | undefined = await pickMode(cfg.get<VerificationMode>('install.defaultMode', 'assist'));
    if (!mode) {
        return;
    }

    // 3) Platforms — asked PER project (each structure differs), nothing pre-selected: the user
    // makes a deliberate choice (or uses "Suggest"). There is intentionally no global default.
    const outcomes: FolderOutcome[] = [];
    for (const folder of folders) {
        const outcome: FolderOutcome = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Setting up IronBee in ${path.basename(folder)}…` },
            (): Promise<FolderOutcome> =>
                setUpFolder(folder, mode, {
                    pickPlatforms: (folderDir: string): Promise<string[] | undefined> => pickPlatformsFor(folderDir),
                    runner: { nodePath: process.execPath, cliEntry, log: (l: string): void => log(l) },
                }),
        );
        outcomes.push(outcome);
    }
    reportSetupOutcomes(outcomes);

    // After a successful setup, make sure the CLI has its collector credential
    // (~/.ironbee/config.json → collector.oauthToken) so the verifier can talk to the collector.
    if (outcomes.some((o: FolderOutcome): boolean => !o.cancelled && o.installed.length > 0)) {
        await ensureCollectorTokenForActiveAccount(svc);
        void promptEnableMcp();
    }
}

const MCP_HINT_SUPPRESSED_KEY: string = 'ironbee.mcpEnableHintSuppressed';

/**
 * Cursor lists a newly-added MCP server (the CLI writes `browser-devtools` to .cursor/mcp.json) but
 * leaves enabling it to the user — there is no reliable way to auto-enable it from config or an API.
 * The CLI only prints this to a terminal the extension user never sees, so surface it after each
 * successful setup, until the user opts out with "Don't show again". Cursor-only.
 */
/** Robust Cursor detection: Cursor exposes a `cursor` property on the vscode module; fall back to appName. */
function isCursor(): boolean {
    if ((vscode as unknown as { cursor?: unknown }).cursor !== undefined) {
        return true;
    }
    return (vscode.env.appName ?? '').toLowerCase().includes('cursor');
}

async function promptEnableMcp(): Promise<void> {
    if (!isCursor()) {
        return; // MCP enablement quirk is Cursor-specific
    }
    const ctx: vscode.ExtensionContext | undefined = extensionContext;
    if (!ctx || ctx.globalState.get(MCP_HINT_SUPPRESSED_KEY) === true) {
        return;
    }
    const shortcut: string = process.platform === 'darwin' ? '⌘⇧J' : 'Ctrl+Shift+J';
    const choice: string | undefined = await vscode.window.showInformationMessage(
        `IronBee added its verification tools to Cursor. New MCP servers start disabled — open Cursor ` +
            `Settings (${shortcut}) → Tools & MCP and turn on “browser-devtools” to activate verification.`,
        'Got it',
        "Don't show again",
    );
    if (choice === "Don't show again") {
        await ctx.globalState.update(MCP_HINT_SUPPRESSED_KEY, true);
    }
}

/**
 * Ensure ~/.ironbee/config.json reflects the active setup: always writes the env-derived
 * console.url + collector.url (creating the file if missing), then the collector token
 * (collector.oauthToken) for the active account. When signed in, mints (or reuses a valid cached)
 * token from the console backend and writes it. When signed out: skips the token if one already
 * exists (collector-only state), otherwise nudges sign-in. Never throws.
 */
async function ensureCollectorTokenForActiveAccount(svc: Services): Promise<void> {
    // Keep the env-derived endpoints in sync first (creates ~/.ironbee/config.json if missing):
    // console.url + collector.url for the selected environment, independent of auth/token.
    const envCfg: EnvConfig = svc.envConfig;
    await writeEnvironmentEndpoints({ consoleUrl: envCfg.consoleUrl, collectorUrl: envCfg.collectorUrl }).catch((e: unknown): void =>
        log(`could not write console/collector URLs: ${(e as Error).message}`),
    );

    if (!(await svc.auth.isSignedIn())) {
        if (await hasLocalCollectorToken().catch((): boolean => false)) {
            return; // a CLI token is already present — leave it as-is
        }
        const choice: string | undefined = await vscode.window.showInformationMessage(
            'IronBee is set up. Sign in to connect the verifier — this writes the collector token the CLI needs.',
            'Sign In',
        );
        if (choice === 'Sign In') {
            await vscode.commands.executeCommand('ironbee.signIn');
            // Only continue if sign-in actually succeeded — avoids re-prompting on cancel/failure.
            if (await svc.auth.isSignedIn()) {
                await ensureCollectorTokenForActiveAccount(svc);
            }
        }
        return;
    }
    try {
        const current: Account = await svc.console.currentAccount();
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'IronBee: connecting the verifier…' },
            (): Promise<void> => svc.accounts.ensureCollectorToken(current.id),
        );
        log('collector token ensured in ~/.ironbee/config.json (collector.oauthToken)');
    } catch (err) {
    // Log the full detail to the output channel (the toast truncates) so failures are diagnosable.
        log(`collector token FAILED: ${(err as Error).message}`);
        if (!notifyAccessIssue(err, svc.envConfig)) {
            outputChannel.show(true);
            void vscode.window.showWarningMessage(
                `IronBee: signed in, but writing the collector token failed — see the IronBee output. ${(err as Error).message}`,
            );
        }
    }
}

function reportSetupOutcomes(outcomes: FolderOutcome[]): void {
    const ok: FolderOutcome[] = outcomes.filter((o: FolderOutcome): boolean => !o.cancelled && o.failed.length === 0 && o.installed.length > 0);
    const failed: FolderOutcome[] = outcomes.filter((o: FolderOutcome): boolean => o.failed.length > 0);
    if (ok.length > 0) {
        track('install');
    }
    if (failed.length > 0) {
        void vscode.window.showErrorMessage(
            `IronBee setup failed for ${failed.length} project(s): ${failed.map((o: FolderOutcome): string => path.basename(o.folder)).join(', ')}. See the IronBee output.`,
        );
        outputChannel.show(true);
    }
    if (ok.length > 0) {
        void vscode.window.showInformationMessage(
            `IronBee set up for ${ok.length} project(s): ${ok.map((o: FolderOutcome): string => path.basename(o.folder)).join(', ')}.`,
        );
    }
}

/** Remove IronBee from set-up projects (mirrors installIntoProject; runs `ironbee uninstall`). */
async function uninstallFromProject(): Promise<void> {
    const cliEntry: string | undefined = resolveCliEntry();
    if (!cliEntry) {
        void vscode.window.showErrorMessage('IronBee CLI is not bundled in this build.');
        return;
    }
    // Only offer folders that are actually set up.
    const open: string[] = vscode.workspace.workspaceFolders?.map((f: vscode.WorkspaceFolder): string => f.uri.fsPath) ?? [];
    const setUp: string[] = [];
    for (const dir of open) {
        if (await isSetUp(dir)) {
            setUp.push(dir);
        }
    }
    if (setUp.length === 0) {
        void vscode.window.showInformationMessage('No IronBee-configured projects are open to remove.');
        return;
    }

    interface DirItem extends vscode.QuickPickItem {
        dir: string;
    }
    const picks: readonly DirItem[] | undefined = await vscode.window.showQuickPick<DirItem>(
        setUp.map((dir: string): DirItem => ({ label: path.basename(dir), description: dir, dir, picked: setUp.length === 1 })),
        { title: 'Remove IronBee from which project(s)?', canPickMany: true, placeHolder: 'Select projects to remove IronBee from' },
    );
    if (!picks || picks.length === 0) {
        return;
    }
    const confirm: string | undefined = await vscode.window.showWarningMessage(
        `Remove IronBee from ${picks.length} project(s)? This deletes their IronBee setup.`,
        { modal: true },
        'Remove',
    );
    if (confirm !== 'Remove') {
        return;
    }

    const runner: RunnerContext = { nodePath: process.execPath, cliEntry, log: (l: string): void => log(l) };
    const removed: string[] = [];
    const failed: string[] = [];
    for (const p of picks) {
        const ok: boolean = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Removing IronBee from ${path.basename(p.dir)}…` },
            async (): Promise<boolean> => (await runUninstall(runner, p.dir)).ok,
        );
        (ok ? removed : failed).push(p.dir);
    }
    if (failed.length > 0) {
        void vscode.window.showErrorMessage(
            `Could not remove IronBee from ${failed.length} project(s): ${failed.map((d: string): string => path.basename(d)).join(', ')}. See the IronBee output.`,
        );
        outputChannel.show(true);
    }
    if (removed.length > 0) {
        track('uninstall');
        void vscode.window.showInformationMessage(
            `IronBee removed from ${removed.length} project(s): ${removed.map((d: string): string => path.basename(d)).join(', ')}.`,
        );
    }
}

/**
 * Download the verification browser binaries (Chromium) into the default ms-playwright cache at the
 * revision matching the pinned devtools' playwright — so the npx-launched devtools finds them and
 * never downloads at MCP-startup (no timeout). Skipped when the user opts into the system browser.
 */
async function installBrowsers(context: vscode.ExtensionContext, extensionPath: string): Promise<boolean> {
    const cfg: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('ironbee');
    if (cfg.get('browser.useSystemBrowser', false)) {
        return true;
    }
    const names: string[] = browserNamesForGroups(['chromium']);
    if (names.length === 0) {
        return true;
    }
    const ok: boolean = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'IronBee', cancellable: false },
        (progress: vscode.Progress<{ message?: string }>): Promise<boolean> =>
            runBrowserInstall(extensionPath, names, {
                onProgress: (m: string): void => progress.report({ message: m }),
                log: (l: string): void => log(l),
                onChromiumFailure: (detail: string): Promise<void> => promptSystemChromeFallback(detail),
            }),
    );
    if (ok) {
        log(`browsers ready (chromium rev ${browserVersions.chromiumRevision})`);
        await context.globalState.update(BROWSERS_MARK, browserVersions.chromiumRevision);
    }
    return ok;
}

const BROWSERS_MARK: string = 'ironbee.browsersRevision';

/** Pre-install browsers once per Chromium-revision change (first run + upgrade). */
async function ensureBrowsersOnUpgrade(context: vscode.ExtensionContext): Promise<void> {
    if (vscode.workspace.getConfiguration('ironbee').get('browser.useSystemBrowser', false)) {
        return;
    }
    if (context.globalState.get(BROWSERS_MARK) === browserVersions.chromiumRevision) {
        return; // already installed for this revision
    }
    await installBrowsers(context, context.extensionPath);
}

async function promptSystemChromeFallback(detail: string): Promise<void> {
    const choice: string | undefined = await vscode.window.showWarningMessage(
        'IronBee: verification browser download failed. Use installed Google Chrome instead? (Chrome must be installed.)',
        { modal: false, detail: detail.slice(0, 800) },
        'Use Google Chrome',
        'Not now',
    );
    if (choice === 'Use Google Chrome') {
        await vscode.workspace
            .getConfiguration('ironbee')
            .update('browser.useSystemBrowser', true, vscode.ConfigurationTarget.Global);
    }
}

const PREWARM_MARK: string = 'ironbee.devtoolsPrewarmedSpec';

/**
 * Layer 2 (best-effort): pre-install the pinned devtools on the user machine via npx at
 * activation, once per devtools spec — so the first MCP verification isn't delayed by a cold
 * npx install. Silent fallback: if npx isn't found the MCP server installs devtools at startup.
 */
async function ensureDevtoolsPrewarmed(context: vscode.ExtensionContext): Promise<void> {
    const cliEntry: string | undefined = resolveCliEntry();
    if (!cliEntry) {
        return;
    }
    const spec: string | null = await getDevtoolsSpec(cliEntry);
    if (!spec || context.globalState.get(PREWARM_MARK) === spec) {
        return;
    }
    const res: PrewarmResult = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'IronBee: preparing verification tools…' },
        (): Promise<PrewarmResult> => prewarmDevtools({ spec, log: (l: string): void => log(l) }),
    );
    if (res.ok) {
        log(`devtools pre-warmed (${spec})`);
        await context.globalState.update(PREWARM_MARK, spec);
    } else {
        log(`devtools pre-warm not done (${res.reason}); the MCP server will install it on first use`);
    }
}

/** Read the exact pinned devtools npm spec from the bundled CLI (`ironbee devtools version --json`). */
function getDevtoolsSpec(cliEntry: string): Promise<string | null> {
    return new Promise((resolve: (value: string | null) => void): void => {
        let out: string = '';
        try {
            const child: ReturnType<typeof nodeSpawn> = nodeSpawn(process.execPath, [cliEntry, 'devtools', 'version', '--json'], {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                shell: false,
            });
            const timer: NodeJS.Timeout = setTimeout((): void => {
                child.kill('SIGTERM');
                const kill9: NodeJS.Timeout = setTimeout((): boolean => child.kill('SIGKILL'), 2000);
                kill9.unref?.();
                resolve(null);
            }, 15_000);
            timer.unref?.();
            // Drain stderr and cap stdout so the child can't deadlock on a full pipe before it prints.
            child.stderr?.on('data', (): void => {});
            child.stdout?.on('data', (d: Buffer): void => {
                if (out.length < 64 * 1024) {
                    out += d.toString('utf8');
                }
            });
            child.on('error', (): void => resolve(null));
            child.on('close', (): void => {
                clearTimeout(timer);
                try {
                    const spec: unknown = JSON.parse(out).spec;
                    resolve(typeof spec === 'string' && spec.includes('@') ? spec : null);
                } catch {
                    resolve(null);
                }
            });
        } catch {
            resolve(null);
        }
    });
}

async function showStatus(svc: Services): Promise<void> {
    if (!(await svc.auth.isSignedIn())) {
        const choice: string | undefined = await vscode.window.showInformationMessage('IronBee — not signed in', { modal: true }, 'Sign In');
        if (choice === 'Sign In') {
            await vscode.commands.executeCommand('ironbee.signIn');
        }
        return;
    }
    let detail: string;
    try {
        const [me, current]: [{ id: string; email: string }, Account] = await Promise.all([svc.console.usersMe(), svc.console.currentAccount()]);
        detail = [
            `Signed in as: ${me.email}`,
            `Account: ${current.name ?? current.id}`,
            `Role: ${current.role}`,
        ].join('\n');
    } catch {
        detail = 'Signed in (account details unavailable — offline?)';
    }
    const choice: string | undefined = await vscode.window.showInformationMessage('IronBee', { modal: true, detail }, 'Switch Account');
    if (choice === 'Switch Account') {
        await vscode.commands.executeCommand('ironbee.switchAccount');
    }
}

// ── prompts ───────────────────────────────────────────────────────────────

/** Verification mode — asked once for the whole batch. Each choice carries a description. */
async function pickMode(seed: VerificationMode): Promise<VerificationMode | undefined> {
    const modes: VerificationMode[] = ['assist', 'enforce', 'monitor'];
    const pick: { label: string; detail: string; mode: VerificationMode } | undefined = await vscode.window.showQuickPick(
        modes.map((m: VerificationMode): { label: string; detail: string; mode: VerificationMode } => ({
            label: m === seed ? `${m}  (default)` : m,
            detail: MODE_DESCRIPTIONS[m],
            mode: m,
        })),
        {
            title: 'IronBee verification mode (applies to all selected projects)',
            placeHolder: 'How should IronBee act on verification failures?',
        },
    );
    return pick?.mode;
}

/**
 * Platforms — asked per project. Manual selection by default (each item shows a description).
 * When an agent CLI (cursor-agent/claude/codex) is available, a "Suggest platforms" toolbar
 * button runs the per-project LLM suggestion on demand and checks the suggested platforms.
 */
async function pickPlatformsFor(folderDir: string): Promise<string[] | undefined> {
    interface PItem extends vscode.QuickPickItem {
        id: Platform;
    }
    const agent: AgentCli | null = await detectAgentCli().catch((): null => null);
    const items: PItem[] = KNOWN_PLATFORMS.map((p: Platform): PItem => ({ label: p, detail: PLATFORM_DESCRIPTIONS[p], id: p }));

    const qp: vscode.QuickPick<PItem> = vscode.window.createQuickPick<PItem>();
    qp.title = `Platforms for ${path.basename(folderDir)}`;
    qp.placeholder = 'Select the platforms to verify for this project';
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.items = items;
    // Nothing pre-selected — a deliberate choice per project (or "Suggest").

    const suggestButton: vscode.QuickInputButton | undefined = agent
        ? { iconPath: new vscode.ThemeIcon('sparkle'), tooltip: `Suggest platforms (via ${agent})` }
        : undefined;
    qp.buttons = suggestButton ? [suggestButton] : [];

    qp.onDidTriggerButton(async (b: vscode.QuickInputButton): Promise<void> => {
        if (b !== suggestButton) {
            return;
        }
        qp.busy = true;
        try {
            const res: SuggestResult = await suggestPlatforms(folderDir);
            if (res.platforms && res.platforms.length > 0) {
                qp.selectedItems = items.filter((i: PItem): boolean => res.platforms!.includes(i.id));
            } else {
                void vscode.window.showInformationMessage('IronBee could not suggest platforms for this project — select manually.');
            }
        } finally {
            qp.busy = false;
        }
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
        qp.onDidAccept((): void => finish(qp.selectedItems.map((i: PItem): Platform => i.id)));
        qp.onDidHide((): void => finish(undefined));
        qp.show();
    });
}

// ── first-run / suggestion ──────────────────────────────────────────────────

async function firstRunAndSuggest(context: vscode.ExtensionContext, auth: AuthManager): Promise<void> {
    // Telemetry is on by default (anonymous, no email/account) and opt-out via
    // `ironbee.telemetry.enable` — no prompt/notice. Just ensure the anonymous id exists.
    await ensureAnonymousId().catch((): void => {});

    // First-run sign-in nudge (design EXT-1). The single source of truth for "is the user set up" is
    // the collector token in ~/.ironbee/config.json — NOT the SecretStorage session, which can persist
    // stale across a reinstall and wrongly read as "signed in". If there's no token, prompt sign-in.
    // Shown once per activation (so it doesn't nag within a session); no persistent snooze — a stale
    // "Later" must never survive a reinstall and silently suppress onboarding.
    const hasToken: boolean = await hasLocalCollectorToken().catch((): boolean => false);
    if (!hasToken) {
        const choice: string | undefined = await vscode.window.showInformationMessage(
            'Sign in to IronBee to start verifying your projects.',
            'Sign In',
            'Later',
        );
        if (choice === 'Sign In') {
            await vscode.commands.executeCommand('ironbee.signIn');
        }
        // "Later"/dismiss → nothing to persist; it simply re-appears on the next activation.
    }

    // Encouraging per-project setup suggestion (design EXT-6) — only when signed in, since setup
    // requires sign-in; a signed-out user is funneled through the sign-in nudge above first.
    const folder: vscode.WorkspaceFolder | undefined = vscode.workspace.workspaceFolders?.[0];
    const suggestOnOpen: boolean = vscode.workspace.getConfiguration('ironbee').get('install.suggestOnOpen', true);
    if (folder && suggestOnOpen && (await auth.isSignedIn())) {
        const key: string = `ironbee.suppressSuggest.${folder.uri.fsPath}`;
        const alreadySetUp: boolean = await isSetUp(folder.uri.fsPath);
        if (!alreadySetUp && context.workspaceState.get(key) !== true) {
            statusBar?.needsProjectSetup();
            const choice: string | undefined = await vscode.window.showInformationMessage(
                'IronBee can verify this project’s changes — set it up in one click.',
                'Set up IronBee',
                'Later',
                "Don't ask for this project",
            );
            if (choice === 'Set up IronBee') {
                await vscode.commands.executeCommand('ironbee.installIntoProject');
            } else if (choice === "Don't ask for this project") {
                await context.workspaceState.update(key, true);
            }
        }
    }
}

async function isSetUp(folderDir: string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(path.join(folderDir, '.ironbee')));
        return true;
    } catch {
        return false;
    }
}

// ── misc ────────────────────────────────────────────────────────────────────

async function refreshStatus(auth: AuthManager, console: ConsoleClient): Promise<void> {
    if (!(await auth.isSignedIn())) {
    // State (b): a CLI collector token exists but no Cognito session → distinct label.
        if (await hasLocalCollectorToken().catch((): boolean => false)) {
            statusBar?.collectorOnly();
        } else {
            statusBar?.signedOut();
        }
        return;
    }
    try {
        const [me, current]: [{ id: string; email: string }, Account] = await Promise.all([console.usersMe(), console.currentAccount()]);
        statusBar?.signedIn(me.email, current.name ?? current.id);
    } catch (err) {
        if (err instanceof NotSignedInError) {
            statusBar?.signedOut();
        } else {
            // Signed in but API unreachable (e.g. offline / BE-1 pending): keep a neutral label.
            statusBar?.signedIn(undefined, null);
        }
    }
}

function resolveCliEntry(): string | undefined {
    try {
        return path.join(path.dirname(require_.resolve('@ironbee-ai/cli/package.json')), 'dist', 'index.js');
    } catch {
        return undefined;
    }
}

function log(line: string): void {
    output().appendLine(line);
}
