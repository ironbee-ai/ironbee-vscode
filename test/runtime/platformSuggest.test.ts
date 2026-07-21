import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { parsePlatforms, suggestPlatforms } from '../../src/runtime/platformSuggest';

describe('parsePlatforms', () => {
    it('extracts a clean JSON array', () => {
        expect(parsePlatforms('["node","backend"]')).toEqual(['node', 'backend']);
    });

    it('extracts an array from noisy prose', () => {
        expect(parsePlatforms('Sure! Here you go:\n["browser", "node"]\nHope that helps')).toEqual([
            'browser', 'node',
        ]);
    });

    it('drops unknown platform ids and de-dupes, normalizing case', () => {
        expect(parsePlatforms('["Node","node","frontend","backend"]')).toEqual(['node', 'backend']);
    });

    it('returns [] when there is no array or it is not string items', () => {
        expect(parsePlatforms('no array here')).toEqual([]);
        expect(parsePlatforms('[1,2,3]')).toEqual([]);
    });
});

function fakeSpawn(exitCode: number, stdout: string) {
    return (() => {
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
            child.stdout.emit('data', Buffer.from(stdout));
            child.emit('close', exitCode);
        });
        return child;
    }) as never;
}

describe('suggestPlatforms', () => {
    it('returns null (ask the user) when no agent CLI is available', async () => {
        const res = await suggestPlatforms('/proj', { detect: async () => null });
        expect(res.platforms).toBeNull();
        expect(res.agent).toBeNull();
    });

    it('returns parsed platforms when an agent succeeds', async () => {
        const res = await suggestPlatforms('/proj', {
            detect: async () => 'cursor-agent',
            spawn: fakeSpawn(0, '["node","backend"]'),
        });
        expect(res.platforms).toEqual(['node', 'backend']);
        expect(res.agent).toBe('cursor-agent');
    });

    it('returns null when the agent fails (e.g. not authed)', async () => {
        const res = await suggestPlatforms('/proj', {
            detect: async () => 'claude',
            spawn: fakeSpawn(1, ''),
        });
        expect(res.platforms).toBeNull();
    });

    it('returns null when the agent produces no usable platforms', async () => {
        const res = await suggestPlatforms('/proj', {
            detect: async () => 'codex',
            spawn: fakeSpawn(0, 'I could not determine platforms'),
        });
        expect(res.platforms).toBeNull();
    });
});
