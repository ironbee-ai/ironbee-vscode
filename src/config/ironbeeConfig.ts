import { promises as fs } from 'node:fs';
import { atomicWriteFile, homeIronbeeConfigPath } from '../util/atomicWrite';

/** Shape of the bits of ~/.ironbee/config.json the extension reads/writes. */
export interface IronbeeGlobalConfig {
    collector?: {
        url?: string;
        oauthToken?: string;
        apiKey?: string;
        [k: string]: unknown;
    };
    console?: {
        url?: string;
        [k: string]: unknown;
    };
    ironbeeDevTools?: {
        env?: Record<string, string>;
        mcp?: { command: string; args: string[]; env?: Record<string, string> };
        [k: string]: unknown;
    };
    privacy?: {
        enable?: boolean;
        [k: string]: unknown;
    };
    [k: string]: unknown;
}

export async function readGlobalConfig(configPath: string = homeIronbeeConfigPath()): Promise<IronbeeGlobalConfig> {
    try {
        const raw: string = await fs.readFile(configPath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as IronbeeGlobalConfig) : {};
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        // Malformed JSON: do NOT clobber — surface so callers can decide.
        throw new Error(`~/.ironbee/config.json is not readable/parseable: ${(err as Error).message}`);
    }
}

/**
 * Write the collector credential for the active account. Deep-merges only the
 * `collector` block, sets `url`+`oauthToken`, and **removes any sibling `apiKey`**
 * so the CLI unambiguously uses the extension's token (design EXT-4 / CLI-5).
 */
export async function writeCollectorToken(
    url: string,
    oauthToken: string,
    configPath: string = homeIronbeeConfigPath(),
): Promise<void> {
    // Guard: an empty/undefined token would be dropped by JSON.stringify, silently leaving
    // collector.url with no oauthToken. Fail loudly instead so the caller surfaces it.
    if (!oauthToken) {
        throw new Error('refusing to write an empty collector.oauthToken');
    }
    const cfg: IronbeeGlobalConfig = await readGlobalConfig(configPath);
    const collector: NonNullable<IronbeeGlobalConfig['collector']> = { ...(cfg.collector ?? {}) };
    collector.url = url;
    collector.oauthToken = oauthToken;
    delete collector.apiKey;
    cfg.collector = collector;
    await atomicWriteFile(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Set the environment-derived endpoints the CLI reads: `console.url` (web-console base, for report
 * deep-links) and `collector.url` (event collector). Deep-merges only those two keys — never
 * touches `collector.oauthToken`/`apiKey` or any other block. Creates ~/.ironbee/config.json (and
 * the ~/.ironbee dir) if missing.
 */
export async function writeEnvironmentEndpoints(
    endpoints: { consoleUrl: string; collectorUrl: string },
    configPath: string = homeIronbeeConfigPath(),
): Promise<void> {
    const cfg: IronbeeGlobalConfig = await readGlobalConfig(configPath);
    cfg.console = { ...(cfg.console ?? {}), url: endpoints.consoleUrl };
    cfg.collector = { ...(cfg.collector ?? {}), url: endpoints.collectorUrl };
    await atomicWriteFile(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Mirror the extension's `ironbee.privacy.enable` setting into GLOBAL config's `privacy.enable`
 * (the CLI's cross-cutting privacy-mode switch). Only touches that one key; when disabled it removes
 * the key rather than writing `false`, and no-ops when there is nothing to change — so it never
 * churns the file or clobbers unrelated `privacy.*` keys. Callers should only invoke it when the
 * setting was set explicitly in the editor (so a CLI-set value isn't overwritten by our default).
 */
export async function writePrivacyMode(enabled: boolean, configPath: string = homeIronbeeConfigPath()): Promise<void> {
    const cfg: IronbeeGlobalConfig = await readGlobalConfig(configPath);
    if (enabled) {
        if (cfg.privacy?.enable === true) {
            return;
        }
        cfg.privacy = { ...(cfg.privacy ?? {}), enable: true };
    } else {
        if (cfg.privacy === undefined || !('enable' in cfg.privacy)) {
            return;
        }
        delete cfg.privacy.enable;
    }
    await atomicWriteFile(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Merge env vars into the devtools MCP entry via GLOBAL config's `ironbeeDevTools.env`.
 * The CLI merges these into (and overrides the defaults of) the `npx @ironbee-ai/devtools`
 * entry it renders — the extension uses this to set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
 * (+ `BROWSER_DEVTOOLS_INSTALL_CHROMIUM=false`) so npx-devtools never downloads browsers;
 * it uses the Chromium the extension pre-installed at the matching revision.
 */
export async function writeDevtoolsEnv(
    env: Record<string, string>,
    configPath: string = homeIronbeeConfigPath(),
): Promise<void> {
    const cfg: IronbeeGlobalConfig = await readGlobalConfig(configPath);
    const existing: NonNullable<IronbeeGlobalConfig['ironbeeDevTools']> = cfg.ironbeeDevTools ?? {};
    cfg.ironbeeDevTools = { ...existing, env: { ...(existing.env ?? {}), ...env } };
    await atomicWriteFile(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Point the CLI-rendered MCP entry at a BUNDLED devtools (platform-specific VSIX variant) via
 * `ironbeeDevTools.mcp` — the CLI uses this full command/args/env instead of the `npx` default,
 * so devtools runs with no npx/network. PLATFORM=compose is still auto-added by the CLI.
 */
export async function writeDevtoolsMcp(
    mcp: { command: string; args: string[]; env?: Record<string, string> },
    configPath: string = homeIronbeeConfigPath(),
): Promise<void> {
    const cfg: IronbeeGlobalConfig = await readGlobalConfig(configPath);
    cfg.ironbeeDevTools = { ...(cfg.ironbeeDevTools ?? {}), mcp };
    await atomicWriteFile(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

/** True when a usable collector credential is already present (skip-if-authed, EXT-1). */
export function hasCollectorToken(cfg: IronbeeGlobalConfig): boolean {
    const t: string | undefined = cfg.collector?.oauthToken;
    return typeof t === 'string' && t.startsWith('ibt_');
}

/** Remove the collector credential from global config (sign-out "also remove local token"). */
export async function clearCollectorToken(configPath: string = homeIronbeeConfigPath()): Promise<void> {
    const cfg: IronbeeGlobalConfig = await readGlobalConfig(configPath);
    if (!cfg.collector) {
        return;
    }
    delete cfg.collector.oauthToken;
    delete cfg.collector.apiKey;
    await atomicWriteFile(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

/** Convenience: read global config and report whether a collector token is present. */
export async function hasLocalCollectorToken(configPath: string = homeIronbeeConfigPath()): Promise<boolean> {
    try {
        return hasCollectorToken(await readGlobalConfig(configPath));
    } catch {
        return false;
    }
}
