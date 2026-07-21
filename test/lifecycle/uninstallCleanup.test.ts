import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    clearCollectorTokenFromGlobalConfig,
    isRealUninstall,
    type UninstallProbe,
} from '../../src/lifecycle/uninstallCleanup';

const PREFIX = 'ironbee-ai.ironbee-vscode-';
const OURS = '/ext/ironbee-ai.ironbee-vscode-0.1.0';

function probe(obsolete: Record<string, boolean> | null, siblings: string[]): UninstallProbe {
    return {
        extensionPath: OURS,
        readObsolete: () => obsolete,
        listSiblings: () => siblings,
        extensionIdPrefix: PREFIX,
    };
}

describe('isRealUninstall', () => {
    it('false on a normal reload/shutdown (our folder not in .obsolete)', () => {
        expect(isRealUninstall(probe({}, ['ironbee-ai.ironbee-vscode-0.1.0']))).toBe(false);
    });

    it('false when .obsolete is unreadable/absent (cannot confirm removal)', () => {
        expect(isRealUninstall(probe(null, ['ironbee-ai.ironbee-vscode-0.1.0']))).toBe(false);
    });

    it('true on a real uninstall (our folder obsolete, no other version left)', () => {
        expect(
            isRealUninstall(probe({ 'ironbee-ai.ironbee-vscode-0.1.0': true }, ['ironbee-ai.ironbee-vscode-0.1.0'])),
        ).toBe(true);
    });

    it('false on an UPDATE (our folder obsolete, but a newer non-obsolete version is installed)', () => {
        expect(
            isRealUninstall(
                probe({ 'ironbee-ai.ironbee-vscode-0.1.0': true }, [
                    'ironbee-ai.ironbee-vscode-0.1.0',
                    'ironbee-ai.ironbee-vscode-0.2.0', // new version, not obsolete → update
                ]),
            ),
        ).toBe(false);
    });

    it('true when every version present is obsolete (full removal)', () => {
        expect(
            isRealUninstall(
                probe(
                    { 'ironbee-ai.ironbee-vscode-0.1.0': true, 'ironbee-ai.ironbee-vscode-0.2.0': true },
                    ['ironbee-ai.ironbee-vscode-0.1.0', 'ironbee-ai.ironbee-vscode-0.2.0'],
                ),
            ),
        ).toBe(true);
    });

    it('ignores unrelated extensions in the same dir', () => {
        expect(
            isRealUninstall(
                probe({ 'ironbee-ai.ironbee-vscode-0.1.0': true }, [
                    'ironbee-ai.ironbee-vscode-0.1.0',
                    'some.other-extension-1.0.0', // not ours → does not count as a live version
                ]),
            ),
        ).toBe(true);
    });
});

describe('clearCollectorTokenFromGlobalConfig', () => {
    let dir: string;
    let cfgPath: string;
    beforeEach(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ib-unc-'));
        cfgPath = path.join(dir, 'config.json');
    });
    afterEach(async () => {
        await fsp.rm(dir, { recursive: true, force: true });
    });

    it('removes only collector.oauthToken, keeping url + other blocks intact', async () => {
        await fsp.writeFile(
            cfgPath,
            JSON.stringify({
                collector: { url: 'https://c', oauthToken: 'ibt_x', apiKey: 'k' },
                console: { url: 'https://console' },
            }),
        );
        clearCollectorTokenFromGlobalConfig(cfgPath);
        const cfg = JSON.parse(await fsp.readFile(cfgPath, 'utf8'));
        expect(cfg.collector.oauthToken).toBeUndefined(); // removed
        expect(cfg.collector.url).toBe('https://c'); // kept
        expect(cfg.collector.apiKey).toBe('k'); // not ours — kept
        expect(cfg.console.url).toBe('https://console'); // unrelated block kept
    });

    it('no-ops when there is no token / no file (never throws)', async () => {
        clearCollectorTokenFromGlobalConfig(path.join(dir, 'missing.json')); // absent
        await fsp.writeFile(cfgPath, JSON.stringify({ collector: { url: 'https://c' } }));
        clearCollectorTokenFromGlobalConfig(cfgPath); // no oauthToken
        const cfg = JSON.parse(await fsp.readFile(cfgPath, 'utf8'));
        expect(cfg.collector.url).toBe('https://c');
    });
});
