import { spawn as nodeSpawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AiClient } from './clientDetect';
import { redact } from '../util/redact';

export type VerificationMode = 'assist' | 'enforce' | 'monitor';

export interface InstallRequest {
  folderDir: string;
  client: AiClient;
  mode: VerificationMode;
  platforms: string[];
}

export interface RunnerContext {
  /** Node/Electron binary to run the bundled CLI with (process.execPath). */
  nodePath: string;
  /** Absolute path to the bundled CLI entry (…/node_modules/@ironbee-ai/cli/dist/index.js). */
  cliEntry: string;
  /** Sink for redacted stdout/stderr lines (e.g. an output channel). */
  log?: (line: string) => void;
  /** Injectable spawn for tests. */
  spawn?: typeof nodeSpawn;
  /**
   * Extra env for the spawned CLI. Used to pass `IRONBEE_DEVTOOLS_MCP` so `ironbee install` bakes the
   * bundled devtools entry into THIS project's `.cursor/mcp.json` — a per-project override that never
   * touches the shared global `~/.ironbee/config.json`.
   */
  env?: Record<string, string>;
}

/**
 * Build the non-interactive `ironbee install` argv. Explicit `--client` (never rely
 * on the CLI's claude-first fallback), explicit mode + platforms so no picker fires
 * under a non-TTY spawn (design EXT-5/EXT-6).
 */
export function buildInstallArgs(cliEntry: string, req: InstallRequest): string[] {
    const args: string[] = [
        cliEntry,
        'install',
        req.folderDir,
        '--client',
        req.client,
        '--mode',
        req.mode,
    ];
    if (req.platforms.length > 0) {
        args.push('--platforms', req.platforms.join(','));
    }
    return args;
}

interface LineSink {
    push: (c: Buffer) => void;
    flush: () => void;
}

export interface InstallResult {
  ok: boolean;
  code: number | null;
  configWritten: boolean;
}

/**
 * Run `ironbee install` for one (folder, client). Uses the extension host's own
 * Node via `ELECTRON_RUN_AS_NODE=1`, `shell:false` + arg array (no shell string,
 * no PATH/quoting hazards). Success = exit 0 AND <folder>/.ironbee/config.json exists.
 */
export async function runInstall(ctx: RunnerContext, req: InstallRequest): Promise<InstallResult> {
    const args: string[] = buildInstallArgs(ctx.cliEntry, req);
    const code: number | null = await spawnCli(ctx, args, req.folderDir, 'ironbee install failed to start');
    const configWritten: boolean = await fileExists(path.join(req.folderDir, '.ironbee', 'config.json'));
    return { ok: code === 0 && configWritten, code, configWritten };
}

/** Build the non-interactive `ironbee uninstall` argv: auto-detects installed clients; `--yes` skips the confirm. */
export function buildUninstallArgs(cliEntry: string, folderDir: string): string[] {
    return [cliEntry, 'uninstall', folderDir, '--yes'];
}

export interface UninstallResult {
    ok: boolean;
    code: number | null;
    configRemoved: boolean;
}

/**
 * Run `ironbee uninstall` for a folder (removes IronBee for whatever client(s) are set up there).
 * Success = exit 0. Also reports whether the folder's .ironbee/config.json is now gone.
 */
export async function runUninstall(ctx: RunnerContext, folderDir: string): Promise<UninstallResult> {
    const args: string[] = buildUninstallArgs(ctx.cliEntry, folderDir);
    const code: number | null = await spawnCli(ctx, args, folderDir, 'ironbee uninstall failed to start');
    const configRemoved: boolean = !(await fileExists(path.join(folderDir, '.ironbee', 'config.json')));
    return { ok: code === 0, code, configRemoved };
}

/**
 * Spawn the bundled CLI via the extension host's own Node (`ELECTRON_RUN_AS_NODE=1`, `shell:false`
 * + arg array — no PATH/quoting hazards). A spawn failure (ENOENT etc.) resolves to a null exit
 * code rather than throwing, so one bad run can't reject and abort a whole multi-folder batch.
 */
function spawnCli(ctx: RunnerContext, args: string[], cwd: string, startErrLabel: string): Promise<number | null> {
    const spawn: typeof nodeSpawn = ctx.spawn ?? nodeSpawn;
    const options: SpawnOptions = {
        cwd,
        shell: false,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...ctx.env },
    };
    const stdoutSink: LineSink = lineSink(ctx.log);
    const stderrSink: LineSink = lineSink(ctx.log);
    return new Promise<number | null>((resolve: (value: number | null) => void): void => {
        let settled: boolean = false;
        const finish: (c: number | null) => void = (c: number | null): void => {
            if (settled) {
                return;
            }
            settled = true;
            stdoutSink.flush();
            stderrSink.flush();
            resolve(c);
        };
        const child: ChildProcess = spawn(ctx.nodePath, args, options);
        child.stdout?.on('data', (d: Buffer): void => stdoutSink.push(d));
        child.stderr?.on('data', (d: Buffer): void => stderrSink.push(d));
        child.on('error', (err: Error): void => {
            ctx.log?.(redact(`${startErrLabel}: ${err.message}`));
            finish(null);
        });
        child.on('close', (c: number | null): void => finish(c));
    });
}

/**
 * Buffers stream chunks into whole lines before redacting — so a secret split across
 * two `data` events is rejoined and masked, not leaked. Flush emits any final partial line.
 */
function lineSink(log: ((line: string) => void) | undefined): LineSink {
    let buf: string = '';
    const emit: (line: string) => void = (line: string): void => {
        if (log && line.length > 0) {
            log(redact(line));
        }
    };
    return {
        push: (chunk: Buffer): void => {
            buf += chunk.toString('utf8');
            const parts: string[] = buf.split(/\r?\n/);
            buf = parts.pop() ?? '';
            for (const line of parts) {
                emit(line);
            }
        },
        flush: (): void => {
            emit(buf);
            buf = '';
        },
    };
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}
