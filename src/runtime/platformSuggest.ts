import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { type AgentCli, HEADLESS_INVOCATION, detectAgentCli } from './agentCli';

export const KNOWN_PLATFORMS: readonly ['browser', 'node', 'backend', 'android', 'terminal'] = ['browser', 'node', 'backend', 'android', 'terminal'] as const;
export type Platform = (typeof KNOWN_PLATFORMS)[number];

export interface SuggestResult {
    /** null when no agent CLI is available/authed → caller must ASK the user (EXT-6). */
    platforms: Platform[] | null;
    agent: AgentCli | null;
}

const PROMPT: (dir: string) => string = (dir: string): string =>
    `You are configuring IronBee verification for the software project at "${dir}". ` +
    `IronBee has these verification platforms: browser (web UI/E2E), node (Node.js apps/libs), ` +
    `backend (HTTP/DB services), android, terminal (CLI tools). ` +
    `Based ONLY on this project's files, reply with a JSON array of the relevant platform ids ` +
    `from that set and nothing else. Example: ["node","backend"]`;

/**
 * LLM-driven platform suggestion via a headless agent CLI (design EXT-6). Best-effort:
 * returns { platforms: null } when no agent CLI is available or it fails — the caller
 * then asks the user. Never throws.
 */
export async function suggestPlatforms(
    folderDir: string,
    opts: {
        spawn?: typeof nodeSpawn;
        timeoutMs?: number;
        detect?: typeof detectAgentCli;
        env?: NodeJS.ProcessEnv;
    } = {},
): Promise<SuggestResult> {
    const detect: typeof detectAgentCli = opts.detect ?? detectAgentCli;
    const agent: AgentCli | null = await detect(opts.env ?? process.env);
    if (!agent) {
        return { platforms: null, agent: null };
    }
    try {
        const output: string = await runHeadless(agent, folderDir, opts.spawn ?? nodeSpawn, opts.timeoutMs ?? 60_000);
        const platforms: Platform[] = parsePlatforms(output);
        return { platforms: platforms.length > 0 ? platforms : null, agent };
    } catch {
    // ENOENT / non-zero exit (e.g. not authed) / timeout → treat as unavailable.
        return { platforms: null, agent };
    }
}

/** Extract a JSON array of known platform ids from noisy model output. */
export function parsePlatforms(output: string): Platform[] {
    const match: RegExpMatchArray | null = output.match(/\[[^[\]]*\]/);
    if (!match) {
        return [];
    }
    let arr: unknown;
    try {
        arr = JSON.parse(match[0]);
    } catch {
        return [];
    }
    if (!Array.isArray(arr)) {
        return [];
    }
    const known: Set<string> = new Set<string>(KNOWN_PLATFORMS);
    const out: Platform[] = [];
    for (const item of arr) {
        if (typeof item === 'string') {
            const id: string = item.trim().toLowerCase();
            if (known.has(id) && !out.includes(id as Platform)) {
                out.push(id as Platform);
            }
        }
    }
    return out;
}

function runHeadless(
    agent: AgentCli,
    folderDir: string,
    spawn: typeof nodeSpawn,
    timeoutMs: number,
): Promise<string> {
    const args: string[] = HEADLESS_INVOCATION[agent](PROMPT(folderDir));
    const MAX_OUT: number = 256 * 1024; // cap accumulated stdout to bound memory on a chatty agent
    return new Promise<string>((resolve: (value: string) => void, reject: (reason?: unknown) => void): void => {
        const child: ChildProcess = spawn(agent, args, { cwd: folderDir, shell: false });
        let out: string = '';
        let done: boolean = false;
        const timer: NodeJS.Timeout = setTimeout((): void => {
            if (!done) {
                done = true;
                child.kill('SIGTERM');
                // Escalate if the agent ignores SIGTERM, so we don't orphan it.
                const kill9: NodeJS.Timeout = setTimeout((): boolean => child.kill('SIGKILL'), 2000);
                kill9.unref?.();
                reject(new Error('platform suggestion timed out'));
            }
        }, timeoutMs);
        // Drain stderr so a chatty agent can't deadlock on a full pipe.
        child.stderr?.on('data', (): void => {});
        child.stdout?.on('data', (d: Buffer): void => {
            if (out.length < MAX_OUT) {
                out += d.toString('utf8');
            }
        });
        child.on('error', (e: Error): void => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                reject(e);
            }
        });
        child.on('close', (code: number | null): void => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve(out);
            } else {
                reject(new Error(`agent exited ${code}`));
            }
        });
    });
}
