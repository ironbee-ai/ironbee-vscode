// Bundles the extension entry to dist/extension.js (CommonJS).
// `vscode` is provided by the host; `@ironbee-ai/*` stay external so they remain
// real files under node_modules (spawned + materialized at runtime).
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode', '@ironbee-ai/cli', '@ironbee-ai/devtools'],
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching…');
} else {
  await esbuild.build(options);
}
