// Entry point: read the environment, start the HTTP server.
//
// Environment (all optional):
//   PORT                       listen port (Railway injects it). Default 4300.
//   HOST                       bind address. Default 0.0.0.0.
//   LANDING_DIR                built landing site. Default ../landing/dist.
//   DEMO_DIR                   built demo app. Default ../frontend/dist-demo.
//   CONTACT_SLACK_WEBHOOK_URL  Slack incoming webhook for the contact form. Unset ⇒ the
//                              form says it is unavailable.
//   CONTACT_TICKET_SECRET      signs the form's fill-time ticket. Falls back to
//                              SESSION_SECRET (its old name), then to a random key.
//   SITE_URL                   canonical origin, for the www → apex redirect.
//                              Falls back to APP_BASE_URL (its old name).
//   HSTS_MAX_AGE               seconds; 0 disables. Default 31536000.
//   TRUST_PROXY_HOPS           proxies in front that append to X-Forwarded-For
//                              (Railway: 1). Default 0 — the header is ignored.
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSiteHandler, hasIndex, type Logger } from './app.js';

const siteRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function line(level: string, obj: Record<string, unknown>, msg: string): void {
  process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), msg, ...obj })}\n`);
}

const logger: Logger = {
  info: (o, m) => line('info', o, m),
  warn: (o, m) => line('warn', o, m),
  error: (o, m) => line('error', o, m),
};

const landingDir = resolve(process.env.LANDING_DIR ?? join(siteRoot, '..', 'landing', 'dist'));
const demoDir = resolve(process.env.DEMO_DIR ?? join(siteRoot, '..', 'frontend', 'dist-demo'));
const canonical = (process.env.SITE_URL ?? process.env.APP_BASE_URL ?? '').trim().replace(/\/$/, '');

const handler = createSiteHandler({
  landingDir,
  demoDir,
  contactWebhookUrl: process.env.CONTACT_SLACK_WEBHOOK_URL ?? '',
  ticketSecret: process.env.CONTACT_TICKET_SECRET || process.env.SESSION_SECRET || null,
  canonicalOrigin: canonical || null,
  hstsMaxAge: intFromEnv('HSTS_MAX_AGE', 31536000),
  trustProxyHops: intFromEnv('TRUST_PROXY_HOPS', 0),
  logger,
});

const server = createServer(handler);
// Keep idle connections open for 72 s (the old Fastify default). Node's own default is
// 5 s, shorter than an edge proxy's idle pool timeout, so the proxy would reuse sockets
// we had just closed and the visitor would see a 502.
server.keepAliveTimeout = 72_000;
// headersTimeout stays above keepAliveTimeout, as Node expects.
server.headersTimeout = 75_000;
// The slow-loris guard: a whole request, headers included, has 30 s to arrive.
server.requestTimeout = 30_000;

const port = intFromEnv('PORT', 4300);
const host = process.env.HOST ?? '0.0.0.0';

server.listen(port, host, () => {
  logger.info(
    {
      port,
      host,
      landingDir,
      landing: hasIndex(landingDir),
      demoDir,
      demo: hasIndex(demoDir),
      contact: Boolean(process.env.CONTACT_SLACK_WEBHOOK_URL),
    },
    'site listening',
  );
  if (!hasIndex(landingDir)) {
    logger.warn({ landingDir }, 'no landing build found — run `pnpm --filter @pierre-review/landing build`');
  }
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  // Do not hang on a keep-alive socket.
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
