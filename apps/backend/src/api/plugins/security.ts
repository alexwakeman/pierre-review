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
// markdown body embeds, and it knows nothing about the local/cloud split). The
// header set below is the same posture, sized to this app.
//
// Everything here is computed ONCE at module load — the per-request hook only
// does a couple of string comparisons and reply.header() calls.
// ---------------------------------------------------------------------------

// Google Tag Manager / GA4 endpoints. Analytics is CLOUD-ONLY (both analytics.ts
// callers gate on it) and now additionally consent-gated in the browser, so these
// only enter the CSP in cloud mode — a local install's CSP names no third party.
const GA_SCRIPT = 'https://www.googletagmanager.com';
const GA_CONNECT = [
  'https://www.google-analytics.com',
  'https://*.google-analytics.com',
  'https://*.analytics.google.com',
  'https://*.googletagmanager.com',
].join(' ');

// `style-src 'unsafe-inline'` is unavoidable and accepted: React writes inline
// `style` attributes, vis-timeline positions every item by mutating element.style,
// and the landing's splash-caret keyframes are an inline <style>. CSS injection is
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
  `script-src 'self'${config.isCloud ? ` ${GA_SCRIPT}` : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' https:",
  `connect-src 'self'${config.isCloud ? ` ${GA_CONNECT}` : ''}`,
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// The landing is a plain marketing page: no third-party images beyond its own
// assets, no embedded frames. Tighter than the SPA on purpose.
const LANDING_CSP = [
  "default-src 'self'",
  `script-src 'self' ${GA_SCRIPT}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  `connect-src 'self' ${GA_CONNECT}`,
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
 * Sets the response security headers on every request, plus (cloud only) HSTS and
 * the www → apex canonical redirect. Registered FIRST in app.ts so the headers ride
 * on every response including redirects, 404s and error bodies.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  // Cloud only: the canonical host, for the www redirect. hostname (not host) so a
  // configured port never enters the comparison.
  let canonicalHost = '';
  if (config.isCloud) {
    try {
      canonicalHost = new URL(config.appBaseUrl).hostname.toLowerCase();
    } catch {
      canonicalHost = '';
    }
  }

  app.addHook('onRequest', async (req, reply) => {
    const path = pathOf(req);
    const isApi = path.startsWith('/api');

    // ---- HSTS + canonical host (cloud only) ----
    // Local mode runs on http://127.0.0.1, where HSTS would wrongly pin localhost
    // to HTTPS and a www redirect is meaningless — so both stay cloud-gated.
    if (config.isCloud) {
      // Honored only over HTTPS (Railway terminates TLS); ignored on plain HTTP.
      // `includeSubDomains` also covers www. No `preload` — it is hard to undo.
      // HSTS_MAX_AGE=0 disables it.
      if (config.hstsMaxAge > 0) {
        reply.header(
          'Strict-Transport-Security',
          `max-age=${config.hstsMaxAge}; includeSubDomains`,
        );
      }
      // 301 www.<apex> → <apex> so the OAuth round-trip and the session cookie stay
      // on a single origin (and crawlers see one canonical URL).
      if (canonicalHost) {
        const host = (req.headers.host ?? '').toLowerCase().split(':')[0] ?? '';
        if (
          host !== canonicalHost &&
          host.replace(/^www\./, '') === canonicalHost
        ) {
          return reply.redirect(`${config.appBaseUrl}${req.url}`, 301);
        }
      }
    }

    // ---- Content-Security-Policy, per surface ----
    reply.header(
      'Content-Security-Policy',
      isApi ? API_CSP : path === '/app' || path.startsWith('/app/') ? SPA_CSP : LANDING_CSP,
    );

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
    // Safe here: OAuth is a top-level redirect, not a popup+postMessage handshake.
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');

    if (isApi) {
      // Block cross-origin no-cors embedding of API JSON (a <script src> / <img src>
      // side-channel). Applied to /api ONLY — the landing's og-image.png must stay
      // embeddable for link previews.
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
 * CLOUD: exactly the deployment's own origin.
 *
 * LOCAL: any loopback origin, on any port. This is deliberately a set of PATTERNS
 * rather than a fixed list, because local mode is reached from several ports that
 * are not knowable here — the Vite dev server (5173), the landing dev server (5174),
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
  return config.isCloud ? o === config.appBaseUrl : isLoopbackOrigin(o);
}

/** The @fastify/cors `origin` option: an allowlist in BOTH modes (was `true` locally). */
export function corsOriginDelegate(
  origin: string | undefined,
  cb: (err: Error | null, allow: boolean) => void,
): void {
  // No Origin header = a same-origin navigation or a non-browser client (curl, the
  // CLI, a webhook). CORS has nothing to decide; the guard below handles the
  // state-changing case.
  if (!origin) return cb(null, true);
  cb(null, isAllowedOrigin(origin));
}

// Server-to-server POSTs authenticated by an HMAC signature instead of an origin.
// GitHub and Stripe send no Origin and no Sec-Fetch-* headers, so they would pass
// the guard regardless — listed explicitly so that stays true by intent, not luck.
const GUARD_EXEMPT_PATHS = new Set([
  '/api/webhooks/github',
  '/api/billing/webhook',
]);

// GET routes that change server state and so need the same protection as a POST.
// /api/auth/reconnect revokes the GitHub grant and drops the session; the frontend
// reaches it as a same-origin <a href> navigation, so guarding it is free.
// NOT guarded: /api/auth/login and /api/billing/checkout — those are legitimately
// entered as cross-site top-level navigations (a link from the README, a bookmark).
const GUARDED_GET_PATHS = new Set(['/api/auth/reconnect']);

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
 * SameSite=Lax covers the cloud cookie case, but this closes the local hole and
 * gives cloud a second, independent layer.
 *
 * Detection prefers `Sec-Fetch-Site`, which every current browser sends and no page
 * can forge, and falls back to `Origin`. A request with neither (curl, a CI script,
 * a webhook) is allowed: CSRF requires a browser, and blocking header-less clients
 * would break the CLI and every integration.
 */
export function registerCrossOriginGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = pathOf(req);
    if (!path.startsWith('/api/')) return;
    if (GUARD_EXEMPT_PATHS.has(path)) return;

    const method = req.method.toUpperCase();
    const mutating =
      method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    if (!mutating && !GUARDED_GET_PATHS.has(path)) return;

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
// Host guard (local mode): DNS-rebinding defence
// ---------------------------------------------------------------------------

/**
 * Local mode binds 127.0.0.1, so nothing on the network can reach it directly — but
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
  if (config.isCloud) return;
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
