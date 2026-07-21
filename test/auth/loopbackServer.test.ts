import { describe, it, expect } from 'vitest';
import { bindLoopback, SignInAbortedError, CognitoCallbackError } from '../../src/auth/loopbackServer';

describe('bindLoopback', () => {
    it('resolves the auth code on a valid callback with matching state', async () => {
        const recv = await bindLoopback([0]);
        const codeP = recv.waitForCode('STATE', 5000);
        const res = await fetch(`${recv.redirectUri}?code=AUTHCODE&state=STATE`);
        expect(res.status).toBe(200);
        expect(await codeP).toBe('AUTHCODE');
    });

    it('rejects on state mismatch (CSRF guard)', async () => {
        const recv = await bindLoopback([0]);
        // Attach the rejection expectation BEFORE triggering, so there is no tick where
        // the rejection is unhandled.
        const assertion = expect(recv.waitForCode('EXPECTED', 5000)).rejects.toThrow(/State mismatch/);
        await fetch(`${recv.redirectUri}?code=X&state=WRONG`);
        await assertion;
    });

    it('rejects when Cognito returns an error param', async () => {
        const recv = await bindLoopback([0]);
        const assertion = expect(recv.waitForCode('STATE', 5000)).rejects.toThrow(/access_denied/);
        await fetch(`${recv.redirectUri}?error=access_denied&error_description=nope&state=STATE`);
        await assertion;
    });

    it('classifies the provider-link error as retryable (first social sign-in for an existing user)', async () => {
        const recv = await bindLoopback([0]);
        const p = recv.waitForCode('STATE', 5000).catch((e: unknown) => e);
        const desc = encodeURIComponent('provider linked to existing user');
        await fetch(`${recv.redirectUri}?error=invalid_request&error_description=${desc}&state=STATE`);
        const err = await p;
        expect(err).toBeInstanceOf(CognitoCallbackError);
        expect((err as CognitoCallbackError).isProviderLinkRetry()).toBe(true);
    });

    it('does NOT mark a generic error as retryable', async () => {
        const recv = await bindLoopback([0]);
        const p = recv.waitForCode('STATE', 5000).catch((e: unknown) => e);
        await fetch(`${recv.redirectUri}?error=access_denied&error_description=nope&state=STATE`);
        const err = await p;
        expect(err).toBeInstanceOf(CognitoCallbackError);
        expect((err as CognitoCallbackError).isProviderLinkRetry()).toBe(false);
    });

    it('404s non-/callback paths', async () => {
        const recv = await bindLoopback([0]);
        const res = await fetch(`http://127.0.0.1:${recv.port}/other`);
        expect(res.status).toBe(404);
        recv.close();
    });

    it('times out when no callback arrives', async () => {
        const recv = await bindLoopback([0]);
        await expect(recv.waitForCode('STATE', 50)).rejects.toThrow(/timed out/);
    });

    it('rejects with SignInAbortedError when the signal fires mid-wait (user cancelled)', async () => {
        const recv = await bindLoopback([0]);
        const ac = new AbortController();
        // Long timeout so only the abort can settle it — proves cancel doesn't wait for the timeout.
        const assertion = expect(recv.waitForCode('STATE', 300_000, ac.signal)).rejects.toBeInstanceOf(SignInAbortedError);
        ac.abort();
        await assertion;
    });

    it('rejects immediately when the signal is already aborted', async () => {
        const recv = await bindLoopback([0]);
        const ac = new AbortController();
        ac.abort();
        await expect(recv.waitForCode('STATE', 300_000, ac.signal)).rejects.toBeInstanceOf(SignInAbortedError);
    });
});
