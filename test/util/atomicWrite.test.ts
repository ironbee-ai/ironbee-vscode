import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteFile } from '../../src/util/atomicWrite';

let dir: string;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-atomic-'));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
    it('writes content and creates parent dirs', async () => {
        const p = path.join(dir, 'a', 'b', 'file.json');
        await atomicWriteFile(p, '{"x":1}');
        expect(await fs.readFile(p, 'utf8')).toBe('{"x":1}');
    });

    it('overwrites an existing file atomically', async () => {
        const p = path.join(dir, 'file.txt');
        await atomicWriteFile(p, 'first');
        await atomicWriteFile(p, 'second');
        expect(await fs.readFile(p, 'utf8')).toBe('second');
    });

    it('applies restrictive modes on POSIX', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const p = path.join(dir, 'secret', 'config.json');
        await atomicWriteFile(p, 'x');
        expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.dirname(p))).mode & 0o777).toBe(0o700);
    });

    it('leaves no leftover temp files', async () => {
        const p = path.join(dir, 'file.txt');
        await atomicWriteFile(p, 'x');
        const entries = await fs.readdir(dir);
        expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
        expect(entries).toContain('file.txt');
    });
});
