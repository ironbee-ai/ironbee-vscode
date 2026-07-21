import type { TokenSet } from './cognito';

/** Matches vscode.SecretStorage (kept as an interface so this module is host-agnostic/testable). */
export interface SecretStore {
    get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
    store(key: string, value: string): Thenable<void> | Promise<void>;
    delete(key: string): Thenable<void> | Promise<void>;
}

export interface CachedCollectorToken {
    token: string;
    /** Server-side access-token id (for GET /access-tokens/list validation + DELETE). */
    id: string;
}

/**
 * Env-namespaced token storage over SecretStorage (design §6). Cognito tokens and
 * per-account collector tokens are keyed by env so switching environments can't bleed.
 */
export class TokenStore {
    constructor(
        private readonly secrets: SecretStore,
        /** Short env name (e.g. "prod"/"dev") used to namespace keys so envs can't bleed. */
        private readonly env: string,
    ) {}

    private sessionKey(): string {
        return `ironbee.${this.env}.cognito.session`;
    }
    private collectorKey(accountId: string): string {
        return `ironbee.${this.env}.collectorToken.${accountId}`;
    }
    private collectorIndexKey(): string {
        return `ironbee.${this.env}.collectorToken.index`;
    }

    async getSession(): Promise<TokenSet | undefined> {
        return parseJson<TokenSet>(await this.secrets.get(this.sessionKey()));
    }
    async setSession(tokens: TokenSet): Promise<void> {
        await this.secrets.store(this.sessionKey(), JSON.stringify(tokens));
    }
    async clearSession(): Promise<void> {
        await this.secrets.delete(this.sessionKey());
    }

    async getCollectorToken(accountId: string): Promise<CachedCollectorToken | undefined> {
        return parseJson<CachedCollectorToken>(await this.secrets.get(this.collectorKey(accountId)));
    }
    async setCollectorToken(accountId: string, value: CachedCollectorToken): Promise<void> {
        await this.secrets.store(this.collectorKey(accountId), JSON.stringify(value));
        const idx: string[] = await this.listCollectorAccountIds();
        if (!idx.includes(accountId)) {
            idx.push(accountId);
            await this.secrets.store(this.collectorIndexKey(), JSON.stringify(idx));
        }
    }

    async listCollectorAccountIds(): Promise<string[]> {
        return parseJson<string[]>(await this.secrets.get(this.collectorIndexKey())) ?? [];
    }

    /** Remove all env-scoped extension state (sign-out / uninstall). */
    async clearAll(): Promise<void> {
        await this.clearSession();
        for (const accountId of await this.listCollectorAccountIds()) {
            await this.secrets.delete(this.collectorKey(accountId));
        }
        await this.secrets.delete(this.collectorIndexKey());
    }
}

function parseJson<T>(raw: string | undefined): T | undefined {
    if (!raw) {
        return undefined;
    }
    try {
        return JSON.parse(raw) as T;
    } catch {
        return undefined;
    }
}
