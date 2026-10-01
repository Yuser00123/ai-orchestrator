import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const uuid = (): string => randomUUID();
export const newToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export function constantTimeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error(`${label}: timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Rough token estimate (chars/4) — same philosophy as the gateway's estimator. */
export const estTokens = (s: string): number => Math.ceil(s.length / 4);

export const estTokensMsg = (m: { content?: string | null; tool_calls?: unknown[] }): number =>
  estTokens(m.content ?? '') + (m.tool_calls ? estTokens(JSON.stringify(m.tool_calls)) : 0);

export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  // head 70% / tail 30%, split on char boundaries safely
  const head = Math.floor(maxBytes * 0.7);
  const tail = maxBytes - head;
  const cutHead = sliceUtf8(text, 0, head);
  const cutTail = sliceUtf8(text, Math.max(0, text.length - tail * 2), text.length);
  const tailCut = tail >= Buffer.byteLength(cutTail) ? cutTail : sliceUtf8(cutTail, Buffer.byteLength(cutTail) - tail, Buffer.byteLength(cutTail));
  const removed = Buffer.byteLength(text, 'utf8') - Buffer.byteLength(cutHead + tailCut, 'utf8');
  return { text: `${cutHead}\n…[truncated ${removed} bytes]…\n${tailCut}`, truncated: true };
}

function sliceUtf8(s: string, startBytes: number, endBytes: number): string {
  const buf = Buffer.from(s, 'utf8').subarray(startBytes, endBytes);
  return buf
    .toString('utf8')
    .replace(/\uFFFD$/, '')
    .replace(/^\uFFFD/, '');
}

export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const rx = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
  return rx.test(value);
}

export const matchAny = (patterns: string[], value: string): boolean =>
  patterns.some((p) => globMatch(p, value));

export function parseJsonSafe(s: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
