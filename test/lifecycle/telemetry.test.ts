import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureAnonymousId, readTelemetryConfig, emitEvent, sharedTelemetryPath } from '../../src/lifecycle/telemetry';

let dir: string;
let cfgPath: string;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-tel-'));
    cfgPath = path.join(dir, '.ironbee', 'telemetry.json');
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('telemetry config', () => {
    it('lives in the shared ~/.ironbee/telemetry.json (jointly owned by all IronBee tools)', () => {
        expect(sharedTelemetryPath()).toBe(path.join(os.homedir(), '.ironbee', 'telemetry.json'));
    });

    it('creates a UUID anonymous id when none exists', async () => {
        const cfg = await ensureAnonymousId(cfgPath);
        expect(cfg.anonymousId).toMatch(/^[0-9a-f-]{36}$/);
        expect((await readTelemetryConfig(cfgPath))?.anonymousId).toBe(cfg.anonymousId);
    });

    it('preserves an existing shared id (jointly owned with the CLI / devtools)', async () => {
        await fs.mkdir(path.dirname(cfgPath), { recursive: true });
        await fs.writeFile(cfgPath, JSON.stringify({ anonymousId: 'preexisting', telemetryEnabled: true }));
        const cfg = await ensureAnonymousId(cfgPath);
        expect(cfg.anonymousId).toBe('preexisting');
        expect(cfg.telemetryEnabled).toBe(true);
    });

    it('returns null for a missing file', async () => {
        expect(await readTelemetryConfig(cfgPath)).toBeNull();
    });
});

describe('emitEvent', () => {
    it('does nothing when telemetry is disabled (opt-out)', async () => {
        const transport = vi.fn(async () => {});
        await emitEvent('sign_in', { enabled: false, transport, configPath: cfgPath });
        expect(transport).not.toHaveBeenCalled();
    });

    it('emits by default with NO notice/consent gate (just enabled), creating the id if missing', async () => {
        const transport = vi.fn(async () => {});
        await emitEvent('cursor_ext_activated', { enabled: true, transport, configPath: cfgPath });
        expect(transport).toHaveBeenCalledTimes(1);
        const payload = transport.mock.calls[0][0];
        expect(payload.event).toBe('cursor_ext_activated');
        expect(payload.distinctId).toMatch(/^[0-9a-f-]{36}$/);
        // Only { event, distinctId, properties } — no email/account id ever.
        expect(Object.keys(payload).sort()).toEqual(['distinctId', 'event', 'properties']);
    });

    it('forwards the caller-supplied properties (coarse env only) to the transport', async () => {
        const transport = vi.fn(async () => {});
        await emitEvent('cursor_ext_error', {
            enabled: true,
            transport,
            configPath: cfgPath,
            properties: { source: 'ironbee-vscode', error_message: 'boom' },
        });
        expect(transport.mock.calls[0][0].properties).toEqual({ source: 'ironbee-vscode', error_message: 'boom' });
    });

    it('reuses the existing anonymous id as the distinctId', async () => {
        const cfg = await ensureAnonymousId(cfgPath);
        const transport = vi.fn(async () => {});
        await emitEvent('switch_account', { enabled: true, transport, configPath: cfgPath });
        expect(transport).toHaveBeenCalledWith({ event: 'switch_account', distinctId: cfg.anonymousId, properties: {} });
    });
});
