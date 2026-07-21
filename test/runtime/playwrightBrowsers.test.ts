import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    browserNamesForGroups,
    namesIncludeChromium,
    resolveInstallBrowsersForNpmInstall,
    runBrowserInstall,
} from '../../src/runtime/playwrightBrowsers';

describe('browserNamesForGroups', () => {
    it('maps chromium to the chromium stack', () => {
        expect(browserNamesForGroups(['chromium'])).toEqual(['chromium', 'chromium-headless-shell', 'ffmpeg']);
    });
    it('combines groups in a stable order and dedupes group set', () => {
        expect(browserNamesForGroups(['webkit', 'chromium', 'chromium'])).toEqual([
            'chromium', 'chromium-headless-shell', 'ffmpeg', 'webkit',
        ]);
    });
    it('returns [] for no groups', () => {
        expect(browserNamesForGroups([])).toEqual([]);
    });
});

describe('namesIncludeChromium', () => {
    it('detects the chromium stack', () => {
        expect(namesIncludeChromium(['firefox'])).toBe(false);
        expect(namesIncludeChromium(['chromium-headless-shell'])).toBe(true);
    });
});

describe('resolveInstallBrowsersForNpmInstall', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-pw-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('returns null when playwright-core is not bundled', () => {
        expect(resolveInstallBrowsersForNpmInstall(dir)).toBeNull();
    });

    it('resolves the installer from a coreBundle.js exposing registry.installBrowsersForNpmInstall', async () => {
        const pwc = path.join(dir, 'node_modules', 'playwright-core', 'lib');
        await fs.mkdir(pwc, { recursive: true });
        await fs.writeFile(
            path.join(pwc, 'coreBundle.js'),
            'module.exports = { registry: { installBrowsersForNpmInstall: () => Promise.resolve(true) } };',
        );
        const fn = resolveInstallBrowsersForNpmInstall(dir);
        expect(typeof fn).toBe('function');
    });

    it('falls through to server/index.js when coreBundle.js is present but the wrong shape', async () => {
        const lib = path.join(dir, 'node_modules', 'playwright-core', 'lib');
        await fs.mkdir(path.join(lib, 'server'), { recursive: true });
        // coreBundle.js exists but installBrowsersForNpmInstall is not a function → must not match.
        await fs.writeFile(path.join(lib, 'coreBundle.js'), 'module.exports = { registry: { installBrowsersForNpmInstall: 123 } };');
        await fs.writeFile(
            path.join(lib, 'server', 'index.js'),
            'module.exports = { installBrowsersForNpmInstall: () => Promise.resolve(true) };',
        );
        const fn = resolveInstallBrowsersForNpmInstall(dir);
        expect(typeof fn).toBe('function');
    });

    it('returns null when a candidate module throws on load and none resolves', async () => {
        const lib = path.join(dir, 'node_modules', 'playwright-core', 'lib');
        await fs.mkdir(lib, { recursive: true });
        await fs.writeFile(path.join(lib, 'coreBundle.js'), 'throw new Error("boom on load");');
        expect(resolveInstallBrowsersForNpmInstall(dir)).toBeNull();
    });
});

describe('runBrowserInstall', () => {
    it('returns true and skips work for an empty name list', async () => {
        expect(await runBrowserInstall('/x', [])).toBe(true);
    });

    it('returns false when the installer cannot be resolved', async () => {
        const logs: string[] = [];
        const ok = await runBrowserInstall('/x', ['chromium'], {
            resolveInstaller: () => null,
            log: (l) => logs.push(l),
        });
        expect(ok).toBe(false);
        expect(logs.join('\n')).toMatch(/not resolvable/);
    });

    it('clears PLAYWRIGHT_SKIP during install and restores it after', async () => {
        process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
        let sawSkip: string | undefined = 'unset';
        const ok = await runBrowserInstall('/x', ['chromium'], {
            resolveInstaller: () => async () => {
                sawSkip = process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
                return true;
            },
        });
        expect(ok).toBe(true);
        expect(sawSkip).toBeUndefined(); // cleared during install
        expect(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBe('1'); // restored
        delete process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    });

    it('invokes the system-Chrome fallback when a Chromium download fails', async () => {
        const onChromiumFailure = vi.fn(async () => {});
        const ok = await runBrowserInstall('/x', ['chromium'], {
            resolveInstaller: () => async () => {
                throw new Error('download 403');
            },
            onChromiumFailure,
        });
        expect(ok).toBe(false);
        expect(onChromiumFailure).toHaveBeenCalledWith(expect.stringContaining('403'));
    });

    it('does NOT offer the Chrome fallback for a non-chromium failure', async () => {
        const onChromiumFailure = vi.fn(async () => {});
        await runBrowserInstall('/x', ['firefox'], {
            resolveInstaller: () => async () => {
                throw new Error('boom');
            },
            onChromiumFailure,
        });
        expect(onChromiumFailure).not.toHaveBeenCalled();
    });
});
