export type AiClient = 'cursor' | 'claude' | 'codex';

/**
 * Which client(s) `ironbee install` should target for a folder.
 *
 * Always exactly **`cursor`** — this is a Cursor extension: it wires up only the editor the user
 * is sitting in and NEVER writes into `.claude`/`.codex`, even when those dirs exist (other
 * tools' setups are left completely untouched). `cursor` is passed EXPLICITLY as
 * `--client cursor`: we must NOT rely on the CLI's own no-detection fallback, whose
 * `REGISTERED_CLIENTS[0]` is `claude`, so an unqualified install would land in `.claude`
 * (design EXT-6).
 */
export function resolveInstallClients(): AiClient[] {
    return ['cursor'];
}
