# IronBee for VS Code & Cursor

**Automatic verification for AI-assisted development.** IronBee checks what your AI coding agent
actually changed — in the browser, on the backend, and across your stack — so you catch broken
behavior before it lands.

This extension gets you onto IronBee and sets it up for your projects in a couple of clicks.

## What it does

- **Sign in once.** A secure browser sign-in connects the editor to your IronBee account. Your
  credentials stay in the editor's encrypted secret storage.
- **Set up a project in one click.** Pick a project (or several), choose a verification mode and
  the platforms to check, and IronBee is wired into that project. Nothing is installed into a
  project unless you ask.
- **Verification runs as you work.** Once a project is set up, IronBee verifies your agent's
  changes automatically — no extra steps.
- **Manage accounts.** If you belong to more than one IronBee account, switch the active one from
  the command palette.

## Getting started

1. Install the extension.
2. When prompted, click **Sign In** (or run **IronBee: Sign In** from the command palette). Your
   browser opens to complete sign-in, then returns you to the editor.
3. Open a project and run **IronBee: Set Up For This Project** (you'll also be offered this
   automatically for projects that aren't set up yet).
4. Choose a **verification mode** and the **platforms** to verify. That's it — IronBee takes over
   from here.

## Verification modes

| Mode | Behavior |
| --- | --- |
| **assist** | Surfaces verification results without blocking — good for getting started. |
| **enforce** | Acts on verification failures so broken changes are caught early. |
| **monitor** | Observes and reports only. |

## Commands

Open the command palette and search "IronBee":

- **IronBee: Sign In** / **Sign Out**
- **IronBee: Set Up For This Project** — set up (or add) projects.
- **IronBee: Reconfigure This Project** — change a project's mode/platforms.
- **IronBee: Remove From This Project** — uninstall IronBee from a project.
- **IronBee: Switch Account** — pick the active IronBee account.
- **IronBee: Install Verification Browsers** — download the browsers used for web verification.
- **IronBee: Open Settings** / **Show Status**

## Settings

Search "IronBee" in Settings:

- **Suggest on open** — offer setup for projects that aren't configured yet.
- **Default mode / default platforms** — seed values for the setup picker.
- **Install browsers (Chromium/Firefox/WebKit)** — which browsers to pre-install for verification.
- **Use system browser** — use your installed Google Chrome instead of downloading a browser.
- **Telemetry** — anonymous usage stats (no email or account id); on by default, opt out anytime.

## Requirements

- VS Code 1.90+ or a recent Cursor.
- An internet connection for sign-in and verification.

## Privacy

Sign-in tokens are stored in the editor's encrypted secret storage. Telemetry, when enabled, is
keyed to an anonymous id; while you're signed in, your account email is attached so usage can be
tied to your account. Turn it off anytime with the **Telemetry** setting.

## License

Elastic-2.0
