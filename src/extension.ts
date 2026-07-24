import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import {
    EXTENSION_ID_PREFIX,
    clearCollectorTokenFromGlobalConfig,
    clearOwnedDevtoolsMcpFromGlobalConfig,
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
    clearDevtoolsMcp,
    isExtensionOwnedDevtoolsMcp,
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
import { refreshSetUpFolders, shouldRefreshSetups, type FolderRefreshOutcome } from './lifecycle/upgradeRefresh';
import { StatusBar } from './ui/statusBar';
import { ensureAnonymousId, emitEvent } from './lifecycle/telemetry';
import { redact } from './util/redact';
import browserVersions from './generated/browser-versions.json';

const require_: NodeJS.Require = createRequire(__filename);

let statusBar: StatusBar | undefined;
let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext | undefined;
let authManager: AuthManager | undefined; // kept for deactivate (full sign-out on real uninstall)
let currentUserEmail: string | undefined; // last-known signed-in email, attached to telemetry ($set.email)
// Bundled devtools entry as an IRONBEE_DEVTOOLS_MCP JSON, passed to `ironbee install` so it bakes a
// PER-PROJECT .cursor/mcp.json (no global config write). undefined in npx/universal mode.
let devtoolsMcpJson: string | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    try {
        await activateInner(context);
    } catch (err) {
        // A fatal activation error would otherwise only show VS Code's generic banner — record it.
        emitErrorEvent('activate', err, false);
        throw err; // still let VS Code mark activation as failed
    }
}

async function activateInner(context: vscode.ExtensionContext): Promise<void> {
    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel('IronBee');
    // Prod by default; a developer's ~/.ironbee/vscode/config.json overrides it (dev/staging).
    const envConfig: EnvConfig = await loadEnvConfig().catch((e: unknown): EnvConfig => {
        logError('env-config-load (ignored; using prod defaults)', e);
        return DEFAULT_ENV_CONFIG;
    });
    log(`environment: ${envConfig.env}`);

    const store: TokenStore = new TokenStore(context.secrets, envConfig.env);
    const auth: AuthManager = new AuthManager({
        env: envConfig,
        store,
        openUrl: async (url: string): Promise<boolean> => vscode.env.openExternal(vscode.Uri.parse(url)),
        onEvent: (name: string, props?: Record<string, unknown>): void => track(name, props),
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
        telemetry: {
            event: (name: string, props?: Record<string, unknown>): void => track(name, props),
            error: (context: string, err: unknown): void => logError(context, err),
        },
    });

    statusBar = new StatusBar();
    context.subscriptions.push({ dispose: (): void => statusBar?.dispose() }, outputChannel);

    // Point devtools at the bundled copy (platform-specific VSIX) or the npx default (universal
    // VSIX). In both cases tell it NOT to download browsers — the extension pre-installs Chromium.
    const devtoolsMode: 'bundled' | 'npx' = await wireDevtools().catch((e: unknown): 'npx' => {
        logError('devtools-wiring (fell back to npx)', e);
        return 'npx' as const;
    });

    const svc: Services = { auth, console, accounts, envConfig };
    registerCommands(context, svc);
    await refreshStatus(auth, console); // populates currentUserEmail before any event fires

    // Diagnostic: which devtools delivery ran — bundled (platform-specific VSIX) vs npx (universal).
    // After refreshStatus so a signed-in user's email rides along.
    track('devtools_mode', { mode: devtoolsMode });

    // Mirror the privacy-mode setting into ~/.ironbee/config.json (at activation + on change).
    void syncPrivacyMode().catch((e: unknown): void => logError('privacy-sync', e));
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent): void => {
            if (e.affectsConfiguration('ironbee.privacy.enable')) {
                void syncPrivacyMode().catch((err: unknown): void => logError('privacy-sync', err));
            }
        }),
    );

    // Non-blocking + guarded so nothing here fails activation (commands are already registered).
    // Chromium is always pre-installed (node-independent); the npx devtools pre-warm only applies
    // to the universal build (the platform-specific build bundles devtools, so nothing to fetch).
    void ensureBrowsersOnUpgrade(context).catch((e: unknown): void => logError('browser-preinstall', e));
    if (devtoolsMode === 'npx') {
        void ensureDevtoolsPrewarmed(context).catch((e: unknown): void => logError('devtools-prewarm', e));
    }
    // Onboarding nudge — runs INDEPENDENTLY (never chained to the network rotation below, so a slow/
    // hung rotation can't stop it from firing). It gates on the config token, so at worst a valid-
    // session user whose token gets refilled a moment later sees one dismissible prompt.
    void firstRunAndSuggest(context, auth).catch((e: unknown): void => logError('first-run/suggest', e));
    // Proactively rotate/refill the collector token before its ~90-day expiry (quietly, if signed in).
    void rotateCollectorTokenOnStartup(svc).catch((e: unknown): void => logError('startup-token-check', e));
    // Silent upgrade refresh: on the first activation after an extension install/upgrade, re-run
    // `ironbee install` for already-set-up workspace folders so the IronBee-owned client files are
    // re-baked (the bundled-devtools path in .cursor/mcp.json is version-scoped and goes stale on
    // upgrade; this also retroactively adds `.cursor` to projects set up before the always-cursor
    // fix). Never installs into a folder that was not set up. Runs AFTER wireDevtools (needs
    // devtoolsMcpJson).
    void refreshProjectSetupsOnUpgrade(context).catch((e: unknown): void => logError('upgrade-refresh', e));
    // Extension-lifecycle telemetry (install/upgrade + activated). Fire-and-forget.
    void trackActivationLifecycle(context).catch((): void => {});
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
        logError('startup-collector-token', err);
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
 * The bundled entry is NOT written to the shared global config; it is passed per-project via
 * `IRONBEE_DEVTOOLS_MCP` at `ironbee install` time, which bakes it into each project's own
 * `.cursor/mcp.json`. NOTE: that baked path is still version-scoped to the extension dir, so on an
 * extension upgrade it goes stale — refreshProjectSetupsOnUpgrade re-bakes it silently on the
 * first activation after an upgrade.
 */
async function wireDevtools(): Promise<'bundled' | 'npx'> {
    const wiring: ReturnType<typeof decideDevtoolsWiring> = decideDevtoolsWiring(resolveBundledDevtoolsEntry(), process.execPath);
    // We NEVER write the devtools `mcp` entry into the SHARED global ~/.ironbee/config.json anymore:
    // that version-scoped absolute path affects every project and goes stale on upgrade/switch. Migrate
    // away any block a PRIOR version of this extension left in global — but ONLY ours (path inside our
    // editor-extensions dir), never a user's own hand-set/CLI override.
    await clearDevtoolsMcp(undefined, isExtensionOwnedDevtoolsMcp);
    if (wiring.mode === 'bundled') {
        // Carry the bundled entry as IRONBEE_DEVTOOLS_MCP for `ironbee install`, which bakes it into
        // THIS project's own .cursor/mcp.json (per-project override; no global write).
        devtoolsMcpJson = JSON.stringify(wiring.mcp);
        log('devtools: bundled (platform-specific) — per-project mcp via IRONBEE_DEVTOOLS_MCP, no global write');
        return 'bundled';
    }
    devtoolsMcpJson = undefined;
    // npx (universal): the CLI bakes its own `npx @ironbee-ai/devtools` default entry; we only suppress
    // the browser download. This env is generic + non-version-scoped, so it never causes stale paths.
    await writeDevtoolsEnv(wiring.env);
    log('devtools: npx (universal) — CLI default entry, browser download suppressed');
    return 'npx';
}

const EXTENSION_ID: string = 'ironbee-ai.ironbee-vscode';
const GITHUB_ISSUES_BASE: string = 'https://github.com/ironbee-ai/ironbee-vscode/issues/new';
const TELEMETRY_VERSION_KEY: string = 'ironbee.telemetry.lastVersion';
const EVENT_PREFIX: string = 'cursor_ext_';

function telemetryEnabled(): boolean {
    return vscode.workspace.getConfiguration('ironbee').get('telemetry.enable', true);
}

function extensionVersion(): string {
    return (vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as { version?: string } | undefined)?.version ?? '';
}

/**
 * Coarse context attached to every event. When a user is signed in, the last-known email (cached
 * from refreshStatus — never a per-event API call) rides along BOTH as an event property (`email`,
 * for immediate per-event filtering) AND as the PostHog person property via `$set.email` (the
 * standard reserved key PostHog's UI recognizes, for People search). The distinct id stays the
 * shared anonymous id.
 */
function baseTelemetryProperties(): Record<string, unknown> {
    const props: Record<string, unknown> = {
        source: 'ironbee-vscode',
        extension_id: EXTENSION_ID,
        extension_version: extensionVersion(),
        node_version: process.version,
        os_platform: process.platform,
        os_arch: process.arch,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timestamp: new Date().toISOString(),
    };
    if (currentUserEmail) {
        props.email = currentUserEmail; // event property — immediate per-event filtering
        props.$set = { email: currentUserEmail }; // person property — People search + persists
    }
    return props;
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
    await writePrivacyMode(explicit).catch((e: unknown): void => logError('privacy-sync', e));
}

/**
 * Fire-and-forget event. Callers pass the SHORT name; every event is namespaced with the
 * `cursor_ext_` prefix here (single source of truth). Never throws or blocks.
 */
function track(event: string, properties: Record<string, unknown> = {}): void {
    void emitEvent(EVENT_PREFIX + event, {
        enabled: telemetryEnabled(),
        properties: { ...baseTelemetryProperties(), ...properties },
    }).catch((): void => {});
}

/**
 * Extension-lifecycle telemetry at activation: a `cursor_ext_installed` on first run after an
 * install/upgrade (detected by comparing the stored version), then always `cursor_ext_activated`.
 * NOTE: globalState survives uninstall, so a reinstall of the SAME version won't re-fire `installed`.
 */
async function trackActivationLifecycle(context: vscode.ExtensionContext): Promise<void> {
    const version: string = extensionVersion();
    const previous: string | undefined = context.globalState.get<string>(TELEMETRY_VERSION_KEY);
    if (previous !== version) {
        track('installed', { previous_version: previous ?? null, upgrade: previous !== undefined });
        await context.globalState.update(TELEMETRY_VERSION_KEY, version).then(undefined, (): void => {});
    }
    track('activated');
}

/** Build a prefilled GitHub new-issue URL for our repo (query params encoded). */
function buildGitHubIssueUrl(title: string, body?: string): string {
    const params: URLSearchParams = new URLSearchParams();
    params.set('title', title);
    if (body) {
        params.set('body', body);
    }
    return `${GITHUB_ISSUES_BASE}?${params.toString()}`;
}

/**
 * Format an error for the issue body: extension version, type, message, stack. Uses `**` headings so
 * `##` is not URL-encoded to `%23%23` in the issue URL.
 */
function formatErrorForIssueBody(error: unknown, version: string): string {
    const lines: string[] = [];
    if (version) {
        lines.push(`**Extension version:** ${version}`, '');
    }
    if (error instanceof Error) {
        lines.push(
            '**Error details**',
            '',
            `**Type:** \`${error.constructor?.name ?? 'Error'}\``,
            '',
            `**Message:** ${error.message}`,
            '',
            '**Stack:**',
            '```',
            error.stack ?? '(no stack)',
            '```',
        );
        // redact() the whole body — a message/stack can carry ibt_ tokens, JWTs, OAuth codes, and
        // this text is prefilled into a (potentially public) GitHub issue URL.
        return redact(lines.join('\n'));
    }
    lines.push(`**Message:** ${String(error)}`);
    return redact(lines.join('\n'));
}

/**
 * Fire a `cursor_ext_error` event (fire-and-forget). `surfaced` records whether the failure was also
 * shown to the user (reportError) or only logged (logError), so both can be filtered in PostHog.
 */
function emitErrorEvent(context: string, error: unknown, surfaced: boolean): void {
    // redact() before anything leaves the machine — error strings can carry ibt_ tokens, JWTs,
    // OAuth codes, bearer headers, etc.
    const rawMessage: string | undefined = error instanceof Error ? error.message : error !== undefined ? String(error) : undefined;
    track('error', {
        context: redact(context).slice(0, 200),
        surfaced,
        error_type: error instanceof Error ? (error.constructor?.name ?? 'Error') : undefined,
        error_message: rawMessage !== undefined ? redact(rawMessage) : undefined,
    });
}

/**
 * Silent error report: write to the output channel AND fire `cursor_ext_error` — no UI. For
 * best-effort/background failures we don't want to interrupt the user over. Never throws or blocks.
 */
function logError(context: string, error: unknown): void {
    log(redact(`${context}: ${error instanceof Error ? error.message : String(error)}`));
    emitErrorEvent(context, error, false);
}

/**
 * Surface a failure: fire a `cursor_ext_error` event and show the message with an "Open issue on
 * GitHub" action that deep-links to our repo's new-issue form (prefilled with the error when given).
 */
function reportError(message: string, error?: unknown, opts: { warning?: boolean } = {}): void {
    emitErrorEvent(message, error, true);
    const show: typeof vscode.window.showErrorMessage = opts.warning
        ? vscode.window.showWarningMessage
        : vscode.window.showErrorMessage;
    void show(message, 'Open issue on GitHub').then((choice: string | undefined): void => {
        if (choice !== 'Open issue on GitHub') {
            return;
        }
        const title: string = redact(message.slice(0, 100).replace(/\s+/g, ' ').trim());
        const body: string | undefined = error !== undefined ? formatErrorForIssueBody(error, extensionVersion()) : undefined;
        void vscode.env.openExternal(vscode.Uri.parse(buildGitHubIssueUrl(title, body)));
    });
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
        const enabled: boolean = telemetryEnabled();
        if (real) {
            // AWAIT the uninstall event so the HTTPS request completes before the host tears us down
            // (a fire-and-forget track() would be cut off). Never throws.
            await emitEvent(EVENT_PREFIX + 'uninstalled', { enabled, properties: baseTelemetryProperties() }).catch((): void => {});
            // Critical clears FIRST (fast, so they finish inside the shutdown budget): exactly what
            // sign-out does — revoke + clear SecretStorage (Cognito session + cached collector tokens),
            // which survives uninstall and would otherwise leave a reinstall "signed in" and refill the
            // token without asking. Then drop the config token. The slow project uninstall runs LAST.
            await authManager?.signOut().catch((): void => undefined);
            clearCollectorTokenFromGlobalConfig(); // drop the extension-managed collector.oauthToken
            clearOwnedDevtoolsMcpFromGlobalConfig(); // drop an owned devtools mcp a prior version wrote to global
            runCliUninstallAll(extPath, process.execPath);
        } else {
            // Reload/shutdown/window-close — best-effort (may be cut short if the host exits fast).
            await emitEvent(EVENT_PREFIX + 'deactivated', { enabled, properties: baseTelemetryProperties() }).catch((): void => {});
        }
    } catch (err) {
        // Non-fatal — never block the host from shutting down. Best-effort telemetry only (no UI/log:
        // the output channel may already be disposed); the request may be cut short on a fast exit.
        emitErrorEvent('deactivate-cleanup', err, false);
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
    // Safety net: VS Code does not surface a command handler's rejected promise (it only logs to the
    // dev console), so wrap every handler — any error that a handler didn't already report itself
    // lands here as `cursor_ext_error` (via reportError). Handlers that catch + report internally
    // resolve normally, so there's no double-report.
    const reg: (id: string, cb: (...a: unknown[]) => unknown) => number = (id: string, cb: (...a: unknown[]) => unknown): number =>
        context.subscriptions.push(
            vscode.commands.registerCommand(id, async (...args: unknown[]): Promise<unknown> => {
                try {
                    return await cb(...args);
                } catch (err) {
                    reportError(`IronBee command '${id}' failed: ${(err as Error).message}`, err);
                    return undefined;
                }
            }),
        );

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
        reportError(`IronBee sign-in failed: ${(err as Error).message}`, err);
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
    } catch (err) {
        logError('pending-invitations', err); // endpoint unavailable / not entitled — no UI, just record
        return;
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
        await clearCollectorToken().catch((e: unknown): void =>
            reportError(`Could not remove local token: ${(e as Error).message}`, e),
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
            reportError(`Could not switch account: ${(err as Error).message}`, err);
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
        reportError('IronBee CLI is not bundled in this build.');
        return;
    }
    // Sign-in is required to set up IronBee — verification is tied to the user's account.
    if (!(await requireSignIn(svc))) {
        track('setup_cancelled', { at: 'sign_in' });
        return;
    }
    // 1) Which projects — checkbox list of open folders + a folder browser for custom paths.
    const folders: string[] | undefined = await pickProjects();
    if (!folders || folders.length === 0) {
        track('setup_cancelled', { at: 'project_selection' });
        return;
    }
    const cfg: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('ironbee');
    // 2) Mode — asked ONCE, applied to all selected projects.
    const mode: VerificationMode | undefined = await pickMode(cfg.get<VerificationMode>('install.defaultMode', 'assist'));
    if (!mode) {
        track('setup_cancelled', { at: 'mode_selection' });
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
                    runner: {
                        nodePath: process.execPath,
                        cliEntry,
                        log: (l: string): void => log(l),
                        // Bundled build: bake the bundled devtools entry into THIS project's mcp.json
                        // (per-project), instead of the shared global config.
                        env: devtoolsMcpJson ? { IRONBEE_DEVTOOLS_MCP: devtoolsMcpJson } : undefined,
                    },
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
        logError('write-env-endpoints', e),
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
        logError('collector-token-write', err);
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
        track('project_setup', { project_count: ok.length });
    }
    if (failed.length > 0) {
        track('project_setup_failed', { project_count: failed.length });
        reportError(
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
        reportError('IronBee CLI is not bundled in this build.');
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
        track('project_uninstall_failed', { project_count: failed.length });
        reportError(
            `Could not remove IronBee from ${failed.length} project(s): ${failed.map((d: string): string => path.basename(d)).join(', ')}. See the IronBee output.`,
        );
        outputChannel.show(true);
    }
    if (removed.length > 0) {
        track('project_uninstall', { project_count: removed.length });
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
    track('browser_install', { ok, revision: browserVersions.chromiumRevision });
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
        track('browser_system_fallback_accepted');
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
    track('devtools_prewarm', { ok: res.ok, reason: res.ok ? undefined : res.reason });
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
    } catch (err) {
        logError('show-status', err);
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
                'Set up',
                'Later',
                "Don't ask again",
            );
            if (choice === 'Set up') {
                await vscode.commands.executeCommand('ironbee.installIntoProject');
            } else if (choice === "Don't ask again") {
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
        currentUserEmail = undefined; // signed out → drop the cached email from telemetry
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
        currentUserEmail = me.email; // cache for telemetry — no per-event API call
        statusBar?.signedIn(me.email, current.name ?? current.id);
    } catch (err) {
        if (err instanceof NotSignedInError) {
            currentUserEmail = undefined;
            statusBar?.signedOut();
        } else {
            // Signed in but API unreachable (e.g. offline / BE-1 pending): keep a neutral label.
            logError('refresh-status', err);
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

const SETUP_REFRESH_VERSION_KEY: string = 'ironbee.setupRefresh.lastVersion';

/**
 * Once per (workspace, extension version): silently re-run install for every already-set-up
 * workspace folder (no `--mode`/`--platforms` → verification config untouched; `--yes` → no
 * prompt can fire). Per-workspace state, not global — each workspace's projects get refreshed
 * the first time that workspace is opened under the new version. No toasts; failures go to the
 * output channel only, and the marker is still written so a broken folder can't nag forever.
 */
async function refreshProjectSetupsOnUpgrade(context: vscode.ExtensionContext): Promise<void> {
    const current: string = extensionVersion();
    const stored: string | undefined = context.workspaceState.get<string>(SETUP_REFRESH_VERSION_KEY);
    if (!shouldRefreshSetups(stored, current)) {
        return;
    }
    const folders: string[] = (vscode.workspace.workspaceFolders ?? [])
        .filter((f: vscode.WorkspaceFolder): boolean => f.uri.scheme === 'file')
        .map((f: vscode.WorkspaceFolder): string => f.uri.fsPath);
    if (folders.length === 0) {
        return; // empty window — keep the marker unset so a real workspace still refreshes later
    }
    const cliEntry: string | undefined = resolveCliEntry();
    if (!cliEntry) {
        return; // bundled CLI missing — keep the marker unset so a repaired install retries
    }
    const runner: RunnerContext = {
        nodePath: process.execPath,
        cliEntry,
        log: (l: string): void => log(l),
        env: devtoolsMcpJson ? { IRONBEE_DEVTOOLS_MCP: devtoolsMcpJson } : undefined,
    };
    const outcomes: FolderRefreshOutcome[] = await refreshSetUpFolders(folders, runner);
    const touched: FolderRefreshOutcome[] = outcomes.filter((o: FolderRefreshOutcome): boolean => !o.skipped);
    if (touched.length > 0) {
        const failedCount: number = touched.filter((o: FolderRefreshOutcome): boolean => o.failed.length > 0).length;
        log(
            `upgrade refresh (${current}): re-ran install for ${touched.length} set-up project(s)` +
                (failedCount > 0 ? ` — ${failedCount} with failures (see above)` : ''),
        );
        track('project_setup_refreshed', { project_count: touched.length, failed_count: failedCount });
    }
    await context.workspaceState.update(SETUP_REFRESH_VERSION_KEY, current);
}

function log(line: string): void {
    // Guarded: the output channel may not exist yet (very early) or be disposed (during shutdown);
    // a logging call must never throw into its caller (e.g. a manager's telemetry error sink).
    try {
        outputChannel.appendLine(line);
    } catch {
        /* channel not yet created or already disposed — drop the line */
    }
}
