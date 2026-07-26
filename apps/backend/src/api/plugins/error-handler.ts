import type { FastifyError, FastifyInstance } from 'fastify';
import { config } from '../../config.js';

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
