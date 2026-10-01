/**
 * SSRF-guarded fetch (§9-4): https/http only, every hop's DNS answers must be
 * public, manual redirects re-checked, size and time capped.
 * resolver is injectable for tests.
 */
import dns from 'node:dns/promises';

export interface Resolver {
  lookup(host: string): Promise<string[]>;
}

const defaultResolver: Resolver = {
  async lookup(host: string) {
    const rows = await dns.lookup(host, { all: true });
    return rows.map((r) => r.address);
  },
};

export class SsrfError extends Error {
  constructor(reason: string) {
    super(`url blocked: ${reason}`);
    this.name = 'SsrfError';
  }
}

export function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  const norm = ip.toLowerCase().split('%')[0];
  if (norm === '::' || norm === '::1') return true;
  if (/^f[cd]/.test(norm)) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(norm)) return true; // link-local
  if (norm.startsWith('::ffff:')) return isPrivateIp(norm.slice(7));
  return false;
}

const MAX_URL_LEN = 2048;

export interface SafeFetchResult {
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  finalUrl: string;
}

export async function safeFetch(
  rawUrl: string,
  opts: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; resolver?: Resolver; signal?: AbortSignal } = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const resolver = opts.resolver ?? defaultResolver;

  let url = rawUrl;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('fetch timed out')), timeoutMs);
  const relay = (): void => ac.abort(opts.signal?.reason as Error | undefined);
  opts.signal?.addEventListener('abort', relay);

  try {
    let redirects = 0;
    for (;;) {
      const u = await validateAndResolve(url, resolver);
      const res = await fetch(u.href, {
        redirect: 'manual',
        signal: ac.signal,
        headers: { 'user-agent': 'agent-orchestrator/0.1 (+fetch-tool)', accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.5' },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) break;
        if (++redirects > maxRedirects) throw new SsrfError('too many redirects');
        await res.body?.cancel().catch(() => undefined);
        url = new URL(loc, url).toString();
        continue;
      }

      const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new SsrfError(`response too large (${declared} bytes > ${maxBytes})`);
      }

      let bytes = 0;
      let truncated = false;
      const chunks: Buffer[] = [];
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            bytes += value.byteLength;
            if (bytes > maxBytes) {
              truncated = true;
              await reader.cancel().catch(() => undefined);
              break;
            }
            chunks.push(Buffer.from(value));
          }
        }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      return {
        status: res.status,
        contentType,
        body: looksBinary(contentType) ? `[binary content omitted: ${bytes} bytes, ${contentType}]` : htmlToText(raw),
        truncated,
        finalUrl: u.href,
      };
    }
    throw new SsrfError('unfollowable redirect chain');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', relay);
  }
}

async function validateAndResolve(rawUrl: string, resolver: Resolver): Promise<URL> {
  if (rawUrl.length > MAX_URL_LEN) throw new SsrfError('url too long');
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfError('unparseable url');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SsrfError('protocol must be http/https');
  if (u.username || u.password) throw new SsrfError('credentials in url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SsrfError('missing host');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new SsrfError('internal hostname');
  }
  let ips: string[];
  try {
    ips = /^[0-9.]+$/.test(host) || host.includes(':') ? [host] : await resolver.lookup(host);
  } catch {
    throw new SsrfError('dns resolution failed');
  }
  if (ips.length === 0) throw new SsrfError('no dns answers');
  if (ips.some(isPrivateIp)) throw new SsrfError('host resolves to private/link-local range');
  return u;
}

const looksBinary = (ct: string): boolean =>
  !/^(text\/|application\/(json|xhtml|xml|yaml|javascript)|application\/pdf)/i.test(ct.split(';')[0].trim());

/** Crude but dependency-free html→text; strips script/style entirely. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
