import type { EnvConfig } from './environments';
import type { TokenStore } from './tokenStore';
import type { TokenSet } from './cognito';
import type { Pkce } from './pkce';
import type { LoopbackReceiver } from './loopbackServer';
import { createPkce } from './pkce';
import { createState } from './pkce';
import { bindLoopback, SignInAbortedError, CognitoCallbackError } from './loopbackServer';
export { SignInAbortedError, CognitoCallbackError } from './loopbackServer';
import { buildAuthorizeUrl, exchangeCode, refreshTokens, revokeToken } from './cognito';

export class NotSignedInError extends Error {
    constructor() {
        super('Not signed in to IronBee');
    }
}

const REFRESH_SKEW_MS: number = 5 * 60 * 1000; // refresh when < 5 min to expiry

export interface AuthManagerDeps {
    env: EnvConfig;
    store: TokenStore;
    /** Open the Hosted UI in the user's browser (vscode.env.openExternal). Resolves false when the
     *  user declines the "open external website?" prompt — treated as a cancel. */
    openUrl: (url: string) => Promise<boolean | void>;
    fetchFn?: typeof fetch;
    now?: () => number;
}

/** Owns the Cognito session: PKCE loopback sign-in, refresh, sign-out. */
export class AuthManager {
    constructor(private readonly deps: AuthManagerDeps) {}

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    async isSignedIn(): Promise<boolean> {
        return (await this.deps.store.getSession()) !== undefined;
    }

    /**
   * Full native PKCE + loopback sign-in. Throws on state mismatch / timeout / error, or a
   * `SignInAbortedError` when the user cancels (declines the browser prompt or aborts via `signal`).
   */
    async signIn(timeoutMs: number = 300_000, signal?: AbortSignal): Promise<void> {
        if (!this.deps.env.clientId) {
            throw new Error('IronBee sign-in isn’t available yet — the Cognito client id is not configured.');
        }
        if (signal?.aborted) {
            throw new SignInAbortedError();
        }
        try {
            await this.attemptSignIn(timeoutMs, signal);
        } catch (err) {
            // First social sign-in for an existing user links the identity and cancels that attempt;
            // the second attempt succeeds. Retry once, automatically (per the backend hand-off).
            if (err instanceof CognitoCallbackError && err.isProviderLinkRetry() && !signal?.aborted) {
                await this.attemptSignIn(timeoutMs, signal);
                return;
            }
            throw err;
        }
    }

    private async attemptSignIn(timeoutMs: number, signal?: AbortSignal): Promise<void> {
        const pkce: Pkce = createPkce();
        const state: string = createState();
        const recv: LoopbackReceiver = await bindLoopback(this.deps.env.loopbackPorts);
        try {
            const url: string = buildAuthorizeUrl(this.deps.env, recv.redirectUri, pkce.challenge, state);
            const opened: boolean | void = await this.deps.openUrl(url);
            if (opened === false) {
                throw new SignInAbortedError(); // user declined the "open external website?" prompt
            }
            const code: string = await recv.waitForCode(state, timeoutMs, signal);
            const tokens: TokenSet = await exchangeCode(this.deps.env, code, pkce.verifier, recv.redirectUri, this.deps.fetchFn);
            await this.deps.store.setSession(tokens);
        } finally {
            recv.close();
        }
    }

    /** Current id token, refreshing when near expiry or when `force`. */
    async getIdToken(force: boolean = false): Promise<string> {
        const session: TokenSet | undefined = await this.deps.store.getSession();
        if (!session) {
            throw new NotSignedInError();
        }
        const expired: boolean = this.now() > session.expiresAt - REFRESH_SKEW_MS;
        if (force || expired) {
            if (!session.refreshToken) {
                // No way to refresh. If the id token is still valid, use it (a forced refresh
                // with a usable token shouldn't fail); only re-auth when actually expired.
                if (!expired) {
                    return session.idToken;
                }
                throw new NotSignedInError();
            }
            // Refresh failure (revoked/expired/network) is left to propagate WITHOUT clearing the
            // stored session, so a later retry can succeed after a transient network blip rather
            // than signing the user out.
            const refreshed: TokenSet = await refreshTokens(this.deps.env, session.refreshToken, this.deps.fetchFn);
            await this.deps.store.setSession(refreshed);
            return refreshed.idToken;
        }
        return session.idToken;
    }

    async signOut(): Promise<void> {
        const session: TokenSet | undefined = await this.deps.store.getSession();
        if (session?.refreshToken) {
            // Best-effort — revocation failing must not block local sign-out.
            await revokeToken(this.deps.env, session.refreshToken, this.deps.fetchFn).catch((): void => {});
        }
        await this.deps.store.clearAll();
    }
}
