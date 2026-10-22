// Security headers for pierre-review.com. Ported from the cloud branch of the old
// backend plugin (apps/backend/src/api/plugins/security.ts): the same CSP for the
// landing, a CSP for the demo app, a locked-down one for /api, HSTS and the
// www → apex redirect. Everything is computed once; the per-request work is a few
// string comparisons.
import type { IncomingMessage, ServerResponse } from 'node:http';

// Google Analytics 4 endpoints. Analytics is consent-gated in the browser (gtag.js is
// never fetched before the visitor accepts), so naming them here allows the script
// only once the page asks for it.
const GA_SCRIPT = 'https://www.googletagmanager.com';
const GA_CONNECT = [
  'https://www.google-analytics.com',
  'https://*.google-analytics.com',
  'https://*.analytics.google.com',
  'https://*.googletagmanager.com',
].join(' ');

/**
 * The landing: a plain marketing site. No third-party images, no frames, fonts
 * self-hosted (`font-src 'self'` — a Google Fonts link would be blocked, which is
 * deliberate: it would disclose every visitor's IP to Google before consent).
 * `style-src 'unsafe-inline'` is for React's inline style attributes; script-src stays
 * strict. The walkthrough video under /media/ is same-origin, so `default-src 'self'`
 * covers it.
 */
export const LANDING_CSP = [
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

/**
 * The demo at /demo/: a static build of the real app, so it gets the app's policy —
 * `img-src https:` because sample avatars and markdown bodies embed remote images,
 * `blob:` workers, and inline styles (vis-timeline positions every item by writing
 * element.style). Still no 'unsafe-inline' / 'unsafe-eval' for scripts.
 */
export const DEMO_CSP = [
  "default-src 'self'",
  `script-src 'self' ${GA_SCRIPT}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' https:",
  `connect-src 'self' ${GA_CONNECT}`,
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** API responses are JSON, never a document: nothing in one may load or run. */
export const API_CSP = [
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

export function cspFor(path: string): string {
  if (path === '/api' || path.startsWith('/api/')) return API_CSP;
  if (path === '/demo' || path.startsWith('/demo/')) return DEMO_CSP;
  return LANDING_CSP;
}

export interface SecurityOptions {
  /** e.g. https://pierre-review.com — enables the www → apex redirect. */
  canonicalOrigin: string | null;
  /** 0 disables HSTS. */
  hstsMaxAge: number;
}

/**
 * Apply the headers. Returns true when the request was answered here (the www
 * redirect) and the caller must stop.
 */
export function applySecurity(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  opts: SecurityOptions,
): boolean {
  if (opts.hstsMaxAge > 0) {
    // Honoured only over HTTPS (Railway terminates TLS); ignored on plain HTTP, so it is
    // harmless on a local run. No `preload` — it is hard to undo.
    res.setHeader('Strict-Transport-Security', `max-age=${opts.hstsMaxAge}; includeSubDomains`);
  }

  if (opts.canonicalOrigin) {
    let canonicalHost = '';
    try {
      canonicalHost = new URL(opts.canonicalOrigin).hostname.toLowerCase();
    } catch {
      canonicalHost = '';
    }
    const host = (req.headers.host ?? '').toLowerCase().split(':')[0] ?? '';
    if (canonicalHost && host !== canonicalHost && host === `www.${canonicalHost}`) {
      res.statusCode = 301;
      res.setHeader('Location', `${opts.canonicalOrigin.replace(/\/$/, '')}${req.url ?? '/'}`);
      res.end();
      return true;
    }
  }

  res.setHeader('Content-Security-Policy', cspFor(path));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  if (path === '/api' || path.startsWith('/api/')) {
    // Block cross-origin no-cors embedding of API JSON. /api only — og-image.png must
    // stay embeddable for link previews.
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
  }
  return false;
}

/**
 * Refuse a state-changing request caused by another site. `Sec-Fetch-Site` is set by
 * the browser and cannot be forged by page script; `Origin` is the fallback. A request
 * with neither (curl, a script) is allowed — CSRF needs a browser.
 */
export function isCrossSiteWrite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site === 'cross-site';
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    return new URL(origin).host.toLowerCase() !== (req.headers.host ?? '').toLowerCase();
  } catch {
    return true;
  }
}
