import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    alias: {
      // The `vscode` module is only available inside the extension host; unit tests
      // use a lightweight mock so pure logic can be exercised without the host.
      vscode: resolve(__dirname, 'test/vscode-mock.ts'),
    },
  },
});
