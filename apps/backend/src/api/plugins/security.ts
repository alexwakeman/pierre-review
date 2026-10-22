import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';

// ---------------------------------------------------------------------------
// Security headers + cross-origin request guard.
//
// Deliberately hand-rolled rather than @fastify/helmet: helmet would be a new
// runtime dependency that must also be threaded through the curated release
// manifest (scripts/build-release.mjs) and the pinned lockfile, and its default
// CSP is wrong for this app in three ways anyway (it forbids the inline styles
// vis-timeline and React both emit, it forbids the `https:` images every GitHub
// markdown body embeds). The header set below is the same posture, sized to this app.
//
// Everything here is computed ONCE at module load — the per-request hook only
// does a couple of string comparisons and reply.header() calls.
// ---------------------------------------------------------------------------

// `style-src 'unsafe-inline'` is unavoidable and accepted: React writes inline
// `style` attributes, vis-timeline positions every item by mutating element.style,
// and some components inject an inline <style>. CSS injection is
// a far weaker primitive than script injection, and script-src stays strict — no
// 'unsafe-inline', no 'unsafe-eval' (verified: neither vis-timeline, vis-data nor
// vis-util contains eval/new Function, so the timeline runs under this policy).
//
// `img-src https:` is required, not lax: PR/comment bodies are third-party markdown
// that legitimately embeds images from arbitrary hosts (user-content, camo, shields,
// gravatar). The markdown pipeline already strips javascript:/data: URLs via
// rehype-sanitize, so the residual risk is a tracking pixel, not code execution.
const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' https:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// API responses are JSON and are never a document. `default-src 'none'` means that
// even if a response body were somehow rendered as HTML (a content-sniffing browser,
// a `view-source`-style navigation, an error page), nothing in it can load or run.
const API_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

/**
 * Sets the response security headers on every request. Registered FIRST in app.ts so the
 * headers ride on every response including redirects, 404s and error bodies.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = pathOf(req);
    const isApi = path.startsWith('/api');

    // ---- Content-Security-Policy, per surface ----
    reply.header('Content-Security-Policy', isApi ? API_CSP : SPA_CSP);

    // ---- The rest, everywhere ----
    // nosniff: stops a browser deciding a JSON error body is HTML and rendering it.
    reply.header('X-Content-Type-Options', 'nosniff');
    // Clickjacking. CSP frame-ancestors above is the modern control; X-Frame-Options
    // is kept for older browsers that ignore it.
    reply.header('X-Frame-Options', 'DENY');
    // App URLs carry repo/PR ids in the query string — send the origin only, never
    // the path, to any cross-origin destination.
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', PERMISSIONS_POLICY);
    // Isolate the browsing context from anything this app opens (and vice-versa).
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');

    if (isApi) {
      // Block cross-origin no-cors embedding of API JSON (a <script src> / <img src>
      // side-channel). Applied to /api ONLY.
      reply.header('Cross-Origin-Resource-Policy', 'same-origin');
      // Never let PR data, feeds or account state land in a browser or proxy cache.
      // Nothing in the app relies on HTTP caching (React Query + IndexedDB do their
      // own caching at the application layer).
      reply.header('Cache-Control', 'no-store');
    }
  });
}

// ---------------------------------------------------------------------------
// Cross-origin request guard
// ---------------------------------------------------------------------------

/** The path with any query string stripped. */
function pathOf(req: FastifyRequest): string {
  return req.url.split('?')[0] ?? req.url;
}

/**
 * Origins allowed to make credentialed / state-changing calls to this instance.
 *
 * Any loopback origin, on any port. This is deliberately a set of PATTERNS rather than a
 * fixed list, because the app is reached from several ports that are not knowable here —
 * the Vite dev server (5173),
 * the isolated demo stack (5273), the packaged CLI serving the SPA from the API port
 * itself, and whatever PORT/BACKEND_PORT a user overrides. What it does NOT match is
 * the case that matters: a page on a real website (https://evil.example) that the
 * developer happens to have open while Pierre is running.
 *
 * ALLOWED_ORIGINS (comma-separated) adds extra origins for anything exotic.
 */
const EXTRA_ORIGINS: readonly string[] = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOOPBACK_HOSTNAMES.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin: string): boolean {
  const o = origin.replace(/\/$/, '');
  if (EXTRA_ORIGINS.includes(o)) return true;
  return isLoopbackOrigin(o);
}

/** The @fastify/cors `origin` option: the loopback allowlist. */
export function corsOriginDelegate(
  origin: string | undefined,
  cb: (err: Error | null, allow: boolean) => void,
): void {
  // No Origin header = a same-origin navigation or a non-browser client (curl, the
  // CLI). CORS has nothing to decide; the guard below handles the
  // state-changing case.
  if (!origin) return cb(null, true);
  cb(null, isAllowedOrigin(origin));
}

/**
 * Rejects state-changing /api requests that arrive from a foreign origin.
 *
 * This is NOT redundant with the CORS allowlist. CORS only governs whether the
 * browser lets the *attacker's page* READ the response — a "simple" cross-origin
 * POST (or a form submission, or a fetch with a non-preflighted content type) is
 * still DELIVERED and still EXECUTES on the server. In local mode that matters a
 * great deal, because there is no session cookie to miss: every request resolves to
 * the single local account, so a drive-by POST from any page the developer has open
 * would run as them — resolve review threads, trigger a paid AI run, add a repo.
 *
 * Detection prefers `Sec-Fetch-Site`, which every current browser sends and no page
 * can forge, and falls back to `Origin`. A request with neither (curl, a CI script)
 * is allowed: CSRF requires a browser, and blocking header-less clients
 * would break the CLI and every integration.
 */
export function registerCrossOriginGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = pathOf(req);
    if (!path.startsWith('/api/')) return;

    const method = req.method.toUpperCase();
    const mutating =
      method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    if (!mutating) return;

    // `Sec-Fetch-Site` is set by the browser, unforgeable by page script:
    //   same-origin / same-site → our own UI
    //   none                    → user-initiated (address bar, bookmark)
    //   cross-site              → another site caused this request
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string') {
      if (site === 'cross-site') await deny(reply, req, 'sec-fetch-site');
      return;
    }

    // Older/exotic browsers: fall back to Origin. Absent = not a cross-origin
    // browser request, so allow.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== 'null' && !isAllowedOrigin(origin)) {
      await deny(reply, req, 'origin');
    }
  });
}

async function deny(
  reply: FastifyReply,
  req: FastifyRequest,
  via: string,
): Promise<void> {
  req.log.warn(
    { path: pathOf(req), method: req.method, origin: req.headers.origin, via },
    'blocked cross-origin state-changing request',
  );
  // 403, not 401: the caller may be perfectly well authenticated — the problem is
  // where the request came from, and retrying with credentials will not help.
  await reply.code(403).send({
    error: 'Forbidden',
    message: 'Cross-origin request blocked.',
  });
}

// ---------------------------------------------------------------------------
// Host guard: DNS-rebinding defence
// ---------------------------------------------------------------------------

/**
 * The server binds 127.0.0.1, so nothing on the network can reach it directly — but
 * a hostname an attacker controls can be made to RESOLVE to 127.0.0.1 (DNS
 * rebinding), at which point their page is same-origin with the app and every
 * same-origin protection above evaporates. The defence is to check the Host header:
 * a rebound request still carries `Host: evil.example`, never `localhost`.
 *
 * Only applied when the server is actually bound to a loopback address. If a user
 * has deliberately set HOST to expose a local instance on their LAN, they need
 * arbitrary Host values to work, so the check stands down (and ALLOWED_HOSTS lets
 * them re-enable it for named hosts).
 */
const EXTRA_HOSTS: readonly string[] = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

export function registerHostGuard(app: FastifyInstance): void {
  const boundToLoopback = LOOPBACK_HOSTNAMES.has(config.host.toLowerCase());
  if (!boundToLoopback && EXTRA_HOSTS.length === 0) return;

  app.addHook('onRequest', async (req, reply) => {
    // Host may carry a port, and an IPv6 literal is bracketed: [::1]:4000.
    const raw = (req.headers.host ?? '').toLowerCase();
    const hostname = raw.startsWith('[')
      ? (raw.split(']')[0] ?? '') + ']'
      : (raw.split(':')[0] ?? '');
    if (LOOPBACK_HOSTNAMES.has(hostname) || EXTRA_HOSTS.includes(hostname)) return;
    // An absent Host header (HTTP/1.0, a raw socket probe) is not a browser doing
    // DNS rebinding — but it is also not something the app needs to serve.
    req.log.warn({ host: raw, path: pathOf(req) }, 'blocked unexpected Host header');
    await reply.code(421).send({
      error: 'MisdirectedRequest',
      message:
        'This instance only serves requests addressed to localhost. Set ALLOWED_HOSTS to permit another hostname.',
    });
  });
}
