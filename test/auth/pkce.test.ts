import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import { createPkce, createState } from '../../src/auth/pkce';

const B64URL = /^[A-Za-z0-9_-]+$/;

describe('pkce', () => {
    it('produces a verifier within RFC 7636 length bounds and base64url charset', () => {
        const { verifier } = createPkce();
        expect(verifier.length).toBeGreaterThanOrEqual(43);
        expect(verifier.length).toBeLessThanOrEqual(128);
        expect(verifier).toMatch(B64URL);
    });

    it('challenge is base64url(SHA-256(verifier)) with S256 method', () => {
        const p = createPkce();
        const expected = crypto
            .createHash('sha256')
            .update(p.verifier)
            .digest('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        expect(p.challenge).toBe(expected);
        expect(p.method).toBe('S256');
        expect(p.challenge).toMatch(B64URL);
    });

    it('state is random and distinct per call', () => {
        expect(createState()).not.toBe(createState());
        expect(createState()).toMatch(B64URL);
    });
});
