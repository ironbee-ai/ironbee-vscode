import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import * as path from 'node:path';

export type AgentCli = 'cursor-agent' | 'claude' | 'codex';

/**
 * Headless-capable agent CLIs the platform-suggestion can drive, in the CLI's
 * SUGGESTION_PRIORITY order (`[claude, codex, cursor]`). These are SEPARATE installs
 * from the editor and often absent, so detection must be cheap and non-executing.
 */
const PRIORITY: AgentCli[] = ['claude', 'codex', 'cursor-agent'];

/** How each agent runs a one-shot headless prompt. */
export const HEADLESS_INVOCATION: Record<AgentCli, (prompt: string) => string[]> = {
    'cursor-agent': (p: string): string[] => ['-p', p],
    claude: (p: string): string[] => ['-p', p],
    codex: (p: string): string[] => ['exec', p],
};

/** First available agent CLI on PATH (by priority), or null if none. */
export async function detectAgentCli(
    env: NodeJS.ProcessEnv = process.env,
): Promise<AgentCli | null> {
    for (const agent of PRIORITY) {
        if (await onPath(agent, env)) {
            return agent;
        }
    }
    return null;
}

/** Non-executing PATH lookup (avoids running an unauthenticated agent). */
export async function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    const pathVar: string = env.PATH ?? env.Path ?? '';
    const dirs: string[] = pathVar.split(path.delimiter).filter(Boolean);
    const exts: string[] = process.platform === 'win32'
        ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
        : [''];
    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate: string = path.join(dir, bin + ext);
            if (await isExecutableFile(candidate)) {
                return true;
            }
        }
    }
    return false;
}

async function isExecutableFile(p: string): Promise<boolean> {
    try {
        const st: Stats = await fs.stat(p);
        if (!st.isFile()) {
            return false;
        }
        if (process.platform === 'win32') {
            return true;
        }
        await fs.access(p, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
