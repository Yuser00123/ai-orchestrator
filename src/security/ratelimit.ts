/** In-memory fixed-refill token bucket per key. Single-instance design (§10). */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perMinute: number,
    private readonly burst: number = perMinute,
  ) {
    this.tokens = burst;
    this.last = Date.now();
  }

  take(n = 1): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return { ok: true };
    }
    const need = n - this.tokens;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((need / this.perMinute) * 60)) };
  }
}

export class RateLimiter {
  private buckets = new Map<string, { general: TokenBucket; runs: TokenBucket }>();

  constructor(
    private readonly apiPerMin: number,
    private readonly runsPerMin: number,
  ) {}

  check(key: string, kind: 'api' | 'run'): { ok: true } | { ok: false; retryAfterSec: number } {
    let b = this.buckets.get(key);
    if (!b) {
      b = { general: new TokenBucket(this.apiPerMin), runs: new TokenBucket(this.runsPerMin) };
      this.buckets.set(key, b);
    }
    return kind === 'run' ? b.runs.take() : b.general.take();
  }
}
