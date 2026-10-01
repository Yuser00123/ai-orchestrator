import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * src is ESM-TypeScript (NodeNext): relative imports carry .js extensions that
 * only exist after build. Map them back to .ts for the test runner.
 */
const jsToTs = {
  name: 'resolve-js-to-ts',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    if (source.startsWith('.') && source.endsWith('.js') && importer) {
      const candidate = resolve(dirname(importer), `${source.slice(0, -3)}.ts`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  },
};

export default defineConfig({
  plugins: [jsToTs],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
