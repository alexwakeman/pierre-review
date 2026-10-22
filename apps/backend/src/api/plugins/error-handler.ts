import type { FastifyError, FastifyInstance } from 'fastify';

export interface NotFoundOptions {
  // The built timeline SPA is served (public/index.html present), under /app.
  serveSpa: boolean;
  // Root for reply.sendFile().
  publicDir: string;
}

// Centralised error handling + the single not-found handler (Fastify allows one
// per context). The not-found handler doubles as the SPA router:
//   /api/* unknown          → JSON 404
//   /app, /app/* (GET)      → the timeline SPA index (client routing / reload)
//   /, other non-/api (GET) → 302 → /app (when the SPA is served)
export function registerErrorHandler(app: FastifyInstance, opts: NotFoundOptions): void {
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
    // The operator IS the caller (the server runs on their own machine), so the real message is
    // passed through for every status: a developer debugging their own instance should not have
    // to go and read the terminal.
    reply.status(status).send({
      error: err.name || 'Error',
      message: err.message,
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

    if (req.method === 'GET' && opts.serveSpa) {
      // The SPA lives under /app — serve its index for any unmatched /app path so
      // deep-links and reloads work.
      if (path === '/app' || path.startsWith('/app/')) {
        return reply.sendFile('index.html', opts.publicDir);
      }
      // Root + other non-/api paths: straight into the app.
      return reply.redirect('/app/');
    }

    return reply.status(404).send({
      error: 'NotFound',
      message: `Route ${req.method} ${req.url} not found`,
    });
  });
}
