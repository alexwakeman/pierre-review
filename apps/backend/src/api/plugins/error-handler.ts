import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyError, FastifyInstance } from 'fastify';
import { config } from '../../config.js';

/**
 * The landing routes that shipped as prerendered HTML, discovered once at boot.
 *
 * The marketing site is built to `<route>/index.html` per route (apps/landing/
 * prerender.mjs) so that a crawler, an AI agent or a no-JS visitor receives real
 * content instead of an empty SPA shell. @fastify/static — registered with
 * `wildcard: false` — already answers `/pricing/` from its directory-index scan,
 * but NOT `/pricing`, which is the canonical, link-shaped form. Those land here.
 *
 * Resolved into a fixed Set at startup rather than stat-ing per request: it costs
 * one readdir instead of a filesystem hit on every 404, and — the reason that
 * matters — a URL can only ever select an entry that was found on disk at boot,
 * so no request-supplied path is ever joined onto a filesystem root. Traversal
 * is not defended against here; it is unrepresentable.
 */
function prerenderedRoutes(landingDir: string): Set<string> {
  const routes = new Set<string>();
  if (!existsSync(landingDir)) return routes;
  for (const entry of readdirSync(landingDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(landingDir, entry.name, 'index.html'))) {
      routes.add(`/${entry.name}`);
    }
  }
  return routes;
}

export interface NotFoundOptions {
  // The built timeline SPA is served (public/index.html present), under /app.
  serveSpa: boolean;
  // The built landing page is served (cloud mode, public-landing/index.html), at /.
  serveLanding: boolean;
  // Roots for reply.sendFile() overrides (two @fastify/static instances share one
  // decorated sendFile, so the root must be passed explicitly).
  publicDir: string;
  publicLandingDir: string;
}

// Centralised error handling + the single not-found handler (Fastify allows one
// per context). The not-found handler doubles as the SPA/landing router:
//   /api/* unknown          → JSON 404 (both modes)
//   /app, /app/* (GET)      → the timeline SPA index (client routing / reload)
//   /, other non-/api (GET) → cloud: the landing page; local: 302 → /app
export function registerErrorHandler(
  app: FastifyInstance,
  opts: NotFoundOptions,
): void {
  const landingRoutes = opts.serveLanding
    ? prerenderedRoutes(opts.publicLandingDir)
    : new Set<string>();

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) {
      reply.status(400).send({
        error: 'ValidationError',
        message: err.message,
        details: err.validation,
      });
      return;
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
    }

    // 5xx bodies are GENERIC. A 500 is an unhandled throw, so `err.message` is whatever the
    // failing layer happened to say — and the layers under these routes talk to Postgres,
    // SQLite, the GitHub GraphQL/REST APIs, Stripe and Anthropic. Their error text routinely
    // carries query fragments and column names, absolute filesystem paths, connection
    // strings, and upstream response bodies. None of that helps a caller (there is nothing
    // they can do about it) and all of it helps an attacker map the internals, so it goes to
    // the log — which the operator can read, and which redacts credentials — and not to the
    // wire. 4xx messages are deliberate, author-written text (validation detail, "PR not
    // found", "already running") and stay as-is, because they are the API's contract.
    //
    // In local mode the operator IS the caller, so the real message is passed through: there
    // is no attacker to withhold it from, and a developer debugging their own instance should
    // not have to go and read the terminal.
    const expose = status < 500 || !config.isCloud;
    reply.status(status).send({
      error: expose ? err.name || 'Error' : 'InternalServerError',
      message: expose
        ? err.message
        : 'Something went wrong on our end. The error has been logged.',
    });
  });

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;

    // Unknown API routes always return a JSON 404 (never an HTML page).
    if (path.startsWith('/api')) {
      return reply.status(404).send({
        error: 'NotFound',
        message: `Route ${req.method} ${req.url} not found`,
      });
    }

    if (req.method === 'GET') {
      // The SPA lives under /app — serve its index for any unmatched /app path so
      // deep-links and reloads work.
      if (opts.serveSpa && (path === '/app' || path.startsWith('/app/'))) {
        return reply.sendFile('index.html', opts.publicDir);
      }
      // Root + other non-/api paths: cloud serves the public landing page; local
      // sends the user straight into the app (never shows a landing).
      if (opts.serveLanding) {
        // Prefer the route's own prerendered file, so /pricing answers with the
        // pricing copy and its own <title>/canonical rather than the generic shell
        // (which only becomes the pricing page once JavaScript runs). Trailing
        // slash tolerated; '/' and anything unknown fall back to the shell, which
        // still client-routes correctly for a browser.
        const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
        if (landingRoutes.has(clean)) {
          return reply.sendFile(`${clean.slice(1)}/index.html`, opts.publicLandingDir);
        }
        return reply.sendFile('index.html', opts.publicLandingDir);
      }
      if (opts.serveSpa) {
        return reply.redirect('/app/');
      }
    }

    return reply.status(404).send({
      error: 'NotFound',
      message: `Route ${req.method} ${req.url} not found`,
    });
  });
}
