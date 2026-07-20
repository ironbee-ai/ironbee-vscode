import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPath, detectAgentCli } from '../../src/runtime/agentCli';

let dir: string;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-agent-'));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

async function makeExecutable(name: string): Promise<void> {
    const p = path.join(dir, name);
    await fs.writeFile(p, '#!/bin/sh\n');
    if (process.platform !== 'win32') {
        await fs.chmod(p, 0o755);
    }
}

describe('onPath', () => {
    it('finds an executable in a PATH dir', async () => {
        await makeExecutable(process.platform === 'win32' ? 'claude.EXE' : 'claude');
        expect(await onPath('claude', { PATH: dir, PATHEXT: '.EXE' })).toBe(true);
    });

    it('returns false when the binary is absent', async () => {
        expect(await onPath('nonesuch', { PATH: dir })).toBe(false);
    });
});

describe('detectAgentCli', () => {
    it('returns null when none are present', async () => {
        expect(await detectAgentCli({ PATH: dir })).toBeNull();
    });

    it('prefers claude over codex/cursor-agent (SUGGESTION_PRIORITY)', async () => {
        await makeExecutable(process.platform === 'win32' ? 'claude.EXE' : 'claude');
        await makeExecutable(process.platform === 'win32' ? 'cursor-agent.EXE' : 'cursor-agent');
        expect(await detectAgentCli({ PATH: dir, PATHEXT: '.EXE' })).toBe('claude');
    });

    it('falls back to cursor-agent when only it is present', async () => {
        await makeExecutable(process.platform === 'win32' ? 'cursor-agent.EXE' : 'cursor-agent');
        expect(await detectAgentCli({ PATH: dir, PATHEXT: '.EXE' })).toBe('cursor-agent');
    });
});
