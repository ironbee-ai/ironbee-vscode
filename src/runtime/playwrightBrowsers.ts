import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const nodeRequire: ReturnType<typeof createRequire> = createRequire(__filename);

/** playwright-core's programmatic browser installer (shape stable across versions). */
type InstallFn = (browsers: string[]) => Promise<boolean | void>;

export type BrowserGroup = 'chromium' | 'firefox' | 'webkit';

// Same registry names the @ironbee-ai/devtools postinstall uses.
const GROUP_BROWSERS: Record<BrowserGroup, readonly string[]> = {
    chromium: ['chromium', 'chromium-headless-shell', 'ffmpeg'],
    firefox: ['firefox'],
    webkit: ['webkit'],
};
const CHROMIUM_NAMES: Set<string> = new Set(GROUP_BROWSERS.chromium);

/** Map selected groups to the Playwright registry names for installBrowsersForNpmInstall. */
export function browserNamesForGroups(groups: BrowserGroup[]): string[] {
    const out: string[] = [];
    const set: Set<BrowserGroup> = new Set(groups);
    for (const g of ['chromium', 'firefox', 'webkit'] as BrowserGroup[]) {
        if (set.has(g)) {
            out.push(...GROUP_BROWSERS[g]);
        }
    }
    return out;
}

export function namesIncludeChromium(names: string[]): boolean {
    return names.some((n: string): boolean => CHROMIUM_NAMES.has(n));
}

/**
 * Resolve playwright-core's `installBrowsersForNpmInstall` from the extension's bundled
 * playwright-core. Location moved across versions:
 *  - >= ~1.60 bundles it into `lib/coreBundle.js` under `registry`;
 *  - older exported it from `lib/server/index.js`.
 * Returns null when playwright-core isn't bundled / can't be resolved.
 */
export function resolveInstallBrowsersForNpmInstall(extensionPath: string): InstallFn | null {
    const dir: string = path.join(extensionPath, 'node_modules', 'playwright-core');
    if (!fs.existsSync(dir)) {
        return null;
    }
    const candidates: Array<{ file: string; pick: (m: unknown) => unknown }> = [
        {
            file: path.join(dir, 'lib', 'coreBundle.js'),
            pick: (m: unknown): unknown => (m as { registry?: { installBrowsersForNpmInstall?: unknown } })?.registry?.installBrowsersForNpmInstall,
        },
        {
            file: path.join(dir, 'lib', 'server', 'index.js'),
            pick: (m: unknown): unknown => (m as { installBrowsersForNpmInstall?: unknown })?.installBrowsersForNpmInstall,
        },
    ];
    for (const c of candidates) {
        if (!fs.existsSync(c.file)) {
            continue;
        }
        try {
            const fn: unknown = c.pick(nodeRequire(c.file));
            if (typeof fn === 'function') {
                return fn as InstallFn;
            }
        } catch {
            /* try next */
        }
    }
    return null;
}

export interface BrowserInstaller {
  /** Notify progress (message). */
  onProgress?: (message: string) => void;
  /** Offer to switch to system Chrome after a Chromium download failure. */
  onChromiumFailure?: (errorDetail: string) => Promise<void>;
  log?: (line: string) => void;
  /** Injectable resolver for tests. */
  resolveInstaller?: (extensionPath: string) => InstallFn | null;
}

// Serializes runBrowserInstall calls: the install temporarily mutates the shared
// process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, so two overlapping calls (e.g. the activation
// pre-install racing the manual command) could clobber each other's save/restore. A single
// in-process lock chains them instead.
let installChain: Promise<unknown> = Promise.resolve();

/**
 * Download the given Playwright browser binaries into the DEFAULT ms-playwright cache
 * (the same cache the npx-launched devtools looks in). Temporarily clears
 * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD so the install actually runs. Calls are serialized so the
 * global-env mutation is safe under concurrency. Never throws.
 * @returns true if the install completed without error.
 */
export function runBrowserInstall(
    extensionPath: string,
    names: string[],
    deps: BrowserInstaller = {},
): Promise<boolean> {
    const run: Promise<boolean> = installChain.then((): Promise<boolean> => runBrowserInstallExclusive(extensionPath, names, deps));
    // Keep the chain alive regardless of this call's outcome (runBrowserInstallExclusive never
    // throws, but guard anyway so a rejection can't wedge the chain).
    installChain = run.catch((): undefined => undefined);
    return run;
}

async function runBrowserInstallExclusive(
    extensionPath: string,
    names: string[],
    deps: BrowserInstaller,
): Promise<boolean> {
    if (names.length === 0) {
        return true;
    }
    const resolve: (extensionPath: string) => InstallFn | null = deps.resolveInstaller ?? resolveInstallBrowsersForNpmInstall;
    const install: InstallFn | null = resolve(extensionPath);
    if (install === null) {
        deps.log?.('playwright-core installer not resolvable — is the extension bundle intact?');
        return false;
    }

    deps.onProgress?.(`Installing verification browsers (${names.join(', ')})…`);
    const hadSkip: string | undefined = process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    if (hadSkip !== undefined) {
        delete process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    }
    let ok: boolean = false;
    let errorDetail: string = '';
    try {
        await install(names);
        ok = true;
    } catch (err) {
        errorDetail = err instanceof Error ? err.message : String(err);
        deps.log?.(`browser install failed: ${errorDetail}`);
    } finally {
        if (hadSkip !== undefined) {
            process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = hadSkip;
        }
    }
    if (!ok && errorDetail && namesIncludeChromium(names) && deps.onChromiumFailure) {
        await deps.onChromiumFailure(errorDetail);
    }
    return ok;
}
