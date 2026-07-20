import type { VerificationMode } from '../runtime/cliRunner';
import type { Platform } from '../runtime/platformSuggest';

/** Human descriptions shown next to each choice so the user knows what they're selecting. */
export const MODE_DESCRIPTIONS: Record<VerificationMode, string> = {
    assist: 'Verify and guide — surfaces issues and suggests fixes, but never blocks the agent',
    enforce: 'Block on verification failure — gates the agent until checks pass (strongest)',
    monitor: 'Observe only — records verification results, never blocks or guides',
};

export const PLATFORM_DESCRIPTIONS: Record<Platform, string> = {
    browser: 'Web UI / end-to-end flows (Playwright-driven Chromium)',
    node: 'Node.js apps & libraries',
    backend: 'HTTP services & databases',
    android: 'Android apps (device instrumentation)',
    terminal: 'CLI tools & terminal programs',
};
