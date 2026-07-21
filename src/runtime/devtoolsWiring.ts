/**
 * Pure decision for how to wire the CLI's devtools MCP entry, extracted from activation glue so
 * the branch is unit-testable. Bundled (platform-specific VSIX) → run the bundled entry via the
 * editor's own Node, no npx/network. Otherwise → keep the CLI's `npx @ironbee-ai/devtools` default
 * and only suppress its browser download (the extension pre-installs Chromium).
 */

/** Tell devtools NOT to fetch browsers — the extension pre-installs Chromium itself. */
const SUPPRESS_BROWSER_DOWNLOAD: Record<string, string> = {
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    BROWSER_DEVTOOLS_INSTALL_CHROMIUM: 'false',
};

export type DevtoolsWiring =
  | { mode: 'bundled'; mcp: { command: string; args: string[]; env: Record<string, string> } }
  | { mode: 'npx'; env: Record<string, string> };

export function decideDevtoolsWiring(
    bundledEntry: string | undefined,
    execPath: string,
): DevtoolsWiring {
    if (bundledEntry) {
        return {
            mode: 'bundled',
            mcp: {
                command: execPath,
                args: [bundledEntry],
                env: { ELECTRON_RUN_AS_NODE: '1', ...SUPPRESS_BROWSER_DOWNLOAD },
            },
        };
    }
    return { mode: 'npx', env: { ...SUPPRESS_BROWSER_DOWNLOAD } };
}
