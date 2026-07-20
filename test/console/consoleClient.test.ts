import { describe, it, expect, vi } from 'vitest';
import { ConsoleClient, ConsoleError } from '../../src/console/consoleClient';

const BASE = 'https://console.service.ironbee.ai';
function json(body: unknown, status = 200): Response {
    // 204/205/304 are null-body statuses — a body would make the Response ctor throw.
    const nullBody = body === undefined || status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('ConsoleClient', () => {
    it('sends Bearer auth and hits the right method/path/body', async () => {
        const fetchFn = vi.fn(async () => json([{ id: 'a', name: 'Acme', role: 'owner' }]));
        const c = new ConsoleClient(BASE, async () => 'ID', fetchFn as never);
        const accounts = await c.listAccounts();
        expect(accounts[0].id).toBe('a');
        const [u, init] = fetchFn.mock.calls[0];
        expect(u).toBe(`${BASE}/accounts/list`);
        expect((init as RequestInit).method).toBe('GET');
        expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer ID' });
    });

    it('POSTs switchAccount with a JSON body', async () => {
        const fetchFn = vi.fn(async () => json(undefined, 204));
        const c = new ConsoleClient(BASE, async () => 'ID', fetchFn as never);
        await c.switchAccount('acc2');
        const [u, init] = fetchFn.mock.calls[0];
        expect(u).toBe(`${BASE}/accounts/switch`);
        expect((init as RequestInit).method).toBe('POST');
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({ accountId: 'acc2' });
    });

    it('unwraps the { data: [...] } list shape from /access-tokens/list', async () => {
        const rows = [{ id: 't1', name: 'ironbee-vscode:host' }];
        const c = new ConsoleClient(BASE, async () => 'ID', vi.fn(async () => json({ data: rows })) as never);
        expect(await c.listAccessTokens()).toEqual(rows);
    });

    it('tolerates a bare-array list shape too', async () => {
        const rows = [{ id: 't2', name: 'x' }];
        const c = new ConsoleClient(BASE, async () => 'ID', vi.fn(async () => json(rows)) as never);
        expect(await c.listAccessTokens()).toEqual(rows);
    });

    it('GETs pending invitations', async () => {
        const invite = {
            invitationId: 'inv1',
            role: 'member',
            expiresAt: '2026-08-01',
            accountName: 'Acme',
            inviterName: 'Ada',
            inviterEmail: 'ada@acme.co',
        };
        const fetchFn = vi.fn(async () => json([invite]));
        const c = new ConsoleClient(BASE, async () => 'ID', fetchFn as never);
        const pending = await c.pendingInvitations();
        expect(pending).toEqual([invite]);
        expect(fetchFn.mock.calls[0][0]).toBe(`${BASE}/invitations/pending`);
    });

    it('refreshes the token once and retries on 401', async () => {
        const fetchFn = vi
            .fn()
            .mockResolvedValueOnce(json({ error: 'unauth' }, 401))
            .mockResolvedValueOnce(json({ id: 'me', email: 'x@y.z' }));
        const getToken = vi.fn(async (force?: boolean) => (force ? 'FRESH' : 'STALE'));
        const c = new ConsoleClient(BASE, getToken, fetchFn as never);
        const me = await c.usersMe();
        expect(me.email).toBe('x@y.z');
        expect(getToken).toHaveBeenCalledWith(false);
        expect(getToken).toHaveBeenCalledWith(true);
        expect((fetchFn.mock.calls[1][1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer FRESH' });
    });

    it('throws ConsoleError with status on failure', async () => {
        const fetchFn = vi.fn(async () => json({ error: { code: 'TOKEN_LIMIT_EXCEEDED' } }, 409));
        const c = new ConsoleClient(BASE, async () => 'ID', fetchFn as never);
        await expect(c.mintAccessToken('label')).rejects.toBeInstanceOf(ConsoleError);
        await c.mintAccessToken('label').catch((e: ConsoleError) => expect(e.status).toBe(409));
    });

    it('exposes the machine-readable error code from the body (for actionable handling)', async () => {
        const c = new ConsoleClient(BASE, async () => 'ID', vi.fn(async () => json({ error: { code: 'USER_NOT_PROVISIONED' } }, 403)) as never);
        const err = await c.currentAccount().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConsoleError);
        expect((err as ConsoleError).status).toBe(403);
        expect((err as ConsoleError).code).toBe('USER_NOT_PROVISIONED');
    });

    it('reads the minted token from `plaintextToken` (the real backend field) with the id', async () => {
    // Real prod/dev response shape: { id, prefix, name, userId, accountId, createdAt, expiresAt, plaintextToken }.
        const fetchFn = vi.fn(async () =>
            json({ id: 'tok1', prefix: 'ibt', name: 'label', plaintextToken: 'ibt_real' }),
        );
        const c = new ConsoleClient(BASE, async () => 'ID', fetchFn as never);
        expect(await c.mintAccessToken('label')).toEqual({ token: 'ibt_real', id: 'tok1' });
    });

    it('tolerates legacy `accessToken` / `token` fields', async () => {
        const c = new ConsoleClient(BASE, async () => 'ID', vi.fn(async () => json({ accessToken: 'ibt_a', id: 'tokA' })) as never);
        expect(await c.mintAccessToken('l')).toEqual({ token: 'ibt_a', id: 'tokA' });
        const c2 = new ConsoleClient(BASE, async () => 'ID', vi.fn(async () => json({ token: 'ibt_b', id: 'tokB' })) as never);
        expect(await c2.mintAccessToken('l')).toEqual({ token: 'ibt_b', id: 'tokB' });
    });

    it('throws (never returns an empty token) when the mint response has no token field', async () => {
    // The exact bug this guards: a 200 with an unexpected shape must NOT silently yield an
    // undefined token that then gets dropped from config.json.
        const fetchFn = vi.fn(async () => json({ id: 'tok3', somethingElse: 1 }));
        const c = new ConsoleClient(BASE, async () => 'ID', fetchFn as never);
        await expect(c.mintAccessToken('label')).rejects.toThrow(/no plaintextToken/);
    });

    it('handles 204 (no content) without parsing', async () => {
        const fetchFn = vi.fn(async () => json(undefined, 204));
        const c = new ConsoleClient(BASE, async () => 'ID', fetchFn as never);
        await expect(c.deleteAccessToken('t1')).resolves.toBeUndefined();
    });

    it('throws (no infinite loop) when the refresh-retry is also 401', async () => {
        const fetchFn = vi
            .fn()
            .mockResolvedValueOnce(json({ e: 1 }, 401))
            .mockResolvedValueOnce(json({ e: 2 }, 401));
        const c = new ConsoleClient(BASE, vi.fn(async () => 'T') as never, fetchFn as never);
        await c.usersMe().catch((e: ConsoleError) => expect(e.status).toBe(401));
        expect(fetchFn).toHaveBeenCalledTimes(2); // exactly one retry, no loop
    });

    it('throws ConsoleError on a non-JSON 200 body (no opaque JSON.parse crash)', async () => {
        const fetchFn = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }));
        const c = new ConsoleClient(BASE, async () => 'ID', fetchFn as never);
        await expect(c.usersMe()).rejects.toBeInstanceOf(ConsoleError);
    });
});
