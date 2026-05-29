import type { FastifyError, FastifyInstance } from 'fastify';

// Centralised error handling: validation errors -> 400, anything with an
// explicit statusCode is honoured, everything else -> 500.
export function registerErrorHandler(app: FastifyInstance): void {
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
    reply.status(404).send({
      error: 'NotFound',
      message: `Route ${req.method} ${req.url} not found`,
    });
  });
}
