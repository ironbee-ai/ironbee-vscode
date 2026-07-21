import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Thrown when a caller aborts the loopback wait (user cancelled sign-in). */
export class SignInAbortedError extends Error {
    constructor() {
        super('Sign-in cancelled');
        this.name = 'SignInAbortedError';
    }
}

/** Cognito redirected back with an `error` param (carries the raw code + description). */
export class CognitoCallbackError extends Error {
    constructor(
        readonly error: string,
        readonly errorDescription: string,
    ) {
        super(`Cognito returned error: ${error} ${errorDescription}`.trim());
        this.name = 'CognitoCallbackError';
    }

    /**
     * A first social sign-in for an existing user: the trigger links the identity and CANCELS this
     * attempt (`invalid_request … provider linked to existing user`). The next attempt succeeds, so
     * the caller should retry once automatically (per the backend hand-off).
     */
    isProviderLinkRetry(): boolean {
        return /linked to (an )?existing user/i.test(this.errorDescription);
    }
}

export interface LoopbackReceiver {
    /** http://127.0.0.1:<port>/callback — pass as redirect_uri and register on BE-1. */
    redirectUri: string;
    port: number;
    /** Resolve with the auth code once Cognito redirects back; rejects on state mismatch,
     *  error param, timeout, or abort (`signal`). Always tears down the server. */
    waitForCode(expectedState: string, timeoutMs?: number, signal?: AbortSignal): Promise<string>;
    close(): void;
}

const SUCCESS_HTML: string =
  '<!doctype html><meta charset="utf-8"><title>IronBee</title>' +
  '<body style="font-family:system-ui;padding:3rem;text-align:center">' +
  '<h2>✓ Signed in to IronBee</h2><p>You can close this tab and return to your editor.</p></body>';
const FAIL_HTML: string =
  '<!doctype html><meta charset="utf-8"><title>IronBee</title>' +
  '<body style="font-family:system-ui;padding:3rem;text-align:center">' +
  '<h2>Sign-in failed</h2><p>Please return to your editor and try again.</p></body>';

// Bind failures worth trying the next port for (rather than aborting sign-in).
const RETRYABLE_BIND_CODES: Set<string> = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);

/** Bind the first available port from `ports` (Cognito requires exact pre-registered URLs). */
export async function bindLoopback(ports: number[]): Promise<LoopbackReceiver> {
    let lastErr: unknown;
    for (const port of ports) {
        try {
            return await bindOne(port);
        } catch (err) {
            lastErr = err;
            if (!RETRYABLE_BIND_CODES.has((err as NodeJS.ErrnoException).code ?? '')) {
                throw err;
            }
        }
    }
    throw new Error(
        `Could not bind any loopback port (${ports.join(', ')}). Last error: ${(lastErr as Error)?.message}`,
    );
}

function bindOne(port: number): Promise<LoopbackReceiver> {
    return new Promise((resolve: (receiver: LoopbackReceiver) => void, reject: (reason: Error) => void): void => {
        let pending: { resolve: (code: string) => void; reject: (e: Error) => void; state: string } | null = null;
        let serverClosed: boolean = false;
        const closeOnce: () => void = (): void => {
            if (!serverClosed) {
                serverClosed = true;
                server.close();
            }
        };

        const server: http.Server = http.createServer((req: IncomingMessage, res: ServerResponse): void => {
            const url: URL = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
            if (url.pathname !== '/callback') {
                res.writeHead(404).end();
                return;
            }
            const err: string | null = url.searchParams.get('error');
            const code: string | null = url.searchParams.get('code');
            const state: string | null = url.searchParams.get('state');
            const ok: boolean = !!(!err && code && pending && state === pending.state);
            res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(ok ? SUCCESS_HTML : FAIL_HTML);
            if (!pending) {
                return;
            }
            if (err) {
                pending.reject(new CognitoCallbackError(err, url.searchParams.get('error_description') ?? ''));
            } else if (!code) {
                pending.reject(new Error('Callback missing authorization code'));
            } else if (state !== pending.state) {
                pending.reject(new Error('State mismatch — possible CSRF; aborting'));
            } else {
                pending.resolve(code);
            }
            pending = null;
        });

        // Bind-phase error: close the (never-listening) server and reject so the caller
        // can try the next port. Reassigned to a no-op once listening (consumer-phase
        // errors must not settle the already-resolved bind promise).
        let onError: (err: Error) => void = (err: Error): void => {
            closeOnce();
            reject(err);
        };
        server.on('error', (e: Error): void => onError(e));

        server.listen(port, '127.0.0.1', (): void => {
            onError = (): void => {};
            const actualPort: number = (server.address() as AddressInfo).port;
            resolve({
                redirectUri: `http://127.0.0.1:${actualPort}/callback`,
                port: actualPort,
                close: closeOnce,
                waitForCode: (expectedState: string, timeoutMs: number = 300_000, signal?: AbortSignal): Promise<string> =>
                    new Promise<string>((res2: (code: string) => void, rej2: (reason: Error) => void): void => {
                        if (signal?.aborted) {
                            closeOnce();
                            rej2(new SignInAbortedError());
                            return;
                        }
                        const timer: NodeJS.Timeout = setTimeout((): void => {
                            pending = null;
                            closeOnce();
                            rej2(new Error('Sign-in timed out'));
                        }, timeoutMs);
                        const onAbort: () => void = (): void => {
                            clearTimeout(timer);
                            pending = null;
                            closeOnce();
                            rej2(new SignInAbortedError());
                        };
                        signal?.addEventListener('abort', onAbort, { once: true });
                        pending = {
                            state: expectedState,
                            resolve: (c: string): void => {
                                clearTimeout(timer);
                                signal?.removeEventListener('abort', onAbort);
                                closeOnce();
                                res2(c);
                            },
                            reject: (e: Error): void => {
                                clearTimeout(timer);
                                signal?.removeEventListener('abort', onAbort);
                                closeOnce();
                                rej2(e);
                            },
                        };
                    }),
            });
        });
    });
}
