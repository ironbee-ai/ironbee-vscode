import { describe, it, expect, vi } from 'vitest';
import { AuthManager, NotSignedInError, SignInAbortedError } from '../../src/auth/authManager';
import { TokenStore, type SecretStore } from '../../src/auth/tokenStore';
import type { EnvConfig } from '../../src/auth/environments';

const env: EnvConfig = {
    env: 'prod',
    cognitoDomain: 'https://login.ironbee.ai',
    clientId: 'client123',
    consoleApiBase: 'https://console.service.ironbee.ai',
    consoleUrl: 'https://console.ironbee.ai',
    collectorUrl: 'https://collector.service.ironbee.ai',
    scopes: ['openid', 'email', 'profile'],
    loopbackPorts: [0],
};

function mem(): SecretStore {
    const m = new Map<string, string>();
    return { get: async (k) => m.get(k), store: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) };
}

function setup(now = 1_000_000) {
    const store = new TokenStore(mem(), 'prod');
    const fetchFn = vi.fn();
    const openUrl = vi.fn(async () => {});
    const mgr = new AuthManager({ env, store, openUrl, fetchFn: fetchFn as never, now: () => now });
    return { mgr, store, fetchFn, openUrl };
}

describe('getIdToken', () => {
    it('throws NotSignedInError when there is no session', async () => {
        const { mgr } = setup();
        await expect(mgr.getIdToken()).rejects.toBeInstanceOf(NotSignedInError);
    });

    it('returns the stored token when it is fresh', async () => {
        const { mgr, store, fetchFn } = setup(1_000_000);
        await store.setSession({ idToken: 'FRESH', refreshToken: 'R', expiresAt: 1_000_000 + 10 * 60 * 1000 });
        expect(await mgr.getIdToken()).toBe('FRESH');
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('refreshes when near expiry and stores the new token', async () => {
        const { mgr, store, fetchFn } = setup(1_000_000);
        await store.setSession({ idToken: 'OLD', refreshToken: 'R', expiresAt: 1_000_000 + 60 * 1000 }); // < 5 min
        fetchFn.mockResolvedValue(
            new Response(JSON.stringify({ id_token: 'NEW', expires_in: 3600 }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        expect(await mgr.getIdToken()).toBe('NEW');
        expect((await store.getSession())?.idToken).toBe('NEW');
        expect((await store.getSession())?.refreshToken).toBe('R'); // preserved
    });

    it('refreshes on force even when fresh', async () => {
        const { mgr, store, fetchFn } = setup(1_000_000);
        await store.setSession({ idToken: 'OLD', refreshToken: 'R', expiresAt: 1_000_000 + 10 * 60 * 1000 });
        fetchFn.mockResolvedValue(
            new Response(JSON.stringify({ id_token: 'FORCED', expires_in: 3600 }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        expect(await mgr.getIdToken(true)).toBe('FORCED');
    });

    it('force-refresh with NO refresh token returns the still-valid id token (does not throw)', async () => {
        const { mgr, store, fetchFn } = setup(1_000_000);
        await store.setSession({ idToken: 'VALID', expiresAt: 1_000_000 + 10 * 60 * 1000 }); // no refreshToken
        expect(await mgr.getIdToken(true)).toBe('VALID');
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('throws NotSignedIn when expired and there is no refresh token', async () => {
        const { mgr, store } = setup(1_000_000);
        await store.setSession({ idToken: 'OLD', expiresAt: 1_000_000 - 1000 }); // expired, no refreshToken
        await expect(mgr.getIdToken()).rejects.toBeInstanceOf(NotSignedInError);
    });

    it('does NOT clear the session when a refresh fails (transient-safe)', async () => {
        const { mgr, store, fetchFn } = setup(1_000_000);
        await store.setSession({ idToken: 'OLD', refreshToken: 'R', expiresAt: 1_000_000 - 1000 });
        fetchFn.mockRejectedValue(new Error('network'));
        await expect(mgr.getIdToken()).rejects.toThrow('network');
        expect(await store.getSession()).toBeDefined(); // preserved for a later retry
    });
});

describe('signOut', () => {
    it('revokes the refresh token and clears all state', async () => {
        const { mgr, store, fetchFn } = setup();
        await store.setSession({ idToken: 'ID', refreshToken: 'R', expiresAt: 1 });
        await store.setCollectorToken('acc1', { token: 'ibt_1', id: 't1' });
        fetchFn.mockResolvedValue(new Response('', { status: 200 }));
        await mgr.signOut();
        expect(fetchFn).toHaveBeenCalledWith(
            `${env.cognitoDomain}/oauth2/revoke`,
            expect.objectContaining({ method: 'POST' }),
        );
        expect(await store.getSession()).toBeUndefined();
        expect(await store.getCollectorToken('acc1')).toBeUndefined();
    });

    it('still clears local state when revoke fails', async () => {
        const { mgr, store, fetchFn } = setup();
        await store.setSession({ idToken: 'ID', refreshToken: 'R', expiresAt: 1 });
        fetchFn.mockRejectedValue(new Error('network'));
        await mgr.signOut();
        expect(await store.getSession()).toBeUndefined();
    });
});

describe('signIn', () => {
    it('refuses with a clean, user-facing message (no internal task ids) when clientId is unset', async () => {
        const store = new TokenStore(mem(), 'prod');
        const mgr = new AuthManager({ env: { ...env, clientId: '' }, store, openUrl: async () => {} });
        await expect(mgr.signIn(100)).rejects.toThrow(/Cognito client id is not configured/);
        // Must NOT leak internal backend task references to the user.
        await expect(mgr.signIn(100)).rejects.not.toThrow(/BE-1|backend task/);
    });

    it('aborts (SignInAbortedError) when the user declines the open-external prompt', async () => {
        const store = new TokenStore(mem(), 'prod');
        const openUrl = vi.fn(async () => false); // user clicked Cancel on "open external website?"
        const mgr = new AuthManager({ env, store, openUrl, fetchFn: vi.fn() as never });
        await expect(mgr.signIn(5000)).rejects.toBeInstanceOf(SignInAbortedError);
        expect(await store.getSession()).toBeUndefined(); // no session written
    });

    it('aborts immediately when the signal is already aborted (browser never opened)', async () => {
        const store = new TokenStore(mem(), 'prod');
        const openUrl = vi.fn(async () => true);
        const mgr = new AuthManager({ env, store, openUrl, fetchFn: vi.fn() as never });
        const ac = new AbortController();
        ac.abort();
        await expect(mgr.signIn(5000, ac.signal)).rejects.toBeInstanceOf(SignInAbortedError);
        expect(openUrl).not.toHaveBeenCalled();
    });

    it('aborts the loopback wait when the signal fires (cancel button) instead of hanging to timeout', async () => {
        const store = new TokenStore(mem(), 'prod');
        const ac = new AbortController();
        // Abort right as the browser "opens" — waitForCode then rejects promptly, not at the 5s timeout.
        const openUrl = vi.fn(async () => {
            ac.abort();
            return true;
        });
        const mgr = new AuthManager({ env, store, openUrl, fetchFn: vi.fn() as never });
        await expect(mgr.signIn(5000, ac.signal)).rejects.toBeInstanceOf(SignInAbortedError);
    });

    it('retries once automatically on the provider-link error, then succeeds', async () => {
        const store = new TokenStore(mem(), 'prod');
        let attempt = 0;
        // Drive the real loopback: parse redirect_uri/state from the authorize URL and fire the
        // callback AFTER openUrl returns (so waitForCode has registered its pending handler).
        const openUrl = vi.fn(async (url: string) => {
            const u = new URL(url);
            const redirect = u.searchParams.get('redirect_uri')!;
            const state = u.searchParams.get('state')!;
            attempt += 1;
            const target =
                attempt === 1
                    ? `${redirect}?error=invalid_request&error_description=${encodeURIComponent('provider linked to existing user')}&state=${state}`
                    : `${redirect}?code=GOODCODE&state=${state}`;
            setTimeout((): void => void fetch(target), 10);
            return true;
        });
        const fetchFn = vi.fn(
            async () =>
                new Response(JSON.stringify({ id_token: 'ID', refresh_token: 'R', expires_in: 3600 }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const mgr = new AuthManager({ env, store, openUrl, fetchFn: fetchFn as never });
        await mgr.signIn(5000);
        expect(attempt).toBe(2); // first attempt link-cancelled, second succeeded
        expect((await store.getSession())?.idToken).toBe('ID');
    });
});
