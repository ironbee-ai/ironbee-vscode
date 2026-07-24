import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectClients, resolveInstallClients } from '../../src/runtime/clientDetect';

let dir: string;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-detect-'));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('detectClients', () => {
    it('returns empty when no client dirs exist', async () => {
        expect(await detectClients(dir)).toEqual([]);
    });

    it('detects each present client dir', async () => {
        await fs.mkdir(path.join(dir, '.claude'));
        await fs.mkdir(path.join(dir, '.codex'));
        const found = await detectClients(dir);
        expect(found).toContain('claude');
        expect(found).toContain('codex');
        expect(found).not.toContain('cursor');
    });

    it('ignores a same-named file (must be a directory)', async () => {
        await fs.writeFile(path.join(dir, '.cursor'), 'not a dir');
        expect(await detectClients(dir)).toEqual([]);
    });
});

describe('resolveInstallClients', () => {
    it('defaults to cursor when nothing is detected', async () => {
        expect(await resolveInstallClients(dir)).toEqual(['cursor']);
    });

    it('always includes cursor alongside detected clients', async () => {
        await fs.mkdir(path.join(dir, '.claude'));
        expect(await resolveInstallClients(dir)).toEqual(['claude', 'cursor']);
    });

    it('does not duplicate cursor when .cursor already exists', async () => {
        await fs.mkdir(path.join(dir, '.cursor'));
        await fs.mkdir(path.join(dir, '.codex'));
        const clients = await resolveInstallClients(dir);
        expect(clients.filter((c) => c === 'cursor')).toHaveLength(1);
        expect(clients).toContain('codex');
    });
});
