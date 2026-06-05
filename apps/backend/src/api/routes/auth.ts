import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { encryptToken } from '../../auth/crypto.js';
import { upsertCloudAccount } from '../../auth/account.js';

// GitHub App OAuth (user-to-server) sign-in routes. Registered only in cloud
// mode. The state cookie is a short-lived signed cookie (CSRF); the session is a
// sealed cookie holding { accountId }.

interface OAuthTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GhUserResponse {
  login: string;
  node_id: string;
  avatar_url: string | null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const redirectUri = `${config.appBaseUrl}/api/auth/callback`;
  const secureCookie = config.appBaseUrl.startsWith('https://');

  // 302 → GitHub authorize, with a CSRF state in a short-lived signed cookie.
  app.get('/api/auth/login', async (_req, reply) => {
    const state = randomBytes(16).toString('hex');
    reply.setCookie('pierre_oauth_state', state, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      signed: true,
      maxAge: 600,
    });
    const params = new URLSearchParams({
      client_id: config.githubAppClientId,
      redirect_uri: redirectUri,
      state,
    });
    return reply.redirect(
      `https://github.com/login/oauth/authorize?${params.toString()}`,
    );
  });

  // Verify state → exchange code for a token → fetch the user → upsert account →
  // set session → 302 to the app.
  app.get('/api/auth/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const rawCookie = req.cookies.pierre_oauth_state;
    const unsigned = rawCookie
      ? req.unsignCookie(rawCookie)
      : { valid: false as const, value: null };
    reply.clearCookie('pierre_oauth_state', { path: '/' });

    if (!code || !state || !unsigned.valid || unsigned.value !== state) {
      return reply
        .code(400)
        .send({ error: 'BadRequest', message: 'Invalid or expired OAuth state.' });
    }

    // Exchange the code for a user access token.
    let token: string;
    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: config.githubAppClientId,
          client_secret: config.githubAppClientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const json = (await res.json()) as OAuthTokenResponse;
      if (!json.access_token) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: `OAuth token exchange failed: ${json.error_description ?? json.error ?? 'no token'}`,
        });
      }
      token = json.access_token;
    } catch (err) {
      return reply.code(502).send({
        error: 'GitHubError',
        message: `OAuth exchange request failed: ${err instanceof Error ? err.message : err}`,
      });
    }

    // Identify the user.
    let user: GhUserResponse;
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          authorization: `token ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!res.ok) {
        return reply
          .code(401)
          .send({ error: 'Unauthorized', message: 'Failed to fetch GitHub user.' });
      }
      user = (await res.json()) as GhUserResponse;
    } catch (err) {
      return reply.code(502).send({
        error: 'GitHubError',
        message: `Fetching GitHub user failed: ${err instanceof Error ? err.message : err}`,
      });
    }

    const account = await upsertCloudAccount({
      githubUserId: user.node_id,
      githubLogin: user.login,
      avatarUrl: user.avatar_url,
      accessTokenEnc: encryptToken(token),
    });

    req.session.set('accountId', account.id);
    return reply.redirect('/app');
  });

  // Clear the session.
  app.post('/api/auth/logout', async (req, reply) => {
    req.session.delete();
    return reply.code(204).send();
  });
}
