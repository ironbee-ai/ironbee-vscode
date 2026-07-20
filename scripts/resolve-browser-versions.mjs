// Build/release-time: resolve the deterministic version chain
//   bundled ironbee-cli  →  its pinned @ironbee-ai/devtools  →  devtools' pinned playwright
//   →  the bundled playwright-core's Chromium revision
// and write it to src/generated/browser-versions.json. Also ASSERTS that the bundled
// playwright-core matches devtools' pinned playwright, so the browsers the extension
// pre-installs are exactly the revision the npx-launched devtools will use at runtime.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

function fail(msg) {
  console.error(`[browser-versions] ${msg}`);
  process.exit(1);
}

// 1) Pinned devtools version, straight from the bundled CLI (the exact npx spec it renders).
const cliEntry = require.resolve('@ironbee-ai/cli/dist/index.js');
let devtoolsVersion;
try {
  const out = execFileSync(process.execPath, [cliEntry, 'devtools', 'version', '--json'], { encoding: 'utf8' });
  devtoolsVersion = JSON.parse(out).version;
} catch (e) {
  fail(`could not read devtools version from bundled CLI (needs @ironbee-ai/cli with 'devtools version'): ${e.message}`);
}
if (!/^\d+\.\d+\.\d+/.test(devtoolsVersion)) {
  fail(`unexpected devtools version: ${devtoolsVersion}`);
}

// 2) devtools' pinned playwright version (must be exact for determinism).
let pinnedPlaywright = null;
try {
  pinnedPlaywright = execFileSync('npm', ['view', `@ironbee-ai/devtools@${devtoolsVersion}`, 'dependencies.playwright'], {
    encoding: 'utf8',
  }).trim();
} catch {
  console.warn('[browser-versions] warning: could not npm-view devtools playwright pin (offline?); skipping strict assert');
}

// 3) Bundled playwright-core version + Chromium revision (source of truth for what we install).
//    browsers.json isn't in playwright-core's `exports`, so read it from the resolved dir.
const pwcDir = path.dirname(require.resolve('playwright-core/package.json'));
const pwc = JSON.parse(readFileSync(path.join(pwcDir, 'package.json'), 'utf8')).version;
const browsers = JSON.parse(readFileSync(path.join(pwcDir, 'browsers.json'), 'utf8')).browsers;
const rev = (name) => browsers.find((b) => b.name === name)?.revision ?? null;

// 4) Alignment guard: bundled playwright-core must satisfy devtools' pinned playwright.
if (pinnedPlaywright) {
  if (/^\d+\.\d+\.\d+$/.test(pinnedPlaywright)) {
    if (pinnedPlaywright !== pwc) {
      fail(
        `ALIGNMENT: devtools ${devtoolsVersion} pins playwright ${pinnedPlaywright} but bundled playwright-core is ${pwc}. ` +
          `Pin "playwright-core": "${pinnedPlaywright}" in package.json and reinstall.`,
      );
    }
  } else {
    console.warn(`[browser-versions] devtools pins a RANGE (${pinnedPlaywright}); pin it exact in ironbee-devtools for full determinism`);
  }
}

const record = {
  devtoolsVersion,
  playwrightVersion: pwc,
  chromiumRevision: rev('chromium'),
  chromiumHeadlessShellRevision: rev('chromium-headless-shell'),
  ffmpegRevision: rev('ffmpeg'),
  resolvedFromPin: pinnedPlaywright ?? null,
};

mkdirSync(path.join(root, 'src', 'generated'), { recursive: true });
writeFileSync(path.join(root, 'src', 'generated', 'browser-versions.json'), JSON.stringify(record, null, 2) + '\n');
console.log('[browser-versions]', JSON.stringify(record));
