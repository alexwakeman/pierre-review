import type { FastifyError, FastifyInstance } from 'fastify';

// Centralised error handling: validation errors -> 400, anything with an
// explicit statusCode is honoured, everything else -> 500.
//
// `spaFallback` is set in single-process production mode (when the built SPA is
// served alongside the API). Fastify allows only one not-found handler per
// context, so the SPA fallback lives here rather than as a second
// setNotFoundHandler in app.ts.
export function registerErrorHandler(app: FastifyInstance, spaFallback = false): void {
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
    reply.status(status).send({
      error: err.name || 'Error',
      message: err.message,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    // SPA fallback: any non-/api GET that didn't match a static asset returns
    // index.html so client-side routes work on reload. Unknown /api routes still
    // return JSON 404 (below). `reply.sendFile` is decorated by @fastify/static.
    if (spaFallback && req.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({
      error: 'NotFound',
      message: `Route ${req.method} ${req.url} not found`,
    });
  });
}
