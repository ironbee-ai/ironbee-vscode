import { spawn as nodeSpawn } from 'node:child_process';
import { resolveToolPath, hasNpx } from './nodeResolve';

export type PrewarmResult =
  | { ok: true; code: number }
  | { ok: false; reason: 'npx-not-found' | 'failed'; detail?: string };

export interface PrewarmDeps {
  /** Exact npm spec to warm, e.g. "@ironbee-ai/devtools@0.23.0" (from `ironbee devtools version`). */
  spec: string;
  spawn?: typeof nodeSpawn;
  resolvePath?: (opts: { env?: NodeJS.ProcessEnv }) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * Best-effort pre-warm of `@ironbee-ai/devtools` on the user machine (Layer 2): resolve a PATH
 * that can find npx, then `npx -y -p <spec> node --version` — this INSTALLS the package (+ its
 * platform-correct native deps) into the npm cache and exits immediately (never starts the
 * server). PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 because the extension pre-installs Chromium itself.
 *
 * On failure (npx unavailable, etc.) returns a reason and the caller silently falls back — the
 * MCP server's own `npx @ironbee-ai/devtools` at startup installs it later.
 */
export async function prewarmDevtools(deps: PrewarmDeps): Promise<PrewarmResult> {
    const spawn: typeof nodeSpawn = deps.spawn ?? nodeSpawn;
    const baseEnv: NodeJS.ProcessEnv = deps.env ?? process.env;
    const resolve: (opts: { env?: NodeJS.ProcessEnv }) => Promise<string> =
        deps.resolvePath ?? ((o: { env?: NodeJS.ProcessEnv }): Promise<string> => resolveToolPath(o));
    const pathStr: string = await resolve({ env: baseEnv });

    if (!(await hasNpx(pathStr, baseEnv))) {
        deps.log?.('devtools pre-warm skipped: npx not found (will install at MCP startup)');
        return { ok: false, reason: 'npx-not-found' };
    }

    const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        PATH: pathStr,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
        BROWSER_DEVTOOLS_INSTALL_CHROMIUM: 'false',
    };
    const args: string[] = ['--yes', '--package', deps.spec, '--', 'node', '--version'];

    return await new Promise<PrewarmResult>((resolveP: (value: PrewarmResult) => void): void => {
        let settled: boolean = false;
        const finish: (r: PrewarmResult) => void = (r: PrewarmResult): void => {
            if (!settled) {
                settled = true;
                resolveP(r);
            }
        };
        let child: ReturnType<typeof spawn>;
        try {
            // stdio:'ignore' — we only care about the exit code. Crucially this also means the child's
            // stdout/stderr can never fill an undrained OS pipe (~64KB) and deadlock a chatty npm install
            // until the timeout fires.
            child = spawn('npx', args, { env, shell: process.platform === 'win32', stdio: 'ignore' });
        } catch (e) {
            finish({ ok: false, reason: 'failed', detail: (e as Error).message });
            return;
        }
        const timer: NodeJS.Timeout = setTimeout((): void => {
            child.kill('SIGTERM');
            // Escalate if npx ignores SIGTERM, so we don't orphan a long install.
            const kill9: NodeJS.Timeout = setTimeout((): boolean => child.kill('SIGKILL'), 2000);
            kill9.unref?.();
            finish({ ok: false, reason: 'failed', detail: 'timed out' });
        }, deps.timeoutMs ?? 300_000);
        timer.unref?.();
        child.on('error', (e: Error): void => {
            clearTimeout(timer);
            finish({ ok: false, reason: 'failed', detail: e.message });
        });
        child.on('close', (code: number | null): void => {
            clearTimeout(timer);
            finish(code === 0 ? { ok: true, code } : { ok: false, reason: 'failed', detail: `exit ${code}` });
        });
    });
}
