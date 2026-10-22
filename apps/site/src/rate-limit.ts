// A fixed-window rate limiter, in memory, keyed by client IP.
//
// The site runs as ONE process, so a Map is the whole store. The contact form is the
// only limited surface: its cost is a PERSON READING A MESSAGE, so the bucket is tight
// (five an hour, shared by the ticket mint and the submit).

export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /**
   * Count one request for `key`. Returns null when it is allowed, or the number of
   * seconds until the window resets when it is not.
   */
  consume(key: string, nowMs: number = Date.now()): number | null {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      entry = { count: 0, resetAt: nowMs + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > this.limit) {
      return Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000));
    }
    // Opportunistic sweep, so a flood of distinct IPs cannot grow the map for ever.
    if (this.hits.size > 10_000) this.sweep(nowMs);
    return null;
  }

  sweep(nowMs: number = Date.now()): void {
    for (const [k, v] of this.hits) if (v.resetAt <= nowMs) this.hits.delete(k);
  }
}

/**
 * The client's IP. Behind a proxy the socket address is the proxy's, so the address
 * comes from X-Forwarded-For — counted from the RIGHT, `trustedHops` entries in.
 *
 * ⚠ NEVER the leftmost entry. The client writes that one itself, so trusting it lets a
 * bot pick a fresh "IP" per request and walk straight past the limit. Each trusted
 * proxy APPENDS the address it saw, so the entry `trustedHops` from the end is the
 * one written by our own edge. With no proxy configured (`trustedHops` 0) the header
 * is ignored entirely.
 */
export function clientIp(
  forwardedFor: string | string[] | undefined,
  socketAddress: string | undefined,
  trustedHops: number,
): string {
  if (trustedHops > 0 && forwardedFor !== undefined) {
    const list = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const pick = list[list.length - trustedHops];
    if (pick) return pick;
  }
  return socketAddress ?? 'unknown';
}
