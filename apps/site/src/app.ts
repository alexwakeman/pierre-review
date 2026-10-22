// The request handler for pierre-review.com.
//
//   /                  the prerendered landing (apps/landing/dist)
//   /demo/             the static demo build — an SPA, so unknown paths without a file
//                      extension fall back to its index.html. When no demo has been
//                      built, a short "coming soon" page.
//   /api/health        liveness, for Railway's health check
//   /api/contact/...   the contact form (contact.ts)
//
// Plain node:http, no framework: the whole surface is three routes and two folders.
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import {
  TicketSigner,
  buildContactMessage,
  normalizeContactWebhookUrl,
  postContactToSlack,
  validateContactBody,
} from './contact.js';
import { FixedWindowLimiter, clientIp } from './rate-limit.js';
import { applySecurity, isCrossSiteWrite } from './security.js';
import { cachePolicyFor, fileAt, safeJoin, sendFile } from './static.js';

export interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface SiteOptions {
  /** The built landing site (dist of apps/landing). */
  landingDir: string;
  /** The built demo app. Absent or empty ⇒ the "coming soon" page. */
  demoDir: string;
  /** CONTACT_SLACK_WEBHOOK_URL. Empty ⇒ the form reports itself unavailable. */
  contactWebhookUrl: string;
  /** CONTACT_TICKET_SECRET (or SESSION_SECRET). Null ⇒ a per-process random key. */
  ticketSecret: string | null;
  /** SITE_URL, e.g. https://pierre-review.com. Enables the www → apex redirect. */
  canonicalOrigin: string | null;
  /** HSTS_MAX_AGE seconds; 0 disables. */
  hstsMaxAge: number;
  /** TRUST_PROXY_HOPS: proxies in front of us that append to X-Forwarded-For. */
  trustProxyHops: number;
  logger: Logger;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Contact submissions and ticket mints per IP per hour. */
export const CONTACT_LIMIT = 5;
const HOUR = 60 * 60 * 1000;
/** A contact message is at most a few kB; anything larger is not one. */
const MAX_BODY_BYTES = 16 * 1024;

const COMING_SOON = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Limn demo — coming soon</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #fafaf8; color: #16161a; font: 17px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.6rem; margin: 0 0 1rem; letter-spacing: -0.02em; }
  code { font: 15px ui-monospace, Menlo, monospace; }
  a { color: inherit; text-decoration-color: #e2492c; }
</style>
</head>
<body>
<main>
  <h1>The demo is coming soon.</h1>
  <p>Limn is free and runs on your machine. Try it now with <code>npx limn-review</code>.</p>
  <p><a href="/">Back to the home page</a></p>
</main>
</body>
</html>
`;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const out = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(out));
  res.end(out);
}

function sendText(res: ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

/** Read a request body up to `limit` bytes; null when it is larger. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createSiteHandler(opts: SiteOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const now = opts.now ?? Date.now;
  const signer = new TicketSigner(opts.ticketSecret);
  const contactConfigured = normalizeContactWebhookUrl(opts.contactWebhookUrl) != null;
  const contactLimiter = new FixedWindowLimiter(CONTACT_LIMIT, HOUR);
  const log = opts.logger;

  function limited(req: IncomingMessage, res: ServerResponse): boolean {
    const ip = clientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, opts.trustProxyHops);
    const retryAfter = contactLimiter.consume(ip, now());
    if (retryAfter == null) return false;
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, {
      error: 'Too Many Requests',
      message: 'That is a few messages in a short time. Try again in a little while.',
    });
    return true;
  }

  async function handleContact(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (isCrossSiteWrite(req)) {
      log.warn({ origin: req.headers.origin }, 'contact form: cross-site request blocked');
      sendJson(res, 403, { error: 'Forbidden', message: 'Cross-origin request blocked.' });
      return;
    }
    if (limited(req, res)) return;
    if (!contactConfigured) {
      sendJson(res, 503, {
        error: 'contact_unavailable',
        message: 'The contact form is not available right now.',
      });
      return;
    }
    const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') {
      sendJson(res, 415, { error: 'Unsupported Media Type', message: 'Send the form as JSON.' });
      return;
    }
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw == null) {
      sendJson(res, 413, { error: 'Payload Too Large', message: 'That message is too long to send.' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf-8'));
    } catch {
      sendJson(res, 400, {
        error: 'Bad Request',
        message: 'That form did not arrive in one piece. Reload the page and try again.',
      });
      return;
    }
    const checked = validateContactBody(parsed);
    if (!checked.ok) {
      sendJson(res, 400, { error: 'Bad Request', message: checked.message });
      return;
    }
    const body = checked.body;
    const ip = clientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, opts.trustProxyHops);

    // Layer 1, the honeypot. Answered with the SUCCESS shape on purpose: a bot told it
    // failed learns which field to leave alone next time. A person never reaches this.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      log.info({ ip }, 'contact form: honeypot filled, dropped');
      sendJson(res, 200, { ok: true });
      return;
    }

    // Layer 2, the signed fill time.
    const verdict = signer.verify(body.ticket, now());
    if (verdict !== 'ok') {
      log.warn({ ip, verdict }, 'contact form: ticket rejected');
      sendJson(res, 400, {
        error: verdict === 'expired' ? 'ticket_expired' : 'ticket_invalid',
        message:
          verdict === 'expired'
            ? 'This form has been open for a while. Reload the page and send it again.'
            : 'We could not verify that form. Reload the page and try again.',
      });
      return;
    }

    try {
      await postContactToSlack(
        opts.contactWebhookUrl,
        buildContactMessage({
          name: body.name.trim(),
          email: body.email.trim(),
          topic: body.topic ?? 'other',
          message: body.message.trim(),
        }),
        opts.fetchImpl,
      );
    } catch (err) {
      // The submitter's words only exist in this request, so a failure here loses
      // them. Log enough to reconstruct the message by hand, and tell the visitor
      // plainly that it did not send.
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          from: body.name,
          email: body.email,
          topic: body.topic,
          message: body.message,
        },
        'contact form: delivery FAILED — the message is in this log line and nowhere else',
      );
      sendJson(res, 502, {
        error: 'delivery_failed',
        message: 'That did not send. Please try again in a minute.',
      });
      return;
    }

    log.info({ topic: body.topic ?? 'other' }, 'contact form: delivered');
    sendJson(res, 200, { ok: true });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (path === '/api/health') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === '/api/contact/ticket') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      if (limited(req, res)) return;
      // With no webhook configured it 503s here, so the page can say so BEFORE someone
      // writes two hundred words into a form with nowhere to send them.
      if (!contactConfigured) {
        sendJson(res, 503, { error: 'contact_unavailable' });
        return;
      }
      sendJson(res, 200, { ticket: signer.issue(now()) });
      return;
    }
    if (path === '/api/contact') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      await handleContact(req, res);
      return;
    }
    sendJson(res, 404, { error: 'Not Found' });
  }

  function methodNotAllowed(res: ServerResponse, allow: string): void {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  async function serveLanding(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const root = opts.landingDir;
    // A route is a folder with an index.html (prerender.mjs writes them that way); a
    // file is itself. Trailing slashes resolve to the same page.
    const direct = safeJoin(root, path);
    const candidates = [direct, direct && join(direct, 'index.html')];
    for (const file of candidates) {
      const st = fileAt(file ?? null);
      if (file && st) {
        await sendFile(req, res, file, st, { cache: cachePolicyFor(path, file) });
        return;
      }
    }
    const notFound = join(root, '404.html');
    const st = fileAt(notFound);
    if (st) {
      await sendFile(req, res, notFound, st, { status: 404, cache: 'html' });
      return;
    }
    sendText(res, 404, 'Not found');
  }

  async function serveDemo(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const indexFile = join(opts.demoDir, 'index.html');
    const index = fileAt(indexFile);
    if (!index) {
      res.setHeader('Cache-Control', 'no-cache');
      sendText(res, 200, req.method === 'HEAD' ? '' : COMING_SOON, 'text/html; charset=utf-8');
      return;
    }
    const rel = path.slice('/demo'.length) || '/';
    const file = safeJoin(opts.demoDir, rel);
    const st = fileAt(file);
    if (file && st) {
      await sendFile(req, res, file, st, { cache: cachePolicyFor(path, file) });
      return;
    }
    // SPA fallback for app routes. A missing FILE (a path with an extension) is a real
    // 404 — answering it with HTML would hand a script tag an HTML page.
    const last = rel.split('/').pop() ?? '';
    if (extname(last) !== '') {
      sendText(res, 404, 'Not found');
      return;
    }
    await sendFile(req, res, indexFile, index, { cache: 'html' });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    if (applySecurity(req, res, path, { canonicalOrigin: opts.canonicalOrigin, hstsMaxAge: opts.hstsMaxAge })) {
      return;
    }

    if (path === '/api' || path.startsWith('/api/')) {
      await handleApi(req, res, path);
      return;
    }

    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD');
      return;
    }

    if (path === '/demo') {
      // The demo's assets are relative to /demo/, so the slash is not optional.
      const query = url.slice(path.length);
      res.statusCode = 301;
      res.setHeader('Location', `/demo/${query}`);
      res.end();
      return;
    }
    if (path.startsWith('/demo/')) {
      await serveDemo(req, res, path);
      return;
    }
    await serveLanding(req, res, path);
  }

  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      log.error({ err: err instanceof Error ? err.message : String(err), url: req.url }, 'request failed');
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal Server Error' });
      else res.destroy();
    });
  };
}

/** Whether a directory looks like a built site (has an index.html). */
export function hasIndex(dir: string): boolean {
  return existsSync(join(dir, 'index.html'));
}
