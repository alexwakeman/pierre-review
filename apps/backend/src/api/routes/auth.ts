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
    // Already signed in? The callback URL carries a one-time ?code= that GitHub
    // expires in ~10 min and invalidates on first use. A back-button, a restored
    // tab, or a Chrome profile switch can re-request this exact URL; re-running the
    // exchange would then fail on the already-consumed code ("code incorrect or
    // expired"). Short-circuit a valid session straight to the app instead.
    if (req.session.get('accountId') != null) {
      return reply.redirect('/app');
    }

    const { code, state } = req.query as { code?: string; state?: string };
    const rawCookie = req.cookies.pierre_oauth_state;
    const unsigned = rawCookie
      ? req.unsignCookie(rawCookie)
      : { valid: false as const, value: null };
    reply.clearCookie('pierre_oauth_state', { path: '/' });

    if (!code || !state || !unsigned.valid || unsigned.value !== state) {
      // Stale/replayed callback (state cookie expired or CSRF mismatch). Bounce
      // back so the user starts a fresh sign-in — never render raw JSON to a human.
      return reply.redirect('/app?auth=expired');
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
        req.log.warn(
          { err: json.error_description ?? json.error },
          'oauth token exchange returned no token',
        );
        return reply.redirect('/app?auth=failed');
      }
      token = json.access_token;
    } catch (err) {
      req.log.error({ err }, 'oauth token exchange request failed');
      return reply.redirect('/app?auth=error');
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
        req.log.warn({ status: res.status }, 'failed to fetch github user');
        return reply.redirect('/app?auth=failed');
      }
      user = (await res.json()) as GhUserResponse;
    } catch (err) {
      req.log.error({ err }, 'fetching github user failed');
      return reply.redirect('/app?auth=error');
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
