// Brings the @fastify/cookie + @fastify/secure-session module augmentations
// (request.cookies / request.unsignCookie / reply.setCookie / request.session)
// into scope project-wide. This is a declaration file — purely type-level, no
// runtime import — so the plugins themselves are still only loaded (dynamically)
// in cloud mode.
import '@fastify/cookie';
import '@fastify/secure-session';

// Type the sealed session payload so session.get/set('accountId') is type-safe.
declare module '@fastify/secure-session' {
  interface SessionData {
    accountId: number;
  }
}
