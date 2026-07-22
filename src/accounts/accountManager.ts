import { ConsoleClient, ConsoleError } from '../console/consoleClient';
import type { Account, AccessTokenRecord, MintedToken } from '../console/consoleClient';
import type { TokenStore, CachedCollectorToken } from '../auth/tokenStore';

export const TOKEN_LABEL_PREFIX: string = 'ironbee-vscode:';

/** Rotate a collector token once it's within this window of its expiry (tokens last ~90 days). */
const TOKEN_ROTATE_SKEW_MS: number = 7 * 24 * 60 * 60 * 1000;

/** Reuse the cached token, rotate it (near/at expiry), or mint fresh (gone/revoked). */
type TokenStatus = 'usable' | 'rotate' | 'gone';

/** Fire-and-forget telemetry sink: product signals + otherwise-swallowed error reporting. */
export interface AccountTelemetry {
  event(name: string, props?: Record<string, unknown>): void;
  error(context: string, err: unknown): void;
}

export interface AccountManagerDeps {
  console: ConsoleClient;
  store: TokenStore;
  collectorUrl: string;
  hostname: string;
  /** Write collector.url + collector.oauthToken to ~/.ironbee/config.json. */
  writeCollector: (url: string, token: string) => Promise<void>;
  /** Force a Cognito token refresh so custom:account_id matches the new active account. */
  refreshSession: () => Promise<void>;
  /** Injectable clock (for expiry checks/tests). */
  now?: () => number;
  /** Optional telemetry (never throws); records rotations/cap-handling + swallowed errors. */
  telemetry?: AccountTelemetry;
}

/**
 * Account switching + collector-token lifecycle (design EXT-3). The switch chain is
 * not committed until the collector token is written; failures roll back, and if a
 * rollback itself fails the local account view is marked DIRTY (must re-fetch before use).
 * Public operations are serialized so overlapping switches can't interleave.
 */
export class AccountManager {
    private dirty: boolean = false;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly deps: AccountManagerDeps) {}

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    isDirty(): boolean {
        return this.dirty;
    }

    /** Serialize public mutating ops so two concurrent switches can't interleave. */
    private serialize<T>(fn: () => Promise<T>): Promise<T> {
        const run: Promise<T> = this.queue.then(fn, fn);
        // Keep the chain alive regardless of this op's outcome.
        this.queue = run.then(
            (): undefined => undefined,
            (): undefined => undefined,
        );
        return run;
    }

    /** After a dirty state, re-sync the session claim and re-fetch the authoritative account. */
    async reconcile(): Promise<string> {
    // Force a refresh first so the id-token claim matches the server, then read the account.
        await this.deps.refreshSession();
        const current: Account = await this.deps.console.currentAccount();
        this.dirty = false;
        return current.id;
    }

    /** switch → refresh → mint → write, with rollback (EXT-3). */
    switchTo(targetAccountId: string): Promise<void> {
        return this.serialize((): Promise<void> => this.doSwitchTo(targetAccountId));
    }

    private async doSwitchTo(targetAccountId: string): Promise<void> {
        if (this.dirty) {
            await this.reconcile();
        }
        const previous: string = (await this.deps.console.currentAccount()).id;
        if (previous === targetAccountId) {
            // Already active server-side, but the local session/token may be stale — refresh the
            // claim before minting/writing so we never act against a stale custom:account_id.
            this.deps.telemetry?.event('account_switch_noop');
            await this.deps.refreshSession();
            await this.doEnsureCollectorToken(targetAccountId);
            return;
        }

        // Step 1 — server-side switch.
        await this.deps.console.switchAccount(targetAccountId);

        // Steps 2-4 — refresh + mint + write; roll back the switch on failure.
        try {
            await this.deps.refreshSession();
            await this.doEnsureCollectorToken(targetAccountId);
        } catch (err) {
            await this.rollback(previous);
            throw err;
        }
    }

    private async rollback(previousAccountId: string): Promise<void> {
        try {
            await this.deps.console.switchAccount(previousAccountId);
            await this.deps.refreshSession();
        } catch (err) {
            // Rollback failed (e.g. dead session). Local view diverges from server —
            // mark dirty so the next operation re-fetches (and re-refreshes) before trusting state.
            this.dirty = true;
            this.deps.telemetry?.error('account-switch-rollback', err);
        }
    }

    ensureCollectorToken(accountId: string): Promise<void> {
        return this.serialize((): Promise<void> => this.doEnsureCollectorToken(accountId));
    }

    /**
   * Ensure a valid collector token for `accountId` and write it to config. Reuse a cached token
   * that's still valid and not near expiry; rotate it (mint fresh + delete the old one) when it's
   * within {@link TOKEN_ROTATE_SKEW_MS} of expiry; mint fresh when it's gone/revoked. Handles the
   * 10/account cap by reclaiming an extension-owned token. Writes config only after a successful mint.
   */
    private async doEnsureCollectorToken(accountId: string): Promise<void> {
        const cached: CachedCollectorToken | undefined = await this.deps.store.getCollectorToken(accountId);
        // Require a non-empty cached token: a poisoned cache ({ token: undefined, id }) whose id is
        // still valid server-side would otherwise pass the check and try to write an empty token.
        if (cached?.token) {
            const status: TokenStatus = await this.tokenStatus(cached.id);
            if (status === 'usable') {
                await this.deps.writeCollector(this.deps.collectorUrl, cached.token);
                return;
            }
            if (status === 'rotate') {
                this.deps.telemetry?.event('collector_token_rotated', { reason: 'near_expiry' });
                // Delete the near-expiry token first so rotations don't pile up toward the 10-cap.
                await this.deps.console
                    .deleteAccessToken(cached.id)
                    .catch((e: unknown): void => this.deps.telemetry?.error('token-rotate-delete-old', e));
            }
        }
        const minted: MintedToken = await this.mintWithCapHandling();
        await this.deps.store.setCollectorToken(accountId, { token: minted.token, id: minted.id });
        await this.deps.writeCollector(this.deps.collectorUrl, minted.token);
    }

    private async tokenStatus(id: string): Promise<TokenStatus> {
        let list: AccessTokenRecord[];
        try {
            list = await this.deps.console.listAccessTokens();
        } catch (err) {
            // Transient list failure — don't force a needless mint; reuse the cached token.
            this.deps.telemetry?.error('token-status-check (reused cached token)', err);
            return 'usable';
        }
        const found: AccessTokenRecord | undefined = list.find((t: AccessTokenRecord): boolean => t.id === id);
        if (!found) {
            return 'gone'; // revoked / no longer on the server
        }
        if (found.expiresAt === undefined) {
            return 'usable'; // no expiry info → existence is enough
        }
        const expiresMs: number = Date.parse(found.expiresAt);
        if (Number.isNaN(expiresMs)) {
            return 'usable'; // unparseable → don't force rotation on bad data
        }
        return expiresMs - this.now() > TOKEN_ROTATE_SKEW_MS ? 'usable' : 'rotate';
    }

    private async mintWithCapHandling(): Promise<{ token: string; id: string }> {
        const label: string = `${TOKEN_LABEL_PREFIX}${this.deps.hostname}`;
        try {
            return await this.deps.console.mintAccessToken(label);
        } catch (err) {
            if (err instanceof ConsoleError && err.status === 409) {
                // At the 10/account cap — reclaim an EXTENSION-OWNED token, then retry once.
                const list: AccessTokenRecord[] = await this.deps.console.listAccessTokens();
                const owned: AccessTokenRecord | undefined = list.find((t: AccessTokenRecord): boolean => t.name.startsWith(TOKEN_LABEL_PREFIX));
                if (!owned) {
                    this.deps.telemetry?.event('token_cap_blocked'); // at cap, nothing of ours to reclaim
                    throw new Error(
                        'This account has reached its 10-token limit and none belong to IronBee for VS Code. ' +
              'Remove an access token from the IronBee console, then try again.',
                    );
                }
                await this.deps.console.deleteAccessToken(owned.id);
                const reminted: MintedToken = await this.deps.console.mintAccessToken(label);
                this.deps.telemetry?.event('token_cap_recovered'); // reclaimed an owned token + re-minted
                return reminted;
            }
            throw err;
        }
    }
}
