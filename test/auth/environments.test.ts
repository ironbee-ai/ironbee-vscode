import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_ENV_CONFIG, loadEnvConfig } from '../../src/auth/environments';

let dir: string;
let cfgPath: string;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-env-'));
    cfgPath = path.join(dir, '.ironbee', 'vscode', 'config.json');
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('DEFAULT_ENV_CONFIG (prod — the only env baked into the shipped extension)', () => {
    it('is prod, on the login.ironbee.ai custom domain, with the openid/email/profile scopes', () => {
        expect(DEFAULT_ENV_CONFIG.env).toBe('prod');
        expect(DEFAULT_ENV_CONFIG.cognitoDomain).toBe('https://login.ironbee.ai');
        expect(DEFAULT_ENV_CONFIG.consoleUrl).toBe('https://console.ironbee.ai');
        expect(DEFAULT_ENV_CONFIG.collectorUrl).toBe('https://collector.service.ironbee.ai');
        expect(DEFAULT_ENV_CONFIG.scopes).toEqual(['openid', 'email', 'profile']);
        expect(DEFAULT_ENV_CONFIG.loopbackPorts).toEqual([53100, 53101, 53102, 53103, 53104]);
    });

    it('does NOT hardcode any dev/staging values', () => {
    // The whole point of the refactor: non-prod hosts must not be in the code.
        const asJson = JSON.stringify(DEFAULT_ENV_CONFIG);
        expect(asJson).not.toMatch(/ironbee\.dev|ironbee\.us|amazoncognito/);
    });
});

describe('loadEnvConfig', () => {
    it('returns the prod defaults when ~/.ironbee/vscode/config.json is absent', async () => {
        const cfg = await loadEnvConfig(cfgPath);
        expect(cfg).toEqual(DEFAULT_ENV_CONFIG);
    });

    it('overrides prod with the dev override file (partial merge)', async () => {
        await fs.mkdir(path.dirname(cfgPath), { recursive: true });
        await fs.writeFile(
            cfgPath,
            JSON.stringify({
                env: 'dev',
                cognitoDomain: 'https://login.ironbee.dev',
                clientId: '5u3ou7i2r6hk3nc74iktl517ud',
                consoleApiBase: 'https://console.service.ironbee.dev',
                consoleUrl: 'https://console.ironbee.dev',
                collectorUrl: 'https://collector.service.ironbee.dev',
            }),
        );
        const cfg = await loadEnvConfig(cfgPath);
        expect(cfg.env).toBe('dev');
        expect(cfg.clientId).toBe('5u3ou7i2r6hk3nc74iktl517ud');
        expect(cfg.cognitoDomain).toBe('https://login.ironbee.dev');
        expect(cfg.consoleApiBase).toBe('https://console.service.ironbee.dev');
        expect(cfg.consoleUrl).toBe('https://console.ironbee.dev');
        expect(cfg.collectorUrl).toBe('https://collector.service.ironbee.dev');
        // Unspecified fields inherit prod defaults.
        expect(cfg.scopes).toEqual(DEFAULT_ENV_CONFIG.scopes);
        expect(cfg.loopbackPorts).toEqual(DEFAULT_ENV_CONFIG.loopbackPorts);
    });

    it('ignores unknown keys and wrong-typed values (keeps the prod default for those)', async () => {
        await fs.mkdir(path.dirname(cfgPath), { recursive: true });
        await fs.writeFile(cfgPath, JSON.stringify({ clientId: 42, bogus: 'x', consoleUrl: 'https://c.dev' }));
        const cfg = await loadEnvConfig(cfgPath);
        expect(cfg.clientId).toBe(DEFAULT_ENV_CONFIG.clientId); // wrong type ignored
        expect(cfg.consoleUrl).toBe('https://c.dev'); // valid string applied
        expect((cfg as Record<string, unknown>).bogus).toBeUndefined();
    });

    it('throws (loud) on malformed JSON rather than silently falling back', async () => {
        await fs.mkdir(path.dirname(cfgPath), { recursive: true });
        await fs.writeFile(cfgPath, '{not json');
        await expect(loadEnvConfig(cfgPath)).rejects.toThrow(/not valid JSON/);
    });
});
