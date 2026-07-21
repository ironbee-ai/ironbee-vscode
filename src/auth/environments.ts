import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface EnvConfig {
    /** Short env name (e.g. "prod"/"dev"), used to namespace stored tokens (SecretStorage keys). */
    env: string;
    /** Cognito Hosted UI custom domain (/oauth2/authorize|token|revoke). */
    cognitoDomain: string;
    /** Public desktop app-client id (PKCE, no secret). */
    clientId: string;
    /** Console REST API base the extension calls — NOTE: console.service.* (the SPA is console.*). */
    consoleApiBase: string;
    /** Web-console (SPA) base — written as the CLI's `console.url` for report deep-links. */
    consoleUrl: string;
    /** Collector base — written as the CLI's `collector.url`. */
    collectorUrl: string;
    scopes: string[];
    /** Loopback callback ports registered on the Cognito desktop client (tried in order). */
    loopbackPorts: number[];
}

/**
 * The ONLY environment baked into the shipped extension: production — what a regular user gets.
 * Non-prod environments (dev/staging) are NOT in the code; a developer supplies them at runtime via
 * ~/.ironbee/vscode/config.json (see `loadEnvConfig`), which overrides these defaults.
 */
export const DEFAULT_ENV_CONFIG: EnvConfig = {
    env: 'prod',
    cognitoDomain: 'https://login.ironbee.ai',
    clientId: 'vsvb3ibsor5uh7erim3bor0mc', // prod desktop app client (SSM /ironbee/prod/…/client.id.desktop)
    consoleApiBase: 'https://console.service.ironbee.ai',
    consoleUrl: 'https://console.ironbee.ai',
    collectorUrl: 'https://collector.service.ironbee.ai',
    scopes: ['openid', 'email', 'profile'],
    loopbackPorts: [53100, 53101, 53102, 53103, 53104],
};

/** ~/.ironbee/vscode/config.json — developer-only env override (absent for normal users → prod). */
export function vscodeConfigPath(): string {
    return path.join(os.homedir(), '.ironbee', 'vscode', 'config.json');
}

const STRING_KEYS: readonly ('env' | 'cognitoDomain' | 'clientId' | 'consoleApiBase' | 'consoleUrl' | 'collectorUrl')[] =
    ['env', 'cognitoDomain', 'clientId', 'consoleApiBase', 'consoleUrl', 'collectorUrl'] as const;

/**
 * Resolve the active env config: prod defaults, overridden by ~/.ironbee/vscode/config.json when
 * present. Missing file → prod (normal user). Malformed file → throws (a dev typo should be loud,
 * not silently fall back). Only known keys are merged, so an override can be partial.
 */
export async function loadEnvConfig(configPath: string = vscodeConfigPath()): Promise<EnvConfig> {
    let raw: string;
    try {
        raw = await fs.readFile(configPath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { ...DEFAULT_ENV_CONFIG };
        }
        throw new Error(`~/.ironbee/vscode/config.json is not readable: ${(err as Error).message}`);
    }
    let override: unknown;
    try {
        override = JSON.parse(raw);
    } catch (err) {
        throw new Error(`~/.ironbee/vscode/config.json is not valid JSON: ${(err as Error).message}`);
    }
    if (!override || typeof override !== 'object') {
        return { ...DEFAULT_ENV_CONFIG };
    }
    const o: Record<string, unknown> = override as Record<string, unknown>;
    const merged: EnvConfig = { ...DEFAULT_ENV_CONFIG };
    for (const k of STRING_KEYS) {
        if (typeof o[k] === 'string') {
            merged[k] = o[k] as string;
        }
    }
    if (Array.isArray(o.scopes) && o.scopes.every((s: unknown): boolean => typeof s === 'string')) {
        merged.scopes = o.scopes as string[];
    }
    if (Array.isArray(o.loopbackPorts) && o.loopbackPorts.every((n: unknown): boolean => typeof n === 'number')) {
        merged.loopbackPorts = o.loopbackPorts as number[];
    }
    return merged;
}
