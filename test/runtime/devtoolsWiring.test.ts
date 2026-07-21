import { describe, it, expect } from 'vitest';
import { decideDevtoolsWiring } from '../../src/runtime/devtoolsWiring';

describe('decideDevtoolsWiring', () => {
    it('bundled: runs the bundled entry via the editor Node with ELECTRON_RUN_AS_NODE + no browser download', () => {
        const w = decideDevtoolsWiring('/ext/node_modules/@ironbee-ai/devtools/dist/index.js', '/Applications/Cursor.app/electron');
        expect(w.mode).toBe('bundled');
        if (w.mode !== 'bundled') {
            return;
        }
        expect(w.mcp.command).toBe('/Applications/Cursor.app/electron');
        expect(w.mcp.args).toEqual(['/ext/node_modules/@ironbee-ai/devtools/dist/index.js']);
        expect(w.mcp.env.ELECTRON_RUN_AS_NODE).toBe('1');
        expect(w.mcp.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBe('1');
        expect(w.mcp.env.BROWSER_DEVTOOLS_INSTALL_CHROMIUM).toBe('false');
    });

    it('npx: no bundled entry → env-only wiring, no ELECTRON_RUN_AS_NODE, keeps the CLI npx default', () => {
        const w = decideDevtoolsWiring(undefined, '/anything');
        expect(w.mode).toBe('npx');
        if (w.mode !== 'npx') {
            return;
        }
        expect(w.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBe('1');
        expect(w.env.BROWSER_DEVTOOLS_INSTALL_CHROMIUM).toBe('false');
        expect(w.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    });
});
