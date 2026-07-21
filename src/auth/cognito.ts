import type { EnvConfig } from './environments';

export interface TokenSet {
    idToken: string;
    refreshToken?: string;
    accessToken?: string;
    /** Absolute epoch ms when the id token expires. */
    expiresAt: number;
}

type FetchFn = typeof fetch;

export function buildAuthorizeUrl(
    env: EnvConfig,
    redirectUri: string,
    codeChallenge: string,
    state: string,
): string {
    const u: URL = new URL(`${env.cognitoDomain}/oauth2/authorize`);
    u.searchParams.set('client_id', env.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', env.scopes.join(' '));
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    // Force a fresh login screen instead of silently reusing an existing Cognito session cookie
    // (otherwise the browser signs in with the last account without asking).
    u.searchParams.set('prompt', 'login');
    return u.toString();
}

export async function exchangeCode(
    env: EnvConfig,
    code: string,
    codeVerifier: string,
    redirectUri: string,
    fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
    const body: URLSearchParams = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
    });
    return tokenRequest(env, body, fetchFn);
}

export async function refreshTokens(
    env: EnvConfig,
    refreshToken: string,
    fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
    const body: URLSearchParams = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.clientId,
        refresh_token: refreshToken,
    });
    const set: TokenSet = await tokenRequest(env, body, fetchFn);
    // Cognito refresh responses omit refresh_token; preserve the caller's.
    if (!set.refreshToken) {
        set.refreshToken = refreshToken;
    }
    return set;
}

export async function revokeToken(
    env: EnvConfig,
    refreshToken: string,
    fetchFn: FetchFn = fetch,
): Promise<void> {
    const body: URLSearchParams = new URLSearchParams({ token: refreshToken, client_id: env.clientId });
    await fetchFn(`${env.cognitoDomain}/oauth2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
    });
}

async function tokenRequest(env: EnvConfig, body: URLSearchParams, fetchFn: FetchFn): Promise<TokenSet> {
    const res: Response = await fetchFn(`${env.cognitoDomain}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) {
        throw new Error(`Cognito token endpoint ${res.status}: ${await safeText(res)}`);
    }
    const json: {
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
    } = (await res.json()) as {
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
    };
    if (!json.id_token) {
        throw new Error('Cognito token response missing id_token');
    }
    return {
        idToken: json.id_token,
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
}

async function safeText(res: Response): Promise<string> {
    try {
        return await res.text();
    } catch {
        return '<no body>';
    }
}
