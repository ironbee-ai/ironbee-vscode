import { describe, it, expect } from 'vitest';
import { redact } from '../../src/util/redact';

describe('redact', () => {
    it('masks ibt_ collector tokens anywhere', () => {
        expect(redact('found ibt_abcdef123456XYZ done')).toBe('found ibt_*** done');
    });

    it('masks Bearer tokens', () => {
        expect(redact('Authorization: Bearer eyJhbGciOi.payload.sig')).toContain('Bearer ***');
    });

    it('masks JSON secret key values', () => {
        const out = redact('{"oauthToken":"ibt_secretvalue","other":"keep"}');
        expect(out).not.toContain('secretvalue');
        expect(out).toContain('"other":"keep"');
    });

    it('masks refresh_token and id_token values', () => {
        expect(redact('"refresh_token":"abcd1234efgh"')).toContain('***');
        expect(redact('"id_token":"abcd1234efgh"')).toContain('***');
    });

    it('masks JWT-like strings', () => {
        const jwt = 'eyJabc123.eyJdef456.sigXYZ789';
        expect(redact(`tok ${jwt}`)).toContain('eyJ***');
    });

    it('masks password / secret / client_secret values', () => {
        expect(redact('{"password":"hunter2xyz"}')).not.toContain('hunter2xyz');
        expect(redact('client_secret: myS3cretValue')).not.toContain('myS3cretValue');
    });

    it('masks unquoted CLI-flag and kv secret values', () => {
        expect(redact('--apiKey=SuperSecretValue123')).not.toContain('SuperSecretValue123');
        expect(redact("apiKey='SingleQuotedSecret'")).not.toContain('SingleQuotedSecret');
    });

    it('masks auth codes / tokens in URL query strings', () => {
        const out = redact('GET http://127.0.0.1/callback?code=SPLITAUTHCODE12345&state=z');
        expect(out).not.toContain('SPLITAUTHCODE12345');
        expect(out).toContain('state=z');
    });

    it('masks Basic auth', () => {
        expect(redact('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toContain('Basic ***');
    });

    it('leaves ordinary text untouched', () => {
        expect(redact('installing platforms: node, backend')).toBe('installing platforms: node, backend');
    });
});
