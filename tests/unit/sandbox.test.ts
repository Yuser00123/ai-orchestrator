import { describe, expect, it, vi } from 'vitest';

/**
 * Regression pin for the E2B read contract (see src/sandbox/e2b.ts):
 * files.read MUST be called with { format: 'bytes' } — the real SDK ignores unknown
 * opts and would silently hand back text, corrupting base64 round-trips
 * (artifact downloads + sandbox.read_file). The fake SDK here REJECTS anything
 * but format:'bytes', making that class of mistake fail at test time.
 */
export const TEST_CONTENT = 'E2B-OK 2026-10-02 — unicode ✓ 🚀';

vi.mock('e2b', () => ({
  Sandbox: {
    create: async () => ({
      sandboxId: 'fake-1',
      files: {
        async read(path: string, opts?: { format?: string }) {
          if (!opts || opts.format !== 'bytes') {
            throw new Error(`bad read opts ${JSON.stringify(opts)} — fake SDK only serves format:'bytes'`);
          }
          return new TextEncoder().encode(TEST_CONTENT);
        },
        async write() { return undefined; },
      },
      commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      async setTimeout() { return undefined; },
      async kill() { return undefined; },
    }),
  },
}));

describe('e2b readFileBase64 contract', () => {
  it('reads binary-safe bytes via format:bytes and survives a base64 round-trip', async () => {
    const { E2bSandboxManager } = await import('../../src/sandbox/e2b.js');
    const mgr = new E2bSandboxManager({
      apiKey: 'fake', template: 'base', idleTtlMs: 60_000, maxSessionMs: 60_000, execTimeoutMs: 5_000,
    });
    const { handle } = await mgr.ensureHandle('sess_fake');
    const b64 = await handle.readFileBase64('/workspace/hello.txt');
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(TEST_CONTENT);
  });
});
