<div align="center">

# Your AI agent writes the code.<br/>IronBee proves it works.

Every change your agent makes is run in a real browser and against your real backend.
Broken changes get caught, fixed, and re-verified before they land.

<img src="https://raw.githubusercontent.com/ironbee-ai/ironbee-vscode/main/media/readme/hero.gif" alt="IronBee in Cursor: sign in, set up the project, and the verification gate takes over" width="880"/>

**[▶ Watch the full demo (2 min)](https://youtu.be/p14QyXRB-No)**

[![Open VSX](https://img.shields.io/open-vsx/v/ironbee-ai/ironbee-vscode?label=Open%20VSX&color=4c7ba8)](https://open-vsx.org/extension/ironbee-ai/ironbee-vscode)
[![Downloads](https://img.shields.io/open-vsx/dt/ironbee-ai/ironbee-vscode?label=downloads&color=5b8a4a)](https://open-vsx.org/extension/ironbee-ai/ironbee-vscode)
[![License](https://img.shields.io/badge/license-Elastic--2.0-b57a24)](https://github.com/ironbee-ai/ironbee-vscode/blob/main/LICENSE)

[ironbee.ai](https://ironbee.ai) · [Docs](https://docs.ironbee.ai) · [Console](https://console.ironbee.ai)

</div>

## Get set up in two minutes

### 1 · Sign in

Click **Sign In** when prompted (or run **IronBee: Sign In** from the command palette). Your
browser opens, you approve, and you're back in the editor. New to IronBee? The same flow creates
your free account: 3 seats, 100 sessions/month, no credit card.

<!-- TODO(asset 2): sign-in notification + browser approval screenshot -->

### 2 · Set up your project

Open your project. IronBee offers to set it up, or you can run **IronBee: Set Up For This
Project** anytime. Pick a **verification mode** and the **platforms** to check (browser,
backend, Node). That's the whole setup.

> Nothing is ever installed into a project unless you explicitly say so, and
> **IronBee: Remove From This Project** undoes it completely.

<!-- TODO(asset 3): mode + platform QuickPick screenshots -->

> ### <img src="https://raw.githubusercontent.com/ironbee-ai/ironbee-vscode/main/media/readme/icons/alert.png" width="22" alt=""/> Important: enable the MCP server in Cursor
>
> IronBee's verification tools run through the `ironbee-devtools` MCP server, and Cursor
> sometimes doesn't pick up newly added MCP servers automatically. After setup:
>
> 1. **Restart Cursor** (quit and reopen) so the new hooks and MCP config load.
> 2. Open **Settings → Tools & MCP** and make sure `ironbee-devtools` is listed and **enabled**.
> 3. Don't see `ironbee-devtools` in the list? **Close and reopen Cursor**; it appears after a
>    restart.
> 4. Listed and enabled, but the tools still aren't available? Toggle the server **off and back
>    on**.

### 3 · Just code with your agent

Ask your agent to build something, like you always do. There's no new workflow to learn:
IronBee hooks into your agent and takes it from here.

## What happens while you code

When your agent finishes a change, it doesn't get to say "done" until it passes **the IronBee
Gate**:

- **The change runs for real.** A real browser (Chromium, Firefox, or WebKit) drives your UI;
  your backend and Node code are exercised, not just the diff.
- **Failures come with the root cause.** IronBee auto-instruments your app with OpenTelemetry
  and uses traces, metrics, and logs to pinpoint exactly what broke.
- **The agent fixes and retries.** Failed verifications loop back to the agent with the
  evidence, and run again until they're clean.

<div align="center">
<img src="https://raw.githubusercontent.com/ironbee-ai/ironbee-vscode/main/media/readme/verification.gif" alt="A verification run: the dev server starts, scenarios execute, and the verdict comes back" width="880"/>
</div>

You decide how strict the gate is for each project:

| Mode | While you code, this means… | |
| --- | --- | --- |
| **assist** | Issues are surfaced with suggested fixes; your agent is never blocked. | ← start here |
| **enforce** | The agent isn't done until verification passes. Broken changes never land. | strongest |
| **monitor** | Everything is recorded and reported; nothing interferes. | |

Change your mind anytime with **IronBee: Reconfigure This Project**.

## Drive it yourself with slash commands

Setup also adds IronBee slash commands to your agent. Type `/` in your agent's chat:

| Command | What it does |
| --- | --- |
| `/ironbee-verify` | Verify the current changes on demand. Runs every verification cycle wired up for the project; add `fix` (`/ironbee-verify fix`) to fix-and-re-verify until it passes, or pass a custom scenario to replace the default flow. |
| `/ironbee-manage-scenario` | Create, update, or delete reusable verification scenarios. |
| `/ironbee-search-scenario` | Find saved scenarios by name, description, or metadata. |
| `/ironbee-sync-scenario` | Re-validate saved scenarios against the current code and repair drift (`check` = dry run, report only). |
| `/ironbee-issue-track` | Work with your connected issue tracker (Jira, Linear, GitHub Issues); available once a tracker is connected. |

## Review every session in the Console

Everything your agent did, and everything IronBee verified, streams to the
[IronBee Console](https://console.ironbee.ai): an interactive timeline, verification videos,
OpenTelemetry traces, cost analytics, and AI-generated findings that make your agent better
over time.

<!-- TODO(asset 5): Console session detail screenshot (timeline + verification video + traces) -->

## Good to know

- **Status at a glance.** The status bar shows what IronBee is up to; click it or run
  **IronBee: Show Status** for details.
- **Browsers, handled.** Verification browsers install automatically. Prefer your own Chrome?
  Flip the **Use system browser** setting. Re-download anytime with
  **IronBee: Install Verification Browsers**.
- **More than one team?** **IronBee: Switch Account** switches the active account; new projects
  are set up under it.
- **Privacy mode.** One setting redacts sensitive data from everything IronBee captures, across
  all projects.
- **Also in CI.** The same gate runs in your pipeline with the
  [IronBee GitHub Action](https://docs.ironbee.ai/github-action/get-started/getting-started):
  verified locally, verified on every PR.

## Editor commands

These live in the command palette. Open it and type "IronBee":

| Command | What it does |
| --- | --- |
| `Sign In` / `Sign Out` / `Switch Account` | Manage who's connected. |
| `Set Up For This Project` | Wire IronBee into a project (mode + platforms). |
| `Reconfigure This Project` | Change mode or platforms later. |
| `Remove From This Project` | Cleanly uninstall from a project. |
| `Install Verification Browsers` | (Re)download browsers used for web verification. |
| `Open Settings` / `Show Status` | Tune IronBee, or see what it's doing. |

## Why runtime verification

Static analysis and code review stop at the diff. AI-generated code fails at runtime: the
button that doesn't click, the API that 500s, the flow that breaks two pages later. IronBee
closes that loop.

| | |
| --- | --- |
| <img src="https://raw.githubusercontent.com/ironbee-ai/ironbee-vscode/main/media/readme/icons/gate.png" width="26" alt=""/> **The IronBee Gate.** Every change must pass the gate to be done. Failures loop back, get fixed, run again. | <img src="https://raw.githubusercontent.com/ironbee-ai/ironbee-vscode/main/media/readme/icons/runtime.png" width="26" alt=""/> **Real runtime verification.** Real browser, real backend, real Node. Actual behavior, not just the diff. |
| <img src="https://raw.githubusercontent.com/ironbee-ai/ironbee-vscode/main/media/readme/icons/trace.png" width="26" alt=""/> **OpenTelemetry-native.** Traces, metrics, and logs pinpoint the root cause automatically. | <img src="https://raw.githubusercontent.com/ironbee-ai/ironbee-vscode/main/media/readme/icons/insight.png" width="26" alt=""/> **Agent intelligence.** Sessions distilled into findings and recommendations in the Console. |

Works with **Cursor**, **Claude Code**, **Codex**, **GitHub Actions**, and local runs.

## Requirements & privacy

- VS Code 1.90+ or a recent Cursor; internet connection for sign-in and verification.
- Tokens live in the editor's **encrypted secret storage**, never in plain files.
- Telemetry is anonymous and one setting turns it off.

---

<div align="center">

Built by [ironbee.ai](https://ironbee.ai) · [Docs](https://docs.ironbee.ai) ·
[Support](https://docs.ironbee.ai/help/support) · Elastic License 2.0

</div>
