import { describe, it, expect } from 'vitest';
import { resolveInstallClients } from '../../src/runtime/clientDetect';

describe('resolveInstallClients', () => {
    it('always targets exactly cursor — never claude/codex, regardless of what exists in the folder', () => {
        expect(resolveInstallClients()).toEqual(['cursor']);
    });
});
