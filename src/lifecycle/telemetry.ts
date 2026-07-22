import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import type * as http from 'node:http';
import * as crypto from 'node:crypto';
import { atomicWriteFile } from '../util/atomicWrite';

/**
 * Anonymous telemetry identity + event transport, stored in the SHARED `~/.ironbee/telemetry.json`
 * (jointly owned by all IronBee tools — ironbee-cli, @ironbee-ai/devtools, and the editor
 * extensions — which all read/write the same anonymousId there). It must NOT be deleted on
 * uninstall. The distinct id stays the anonymous id; when the caller is signed in it may attach the
 * user's email as the PostHog person property via `properties.$set.email` (opt-in by being signed
 * in). Opt-out is honoured by the caller via the `enabled` flag (the `ironbee.telemetry.enable`
 * setting).
 */
export interface TelemetryConfig {
    anonymousId: string;
    telemetryEnabled?: boolean;
    [k: string]: unknown;
}

// Shared IronBee PostHog project. Raw HTTPS ingestion — no posthog-node client needed for
// fire-and-forget capture. Overridable via env for a non-prod project.
const POSTHOG_API_KEY: string = process.env.IRONBEE_POSTHOG_API_KEY || 'phc_ekFEnQ9ipk0F1BbO0KCkaD8OaYPa4bIqqUoxsCfeFsy';
const POSTHOG_HOST: string = 'us.i.posthog.com';
const POSTHOG_PATH: string = '/i/v0/e/';

export function sharedTelemetryPath(): string {
    return path.join(os.homedir(), '.ironbee', 'telemetry.json');
}

export async function readTelemetryConfig(configPath: string = sharedTelemetryPath()): Promise<TelemetryConfig | null> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(configPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? (parsed as TelemetryConfig) : null;
    } catch {
        return null;
    }
}

/** Get-or-create the shared anonymous id, preserving any existing config. */
export async function ensureAnonymousId(configPath: string = sharedTelemetryPath()): Promise<TelemetryConfig> {
    const existing: TelemetryConfig | null = await readTelemetryConfig(configPath);
    if (existing?.anonymousId) {
        return existing;
    }
    const cfg: TelemetryConfig = { ...(existing ?? {}), anonymousId: crypto.randomUUID() };
    await atomicWriteFile(configPath, JSON.stringify(cfg, null, 2) + '\n', { dirMode: 0o755, fileMode: 0o644 });
    return cfg;
}

export interface TelemetryEventPayload {
    event: string;
    distinctId: string;
    properties: Record<string, unknown>;
}

export type TelemetryTransport = (payload: TelemetryEventPayload) => Promise<void>;

/** Give up on a hung request after this long so an awaited send (deactivate/uninstall) can't block. */
const POSTHOG_TIMEOUT_MS: number = 3000;

/**
 * Raw HTTPS POST to PostHog's capture endpoint (`/i/v0/e/`). Fire-and-forget: any network/parse
 * error resolves (never rejects) so telemetry can neither break nor block the extension.
 */
export function postHogTransport(apiKey: string = POSTHOG_API_KEY): TelemetryTransport {
    return (payload: TelemetryEventPayload): Promise<void> =>
        new Promise((resolve: () => void): void => {
            let done: boolean = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish: () => void = (): void => {
                if (done) {
                    return;
                }
                done = true;
                if (timer) {
                    clearTimeout(timer);
                }
                resolve();
            };
            try {
                const body: string = JSON.stringify({
                    api_key: apiKey,
                    event: payload.event,
                    distinct_id: payload.distinctId,
                    properties: payload.properties,
                });
                const req: http.ClientRequest = https.request(
                    {
                        hostname: POSTHOG_HOST,
                        path: POSTHOG_PATH,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                        timeout: POSTHOG_TIMEOUT_MS,
                    },
                    (res: http.IncomingMessage): void => {
                        res.on('data', (): void => {});
                        res.on('end', finish);
                        res.on('close', finish);
                    },
                );
                // A connected-but-silent server won't emit 'error'/'end'. Belt-and-suspenders: the
                // socket 'timeout' handler destroys the request, AND a hard timer covers connect/DNS
                // black-holes (where socket-timeout semantics are unreliable) so the awaited path
                // (deactivate on uninstall) can never hang the extension-host shutdown.
                req.on('timeout', (): void => {
                    req.destroy();
                });
                req.on('error', finish);
                timer = setTimeout((): void => {
                    req.destroy();
                    finish();
                }, POSTHOG_TIMEOUT_MS + 500);
                timer.unref?.(); // don't keep the event loop alive for a background send
                req.write(body);
                req.end();
            } catch {
                finish();
            }
        });
}

/**
 * Emit a telemetry event. Respects opt-out (`enabled`), attaches the shared anonymous id, and sends
 * via PostHog by default (tests/callers may inject a transport). Carries ONLY the anonymous id +
 * the caller's coarse properties — never email/account id. Never throws.
 */
export async function emitEvent(
    name: string,
    opts: { enabled: boolean; properties?: Record<string, unknown>; transport?: TelemetryTransport; configPath?: string },
): Promise<void> {
    if (!opts.enabled) {
        return;
    }
    const cfg: TelemetryConfig = await ensureAnonymousId(opts.configPath);
    if (!cfg.anonymousId) {
        return;
    }
    const transport: TelemetryTransport = opts.transport ?? postHogTransport();
    await transport({ event: name, distinctId: cfg.anonymousId, properties: opts.properties ?? {} });
}
