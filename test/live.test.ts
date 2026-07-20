/**
 * LIVE integration tests against the real bundled `ironbee` CLI + `playwright-core`.
 * Skipped unless IRONBEE_LIVE=1 (they need the CLI, a temp HOME, and — for the browser
 * test — a ~150MB Chromium download into a TEMP browsers path).
 *
 *   IRONBEE_LIVE=1 npx vitest run src/live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInstall } from '../src/runtime/cliRunner';
import { resolveInstallClients } from '../src/runtime/clientDetect';
import { writeDevtoolsEnv } from '../src/config/ironbeeConfig';
import { suggestPlatforms } from '../src/runtime/platformSuggest';
import { runBrowserInstall } from '../src/runtime/playwrightBrowsers';
import { prewarmDevtools } from '../src/runtime/devtoolsPrewarm';
import browserVersions from '../src/generated/browser-versions.json';

const LIVE = process.env.IRONBEE_LIVE === '1';
const repoRoot = path.join(__dirname, '..');
const cliEntry = path.join(repoRoot, 'node_modules', '@ironbee-ai', 'cli', 'dist', 'index.js');

describe.runIf(LIVE)('LIVE: ironbee install', () => {
    it('installs into .cursor by default and merges the PLAYWRIGHT_SKIP env into the entry', async () => {
        const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-live-home-'));
        const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-live-proj-'));
        const savedHome = process.env.HOME;
        const savedUser = process.env.USERPROFILE;
        process.env.HOME = tmpHome;
        process.env.USERPROFILE = tmpHome;
        try {
            // The extension writes this to global config so npx-devtools never downloads browsers.
            await writeDevtoolsEnv({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', BROWSER_DEVTOOLS_INSTALL_CHROMIUM: 'false' });

            expect(await resolveInstallClients(proj)).toEqual(['cursor']);

            const res = await runInstall(
                { nodePath: process.execPath, cliEntry },
                { folderDir: proj, client: 'cursor', mode: 'assist', platforms: ['browser', 'node'] },
            );
            expect(res.ok).toBe(true);
            await expect(fs.access(path.join(proj, '.cursor'))).resolves.toBeUndefined();
            await expect(fs.access(path.join(proj, '.claude'))).rejects.toBeTruthy();

            const mcp = JSON.parse(await fs.readFile(path.join(proj, '.cursor', 'mcp.json'), 'utf8'));
            const compose = mcp.mcpServers?.['ironbee-devtools'];
            expect(compose.command).toBe('npx');
            expect(compose.args.join(' ')).toContain('@ironbee-ai/devtools@'); // pinned exact spec
            expect(compose.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBe('1');
            expect(compose.env.BROWSER_DEVTOOLS_INSTALL_CHROMIUM).toBe('false');
        } finally {
            process.env.HOME = savedHome;
            process.env.USERPROFILE = savedUser;
            await fs.rm(tmpHome, { recursive: true, force: true });
            await fs.rm(proj, { recursive: true, force: true });
        }
    }, 120_000);
});

describe.runIf(LIVE)('LIVE: platform suggestion via agent CLI', () => {
    it('returns a SuggestResult without throwing (best-effort)', async () => {
        const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-live-suggest-'));
        try {
            await fs.writeFile(path.join(proj, 'package.json'), JSON.stringify({ dependencies: { express: '^4' } }));
            await fs.writeFile(path.join(proj, 'server.js'), "require('express')().listen(3000)\n");
            const res = await suggestPlatforms(proj, { timeoutMs: 90_000 });
             
            console.log('[live suggest]', JSON.stringify(res));
            expect(res).toHaveProperty('platforms');
        } finally {
            await fs.rm(proj, { recursive: true, force: true });
        }
    }, 120_000);
});

describe.runIf(LIVE)('LIVE: devtools pre-warm via npx', () => {
    it('installs the pinned devtools into an isolated npm cache and exits (no server)', async () => {
        const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-live-npmcache-'));
        try {
            const res = await prewarmDevtools({
                spec: '@ironbee-ai/devtools@0.23.0',
                env: { ...process.env, npm_config_cache: cache },
                log: (l) => console.log('[live prewarm]', l),
                timeoutMs: 480_000,
            });
             
            console.log('[live prewarm result]', JSON.stringify(res));
            expect(res.ok).toBe(true); // npx is available in this env
            // The npm cache now holds the devtools tarball(s) → MCP-startup npx would be warm.
            const cacacheDirs = await fs.readdir(cache);
            expect(cacacheDirs.length).toBeGreaterThan(0);
        } finally {
            await fs.rm(cache, { recursive: true, force: true });
        }
    }, 540_000);
});

describe.runIf(LIVE)('LIVE: Chromium install via bundled playwright-core', () => {
    it('downloads the pinned Chromium revision into a browsers path (no npx)', async () => {
        const browsersPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-live-browsers-'));
        const savedPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
        process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath; // keep the real user cache untouched
        try {
             
            console.log('[live browsers] installing chromium rev', browserVersions.chromiumRevision, 'to', browsersPath);
            const ok = await runBrowserInstall(repoRoot, ['chromium'], {
                onProgress: (m) => console.log('[live browsers]', m),
                log: (l) => console.log('[live browsers]', l),
            });
            expect(ok).toBe(true);
            // A chromium-<revision> dir must now exist at the matching revision.
            const entries = await fs.readdir(browsersPath);
             
            console.log('[live browsers] installed:', entries.join(', '));
            expect(entries.some((e) => e.includes(`chromium-${browserVersions.chromiumRevision}`))).toBe(true);
        } finally {
            if (savedPath === undefined) {
                delete process.env.PLAYWRIGHT_BROWSERS_PATH;
            } else {
                process.env.PLAYWRIGHT_BROWSERS_PATH = savedPath;
            }
            await fs.rm(browsersPath, { recursive: true, force: true });
        }
    }, 600_000);
});
