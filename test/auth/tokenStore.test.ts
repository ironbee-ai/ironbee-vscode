import { describe, it, expect } from 'vitest';
import { TokenStore, type SecretStore } from '../../src/auth/tokenStore';

function memStore(): SecretStore {
    const m = new Map<string, string>();
    return {
        get: async (k) => m.get(k),
        store: async (k, v) => void m.set(k, v),
        delete: async (k) => void m.delete(k),
    };
}

describe('TokenStore', () => {
    it('round-trips a session', async () => {
        const s = new TokenStore(memStore(), 'prod');
        await s.setSession({ idToken: 'id', refreshToken: 'r', expiresAt: 123 });
        expect(await s.getSession()).toEqual({ idToken: 'id', refreshToken: 'r', expiresAt: 123 });
        await s.clearSession();
        expect(await s.getSession()).toBeUndefined();
    });

    it('namespaces keys by environment (no cross-env bleed)', async () => {
        const backing = memStore();
        const prod = new TokenStore(backing, 'prod');
        const dev = new TokenStore(backing, 'dev');
        await prod.setSession({ idToken: 'P', expiresAt: 1 });
        expect(await dev.getSession()).toBeUndefined();
        expect((await prod.getSession())?.idToken).toBe('P');
    });

    it('tracks collector tokens per account with an index', async () => {
        const s = new TokenStore(memStore(), 'prod');
        await s.setCollectorToken('acc1', { token: 'ibt_1', id: 't1' });
        await s.setCollectorToken('acc2', { token: 'ibt_2', id: 't2' });
        expect(await s.getCollectorToken('acc1')).toEqual({ token: 'ibt_1', id: 't1' });
        expect((await s.listCollectorAccountIds()).sort()).toEqual(['acc1', 'acc2']);
    });

    it('clearAll removes session and all collector tokens', async () => {
        const s = new TokenStore(memStore(), 'prod');
        await s.setSession({ idToken: 'id', expiresAt: 1 });
        await s.setCollectorToken('acc1', { token: 'ibt_1', id: 't1' });
        await s.clearAll();
        expect(await s.getSession()).toBeUndefined();
        expect(await s.getCollectorToken('acc1')).toBeUndefined();
        expect(await s.listCollectorAccountIds()).toEqual([]);
    });
});
