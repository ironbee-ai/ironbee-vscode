# IronBee for Cursor — Extension Design

Status: Reviewed (6 review rounds → zero findings; CLI + devtools claims and all load-bearing
platform/AWS facts verified against source/docs; both need no code changes; work confined to
`ironbee` + `ironbee-vscode`)
Owner: Serkan Özal
Last updated: 2026-07-01

## 1. Purpose & goals

Build a Cursor/VS Code extension (repo: `ironbee-vscode`) that is the on-ramp for
`@ironbee-ai/cli`. It is published to **OpenVSX** so it is installable from the Cursor
marketplace. Modeled on the existing `ironbee-devtools-vscode` extension.

The extension does three things:

1. **Onboard the user** — sign up / sign in via IronBee's identity provider (AWS Cognito),
   obtain tokens, and make the person a registered IronBee user. If a valid credential
   already exists locally, skip sign-in (see the activation state machine in §5.4/EXT-1).
2. **Account & role management** — a single user can belong to multiple accounts with
   different roles; the extension lets them see and switch the active account.
3. **Install & configure `ironbee-cli` per project, opt-in** — bundle the CLI (and a
   compatible `@ironbee-ai/devtools`) inside the extension and run `ironbee install` against a
   project **only when the user explicitly sets it up for that project**, with that project's
   own configuration (mode/platforms/checks). The extension NEVER auto-installs into all/any
   open workspace (unlike `ironbee-devtools-vscode`'s global MCP registration) — installing
   everywhere is aggressive and verification settings are inherently per-project (see EXT-6).
   After install, the CLI's own hooks take over for that project.

Design intent for runtime robustness: prefer NOT to depend on a system `node`/`npx`/PATH
for the extension's own actions (§5.4/EXT-5). Note this is a **deliberate departure** from
`ironbee-devtools-vscode`, which uses `command: 'node'` (system PATH) — see §7/Q1 for the
consequence when the CLI persists an MCP entry into project files.

Non-goals: reimplementing verification logic (CLI/devtools own it), replacing the web
console, or a general settings UI beyond onboarding/install.

## 2. Current state of each repo (verified against source, round 1)

- **`ironbee-cli`** (`@ironbee-ai/cli` v0.34.0) — Node ≥22, TypeScript bundled with esbuild
  to `dist/`. Single bin `ironbee` → `dist/index.js`. Pure JS; runtime deps only `blessed`,
  `commander`, `diff`, `image-size`, `picocolors`. **No native deps, no Playwright.**
  `ironbee install <dir>` writes AI-client hooks/permissions/MCP config + guidance files
  into `.claude`/`.cursor`/`.codex`, writes `<proj>/.ironbee/config.json`, and registers the
  project in `~/.ironbee/projects.json`. Does **not** modify `package.json` or install git
  hooks. It configures the AI client to launch the verifier MCP server as a **single
  `PLATFORM=compose` server named `ironbee-devtools`** (`getComposeDevToolsMcpEntry`,
  `src/lib/config.ts:2173-2179`, name const `config.ts:80`). Default command:
  `npx -y @ironbee-ai/devtools@^0.17.0` (`DEFAULT_MCP_COMMAND` `config.ts:1835`,
  version+args `config.ts:1848-1849`). An **override already exists**:
  `config.ironbeeDevTools.mcp` (full command/args/env replacement) and
  `config.ironbeeDevTools.env` (`config.ts:2181-2208`). Auth: `ironbee login`
  (`src/commands/login.ts`, `src/lib/auth.ts`) stores a collector token in
  `~/.ironbee/config.json` under `collector.oauthToken` (or `collector.apiKey`).
  `isCollectorConfigured` requires `collector.url` **and at least one** of
  `oauthToken`/`apiKey` (inclusive-or; `config.ts:2240-2264`, fails only when neither is
  set) — both present is *accepted*. The extension still normalizes to only `oauthToken`
  (EXT-4) so the CLI unambiguously uses the extension's token, not a stale `apiKey`.
  Env-var overrides `IRONBEE_OAUTH_TOKEN` / `IRONBEE_API_KEY` also feed the collector token
  (`config.ts:1512-1513`); `IRONBEE_COLLECTOR=false` disables the collector.

- **`@ironbee-ai/devtools`** — the MCP verifier server; source repo is currently **0.17.1**
  and its `src/config.ts` supports the `compose` platform. It pulls in the heavy/native
  surface: `sharp` (image processing), optional `better-sqlite3`, and Playwright/Chromium
  for the browser cycle. Launched as `node <path>/dist/index.js --cursor-mcp-server` with a
  `PLATFORM` env var.

- **`ironbee-devtools-vscode`** — reference extension, but with two caveats:
  (a) it runs **three per-platform servers** (`PLATFORM=browser|node|backend`, names
  `ironbee-dt-*`, `src/extension.ts:41-53,750,839-948`) — it does **NOT** use
  `PLATFORM=compose`; compose is CLI-only. (b) it bundles `@ironbee-ai/devtools 0.10.2`
  (`package.json:353`, installed copy `node_modules/.../package.json:3`) which **predates
  compose entirely** (no `COMPOSE_PLATFORMS` in its `dist`). Reusable from it: `.vscodeignore`
  sharp-prebuild exclusion (`:32-39`), `.npmrc force=true`, in-process Playwright install
  (`src/playwrightBrowsersInstall.ts`), OpenVSX publish via `HaaLeo/publish-vscode-extension`
  (`.github/workflows/publish-vscode-extension.yml:49-54`), `npm ci --omit=optional`
  (drops `better-sqlite3`), first-run/uninstall lifecycle detection, telemetry anonymous-id
  in `~/.ironbee-devtools/config.json`. VSIX ~25 MB (browsers excluded).

- **`ironbee`** (backend/platform monorepo) — **AWS Cognito** User Pool for identity (NOT
  Better Auth). `ironbee-console-backend` (Express) verifies Cognito **ID tokens**
  (`src/middleware/auth.ts:12-16`, `tokenUse:'id'`). `ironbee-collector` (Java) ingests
  telemetry, authenticated by `ibt_` access tokens sent as `X-OAuth-Token`
  (`ApiKeyAuthFilter.java:32,96`; prefix `access-token-hash.ts:8`). Multi-account model in
  Postgres: `Users.active_account_id` (`schema.sql:18`), `UserAccounts(user_id, account_id,
  role, status)` (`schema.sql:40-49`, role is `VARCHAR(20) DEFAULT 'member'`, no CHECK).
  Role **values** are enumerated in the domain layer, not the schema:
  `ironbee-domain/src/model/types.ts:16-21` `AccountRoles = owner/admin/member/billing_admin`.
  Active account is injected into the ID token as `custom:account_id` by the Cognito
  `preTokenGeneration` trigger (`ironbee-auth-manager/src/signin/index.ts:20-30`);
  `postConfirmation` provisions the `Users` row + default account
  (`.../signup/index.ts:109-126`). Refresh-token grant exists at the Hosted UI
  `/oauth2/token` (`ironbee-console-frontend/src/lib/cognito.ts:186,213-219`; refresh
  validity 30 days, `auth-stack.ts:278,311`). Environments: dev `*.ironbee.dev`, staging
  `*.ironbee.us`, prod `*.ironbee.ai`; region `us-west-2`.

## 3. Credential & identity model

Two distinct credentials are involved; keeping them separate is central to the design.

| Credential | Issued by | Used against | Sent as | Stored |
|---|---|---|---|---|
| **Cognito ID token** (+ refresh token) | Cognito Hosted UI (PKCE) | Console REST API `https://console.service.ironbee.<env>` | `Authorization: Bearer <id_token>` | Extension **SecretStorage** (namespaced by env) |
| **Collector access token** `ibt_…` | Console API `POST /access-tokens` | Collector `https://collector.service.ironbee.<env>` | `X-OAuth-Token` | `~/.ironbee/config.json` → `collector.oauthToken` |

> Hostname note: `console.ironbee.<env>` is the **frontend SPA**; the REST API the extension
> calls is `console.service.ironbee.<env>` (frontend `.env.*` `VITE_API_BASE_URL`).

- Signing in with Cognito is what makes the person a **registered user** (the
  `postConfirmation` trigger provisions the `Users` row + a default account).
- The **CLI only needs the collector token** in `~/.ironbee/config.json`. The extension uses
  the **Cognito ID token** to talk to the Console API (identity, account list/switch) and to
  **mint** the collector token for the active account.
- The collector token is scoped to a single `(user, account)`. **Max 10 per account**
  (`access-token-service.ts:25`, enforced → HTTP 409 `TOKEN_LIMIT_EXCEEDED`).
- `POST /access-tokens` mints for the caller's **active account only** — it takes no
  `accountId` param (`routes/access-tokens.ts:37-50`, uses `req.userAccountId`). Therefore
  "switch account" = change active account server-side → refresh ID token so
  `custom:account_id` updates → mint for the now-active account (§5.4/EXT-3). *(Resolves old
  Q2.)*
- `POST /accounts/switch` only mutates `Users.active_account_id`; it issues no token. An
  already-issued ID token keeps the stale `custom:account_id` until a refresh regenerates it.
  A refresh suffices — no full re-auth is needed on switch. *(Resolves old Q4.)*

## 4. Architecture overview

```
Cursor / VS Code
 └─ IronBee extension (ironbee-vscode)  [Node extension host]
     ├─ Auth module      → Cognito Hosted UI (PKCE + loopback)  → id/refresh token (SecretStorage)
     ├─ Console client   → https://console.service.ironbee.<env> (Bearer id_token)
     │                       GET /users/me, GET /accounts/list, GET /accounts/current,
     │                       POST /accounts/switch, POST /access-tokens (+ list, DELETE /:id)
     ├─ Config writer    → ~/.ironbee/config.json (collector.url, collector.oauthToken; removes apiKey)
     ├─ Bundled runtime  → node_modules/@ironbee-ai/cli, node_modules/@ironbee-ai/devtools (≥0.17.0)
     ├─ CLI runner       → spawn(process.execPath, [cliEntry, 'install', <folder>, …],
     │                            { ELECTRON_RUN_AS_NODE:'1', shell:false })
     └─ Playwright install → in-process browser download on demand (from bundled devtools)

Result of `ironbee install`: writes AI-client hooks + a persisted compose MCP entry into the
 workspace (.cursor/.claude/.codex), pointing the verifier at the BUNDLED devtools via the
 CLI's config.ironbeeDevTools.mcp override.
```

## 5. Implementation requirements by component

### 5.0 Work distribution — where the actual code work lives

After round-1..4 review + direct source verification (2026-07-01), **required code work is
confined to two repos: `ironbee` (backend/infra) and `ironbee-vscode` (the new extension).**
`ironbee-cli` and `@ironbee-ai/devtools` need **no code changes** for the MVP — every item
against them was verified to already work; they are consumed as-is (CLI driven via config +
non-interactive `install`; devtools bundled and launched with `PLATFORM=compose`).

| Repo | Required code work? | What |
|---|---|---|
| **`ironbee`** (backend/infra) | **Yes — 2 real items + confirmations** | **BE-1**: new public Cognito PKCE app client with loopback callbacks (blocks native auth). **BE-6**: widen the console API JWT verifier to accept the new client id (else every extension API call 401s). BE-2/3/4 verified (no change); BE-5 (CORS) likely no-op. |
| **`ironbee-vscode`** (extension) | **Yes — all of it** | The entire extension: EXT-1..EXT-10 (auth, accounts, config writer, bundled CLI runner, Playwright, lifecycle, packaging). |
| **`ironbee-cli`** | **No (MVP)** | CLI-1..CLI-5 all ✔ verified. 3 optional DX niceties: CLI-OPT-1 (env-var override), CLI-OPT-2 (`--non-interactive`), CLI-OPT-3 (`install --json`). |
| **`@ironbee-ai/devtools`** | **No** | DT-1..DT-3 all ✔ verified against v0.17.1. Only constraint: bundle **≥0.17.0** (not the 0.10.2 that devtools-vscode ships). |

So the answer to "is the work only in `ironbee` and `ironbee-vscode`?" is **yes** — with the
one caveat that the extension must **bundle devtools ≥0.17.0** and may optionally motivate the
3 small CLI-OPT improvements if we want to avoid writing a config block / want richer install
feedback.

### 5.1 `ironbee` (backend + infra) — prerequisites (Phase 0, blocking)

> A standalone, self-contained spec for the platform team lives in the `ironbee` repo:
> `docs/vscode-extension-backend-requirements.md` (BE-1 + BE-6 with rationale, security posture,
> and acceptance criteria). Keep the two in sync.

- **[BE-1] New public Cognito app client** in CDK `AuthStack`
  (`infra/platform/app/lib/core/auth/auth-stack.ts`). Existing clients only register web
  callbacks (`console.ironbee.<env>`, local `localhost:5173`, all env-driven —
  `auth-stack.ts:280-357`), so a new client is genuinely required. **Mirror the existing
  local-dev client pattern** (`localUserPoolClient`, `auth-stack.ts:329-357`) but for loopback:
  - Public (no secret) — omit `generateSecret` (CDK defaults false, as existing clients do).
  - `oAuth.flows.authorizationCodeGrant: true`, scopes `[OPENID, EMAIL, PROFILE]` (same as
    existing, `auth-stack.ts:298-305`). PKCE is used by the client at runtime (no server flag).
  - **`enableTokenRevocation`** — the CDK L2 default is already `true` (so existing clients and
    BE-1 both have revocation, and `/oauth2/revoke` works for sign-out EXT-8b). Recommend pinning
    `enableTokenRevocation: true` **defensively/explicitly** for clarity; it is not functionally
    required.
  - `refreshTokenValidity` 30 days (match existing).
  - **Callbacks:** Cognito does **NOT** support wildcard/port-wildcard callback URLs — each
    `redirect_uri` must exactly match a registered one (only `http://localhost`/`127.0.0.1` may
    use http; everything else https). ⇒ register a **small fixed set** of loopback URLs
    (e.g. `http://127.0.0.1:<p>/callback` for ~4-5 candidate ports); the extension tries them in
    order (EXT-1). Supply them via a new env list (mirror `AUTH_CALLBACK_URLS_LOCAL`).
  - Expose the new client id + Hosted UI domain per env (SSM/CfnOutput, as the local client does
    at `auth-stack.ts:364-373`).
  - **Security posture (no new exposure).** An app client is a *registration in the existing user
    pool*, not a new directory or a new signup surface — the Hosted UI is already public (the web
    console uses it), and **signup is gated pool-wide by the `preSignUp` Lambda**
    (`ironbee-auth-manager/src/signup/index.ts`: `AUTH_PRIVATE_ENABLE` → `AllowlistService.check`
    + invite bypass; `AdminCreateUser` always rejected). That trigger fires for **all** app
    clients, so BE-1 cannot bypass the allowlist/invite gate. "Public client" means *no secret*
    (correct for a desktop app; the web clients are the same) — security rests on **PKCE**, not a
    secret. Guardrails to keep it safe: authorization_code + PKCE **only** (no implicit grant, no
    secret), callback allow-list = **loopback only** (no wildcard, no remote URLs), minimal scopes
    (`openid email profile`), and do not enable admin/custom auth flows. Net: it is *more* isolated
    than reusing the web client (own loopback-only callbacks, independently revocable). If
    extension signup should differ from web (e.g. open vs invite-only), the `preSignUp` trigger can
    branch on `event.callerContext.clientId` — an optional policy lever, not required for BE-1.
- **[BE-2 — RESOLVED]** `POST /access-tokens` mints for the active account only, 10-per-account
  cap → 409 (`routes/access-tokens.ts:37-61`, `access-token-service.ts:25,59-60`). No change
  needed; documented so the switch flow (EXT-3) is built on the verified contract.
- **[BE-3 — ✔ VERIFIED] account-list / account-current shapes.** `GET /accounts/list`
  (`routes/accounts.ts:19`) returns an **array**; `GET /accounts/current` (`:31`) a single
  object. Per account: **`id`** (uuid, NOT `accountId`), **`name`** (string|null until
  `onboarded`), **`role`** (`owner|admin|member|billing_admin`), **`active`** (bool),
  `onboarded` (bool), plus `analyzeUseLlm`/`useMockData` (and `acceptedAt` on the list path).
  **`apiKey`** is present only for owner/admin (omitted otherwise) — the extension does not need
  it (it mints `ibt_` tokens via `POST /access-tokens`). Picker reads `account.id`/`.name`/
  `.role`; the switch request body is `{ accountId: account.id }` (the request field IS named
  `accountId`, `accounts.ts:141`, even though the object field is `id`).
- **[BE-4 — ✔ VERIFIED] Refresh + revocation posture.** Existing clients are public (no secret,
  `generateSecret` defaults false), authorization-code-grant, `openid/email/profile`, refresh
  30 days, access/id 12h (`auth-stack.ts:276-311`). Refresh-token auth is implicitly enabled and
  token revocation is on by CDK default; BE-1 inherits both. Pinning `enableTokenRevocation: true`
  on BE-1 is a defensive clarity choice, not a functional requirement (folded into BE-1 above).
- **[BE-6 — REQUIRED, blocking] Console API JWT verifier must accept the new BE-1 client id.**
  The console backend verifies ID tokens against a **single** client id:
  `CognitoJwtVerifier.create({ userPoolId, clientId: config.cognito.clientId, tokenUse:'id' })`
  (`ironbee-console-backend/src/middleware/auth.ts:12-15`), and `config.cognito.clientId` is a
  scalar `string` from one SSM param (`src/config/index.ts:18,38`,
  `cognito.user.pool.client.id`). An ID token minted by the **new** BE-1 app client carries a
  **different `aud`/`client_id`**, so aws-jwt-verify would **reject it → 401** on *every* console
  call the extension makes — both account management AND `POST /access-tokens` (collector-token
  mint) go through this same `authenticate` middleware. **Fix:** make the verifier accept a
  **list** of client ids — `clientId: [webClientId, extensionClientId]` (aws-jwt-verify accepts
  `string | string[]`); i.e. widen `config.cognito.clientId` to a string[] (or add a second
  `cognito.user.pool.client.id.extension` SSM param and pass both). Without this, the extension
  can authenticate to Cognito but cannot use the console API at all.
- **[BE-5] (verify, likely no-op) CORS** — the extension calls the API from the Node host, not
  a browser, so CORS is not enforced. Documented to rule it out.

### 5.2 `ironbee-cli` — **required code changes: NONE for MVP; 3 optional DX improvements**

CLI-1..CLI-5 are all **verifications that passed** (no required work). CLI-OPT-1..3 are the
**optional** improvements. (Verified 2026-07-01 against
`/Users/sozal/Documents/workspace/ironbee-cli` v0.34.0.)

**Verified — no code change required:**

- **[CLI-1 — ✔ VERIFIED] Devtools override already exists.** `config.ironbeeDevTools.mcp`
  (full command/args/env replacement) + `config.ironbeeDevTools.env` (`config.ts:2148-2151,
  2181-2208`). The extension writes this block into **global** `~/.ironbee/config.json` before
  install (global-only — see EXT-5 / CLI-2b) — **no CLI change**. Do NOT invent
  `devtools.mcpCommand`/`mcpArgs` (fictional).
- **[CLI-2 — ✔ VERIFIED] The override round-trips into the written project MCP entries** — the
  load-bearing check for the whole bundling approach, and it holds. All clients compute the
  entry at write time via `getComposeDevToolsMcpEntry(projectDir)` and serialize it: Cursor →
  `.cursor/mcp.json` (`clients/cursor/index.ts:623-638`); Codex → `config.toml` session + agent
  toml (`clients/codex/index.ts:833-866`); Claude → verifier/scenario sub-agent **frontmatter**
  (`clients/claude/index.ts:187,453-467`; Claude deliberately strips the compose entry from
  `.mcp.json` at `:1321` — devtools MCP lives only in sub-agent frontmatter, still reflecting
  the override). Custom `command`/`args` carried verbatim; `env` merged with `PLATFORM=compose`
  **forced last** (`config.ts:2181-2195`) ⇒ the extension supplies `command` (node path) +
  `env.ELECTRON_RUN_AS_NODE=1` and must NOT set `PLATFORM`. `installCommand` writes config
  selections BEFORE calling clients (`install.ts:580-586`); `getComposeDevToolsMcpEntry`
  re-reads config each call (`config.ts:2154`), so a pre-written override is in effect.
- **[CLI-2b — ✔ VERIFIED] Config layering.** `loadConfig` merges global `~/.ironbee/config.json`
  + project + local (`config.ts:1589-1597`). `ironbeeDevTools` is **shallow-merged** (highest
  layer wins wholesale; not in the deep-merge list `config.ts:1274-1286`). Project-level is
  *technically* accepted by the merge, but **by design the extension writes it to GLOBAL
  `~/.ironbee/config.json` only** (EXT-5) — keeping it out of project configs avoids a project
  accidentally shadowing the runtime override. Never split it across layers.
- **[CLI-3 — ✔ VERIFIED] Non-interactive install works under a non-TTY.** With
  `--client`/`--mode`/`--platforms` supplied and a piped (non-TTY) spawn, all pickers are
  skipped via `isInteractive()` (`prompt.ts:17-19`); client picker falls back to a default
  under non-TTY (`install.ts:552-555`). The workspace-trust step is a **non-blocking file
  write** (`clients/claude/trust.ts`), not a prompt.
- **[CLI-4 — ✔ VERIFIED] Exit codes.** `install` exits non-zero on failure
  (`install.ts:485,494,503,512,523`) and 0 on success (no catch swallows client throws). The
  extension relies on exit code + verifying `<folder>/.ironbee/config.json` (§5.4/EXT-6).
- **[CLI-5 — ✔ VERIFIED] Pre-populated config accepted; no forced login.** `install` never
  invokes login/auth; a hand-written `~/.ironbee/config.json` is treated as authenticated.
  `isCollectorConfigured` accepts `url` + at-least-one of `oauthToken`/`apiKey` (inclusive-or,
  `config.ts:2240-2264`); the extension normalizes to only `oauthToken` (EXT-4).

**Optional DX improvements (all confirmed absent today — nice-to-have, not blocking):**

- **[CLI-OPT-1] Env-var override for the devtools entry** (e.g. `IRONBEE_DEVTOOLS_ENTRY` →
  bundled `dist/index.js`, or `IRONBEE_DEVTOOLS_MCP` → JSON entry). Absent (`config.ts` has only
  the config-file block + hardcoded npx default `:1835,1848-1849`). **Value:** lets the
  extension avoid writing an `ironbeeDevTools.mcp` block into the user's config file. Without
  it, the config-file approach (CLI-1/CLI-2) already works.
- **[CLI-OPT-2] `--non-interactive` / `--yes` flag on `install`.** Absent (`install.ts:470-474`
  options are `--client/--all/--platforms/--mode/--strict`). **Value:** guarantees no prompts
  even if the extension ever spawns with an inherited TTY. Non-TTY auto-detection already covers
  the piped-spawn case.
- **[CLI-OPT-3] `install --json` machine-readable output.** Absent (only
  scenario/uninstall/import/config have `--json`). **Value:** the extension could confirm which
  clients/paths were configured instead of only exit-code + file-existence checks.
- **[CLI-OPT-4] Non-interactive platform-suggest command (JSON).** The LLM platform suggestion
  exists today only inside `install`'s **interactive** picker (the `s` key,
  `install.ts:192-216`) — there's no way to get it from a non-TTY spawn. **Value:** expose the
  existing `suggestPlatforms` as a standalone non-interactive command
  (e.g. `ironbee platforms suggest --json`) returning the suggested platform list, so the
  extension can call it and pre-select platforms in its own QuickPick (EXT-6) without a PTY.
  Uses the same headless AI CLI under the hood; needs no editor LLM API.

### 5.3 `@ironbee-ai/devtools` — **required code changes: NONE** (all verified against v0.17.1)

Every item below is a **verification** that passed; there is **no devtools code work** for the
MVP. (Verified 2026-07-01 against `/Users/sozal/Documents/workspace/ironbee-devtools` v0.17.1.)

- **[DT-1 — ✔ VERIFIED, with a nuance] Bundled/path launch.** `node dist/index.js` is a valid
  standalone entry (`package.json` `main`/`bin` → `dist/index.js`, shebang `src/index.ts:1`);
  npx is not required. `PLATFORM` is read from `process.env` at startup (`src/config.ts:239`,
  `_envStr`→`_envStrRaw` `:141-142`); default transport is stdio (`src/index.ts:29-30`), so a
  bare `node dist/index.js` + `PLATFORM=compose` env starts the compose MCP server.
  **Nuance:** the `--cursor-mcp-server` flag that devtools-vscode passes is **not a handled
  option** in devtools — the parser only knows `--transport`/`--port` and uses
  `allowUnknownOption()`/`allowExcessArguments()` (`src/index.ts:37-38`), so the flag is
  silently ignored (zero effect). In devtools-vscode it is only a **process-identification
  marker** (`CURSOR_MCP_SERVER_ARG`, `extension.ts:56,764`). For ironbee-vscode it is optional:
  omit it, or keep it as a harmless marker. Launch relies solely on the `PLATFORM` env +
  default stdio. No devtools change needed.
- **[DT-2 — ✔ VERIFIED] compose is real in 0.17.1.** `'compose'` is a first-class `Platform`
  value (`src/config.ts:246,253`); it multiplexes sub-platforms behind one MCP server with
  per-platform tool prefixes (bdt/bedt/ndt/adt/tdt, `src/config.ts:277-283`,
  `src/platform/compose/index.ts`). It reads **`COMPOSE_PLATFORMS`** (comma list) to choose
  cycles (`src/config.ts:265-274`) and validates it only on the compose branch
  (`assertComposeConfigValid`, throws if empty/unknown — so the extension's override MUST keep
  the CLI-injected `COMPOSE_PLATFORMS`, which it does since IronBee env is forced last). The
  extension must still **bundle ≥0.17.0** (devtools-vscode ships 0.10.2, which has no compose);
  0.17.1 satisfies the CLI's `^0.17.0`. No devtools change; just bundle the right version.
- **[DT-3 — ✔ VERIFIED] Degrades without `better-sqlite3`.** No static import anywhere; the
  module is `require`d lazily at exactly two sites, both try/catch-guarded
  (`platform/backend/tools/db/connections/sqlite-connection.ts:74-82`,
  `search/strategies/fts5-strategy.ts:22-30`). Neither is on the startup/compose path; FTS5
  search falls back to MiniSearch (`search/search-engine.ts:23-31`) and the default strategy is
  `SIMPLE` anyway. So `--omit=optional` (dropping `better-sqlite3`) yields a clean tool-level
  error only if someone opens the sqlite `db_connect` cycle — never a startup crash. No change.

### 5.4 `ironbee-vscode` (the extension) — full requirements

**Project setup**
- `package.json`: name `ironbee-vscode`, publisher `ironbee-ai`, `main ./dist/extension.js`,
  engine matching Cursor's VS Code baseline, `activationEvents:["onStartupFinished"]`,
  license `Elastic-2.0`. Ship `@ironbee-ai/cli` and `@ironbee-ai/devtools (≥0.17.0)` as real
  `node_modules`. Build with `tsc` (mirror devtools-vscode) or esbuild-bundle the entry.
- `contributes`:
  - commands: `ironbee.signIn`, `ironbee.signOut`, `ironbee.switchAccount`,
    `ironbee.installIntoProject`, `ironbee.configureProject`, `ironbee.installBrowsers`,
    `ironbee.openSettings` (open the extension's settings UI / `settings.json` scope),
    `ironbee.showStatus` (show current identity + active account + per-folder install state).
  - views: a sidebar webview (status/onboarding) in the explorer container.
  - configuration: `ironbee.environment` (prod/staging/dev),
    `ironbee.install.suggestOnOpen` (bool, **default true**; actively suggest per-project setup
    on open — see EXT-6), `ironbee.install.defaultMode` (**default `assist`** —
    verify-and-guide, non-blocking; user can pick enforce/monitor per project),
    `ironbee.install.defaultPlatforms` (seed values for the per-project picker, never applied
    silently), `ironbee.telemetry.enable` (**default true**, notice + opt-out — EXT-9),
    Playwright `install.*` toggles.
  - status bar item showing sign-in state + active account.

**[EXT-1] Auth module (native Cognito PKCE) + activation state machine**
- Loopback HTTP server on `127.0.0.1:<port>` (a free port, or the fixed set registered per
  BE-1, tried in order). PKCE `code_verifier`/`code_challenge` (S256) + random `state`.
- Authorize URL:
  `https://<cognitoDomain>/oauth2/authorize?client_id=<BE-1>&response_type=code&scope=openid+email+profile&redirect_uri=<loopback>&state=<state>&code_challenge=<c>&code_challenge_method=S256`.
  Sign-up happens on the same Hosted UI (no separate signup call).
- On callback: validate `state` (reject on mismatch), exchange `code` at
  `https://<cognitoDomain>/oauth2/token` (`grant_type=authorization_code`, `code_verifier`)
  → `{ id_token, refresh_token, expires_in }`. Store in **SecretStorage**, keys namespaced
  by env: `ironbee.<env>.cognito.{idToken,refreshToken,expiresAt}`.
- **Loopback robustness:** enforce a **5-minute** sign-in timeout with a user-cancelable
  progress notification; handle an `error`/`error_description` callback (Cognito failure) as
  a sign-in failure; only accept path `/callback` (reject others); always tear down the
  server on success/cancel/timeout; if no registered port can bind, fail with a clear
  message. Only one sign-in may run at a time (see Concurrency, §7).
- **Token renewal:** before any Console API call, refresh when `expiresAt - now < 5 min` via
  `grant_type=refresh_token`; on refresh failure, prompt re-sign-in. Refresh/rotation must
  tolerate a concurrent refresher in another window (last-writer-wins on SecretStorage).
- **Activation state machine (resolves old Q3):**
  - (a) Valid Cognito session (id/refresh present, refreshable) → full features, no prompt.
  - (b) Only a well-formed collector token (`ibt_…`) in `~/.ironbee/config.json`, no Cognito
    session → **allow install/verify** (the CLI is usable), but present account features as
    "Sign in to manage accounts"; do **not** force sign-in. **There is no collector
    token-validation endpoint** — the collector's `/ping` is anonymous (does not
    authenticate) and the `/v1/*` endpoints *ingest* data, so the extension treats token
    *presence + `ibt_` prefix* as sufficient here (it does NOT actively validate against the
    collector, and never uses `GET /accounts/current`, which needs the Cognito session and
    would be circular). Real validity is only knowable once a Cognito session exists, via
    Console `GET /access-tokens/list` (matching the stored token id).
  - (c) Neither → prompt sign-in on first run only (not on every activation).
  - **Fall-through:** the extension keys transitions on **observable** signals only — a
    Console API attempt failing (401 that refresh cannot fix) or a lost Cognito session →
    transition toward (c): surface "sign in to refresh your IronBee credential" without
    forcing it; do not silently loop. (Collector-side rejection of a state-(b) token surfaces
    only in the CLI's own logs, not to the extension, so it cannot be reacted to directly —
    the sign-in hint is offered opportunistically, not reactively.)
- **Never log** `code`, `code_verifier`, `id_token`, `refresh_token`, or collector tokens.

**[EXT-2] Console API client**
- Base URL from `ironbee.environment` → `https://console.service.ironbee.<env>`. Attaches
  `Authorization: Bearer <id_token>`, auto-refresh on 401. Typed calls: `GET /users/me`,
  `GET /accounts/list`, `GET /accounts/current`, `POST /accounts/switch {accountId}`,
  `POST /access-tokens {name, expiresInDays}`, `GET /access-tokens/list`,
  `DELETE /access-tokens/:id`. Honors VS Code `http.proxy` + standard proxy env vars.
  On network failure during activation, degrade to offline (use cached tokens, defer refresh,
  don't block startup).

**[EXT-3] Account switching (with failure/rollback semantics)**
- `ironbee.switchAccount`: `GET /accounts/list` → QuickPick (name + role). On pick, run the
  chain and treat it as **not committed** until the last step; do not update status bar /
  config.json until the collector token is written:
  1. `POST /accounts/switch {accountId}`. If this fails → abort, no local change.
  2. Refresh the Cognito token so `custom:account_id` matches. On failure → attempt to
     restore the previous active account (`POST /accounts/switch` back), surface an error.
  3. Mint a collector token for the now-active account (`POST /access-tokens`). Handle the
     10-token cap (see below). On failure after a successful switch → restore previous active
     account and error out.
  4. Atomically write `collector.url` + `collector.oauthToken` (and remove `apiKey`) into
     `~/.ironbee/config.json` (EXT-4). Only now update status bar + notify.
- **Rollback terminal state:** if step 2/3 fails AND the restoring `POST /accounts/switch`
  also fails (e.g. the Cognito session is dead — the common cause), the server active account
  and local view diverge. Do not trust cached account state: mark local account state
  **dirty**, and on the next account operation force `GET /accounts/current` (after
  re-auth) before acting. Never write `config.json` while dirty.
- **10-token cap handling (implementable):** the extension can only reuse collector tokens it
  **minted and cached itself** (plaintext is returned once). Cache per account in
  SecretStorage: `ironbee.<env>.collectorToken.<accountId>` (store the token id alongside the
  plaintext). "Reuse if it still validates" = the cached token's **id is still present** in
  Console `GET /access-tokens/list` (Cognito-authed) — not a collector ping. At the cap (409),
  delete an **extension-owned** token, identified by a **stable name prefix** the extension
  sets on mint — `ironbee-vscode:<hostname>` (match on the `ironbee-vscode:` prefix, hostname
  is a diagnostic suffix only, so tokens this user minted from *any* machine are reclaimable) —
  via `DELETE /access-tokens/:id`, then mint. **Never** delete a token without the
  `ironbee-vscode:` prefix; if all 10 are foreign, surface an actionable error (open the
  console `/access-tokens` page) instead of deleting.

**[EXT-4] Config writer**
- Read/deep-merge/write `~/.ironbee/config.json`, touching only the `collector` block; never
  clobber unrelated keys. When writing `oauthToken`, **remove any sibling `apiKey`** so the
  CLI unambiguously sends the extension's token (not a stale shared key); this is a
  normalization, not a hard CLI requirement (CLI-5). Create `~/.ironbee/` with mode
  `0700` and write the file (and its temp file) with mode `0600`, atomically (temp + rename,
  temp created restrictive from the start — not world-readable then chmod'd).

**[EXT-5] Bundled CLI runner**
- Resolve `<extensionPath>/node_modules/@ironbee-ai/cli/dist/index.js`. Run:
  `spawn(process.execPath, [cliEntry, 'install', folderDir, '--client', <detected>,
  '--mode', <mode>, '--platforms', <list>], { env:{ ...process.env,
  ELECTRON_RUN_AS_NODE:'1' }, shell:false, cwd:folderDir })`.
  Before/at install, ensure the compose MCP entry points at the **bundled devtools**: write
  `ironbeeDevTools.mcp = { command:<stableNodePath>, args:[<stableDevtoolsEntry>],
  env:{ ELECTRON_RUN_AS_NODE:'1' } }` (PLATFORM is auto-added by the CLI; do not set it; the
  `--cursor-mcp-server` marker is optional and inert in devtools — see DT-1).
  **Where to write it:** the devtools override is an **extension-runtime** concern (which
  bundled binary to run), not a project preference, so write it to **global**
  `~/.ironbee/config.json` (`ironbeeDevTools` is shallow-merged, highest layer wins — CLI-2b —
  so keep it out of project configs to avoid a project accidentally shadowing it). Project
  configs hold only per-project preferences (mode/platforms/checks).
  **Stable paths (Q1, resolved):** the CLI **bakes the resolved `command`/`args` into each
  project's MCP files** at install time, and extension dirs are version-scoped, so the paths
  must be version-independent: `<stableDevtoolsEntry>` = the devtools entry **materialized into
  `context.globalStorageUri`** (re-materialized on every activate/upgrade, path never changes),
  `<stableNodePath>` = `process.execPath`. On activate, if `process.execPath` changed
  (rare editor update), re-run install for registered projects to refresh (§7/Q1).
- `shell:false` + arg array avoids Windows quoting/PATH/permission issues. Never invoke via a
  shell string; never rely on a global `ironbee`/`node`/`npx`.
- **Redact secrets** from the streamed stdout/stderr shown in the output channel (mask
  `ibt_…`, `Bearer …`, `oauthToken` values).

**[EXT-6] Install-into-project UX — per-project, opt-in, isolated (multi-root aware)**

**Core principle: the extension NEVER auto-installs into all/any workspace.** Unlike
`ironbee-devtools-vscode` (which registered one MCP server with the host for every window),
this extension delegates to `ironbee install <folder>`, which is inherently **per-project** —
each project gets its own configuration and nothing is applied to a project the user did not
explicitly opt into. This is deliberate: installing into every open project is aggressive and
could disrupt projects the user never intended to touch, and verification settings
(`platforms`, `verification.checks`, `mode`) are inherently per-project.

- **Install is always an explicit, per-project action.** `ironbee.installIntoProject` targets a
  single chosen folder. No install runs without a direct user action.
- **Encouraging suggestion (the *install* is opt-in — requires a click; the *nudge* is
  opt-out — on by default — and never auto-installs).** When a workspace folder opens that
  isn't yet registered (check `~/.ironbee/projects.json` or `<ws>/.ironbee`), the extension
  *actively invites* setup — the goal is to get the user to install, not to be so quiet it's
  ignored. Concretely:
  - A **prominent notification** with a clear value proposition and a primary **"Set up
    IronBee"** button (e.g. "IronBee can verify this project's changes — set it up in one
    click."). Primary action is the install flow; secondary actions "Later" and
    **"Don't ask for this project"**.
  - A **persistent, actionable status-bar item** ("$(shield) IronBee: set up") that stays
    visible until the project is set up, so the call-to-action doesn't vanish if the toast is
    missed — clicking it runs `installIntoProject`.
  - A **sidebar onboarding view** (the status webview) that, for an un-set-up project, shows a
    "Set up IronBee for this project" call-to-action rather than an empty state. A VS Code
    **walkthrough** ("Getting started with IronBee") reinforces it.
  - **Re-prompt policy:** "Later" is a soft dismiss — the status-bar CTA remains and the toast
    may re-surface in a subsequent session (not repeatedly within one session). Only
    **"Don't ask for this project"** (persisted per-folder in workspaceState) or the global
    **`ironbee.install.suggestOnOpen: false`** silences it. Default `suggestOnOpen: true`.
  - Still **no modal, no auto-install** — every path requires the user to click "Set up".
- **Per-project configuration at install time.** Mode (enforce/assist/monitor), platforms, and
  `verification.checks` are chosen **per project** via QuickPick (or the folder's existing
  `<folder>/.ironbee/config.json` if re-running), written to that folder's committed
  `.ironbee/config.json`.
- **AI-client selection — default to `.cursor` when nothing is detected.** Detect existing client
  dirs per folder (`.cursor`/`.claude`/`.codex`) and target the detected one(s). **If none of the
  three exist, this being a Cursor extension, install into `.cursor`** by passing `--client cursor`
  **explicitly**. ⚠ Do NOT rely on the CLI's own no-detection fallback: `REGISTERED_CLIENTS[0]` is
  **`claude`** (`ironbee-cli/src/clients/registry.ts:10-14,88`), so an unqualified install would
  land in `.claude`, not `.cursor`. `cursor` is a valid `--client` value
  (`clients/cursor/index.ts:162`). (If the host is VS Code proper rather than Cursor, still default
  to the detected client, or `cursor` if the extension standardizes on it.)
- **LLM-driven platform suggestion (best-effort, reuses IronBee's own mechanism — NOT the
  editor's LLM API).** The platform QuickPick offers a "Suggest platforms" affordance that
  pre-selects platforms based on the project. The suggestion is produced by running the user's
  **AI coding CLI headlessly** — `cursor-agent -p` / `claude -p` / `codex exec` — which
  `ironbee install` already does via `IClient.runHeadlessPrompt` + `suggestPlatforms`
  (`ironbee-cli/src/commands/install.ts:192-216`, `clients/cursor/index.ts:193-203`;
  `SUGGESTION_PRIORITY = [claude, codex, cursor]`). So the "LLM" is the user's own agent CLI — no
  Copilot, no IronBee-backend LLM, and it works identically in Cursor and VS Code.
  - **Why not `vscode.lm`?** VS Code's Language Model API exists but is **Copilot-backed +
    consent-gated**, and **Cursor does not reliably expose it** (nor a public API to its own
    models). Reusing the headless-CLI path avoids that dependency entirely.
  - **Availability: genuinely best-effort and OFTEN ABSENT — do not depend on it.** These agent
    CLIs are **separate installs**, not bundled with the editor. Confirmed: `cursor-agent` is a
    standalone **beta** CLI installed via `curl https://cursor.com/install | bash` (NOT shipped
    with the Cursor desktop app; Windows support is **WSL-only**, so it's not directly invocable
    from a native-Windows extension host). `claude` / `codex` are likewise separate installs. Each
    must also be **authenticated**. `runHeadlessPrompt` rejects with ENOENT when the CLI is absent
    (`cursor/index.ts:189`). So most Cursor GUI users won't have any of these.
  - **Policy: if available, use it; if not, ask the user.** On opening the platform step, detect
    whether a headless-capable, **authed** agent CLI (`cursor-agent`/`claude`/`codex`) is present:
    - **Available** → run the LLM suggestion and **pre-select** the suggested platforms in the
      QuickPick (the user can still adjust/confirm).
    - **Not available** → **ask the user**: show the manual platform QuickPick for an explicit
      choice (no silent auto-pick). Never block install on the suggestion.
  - **Integration wrinkle:** the extension drives `install` **non-interactively** (no TTY), so the
    CLI's interactive `s`-key suggestion doesn't fire. Surface it in the extension's own QuickPick
    via a non-interactive CLI affordance — see **CLI-OPT-4** (a JSON platform-suggest command) —
    then pre-select the returned platforms. (Fallback if CLI-OPT-4 isn't built: the extension can
    invoke the same headless agent CLI itself, duplicating the small classify prompt.)
- **Reconfigure later, per project:** `ironbee.configureProject` re-opens the per-project
  mode/platforms/checks picker for an already-installed folder and re-runs install to apply —
  so a project's settings can evolve independently of every other project.
- **Multi-root / no-folder:** for a multi-root workspace, the user **picks which folder(s)** to
  install into (never "all" implicitly); each selected folder gets its own CLI invocation +
  per-folder client detection + per-folder config. When no folder is open, `installIntoProject`
  shows "open a folder first" and the suggestion is suppressed.
- **Success criterion:** exit code 0 **and** `<folder>/.ironbee/config.json` exists after the
  run; otherwise surface the failure with the (redacted) output.

**[EXT-7] Playwright browser install**
- Reuse devtools-vscode's in-process approach (`installBrowsersForNpmInstall` from bundled
  `playwright-core`, run inside `withProgress`, system-Chrome fallback on Chromium failure).
  Because devtools is bundled (not fetched via npx at runtime), the **extension** installs
  browsers — trigger on first install/upgrade and via `ironbee.installBrowsers`. Honor proxy
  settings; offer system-Chrome fallback offline.

**[EXT-8] Lifecycle**
- First-run/upgrade detection via a version marker in `globalStorage` (mirror devtools-vscode).
  First run: show the telemetry notice **before** emitting any event (EXT-9), then prompt
  sign-in and Playwright install.
- **[EXT-8b] Sign-out** (`ironbee.signOut`): revoke the Cognito refresh token via
  `/oauth2/revoke` (confirm it is enabled on the BE-1 client — Cognito can revoke the refresh
  token but **not** an already-issued ID token, so a residual window of ~ID-token TTL remains
  after sign-out; acceptable); delete all `ironbee.<env>.cognito.*` and cached
  `ironbee.<env>.collectorToken.*` SecretStorage keys; by default **leave**
  `~/.ironbee/config.json`'s collector token in place (shared with a possibly global CLI) but
  offer an explicit "also remove local collector token" option. Update status bar to
  signed-out.
- **Environment switch** (`ironbee.environment` change): clear all `ironbee.<current-env>.*`
  SecretStorage state, force re-sign-in, and rewrite `collector.url` for the new env. Because
  SecretStorage is env-namespaced there is no cross-env bleed; note in `config.json` which env
  the collector token belongs to (or re-mint on next sign-in).
- **Uninstall cleanup** (on `deactivate`, obsolete-marker detection like devtools-vscode):
  enumerate and remove **extension-owned** state only — all `ironbee.*` SecretStorage keys and
  optionally server-side collector tokens whose name carries the `ironbee-vscode:` prefix
  (to avoid 10-cap pollution). **Do NOT** delete `~/.ironbee/config.json`'s collector token by
  default (shared with the CLI), and **do NOT** touch the shared
  `~/.ironbee-devtools/config.json` — its anonymous id is shared with `ironbee-devtools-vscode`
  (EXT-9), so there is no ironbee-vscode-specific state to remove there.
- **Self-update:** best-effort, non-blocking poll of the OpenVSX API with backoff; offer to
  update on a newer version (mirror devtools-vscode).

**[EXT-9] Telemetry**
- Show the notice on first run **before** any event is emitted; respect
  `ironbee.telemetry.enable` (and the shared anonymous-id file). Events contain only an
  anonymous id + event name — **no email/account id** (which would de-anonymize). Storage
  path: reuse `~/.ironbee-devtools/config.json` for a shared anonymous id (single decision;
  do not split into a second file). Emit `sign_in`, `install`, `switch_account` events.

**[EXT-10] Packaging & publishing**
- `.vscodeignore`: keep `@ironbee-ai/cli`, `@ironbee-ai/devtools (≥0.17.0)`,
  `@img/sharp-wasm32`, `sharp`, `playwright-core`; exclude platform sharp prebuilds
  (`@img/sharp-{darwin,linux,win32}-*`, `sharp-libvips-*`) → universal VSIX.
- `.npmrc` `force=true` (so `@img/sharp-wasm32` installs on any host).
- CI: `npm ci --omit=optional` (drops `better-sqlite3`), `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`,
  lint, build, package, publish to **OpenVSX** via `HaaLeo/publish-vscode-extension` with
  `OPEN_VSX_TOKEN`. **Decision: OpenVSX-only for MVP** (covers Cursor); VS Code Marketplace
  deferred (separate account/token/approval — not now).

## 6. Configuration & data formats

**Global vs per-project split (deliberate).** Account/identity is global; verification behavior
is per-project. This maps directly onto the CLI's config layering (global `~/.ironbee` <
project `<proj>/.ironbee/config.json` < project-local `.ironbee/config.local.json`).

- **Global `~/.ironbee/config.json`** (shared with the CLI) — **credentials + extension
  runtime only**, never per-project verification settings. Extension writes:
  ```jsonc
  {
    "collector": { "url": "https://collector.service.ironbee.<env>", "oauthToken": "ibt_…" },
    "ironbeeDevTools": { "mcp": { "command": "<process.execPath>",
                                  "args": ["<globalStorageUri>/devtools-runtime/<version>/dist/index.js"],
                                  "env": { "ELECTRON_RUN_AS_NODE": "1" } } }
  }
  ```
  `collector` block deep-merged, sibling `collector.apiKey` removed; `ironbeeDevTools` is
  shallow-merged (write it only here — EXT-5). File mode `0600`, dir `0700`.
- **Per-project `<proj>/.ironbee/config.json`** (committed, written by the CLI at install per
  the user's picks) — the per-project preferences: `mode` (enforce/assist/monitor),
  enabled `platforms`, `verification.checks`, etc. **Isolated per project**; installing or
  reconfiguring one project never touches another. `<proj>/.ironbee/config.local.json` holds
  gitignored per-project-local overrides.
- **Extension SecretStorage keys** (env-namespaced): `ironbee.<env>.cognito.session` (a single
  JSON blob holding `{ idToken, refreshToken, expiresAt }` — atomic read/write, still cleared by
  the `ironbee.<env>.cognito.*` intent), `ironbee.<env>.collectorToken.<accountId>` (+ a
  `.collectorToken.index` listing account ids, since SecretStorage isn't enumerable). Per-folder
  "don't ask" suppression lives in `workspaceState`.
- The AI-client files (`.cursor/mcp.json`, `.claude`, `.codex`) are written by the CLI per
  project; the persisted MCP entry embeds the stable bundled-devtools path (EXT-5 / Q1).

## 7. Cross-cutting concerns & risks

- **[Q1 — RESOLVED] Persisted MCP path stability across upgrades → materialize into
  `globalStorageUri`.** The CLI **persists** an MCP entry (command + args path) into project
  `.cursor/.claude/.codex` files, and the AI client re-reads those files directly (not through
  our extension). **Empirically confirmed** the risk is real: Cursor/VS Code extension
  directories are **version-scoped** — e.g. installed extensions on this machine are
  `anysphere.remote-ssh-1.1.4`, `qwtel.sqlite-viewer-26.2.5-darwin-arm64` — so
  `context.extensionPath` (and thus `<extensionPath>/node_modules/@ironbee-ai/devtools/...`)
  **changes on every extension update**. A path baked into `.cursor/mcp.json` would point at a
  now-deleted `…-<oldversion>/…` dir after an update → broken MCP server. devtools-vscode never
  hit this because it **recomputes the path from `context.extensionPath` on every `activate()`
  and re-registers the server in-memory** (never persisting to disk) — we cannot copy that
  because the CLI persists to project files. **Per-project multiplies it:** the stale path lands
  in *every* installed project's MCP files.
  **Resolution:** on activate / first-install / upgrade, **materialize** the bundled devtools
  into the extension's **`context.globalStorageUri`**, which is **version-independent**
  (`…/User/globalStorage/ironbee-ai.ironbee-vscode/`, no version — devtools-vscode already relies
  on this dir being stable for its upgrade marker). Each devtools version lands in its own
  **immutable subdir** `devtools-runtime/<version>/`, and the persisted MCP `args` point at
  `…/devtools-runtime/<version>/dist/index.js`. Extension updates that keep the same devtools
  version reuse the same path (stable); a devtools bump produces a NEW path while the old dir
  (which a running/old-configured server may use) is left intact.
  - **Materialize the FULL package tree, not just `dist/index.js`.** The devtools runtime needs
    its resolvable `node_modules` at run time (`@img/sharp-wasm32`, `playwright-core`, etc.,
    which are `createRequire`'d relative to the package, not `dist/`). So the copy is the whole
    devtools package directory **including its `node_modules`** (tens of MB), copied with symlink
    **dereference** so it doesn't point back into the disposable extension install dir. Node
    resolution roots at the materialized package. (Playwright browser binaries stay in their
    shared cache per EXT-7, not under globalStorage.)
  - **Atomicity + concurrency (see Concurrency below).** Each version subdir is written **once**
    via `copy → staging → validate → rename` and **never overwritten in place**, so a running
    compose server (executing out of its version dir) is never destroyed and there is no
    "not-found" window. `skip-if-current` = the version's `dist/index.js` already exists (the
    common case). An inter-window **lock** + existence re-check serializes concurrent windows;
    an incomplete crash remnant is safe to `rm` because a COMPLETE version dir would have
    short-circuited via the existence check.
  - `command` = `process.execPath` + `ELECTRON_RUN_AS_NODE=1`; that path is the editor app binary
    (`/Applications/Cursor.app/…`), stable across *extension* updates and changing only on rare
    *editor* moves/updates — reconcile opportunistically: on activate, if the current
    `process.execPath` differs from the persisted one, re-run `ironbee install` for each
    registered project (`~/.ironbee/projects.json`) **reading that project's existing
    `.ironbee/config.json` and re-passing its mode/platforms/checks** so per-project settings are
    preserved (never fall back to defaults — that would clobber the project's choices). Guard the
    per-project re-install with the same inter-window lock.
  - **Fallback** if materialization ever fails: the CLI's default `npx -y
    @ironbee-ai/devtools@^0.17.0` (no persisted path, but reintroduces the node/npx/PATH + cold
    Chromium concerns bundling was meant to avoid).
- **VSIX size** ~25 MB+ (devtools + sharp-wasm + playwright-core, browsers excluded).
  Acceptable per devtools-vscode precedent.
- **Cognito loopback port registration** (BE-1) — may require exact URLs; use a fixed port set
  with in-order fallback (EXT-1).
- **Collector 10-per-account cap** — reuse/rotate only extension-owned tokens, identified by
  a stable `ironbee-vscode:` name prefix (hostname is a diagnostic suffix only) (EXT-3).
- **Concurrency across windows/instances.** SecretStorage + `~/.ironbee/config.json` +
  globalStorage are shared per-user across all open windows. Coordinate: (a) config.json writes
  are atomic, last-writer-wins; (b) a "sign-in already in progress" guard prevents two windows
  binding the same fixed loopback port; (c) refresh-token rotation tolerates concurrent
  refreshers; (d) **devtools materialization** into globalStorage is guarded by an inter-window
  lock + skip-if-current marker + temp-dir-then-atomic-swap, so two windows can't interleave a
  write and a running server's file is never overwritten in place (§7/Q1); (e) the
  **execPath-reconcile** per-project re-install takes the same lock so concurrent windows don't
  race on the same projects' files.
- **Two-editor differences** — the extension itself does not register MCP with the host (the
  CLI writes MCP config into project files), so Cursor-vs-VS-Code MCP-API differences don't
  affect it. Verify for the clients the CLI targets.
- **Do not delete shared credentials** on sign-out/uninstall by default (EXT-8/EXT-8b).
- **Security** — never log tokens/codes/verifiers; `config.json` `0600` / `~/.ironbee` `0700`;
  redact CLI output in the channel.

## 8. Open questions (remaining)

- **Q5 (devtools version):** exact `@ironbee-ai/devtools` version to bundle (≥0.17.0; latest is
  0.17.1) and how to keep it aligned with the CLI's `^0.17.0` compose contract on upgrades.
  Impl/maintenance detail — default: bundle latest, pin, bump on CLI-contract changes.

*(Resolved: former Q-port — Cognito does not support wildcard/port-wildcard callbacks
(confirmed via AWS docs); register a small fixed set of loopback URLs in BE-1, extension tries
them in order.)*

*(Resolved during review: former Q1 — persisted MCP path stability: materialize the bundled
devtools into version-independent `context.globalStorageUri` and use `process.execPath` for
`command`, so the persisted path never goes stale across extension updates (§7/Q1, EXT-5);
former Q3 — activation skip-if-authed is a defined state machine (EXT-1); former Q2 — mint is
active-account-only, cap 10/409; former Q4 —
switch needs only a refresh, not full re-auth (both folded into §3). Former Q-role-gate —
`POST /access-tokens` and `POST /accounts/switch` carry `authenticate` only, **no
`requireRole`** (`access-tokens.ts:32`, `accounts.ts:136`), so any authenticated user of any
role can mint a token and switch account; the account-switcher UI needs no role gating. Role
gates exist only on endpoints the extension does not call, e.g. rotate-api-key / account
update require OWNER/ADMIN.)*

## 9. Phased delivery

- **Phase 0 — prerequisites:** BE-1 (new Cognito client) + **BE-6** (verifier accepts its id) —
  both blocking for auth; bundle-devtools **≥0.17.0** validation. (BE-2/3/4 verified; Q1/Q2/Q4
  resolved; CLI-1..CLI-5 and DT-1..DT-3 already ✔ verified — no work.) Optional, not blocking:
  CLI-OPT-1..3.
- **Phase 1 — scaffold:** package.json, build, activation, CI/OpenVSX skeleton,
  `.vscodeignore`/`.npmrc`.
- **Phase 2 — bundling:** vendor CLI + devtools (≥0.17.0), sharp-wasm swap, Playwright install
  module; validate a `PLATFORM=compose` launch of the bundled devtools.
- **Phase 3 — auth:** Cognito PKCE loopback, SecretStorage (env-namespaced), refresh,
  activation state machine, sign-out, environment-switch reconciliation. **Dependency:** the
  collector-touching parts of sign-out (delete `collectorToken.*` cache, optional local-token
  removal) and env-switch (rewrite `collector.url`) need the **EXT-4 config writer** and the
  collector-token cache — pull those forward into Phase 3 (the mint/switch logic that
  *populates* them stays in Phase 4).
- **Phase 4 — accounts:** Console client, list/current/switch with failure/rollback (dirty-state
  handling), collector token mint + cap handling; reuses the Phase-3 config writer/cache.
- **Phase 5 — install:** bundled CLI runner (Q1 resolved), multi-root install UX, workspace
  detection, success verification.
- **Phase 6 — lifecycle:** first-run, telemetry consent, uninstall cleanup, self-update,
  concurrency guards.
