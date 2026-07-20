export interface Account {
    id: string;
    name: string | null;
    role: 'owner' | 'admin' | 'member' | 'billing_admin';
    active?: boolean;
    onboarded?: boolean;
}

export interface AccessTokenRecord {
    id: string;
    name: string;
    /** ISO timestamp when the token expires (used to rotate before the ~90-day expiry). */
    expiresAt?: string;
}

export interface MintedToken {
    /** Plaintext `ibt_…` — returned once. */
    token: string;
    id: string;
}

/** A pending team invitation for the signed-in user (GET /invitations/pending). */
export interface PendingInvitation {
    invitationId: string;
    role: string;
    expiresAt: string;
    accountName: string;
    inviterName: string;
    inviterEmail: string;
}

type FetchFn = typeof fetch;

/** Provides a Cognito id token; `force` requests a refresh (used on 401). */
export type TokenProvider = (force?: boolean) => Promise<string>;

/** Console REST API client (console.service.ironbee.<env>). Auto-refresh once on 401. */
export class ConsoleClient {
    constructor(
        private readonly apiBase: string,
        private readonly getToken: TokenProvider,
        private readonly fetchFn: FetchFn = fetch,
    ) {}

    usersMe(): Promise<{ id: string; email: string }> {
        return this.req('GET', '/users/me');
    }
    listAccounts(): Promise<Account[]> {
        return this.req('GET', '/accounts/list');
    }
    currentAccount(): Promise<Account> {
        return this.req('GET', '/accounts/current');
    }
    switchAccount(accountId: string): Promise<void> {
        return this.req('POST', '/accounts/switch', { accountId });
    }
    pendingInvitations(): Promise<PendingInvitation[]> {
        return this.req('GET', '/invitations/pending');
    }
    mintAccessToken(name: string, expiresInDays?: number): Promise<MintedToken> {
        return this.req<Record<string, unknown>>('POST', '/access-tokens', { name, expiresInDays }).then((r: Record<string, unknown>): MintedToken => {
            // The backend returns the plaintext token as `plaintextToken` (returned once, at creation);
            // tolerate `accessToken`/`token` too. Throw loudly if absent so we never silently write an
            // undefined oauthToken (which JSON.stringify would drop — leaving collector.url but no token).
            const token: string | undefined = (r?.plaintextToken ?? r?.accessToken ?? r?.token) as string | undefined;
            const id: string | undefined = (r?.id ?? r?.tokenId ?? r?.accessTokenId) as string | undefined;
            if (!token) {
                throw new ConsoleError(
                    200,
                    '/access-tokens',
                    `mint response has no plaintextToken (keys: ${Object.keys(r ?? {}).join(', ')})`,
                );
            }
            return { token, id: id ?? '' };
        });
    }
    listAccessTokens(): Promise<AccessTokenRecord[]> {
        // The backend wraps the list as `{ data: [...] }`; tolerate a bare array too.
        return this.req<{ data?: AccessTokenRecord[] } | AccessTokenRecord[]>('GET', '/access-tokens/list').then(
            (r: { data?: AccessTokenRecord[] } | AccessTokenRecord[]): AccessTokenRecord[] =>
                Array.isArray(r) ? r : (r?.data ?? []),
        );
    }
    deleteAccessToken(id: string): Promise<void> {
        return this.req('DELETE', `/access-tokens/${encodeURIComponent(id)}`);
    }

    private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
        let res: Response = await this.send(method, path, await this.getToken(false), body);
        if (res.status === 401) {
            // One refresh-and-retry.
            res = await this.send(method, path, await this.getToken(true), body);
        }
        if (!res.ok) {
            throw new ConsoleError(res.status, path, await safeText(res));
        }
        if (res.status === 204 || res.status === 205) {
            return undefined as T;
        }
        const text: string = await res.text();
        if (!text) {
            return undefined as T;
        }
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new ConsoleError(res.status, path, `non-JSON response body: ${text.slice(0, 200)}`);
        }
    }

    private send(method: string, path: string, token: string, body?: unknown): Promise<Response> {
        return this.fetchFn(`${this.apiBase}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    }
}

export class ConsoleError extends Error {
    /** Machine-readable error code from the body (e.g. USER_NOT_PROVISIONED), if any. */
    readonly code: string | undefined;

    constructor(
        public readonly status: number,
        public readonly path: string,
        public readonly bodyText: string,
    ) {
        super(`Console API HTTP ${status} on ${path}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
        this.name = 'ConsoleError';
        this.code = parseErrorCode(bodyText);
    }
}

/** Extract `{ error: { code } }` or `{ code }` from a JSON error body. */
function parseErrorCode(bodyText: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(bodyText);
        const obj: Record<string, unknown> = (parsed ?? {}) as Record<string, unknown>;
        const nested: Record<string, unknown> = (obj.error ?? {}) as Record<string, unknown>;
        const code: unknown = nested.code ?? obj.code;
        return typeof code === 'string' ? code : undefined;
    } catch {
        return undefined;
    }
}

async function safeText(res: Response): Promise<string> {
    try {
        return await res.text();
    } catch {
        return '<no body>';
    }
}
