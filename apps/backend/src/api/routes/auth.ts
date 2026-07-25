import { randomBytes } from 'node:crypto';
import type { AuthProvidersResponse } from '@pierre-review/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../../config.js';
import { encryptToken } from '../../auth/crypto.js';
import { getAccessToken, upsertCloudAccount } from '../../auth/account.js';

// Revoke the OAuth App's grant for a user's token (Basic auth = the app's own id/secret). This
// forces the NEXT authorize to re-show consent — which is what re-injects the SAML SSO step; a
// silent re-issue would skip it and re-mint a still-de-authorized token. 404 = already gone.
async function revokeOAuthGrant(token: string): Promise<void> {
  const basic = Buffer.from(
    `${config.githubOAuthClientId}:${config.githubOAuthClientSecret}`,
  ).toString('base64');
  const res = await fetch(
    `https://api.github.com/applications/${config.githubOAuthClientId}/grant`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Basic ${basic}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ access_token: token }),
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`revoke grant -> ${res.status}`);
  }
}

// GitHub sign-in routes (cloud only). TWO providers are supported side by side; a deployment
// enables either or both (config.oauthProviderEnabled / appProviderEnabled) and the SignInGate
// offers whatever's set:
//   • 'oauth' — a traditional OAuth App: user-scoped token, NO install, `config.oauthScope`
//     (public repos incl. CI checks). A GitHub App IGNORES a scope param; an OAuth App honours it.
//   • 'app'   — a GitHub App user token: private repos need the App INSTALLED where they live.
// Both share GitHub's authorize/token endpoints; only the credential (and whether a scope is
// sent) differs. The chosen provider is folded into the CSRF `state` (`<provider>.<nonce>`) so
// the single callback exchanges the code against the MATCHING client id/secret.

type Provider = 'oauth' | 'app';

interface OAuthTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GhUserResponse {
  login: string;
  node_id: string;
  name: string | null;
  avatar_url: string | null;
}

// Per-provider credential + the scope to request (empty for the GitHub App).
function providerCredentials(
  provider: Provider,
): { clientId: string; clientSecret: string; scope: string; enabled: boolean } {
  return provider === 'app'
    ? {
        clientId: config.githubAppClientId,
        clientSecret: config.githubAppClientSecret,
        scope: '',
        enabled: config.appProviderEnabled,
      }
    : {
        clientId: config.githubOAuthClientId,
        clientSecret: config.githubOAuthClientSecret,
        scope: config.oauthScope,
        enabled: config.oauthProviderEnabled,
      };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const redirectUri = `${config.appBaseUrl}/api/auth/callback`;
  const secureCookie = config.appBaseUrl.startsWith('https://');
  // The default provider for the bare /api/auth/login link (landing/billing CTAs): prefer the
  // frictionless OAuth App; fall back to the GitHub App if that's the only one configured.
  const defaultProvider: Provider = config.oauthProviderEnabled ? 'oauth' : 'app';

  // Which sign-in methods this deployment offers — read by the (signed-out) SignInGate to render
  // the right button(s), and by the SIGNED-IN Settings "GitHub App" section, which needs the slug
  // to build the install link (signing in via the App does NOT install it — see
  // docs/REALTIME-SYNC.md). Unauthenticated: it sits under the /api/auth/* auth-gate exemption.
  app.get('/api/auth/providers', async (): Promise<AuthProvidersResponse> => ({
    oauth: config.oauthProviderEnabled,
    app: config.appProviderEnabled,
    // Slug drives the install link on the gate + in Settings; only meaningful with the App.
    appSlug: config.appProviderEnabled ? config.githubAppSlug : '',
  }));

  const startLogin = (provider: Provider, reply: FastifyReply): FastifyReply => {
    const cred = providerCredentials(provider);
    if (!cred.enabled) return reply.redirect('/app?auth=unavailable');
    // Fold the provider into the state so the callback knows which credential to exchange with.
    const state = `${provider}.${randomBytes(16).toString('hex')}`;
    reply.setCookie('pierre_oauth_state', state, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      signed: true,
      maxAge: 600,
    });
    const params = new URLSearchParams({
      client_id: cred.clientId,
      redirect_uri: redirectUri,
      state,
    });
    if (cred.scope) params.set('scope', cred.scope);
    return reply.redirect(
      `https://github.com/login/oauth/authorize?${params.toString()}`,
    );
  };

  // Explicit provider choice (the SignInGate's two buttons).
  app.get<{ Params: { provider: string } }>(
    '/api/auth/login/:provider',
    async (req, reply) => {
      const provider: Provider = req.params.provider === 'app' ? 'app' : 'oauth';
      return startLogin(provider, reply);
    },
  );

  // Bare login (landing / billing CTAs). When BOTH providers are configured, don't silently
  // pick one — bounce to the in-app sign-in gate so the user explicitly chooses OAuth App vs
  // GitHub App. When only one is configured there's no choice to make, so go straight to it.
  app.get('/api/auth/login', async (_req, reply) => {
    if (config.oauthProviderEnabled && config.appProviderEnabled) {
      return reply.redirect('/app');
    }
    return startLogin(defaultProvider, reply);
  });

  // "Reconnect GitHub" (the SAML-block banner action): revoke this app's grant so the re-auth
  // shows FRESH consent — forcing the SAML SSO step that a silent re-issue would skip — then
  // clear our session (so the callback re-runs the code exchange, not the already-signed-in
  // short-circuit) and start a fresh OAuth login. Best-effort revoke: even if it fails, the
  // re-login can still succeed if the user's SAML session is active.
  app.get('/api/auth/reconnect', async (req, reply) => {
    const accountId = req.session.get('accountId');
    if (accountId != null) {
      try {
        await revokeOAuthGrant(await getAccessToken(accountId));
      } catch (err) {
        req.log.warn({ err }, 'reconnect: grant revoke failed, continuing to re-auth');
      }
      req.session.delete();
    }
    return startLogin('oauth', reply);
  });

  // Verify state → exchange code for a token (against the state's provider) → fetch the user →
  // upsert account → set session → 302 to the app.
  app.get('/api/auth/callback', async (req, reply) => {
    // Already signed in? The callback URL carries a one-time ?code= that GitHub expires in
    // ~10 min and invalidates on first use. A back-button, a restored tab, or a Chrome profile
    // switch can re-request this exact URL; re-running the exchange would then fail on the
    // already-consumed code. Short-circuit a valid session straight to the app instead.
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
      // Stale/replayed callback (state cookie expired or CSRF mismatch). Bounce back so the
      // user starts a fresh sign-in — never render raw JSON to a human.
      return reply.redirect('/app?auth=expired');
    }

    // The provider chosen at /login is encoded in the state; pick the matching credential.
    const provider: Provider = state.startsWith('app.') ? 'app' : 'oauth';
    const cred = providerCredentials(provider);

    // Exchange the code for a user access token.
    let token: string;
    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: cred.clientId,
          client_secret: cred.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const json = (await res.json()) as OAuthTokenResponse;
      if (!json.access_token) {
        req.log.warn(
          { err: json.error_description ?? json.error, provider },
          'oauth token exchange returned no token',
        );
        return reply.redirect('/app?auth=failed');
      }
      token = json.access_token;
    } catch (err) {
      req.log.error({ err, provider }, 'oauth token exchange request failed');
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
      displayName: user.name ?? null,
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
