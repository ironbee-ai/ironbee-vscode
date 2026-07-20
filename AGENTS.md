# AGENTS.md — IronBee VS Code / Cursor extension

Internal engineering notes for this repo. Not shipped in the VSIX. The user-facing doc is
`README.md`; the full design + rationale is in `docs/ironbee-vscode-design.md`. Backend
prerequisites for the platform team live in the `ironbee` repo at
`docs/vscode-extension-backend-requirements.md`.

## What this extension does

Three jobs: (1) sign up / sign in to IronBee via native Cognito PKCE + loopback (RFC 8252);
(2) manage accounts/roles and mint the collector token the CLI needs; (3) install/configure
`@ironbee-ai/cli` per project (opt-in, per-project). After setup the CLI's own hooks verify the
agent's changes.

## Commands

```bash
npm install
npm run compile   # tsc --noEmit type-check
npm test          # vitest (unit)
npm run build     # browser-versions gen + esbuild bundle -> dist/extension.js
npm run package   # VSIX (vsce)

# Live integration tests (need the ironbee CLI + an authed agent CLI):
IRONBEE_LIVE=1 npx vitest run test/live.test.ts
```

Tests live in `test/**` mirroring `src/**`; `vscode` is aliased to `test/vscode-mock.ts`.

## Layout

- `src/auth/` — Cognito PKCE loopback, token store, session manager, per-env config.
- `src/console/` — console REST API client (`console.service.ironbee.<tld>`).
- `src/accounts/` — account switch + collector-token lifecycle (mint/rotate, cap handling).
- `src/runtime/` — bundled CLI runner, client detection, browser install, devtools pre-warm,
  node/npx PATH resolution, platform suggestion, devtools wiring decision.
- `src/config/` — `~/.ironbee/config.json` reader/writer.
- `src/ui/`, `src/lifecycle/` — pickers, setup flow, status bar, telemetry.
- `src/extension.ts` — activation + command wiring.
- `media/` — extension icon (`icon.png`, the IronBee brand mark).

## Environment selection (prod baked in; dev/staging via file)

Only **prod** is baked into the shipped extension (`DEFAULT_ENV_CONFIG` in `environments.ts`) —
custom Cognito domain `login.ironbee.ai`, `console.ironbee.ai`, `collector.service.ironbee.ai`. No
dev/staging hosts live in the code.

To run against a non-prod environment, a developer drops `~/.ironbee/vscode/config.json`;
`loadEnvConfig()` reads it at activation and merges it over the prod defaults (missing file → prod;
malformed → loud throw, then falls back to prod with a log). It's read **once** at activation, so
changing it needs a **window reload**. Tokens are namespaced by `envConfig.env` in SecretStorage,
so dev/prod sessions can't bleed. Example dev override:

```json
{
  "env": "dev",
  "cognitoDomain": "https://login.ironbee.dev",
  "clientId": "<dev desktop client id>",
  "consoleApiBase": "https://console.service.ironbee.dev",
  "consoleUrl": "https://console.ironbee.dev",
  "collectorUrl": "https://collector.service.ironbee.dev"
}
```

Sign-in throws a clean, user-facing message when `clientId` is empty — keep internal task ids out
of that string.

## Collector token flow

`collector.oauthToken` (an `ibt_…` access token) in `~/.ironbee/config.json` is what the CLI/
collector uses. `AccountManager.ensureCollectorToken()` mints it via `POST /access-tokens`
(handling the 10/account cap by reclaiming an extension-owned token) and `writeCollectorToken()`
writes it (stripping any sibling `apiKey`). It is wired to run after a successful project setup and
on account switch.

## Bundling / delivery (two tracks)

- **Universal VSIX** (`publish-vscode-extension.yml`) bundles only pure-JS `@ironbee-ai/cli` +
  `playwright-core`. Chromium is pre-installed in-process at the pinned revision via
  playwright-core (node-independent). `@ironbee-ai/devtools` (+ native deps) is installed on the
  user machine via `npx` — best-effort pre-warm at activation, otherwise at MCP-server startup.
- **Per-platform VSIX** (`publish-vscode-extension-per-platform.yml`) additionally bundles
  `@ironbee-ai/devtools` + its native deps (sharp/node-pty/frida) built on a real runner per
  OS/arch, published with `--target`. Devtools then runs via the editor's own Node (no npx). Note
  the per-platform job installs devtools with `npm install --no-save --include=optional` so the
  committed lockfile stays devtools-free (the universal build must not bundle it).

The version chain is deterministic and asserted at build time by
`scripts/resolve-browser-versions.mjs`: cli → `ironbee devtools version` → devtools →
playwright pin → chromium revision (must match bundled `playwright-core`).

## Runtime gotchas (learned the hard way)

- Run the bundled CLI and devtools with `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (the
  editor's own Node) — never rely on a system `node`/`npx` on PATH.
- GUI-launched editors don't inherit the shell PATH; `nodeResolve.ts` augments it (nvm/fnm/volta/
  homebrew/system + a login-shell probe) before looking for `npx`.
- Any spawned child: drain (or ignore) stdout/stderr to avoid a full-pipe deadlock, and escalate
  SIGTERM→SIGKILL on timeout. A spawn error must not abort a multi-folder batch.
