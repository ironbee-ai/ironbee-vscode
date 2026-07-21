import * as crypto from 'node:crypto';

/** PKCE (RFC 7636) + CSRF state helpers for the loopback authorization-code flow. */

export interface Pkce {
    verifier: string;
    challenge: string;
    method: 'S256';
}

function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkce(): Pkce {
    const verifier: string = base64url(crypto.randomBytes(64)); // 86 chars, within 43–128
    const challenge: string = base64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge, method: 'S256' };
}

export function createState(): string {
    return base64url(crypto.randomBytes(32));
}
