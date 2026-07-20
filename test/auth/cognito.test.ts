import { describe, it, expect, vi } from 'vitest';
import { buildAuthorizeUrl, exchangeCode, refreshTokens, revokeToken } from '../../src/auth/cognito';
import type { EnvConfig } from '../../src/auth/environments';

const env: EnvConfig = {
    cognitoDomain: 'https://ironbee-prod.auth.us-west-2.amazoncognito.com',
    clientId: 'client123',
    consoleApiBase: 'https://console.service.ironbee.ai',
    collectorUrl: 'https://collector.service.ironbee.ai',
    scopes: ['openid', 'email', 'profile'],
    loopbackPorts: [53187],
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('buildAuthorizeUrl', () => {
    it('includes client_id, PKCE challenge, scopes, redirect, and state', () => {
        const url = new URL(buildAuthorizeUrl(env, 'http://127.0.0.1:53187/callback', 'CHAL', 'STATE'));
        expect(url.origin + url.pathname).toBe(`${env.cognitoDomain}/oauth2/authorize`);
        expect(url.searchParams.get('client_id')).toBe('client123');
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('scope')).toBe('openid email profile');
        expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53187/callback');
        expect(url.searchParams.get('state')).toBe('STATE');
        expect(url.searchParams.get('code_challenge')).toBe('CHAL');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });
});

describe('exchangeCode', () => {
    it('POSTs the code+verifier and returns a TokenSet with expiresAt', async () => {
        const fetchFn = vi.fn(async () =>
            jsonResponse({ id_token: 'ID', refresh_token: 'R', access_token: 'A', expires_in: 100 }),
        );
        const before = Date.now();
        const tokens = await exchangeCode(env, 'CODE', 'VERIFIER', 'http://127.0.0.1:53187/callback', fetchFn as never);
        expect(tokens.idToken).toBe('ID');
        expect(tokens.refreshToken).toBe('R');
        expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 100_000);
        const [u, init] = fetchFn.mock.calls[0];
        expect(u).toBe(`${env.cognitoDomain}/oauth2/token`);
        const body = (init as RequestInit).body as URLSearchParams;
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code_verifier')).toBe('VERIFIER');
    });

    it('throws on a non-ok token response', async () => {
        const fetchFn = vi.fn(async () => new Response('bad', { status: 400 }));
        await expect(exchangeCode(env, 'C', 'V', 'r', fetchFn as never)).rejects.toThrow(/400/);
    });

    it('throws when id_token is missing', async () => {
        const fetchFn = vi.fn(async () => jsonResponse({ access_token: 'A' }));
        await expect(exchangeCode(env, 'C', 'V', 'r', fetchFn as never)).rejects.toThrow(/id_token/);
    });
});

describe('refreshTokens', () => {
    it('preserves the caller refresh token when the response omits it', async () => {
        const fetchFn = vi.fn(async () => jsonResponse({ id_token: 'ID2', expires_in: 100 }));
        const tokens = await refreshTokens(env, 'ORIG_REFRESH', fetchFn as never);
        expect(tokens.idToken).toBe('ID2');
        expect(tokens.refreshToken).toBe('ORIG_REFRESH');
    });
});

describe('revokeToken', () => {
    it('POSTs the refresh token to /oauth2/revoke', async () => {
        const fetchFn = vi.fn(async () => new Response('', { status: 200 }));
        await revokeToken(env, 'R', fetchFn as never);
        const [u, init] = fetchFn.mock.calls[0];
        expect(u).toBe(`${env.cognitoDomain}/oauth2/revoke`);
        expect(((init as RequestInit).body as URLSearchParams).get('token')).toBe('R');
    });
});
