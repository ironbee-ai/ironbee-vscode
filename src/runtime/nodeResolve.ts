import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { onPath } from './agentCli';

/**
 * Best-effort resolution of a PATH that can find `node`/`npx` — GUI-launched editor processes
 * often DON'T inherit the shell PATH, so a bare spawn of `npx` fails even when Node is installed.
 * We augment PATH with common install locations (nvm/fnm/volta/homebrew/system) and, on
 * POSIX, the user's login-shell PATH. Never throws; returns the (possibly augmented) PATH.
 */
export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  spawn?: typeof nodeSpawn;
  /** Skip the (slower) login-shell probe. */
  skipShell?: boolean;
  homeDir?: string;
}

export async function resolveToolPath(opts: ResolveOptions = {}): Promise<string> {
    const env: NodeJS.ProcessEnv = opts.env ?? process.env;
    const home: string = opts.homeDir ?? os.homedir();
    const sep: string = path.delimiter;
    const current: string[] = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);

    const extra: string[] = [];
    for (const dir of staticCandidates(home, process.platform, env)) {
        extra.push(dir);
    }
    for (const dir of await dynamicCandidates(home)) {
        extra.push(dir);
    }
    if (!opts.skipShell && process.platform !== 'win32') {
        const shellPath: string[] = await loginShellPath(env, opts.spawn ?? nodeSpawn);
        for (const dir of shellPath) {
            extra.push(dir);
        }
    }

    // Dedupe, preserving current PATH first (user's own resolution wins), then extras.
    const seen: Set<string> = new Set<string>();
    const merged: string[] = [];
    for (const dir of [...current, ...extra]) {
        if (dir && !seen.has(dir)) {
            seen.add(dir);
            merged.push(dir);
        }
    }
    return merged.join(sep);
}

/** True if npx is resolvable given a PATH string. */
export function hasNpx(pathStr: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    return onPath('npx', { ...env, PATH: pathStr });
}

export function staticCandidates(
    home: string,
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    if (platform === 'win32') {
        const pf: string = env.ProgramFiles ?? 'C:\\Program Files';
        const appdata: string = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
        const localappdata: string = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
        return [
            path.join(pf, 'nodejs'),
            path.join(appdata, 'npm'),
            path.join(localappdata, 'Volta', 'bin'),
            path.join(localappdata, 'fnm_multishells'),
        ];
    }
    return [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/bin',
        '/bin',
        path.join(home, '.local', 'bin'),
        path.join(home, '.volta', 'bin'),
    ];
}

/** Enumerate version-manager bin dirs (nvm/fnm) that only exist at runtime. */
async function dynamicCandidates(home: string): Promise<string[]> {
    const out: string[] = [];
    const nvmNode: string = path.join(home, '.nvm', 'versions', 'node');
    for (const v of await listDir(nvmNode)) {
        out.push(path.join(nvmNode, v, 'bin'));
    }
    const fnm: string = path.join(home, '.local', 'share', 'fnm', 'node-versions');
    for (const v of await listDir(fnm)) {
        out.push(path.join(fnm, v, 'installation', 'bin'));
    }
    return out;
}

async function listDir(dir: string): Promise<string[]> {
    try {
        return await fs.readdir(dir);
    } catch {
        return [];
    }
}

/** Best-effort: read PATH from a login shell (captures nvm/asdf shims). Times out fast. */
function loginShellPath(env: NodeJS.ProcessEnv, spawn: typeof nodeSpawn): Promise<string[]> {
    const shell: string = env.SHELL || '/bin/sh';
    return new Promise((resolve: (value: string[]) => void): void => {
        let out: string = '';
        let done: boolean = false;
        const finish: (dirs: string[]) => void = (dirs: string[]): void => {
            if (!done) {
                done = true;
                resolve(dirs);
            }
        };
        try {
            const child: ChildProcess = spawn(shell, ['-lic', 'echo __PATH__=$PATH'], { env });
            const timer: NodeJS.Timeout = setTimeout((): void => {
                child.kill('SIGTERM');
                // Escalate if a wedged rc file makes the shell ignore SIGTERM.
                const kill9: NodeJS.Timeout = setTimeout((): boolean => child.kill('SIGKILL'), 1000);
                kill9.unref?.();
                finish([]);
            }, 3000);
            timer.unref?.();
            // Drain stderr — a noisy login rc (warnings/motd on stderr) would otherwise fill the pipe
            // and hang the shell until the 3s timeout instead of closing promptly.
            child.stderr?.on('data', (): void => {});
            child.stdout?.on('data', (d: Buffer): void => {
                if (out.length < 64 * 1024) {
                    out += d.toString('utf8');
                }
            });
            child.on('error', (): void => finish([]));
            child.on('close', (): void => {
                clearTimeout(timer);
                const m: RegExpMatchArray | null = out.match(/__PATH__=(.*)/);
                finish(m ? m[1].trim().split(path.delimiter).filter(Boolean) : []);
            });
        } catch {
            finish([]);
        }
    });
}
