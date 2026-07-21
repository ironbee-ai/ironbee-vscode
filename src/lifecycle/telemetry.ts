import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { atomicWriteFile } from '../util/atomicWrite';

/**
 * Anonymous telemetry identity, stored in the SHARED `~/.ironbee-devtools/config.json`
 * (jointly owned with ironbee-devtools-vscode — the extension must NOT delete this file
 * on uninstall). Events carry only { anonymousId, event } — never email/account id.
 */
export interface TelemetryConfig {
    anonymousId: string;
    telemetryEnabled?: boolean;
    telemetryNoticeShown?: boolean;
    [k: string]: unknown;
}

export function sharedTelemetryPath(): string {
    return path.join(os.homedir(), '.ironbee-devtools', 'config.json');
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
    anonymousId: string;
    event: string;
}

/**
 * Emit a telemetry event (design EXT-9). Respects the opt-out and the notice-before-events
 * rule, and carries ONLY { anonymousId, event } — never email/account id. The network
 * transport/endpoint is deferred (not specified for this extension yet); callers inject one
 * when available, else it is a no-op.
 */
export async function emitEvent(
    name: string,
    opts: { enabled: boolean; transport?: (p: TelemetryEventPayload) => void; configPath?: string },
): Promise<void> {
    // Telemetry is on by default (opt-out via `enabled`) — no notice/consent gate.
    if (!opts.enabled) {
        return;
    }
    const cfg: TelemetryConfig = await ensureAnonymousId(opts.configPath);
    (opts.transport ?? ((): void => {}))({ anonymousId: cfg.anonymousId, event: name });
}
