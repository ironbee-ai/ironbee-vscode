import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    readGlobalConfig,
    writeCollectorToken,
    writeDevtoolsEnv,
    writeDevtoolsMcp,
    writeEnvironmentEndpoints,
    writePrivacyMode,
    hasCollectorToken,
    clearCollectorToken,
    hasLocalCollectorToken,
} from '../../src/config/ironbeeConfig';

let dir: string;
let cfgPath: string;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-cfg-'));
    cfgPath = path.join(dir, '.ironbee', 'config.json');
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('readGlobalConfig', () => {
    it('returns {} when file is missing', async () => {
        expect(await readGlobalConfig(cfgPath)).toEqual({});
    });

    it('throws on malformed JSON (never silently clobbers)', async () => {
        await fs.mkdir(path.dirname(cfgPath), { recursive: true });
        await fs.writeFile(cfgPath, '{not json');
        await expect(readGlobalConfig(cfgPath)).rejects.toThrow();
    });
});

describe('writeEnvironmentEndpoints', () => {
    it('creates the file and sets console.url + collector.url', async () => {
        await writeEnvironmentEndpoints(
            { consoleUrl: 'https://console.ironbee.dev', collectorUrl: 'https://collector.service.ironbee.dev' },
            cfgPath,
        );
        const cfg = await readGlobalConfig(cfgPath);
        expect(cfg.console?.url).toBe('https://console.ironbee.dev');
        expect(cfg.collector?.url).toBe('https://collector.service.ironbee.dev');
    });

    it('preserves an existing collector.oauthToken (only touches the two url keys)', async () => {
        await fs.mkdir(path.dirname(cfgPath), { recursive: true });
        await fs.writeFile(
            cfgPath,
            JSON.stringify({ collector: { oauthToken: 'ibt_keep', url: 'https://old' }, verification: { enable: true } }),
        );
        await writeEnvironmentEndpoints(
            { consoleUrl: 'https://console.ironbee.ai', collectorUrl: 'https://collector.service.ironbee.ai' },
            cfgPath,
        );
        const cfg = await readGlobalConfig(cfgPath);
        expect(cfg.collector?.oauthToken).toBe('ibt_keep'); // untouched
        expect(cfg.collector?.url).toBe('https://collector.service.ironbee.ai'); // updated
        expect(cfg.console?.url).toBe('https://console.ironbee.ai');
        expect(cfg.verification).toEqual({ enable: true }); // unrelated block preserved
    });
});

describe('writePrivacyMode', () => {
    it('sets privacy.enable=true when enabled, creating the file', async () => {
        await writePrivacyMode(true, cfgPath);
        expect((await readGlobalConfig(cfgPath)).privacy?.enable).toBe(true);
    });

    it('removes privacy.enable when disabled (does not write false), preserving siblings', async () => {
        await fs.mkdir(path.dirname(cfgPath), { recursive: true });
        await fs.writeFile(cfgPath, JSON.stringify({ privacy: { enable: true, other: 1 }, collector: { url: 'u' } }));
        await writePrivacyMode(false, cfgPath);
        const cfg = await readGlobalConfig(cfgPath);
        expect(cfg.privacy?.enable).toBeUndefined();
        expect(cfg.privacy?.other).toBe(1); // unrelated privacy key kept
        expect(cfg.collector?.url).toBe('u'); // unrelated block kept
    });

    it('no-ops (no file created) when disabling and nothing was set', async () => {
        await writePrivacyMode(false, cfgPath);
        await expect(fs.access(cfgPath)).rejects.toThrow(); // file was never written
    });
});

describe('writeCollectorToken', () => {
    it('writes url + oauthToken and removes a stale apiKey, preserving unrelated keys', async () => {
        await fs.mkdir(path.dirname(cfgPath), { recursive: true });
        await fs.writeFile(
            cfgPath,
            JSON.stringify({ collector: { apiKey: 'old', extra: 1 }, verification: { enable: true } }),
        );
        await writeCollectorToken('https://collector.x', 'ibt_new', cfgPath);
        const cfg = await readGlobalConfig(cfgPath);
        expect(cfg.collector?.oauthToken).toBe('ibt_new');
        expect(cfg.collector?.url).toBe('https://collector.x');
        expect(cfg.collector?.apiKey).toBeUndefined();
        expect(cfg.collector?.extra).toBe(1);
        expect(cfg.verification).toEqual({ enable: true });
    });

    it('refuses to write an empty token (would be silently dropped by JSON.stringify)', async () => {
        await expect(writeCollectorToken('https://c', '', cfgPath)).rejects.toThrow(/empty collector\.oauthToken/);
    });

    it('creates the file when missing', async () => {
        await writeCollectorToken('https://c', 'ibt_x', cfgPath);
        expect((await readGlobalConfig(cfgPath)).collector?.oauthToken).toBe('ibt_x');
    });

    it('writes config.json with 0600 permissions', async () => {
        await writeCollectorToken('https://c', 'ibt_x', cfgPath);
        const mode = (await fs.stat(cfgPath)).mode & 0o777;
        // Windows does not enforce POSIX modes; assert only on POSIX.
        if (process.platform !== 'win32') {
            expect(mode).toBe(0o600);
        }
    });
});

describe('writeDevtoolsEnv', () => {
    it('merges ironbeeDevTools.env, preserving collector and existing env keys', async () => {
        await writeCollectorToken('https://c', 'ibt_x', cfgPath);
        await writeDevtoolsEnv({ KEEP: 'a' }, cfgPath);
        await writeDevtoolsEnv({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', BROWSER_DEVTOOLS_INSTALL_CHROMIUM: 'false' }, cfgPath);
        const cfg = await readGlobalConfig(cfgPath);
        expect(cfg.ironbeeDevTools?.env).toEqual({
            KEEP: 'a',
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
            BROWSER_DEVTOOLS_INSTALL_CHROMIUM: 'false',
        });
        expect(cfg.collector?.oauthToken).toBe('ibt_x');
    });
});

describe('writeDevtoolsMcp', () => {
    it('sets the full mcp override (bundled devtools) preserving collector', async () => {
        await writeCollectorToken('https://c', 'ibt_x', cfgPath);
        await writeDevtoolsMcp(
            { command: '/node', args: ['/gs/devtools/dist/index.js'], env: { ELECTRON_RUN_AS_NODE: '1' } },
            cfgPath,
        );
        const cfg = await readGlobalConfig(cfgPath);
        expect(cfg.ironbeeDevTools?.mcp).toEqual({
            command: '/node',
            args: ['/gs/devtools/dist/index.js'],
            env: { ELECTRON_RUN_AS_NODE: '1' },
        });
        expect(cfg.collector?.oauthToken).toBe('ibt_x');
    });
});

describe('hasCollectorToken', () => {
    it('true only for an ibt_ token', () => {
        expect(hasCollectorToken({ collector: { oauthToken: 'ibt_abc' } })).toBe(true);
        expect(hasCollectorToken({ collector: { oauthToken: 'nope' } })).toBe(false);
        expect(hasCollectorToken({})).toBe(false);
    });
});

describe('clearCollectorToken / hasLocalCollectorToken', () => {
    it('removes oauthToken + apiKey but keeps url and unrelated keys', async () => {
        await fs.mkdir(path.dirname(cfgPath), { recursive: true });
        await fs.writeFile(
            cfgPath,
            JSON.stringify({ collector: { url: 'https://c', oauthToken: 'ibt_x', apiKey: 'k' }, verification: {} }),
        );
        await clearCollectorToken(cfgPath);
        const cfg = await readGlobalConfig(cfgPath);
        expect(cfg.collector?.oauthToken).toBeUndefined();
        expect(cfg.collector?.apiKey).toBeUndefined();
        expect(cfg.collector?.url).toBe('https://c');
        expect(cfg.verification).toBeDefined();
    });

    it('hasLocalCollectorToken reflects presence and survives a missing file', async () => {
        expect(await hasLocalCollectorToken(cfgPath)).toBe(false);
        await writeCollectorToken('https://c', 'ibt_x', cfgPath);
        expect(await hasLocalCollectorToken(cfgPath)).toBe(true);
        await clearCollectorToken(cfgPath);
        expect(await hasLocalCollectorToken(cfgPath)).toBe(false);
    });
});
