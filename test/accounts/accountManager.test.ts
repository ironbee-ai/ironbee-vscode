import { describe, it, expect, vi } from 'vitest';
import { AccountManager, TOKEN_LABEL_PREFIX, type AccountManagerDeps } from '../../src/accounts/accountManager';
import { ConsoleError } from '../../src/console/consoleClient';
import { TokenStore, type SecretStore } from '../../src/auth/tokenStore';

function memSecrets(): SecretStore {
    const m = new Map<string, string>();
    return { get: async (k) => m.get(k), store: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) };
}

interface FakeConsole {
  currentAccount: ReturnType<typeof vi.fn>;
  switchAccount: ReturnType<typeof vi.fn>;
  mintAccessToken: ReturnType<typeof vi.fn>;
  listAccessTokens: ReturnType<typeof vi.fn>;
  deleteAccessToken: ReturnType<typeof vi.fn>;
}

function setup(overrides: Partial<FakeConsole> = {}, now: () => number = () => 1_700_000_000_000) {
    const writes: Array<[string, string]> = [];
    const refreshSession = vi.fn(async () => {});
    const console: FakeConsole = {
        currentAccount: vi.fn(async () => ({ id: 'acc1', name: 'One', role: 'owner' })),
        switchAccount: vi.fn(async () => {}),
        mintAccessToken: vi.fn(async () => ({ token: 'ibt_new', id: 'tok_new' })),
        listAccessTokens: vi.fn(async () => []),
        deleteAccessToken: vi.fn(async () => {}),
        ...overrides,
    };
    const store = new TokenStore(memSecrets(), 'prod');
    const deps: AccountManagerDeps = {
        console: console as never,
        store,
        collectorUrl: 'https://collector.x',
        hostname: 'host9',
        writeCollector: async (url, token) => void writes.push([url, token]),
        refreshSession,
        now,
    };
    return { mgr: new AccountManager(deps), console, store, writes, refreshSession };
}

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

describe('ensureCollectorToken', () => {
    it('mints and writes when nothing is cached', async () => {
        const { mgr, console, writes } = setup();
        await mgr.ensureCollectorToken('acc1');
        expect(console.mintAccessToken).toHaveBeenCalledWith(`${TOKEN_LABEL_PREFIX}host9`);
        expect(writes).toEqual([['https://collector.x', 'ibt_new']]);
    });

    it('reuses a cached token that is still valid server-side (no mint)', async () => {
        const { mgr, console, store, writes } = setup({
            listAccessTokens: vi.fn(async () => [{ id: 'tokA', name: `${TOKEN_LABEL_PREFIX}host9` }]),
        });
        await store.setCollectorToken('acc1', { token: 'ibt_cached', id: 'tokA' });
        await mgr.ensureCollectorToken('acc1');
        expect(console.mintAccessToken).not.toHaveBeenCalled();
        expect(writes).toEqual([['https://collector.x', 'ibt_cached']]);
    });

    it('reuses a cached token that is far from expiry (no mint, no delete)', async () => {
        const { mgr, console, store, writes } = setup({
            listAccessTokens: vi.fn(async () => [{ id: 'tokA', name: `${TOKEN_LABEL_PREFIX}host9`, expiresAt: iso(NOW + 30 * DAY) }]),
        });
        await store.setCollectorToken('acc1', { token: 'ibt_cached', id: 'tokA' });
        await mgr.ensureCollectorToken('acc1');
        expect(console.mintAccessToken).not.toHaveBeenCalled();
        expect(console.deleteAccessToken).not.toHaveBeenCalled();
        expect(writes).toEqual([['https://collector.x', 'ibt_cached']]);
    });

    it('rotates a near-expiry cached token: deletes the old one and mints a fresh one', async () => {
        const { mgr, console, store, writes } = setup({
            listAccessTokens: vi.fn(async () => [{ id: 'tokA', name: `${TOKEN_LABEL_PREFIX}host9`, expiresAt: iso(NOW + 2 * DAY) }]),
        });
        await store.setCollectorToken('acc1', { token: 'ibt_old', id: 'tokA' });
        await mgr.ensureCollectorToken('acc1');
        expect(console.deleteAccessToken).toHaveBeenCalledWith('tokA'); // old token removed
        expect(console.mintAccessToken).toHaveBeenCalled();
        expect(writes).toEqual([['https://collector.x', 'ibt_new']]); // fresh token written
        expect((await store.getCollectorToken('acc1'))?.id).toBe('tok_new'); // cache updated
    });

    it('reuses the cached token on a transient list failure (no needless mint)', async () => {
        const { mgr, console, store, writes } = setup({
            listAccessTokens: vi.fn(async () => {
                throw new Error('network');
            }),
        });
        await store.setCollectorToken('acc1', { token: 'ibt_cached', id: 'tokA' });
        await mgr.ensureCollectorToken('acc1');
        expect(console.mintAccessToken).not.toHaveBeenCalled();
        expect(writes).toEqual([['https://collector.x', 'ibt_cached']]);
    });

    it('re-mints when the cached token id is gone server-side', async () => {
        const { mgr, console, store } = setup({ listAccessTokens: vi.fn(async () => []) });
        await store.setCollectorToken('acc1', { token: 'ibt_stale', id: 'goneId' });
        await mgr.ensureCollectorToken('acc1');
        expect(console.mintAccessToken).toHaveBeenCalled();
    });

    it('re-mints when the cache is poisoned (empty token) even if its id is still valid', async () => {
    // Regression: a prior bug cached { token: undefined, id } with a server-valid id. That must
    // NOT be reused (it would write an empty token) — re-mint instead.
        const { mgr, console, store, writes } = setup({
            listAccessTokens: vi.fn(async () => [{ id: 'tokA', name: `${TOKEN_LABEL_PREFIX}host9` }]),
        });
        await store.setCollectorToken('acc1', { token: undefined as unknown as string, id: 'tokA' });
        await mgr.ensureCollectorToken('acc1');
        expect(console.mintAccessToken).toHaveBeenCalled();
        expect(writes).toEqual([['https://collector.x', 'ibt_new']]);
    });

    it('at the 10-cap, deletes an extension-owned token then re-mints', async () => {
        const mint = vi
            .fn()
            .mockRejectedValueOnce(new ConsoleError(409, '/access-tokens', 'TOKEN_LIMIT_EXCEEDED'))
            .mockResolvedValueOnce({ token: 'ibt_after', id: 'tok_after' });
        const { mgr, console } = setup({
            mintAccessToken: mint,
            listAccessTokens: vi.fn(async () => [
                { id: 'foreign', name: 'someone-else' },
                { id: 'mine', name: `${TOKEN_LABEL_PREFIX}oldhost` },
            ]),
        });
        await mgr.ensureCollectorToken('acc1');
        expect(console.deleteAccessToken).toHaveBeenCalledWith('mine');
        expect(mint).toHaveBeenCalledTimes(2);
    });

    it('at the cap with only foreign tokens, throws an actionable error (never deletes foreign)', async () => {
        const mint = vi.fn().mockRejectedValue(new ConsoleError(409, '/access-tokens', 'TOKEN_LIMIT_EXCEEDED'));
        const { mgr, console } = setup({
            mintAccessToken: mint,
            listAccessTokens: vi.fn(async () => [{ id: 'foreign', name: 'someone-else' }]),
        });
        await expect(mgr.ensureCollectorToken('acc1')).rejects.toThrow(/10-token limit/);
        expect(console.deleteAccessToken).not.toHaveBeenCalled();
    });
});

describe('switchTo', () => {
    it('switches, refreshes, mints, writes (happy path)', async () => {
        const { mgr, console, refreshSession, writes } = setup({
            currentAccount: vi.fn(async () => ({ id: 'acc1', name: 'One', role: 'owner' })),
        });
        await mgr.switchTo('acc2');
        expect(console.switchAccount).toHaveBeenCalledWith('acc2');
        expect(refreshSession).toHaveBeenCalled();
        expect(writes.length).toBe(1);
    });

    it('is a no-op switch (only ensures token) when already on the target account', async () => {
        const { mgr, console } = setup();
        await mgr.switchTo('acc1');
        expect(console.switchAccount).not.toHaveBeenCalled();
        expect(console.mintAccessToken).toHaveBeenCalled();
    });

    it('rolls back the server switch when refresh fails', async () => {
        const refreshSession = vi
            .fn()
            .mockRejectedValueOnce(new Error('refresh dead')) // step 2 fails
            .mockResolvedValue(undefined); // rollback refresh ok
        const { mgr, console } = setup();
        // rebuild with our refreshSession
        (mgr as unknown as { deps: AccountManagerDeps }).deps.refreshSession = refreshSession;
        await expect(mgr.switchTo('acc2')).rejects.toThrow('refresh dead');
        // switched to target, then back to previous (acc1)
        expect(console.switchAccount).toHaveBeenNthCalledWith(1, 'acc2');
        expect(console.switchAccount).toHaveBeenNthCalledWith(2, 'acc1');
        expect(mgr.isDirty()).toBe(false);
    });

    it('marks dirty when rollback itself fails', async () => {
        const switchAccount = vi
            .fn()
            .mockResolvedValueOnce(undefined) // switch to acc2 ok
            .mockRejectedValueOnce(new Error('rollback switch failed')); // rollback fails
        const refreshSession = vi.fn().mockRejectedValue(new Error('refresh dead'));
        const { mgr } = setup({ switchAccount });
        (mgr as unknown as { deps: AccountManagerDeps }).deps.refreshSession = refreshSession;
        await expect(mgr.switchTo('acc2')).rejects.toThrow();
        expect(mgr.isDirty()).toBe(true);
    });

    it('surfaces a currentAccount() failure with no server switch or write', async () => {
        const { mgr, console, writes } = setup({
            currentAccount: vi.fn(async () => {
                throw new Error('offline');
            }),
        });
        await expect(mgr.switchTo('acc2')).rejects.toThrow('offline');
        expect(console.switchAccount).not.toHaveBeenCalled();
        expect(writes).toEqual([]);
    });

    it('refreshes the session before minting on the already-active fast path (H1)', async () => {
        const { mgr, refreshSession } = setup();
        await mgr.switchTo('acc1'); // already active
        expect(refreshSession).toHaveBeenCalled();
    });
});

describe('mint ordering + reconcile', () => {
    it('does NOT write config or cache when the mint fails', async () => {
        const { mgr, store, writes } = setup({
            mintAccessToken: vi.fn().mockRejectedValue(new Error('mint boom')),
        });
        await expect(mgr.ensureCollectorToken('acc1')).rejects.toThrow('mint boom');
        expect(writes).toEqual([]);
        expect(await store.getCollectorToken('acc1')).toBeUndefined();
    });

    it('reconcile() re-refreshes the session before reading the account and clears dirty', async () => {
        const { mgr, refreshSession, console } = setup();
        const id = await mgr.reconcile();
        expect(refreshSession).toHaveBeenCalled();
        expect(console.currentAccount).toHaveBeenCalled();
        expect(id).toBe('acc1');
        expect(mgr.isDirty()).toBe(false);
    });
});
