// SIGNING LIMN'S OWN CODEX HOME IN AND OUT (docs/CODEX-PLAN.md § 6: one extra sign-in, from Settings
// or `limn ai login codex`). The SPA's route drives it through `codex app-server`
// (`account/login/start` → `account/login/completed`), which is `codex login` with structured
// progress: the browser flow answers the URL to open, the device flow the code to type, and the
// completion arrives as a notification — no scraping of a terminal program's output. The CLI
// (`limn ai login codex`, cli.ts) runs `codex login` itself, with CODEX_HOME set and the terminal
// attached.
//
// ⚠ An API KEY IS NEVER STORED. `codex login --with-api-key` would write the key into Limn's home;
// Limn's rule is "no stored key" (CLAUDE.md, the credential ladder), so the API-key rung reads
// OPENAI_API_KEY from the environment at run time (ai/credentials.ts `codexRunEnv`).
//
// One sign-in at a time per process. The app-server process is kept alive while the reader signs in
// (it hosts the browser flow's callback server) and stopped on completion, cancel or timeout.
import type { CodexLoginMethod, CodexLoginState } from '@pierre-review/shared';
import { codexBinaryPath } from '../runtime.js';
import { CodexAppServer, invalidateCodexState, limnAppServerOptions, withCodexAppServer } from './app-server.js';
import { CODEX_NOT_INSTALLED_MESSAGE, ensureCodexHomeConfig } from './home.js';

export type { CodexLoginMethod, CodexLoginState };

/** A sign-in the reader never finishes is stopped after this long. */
export const CODEX_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

interface Session {
  server: CodexAppServer;
  loginId: string | null;
  timer: NodeJS.Timeout;
}

let state: CodexLoginState = { state: 'idle' };
let session: Session | null = null;
// The start in flight, TAGGED with its generation: a POST joins it only while it is still the current
// one. ⚠ A start that a cancel overtook keeps running until it notices; a new sign-in must not join it
// (it would answer the cancelled state), and its `finally` must not clear a NEWER start's slot.
let starting: { gen: number; promise: Promise<CodexLoginState> } | null = null;
// ⚠ Bumped by every cancel (and every start). A start that awaits across a cancel finds a different
// number when it resumes and touches NOTHING — no session, no state — so a "cancelled" sign-in can
// neither come back to life as `waiting` nor be overwritten as `failed` by the start it cancelled.
let generation = 0;

/** The sign-in's state, for the SPA's poll. */
export function codexLoginState(): CodexLoginState {
  return state;
}

function endSession(): void {
  if (!session) return;
  clearTimeout(session.timer);
  session.server.close();
  session = null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Start a sign-in (or join the one running). Resolves the `waiting` state with what the reader must
 * open, or `failed` with one sentence. Never throws.
 */
export function startCodexLogin(method: CodexLoginMethod, opts: { timeoutMs?: number } = {}): Promise<CodexLoginState> {
  if (starting && starting.gen === generation) return starting.promise;
  if (session && state.state === 'waiting') return Promise.resolve(state);
  const gen = ++generation;
  const current = (): boolean => gen === generation;
  const promise = (async (): Promise<CodexLoginState> => {
    const spawnOpts = limnAppServerOptions();
    if (!spawnOpts) return (state = { state: 'failed', message: CODEX_NOT_INSTALLED_MESSAGE });
    let server: CodexAppServer | null = null;
    try {
      // The home must hold file-store auth BEFORE the sign-in writes anything.
      await ensureCodexHomeConfig(null);
      if (!current()) return state; // cancelled meanwhile
      server = await CodexAppServer.start(spawnOpts);
      if (!current()) {
        server.close();
        return state;
      }
      const own = server;
      const timer = setTimeout(() => {
        void cancelCodexLogin('The sign-in took too long and was stopped. Try again.');
      }, opts.timeoutMs ?? CODEX_LOGIN_TIMEOUT_MS);
      session = { server, loginId: null, timer };
      server.on('account/login/completed', (params) => {
        if (session?.server !== own) return; // a cancelled (or replaced) sign-in's late answer
        const p = (params ?? {}) as { success?: unknown; error?: unknown; loginId?: unknown };
        if (session?.loginId && str(p.loginId) && p.loginId !== session.loginId) return; // another flow's
        state =
          p.success === true
            ? { state: 'done' }
            : { state: 'failed', message: str(p.error) ?? 'The Codex sign-in did not finish. Try again.' };
        endSession();
        void invalidateCodexState();
      });
      void server.exited.then(() => {
        if (session?.server === own && state.state === 'waiting') {
          state = { state: 'failed', message: 'Codex stopped before the sign-in finished. Try again.' };
          endSession();
        }
      });
      const res = (await server.request('account/login/start', {
        type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt',
      })) as Record<string, unknown> | null;
      if (!current() || session?.server !== own) return state; // cancelled while it started
      session.loginId = str(res?.loginId);
      state = {
        state: 'waiting',
        method,
        authUrl: str(res?.authUrl),
        verificationUrl: str(res?.verificationUrl),
        userCode: str(res?.userCode),
        startedAt: new Date().toISOString(),
      };
      if (!state.authUrl && !state.verificationUrl) {
        endSession();
        state = { state: 'failed', message: 'Codex did not say where to sign in. Try again, or run: limn ai login codex' };
      }
      return state;
    } catch (err) {
      // A start the reader cancelled fails BECAUSE of the cancel (its server was closed): the cancel's
      // state stands, and the session (if any) is the cancel's to have ended, not ours.
      if (!current()) {
        if (server && session?.server !== server) server.close();
        return state;
      }
      endSession();
      return (state = { state: 'failed', message: `The Codex sign-in could not start: ${(err as Error).message}` });
    }
  })().finally(() => {
    if (starting?.gen === gen) starting = null;
  });
  starting = { gen, promise };
  return promise;
}

/** Stop a running sign-in. `message` set ⇒ it ends as `failed` with it; otherwise back to idle. */
export async function cancelCodexLogin(message?: string): Promise<CodexLoginState> {
  generation++; // a start still in flight now owns nothing (see `generation`)
  const s = session;
  if (s) {
    if (s.loginId) await s.server.request('account/login/cancel', { loginId: s.loginId }, 5_000).catch(() => {});
    endSession();
  }
  state = message ? { state: 'failed', message } : { state: 'idle' };
  return state;
}

/** Sign Limn's Codex home out (`account/logout`). Resolves null on success, else one sentence. */
export async function codexLogout(): Promise<string | null> {
  if (!codexBinaryPath()) return CODEX_NOT_INSTALLED_MESSAGE;
  const spawnOpts = limnAppServerOptions();
  if (!spawnOpts) return CODEX_NOT_INSTALLED_MESSAGE;
  await cancelCodexLogin();
  try {
    await withCodexAppServer((s) => s.request('account/logout', null), spawnOpts);
    return null;
  } catch (err) {
    return `Codex could not sign out: ${(err as Error).message}`;
  } finally {
    state = { state: 'idle' };
    void invalidateCodexState();
  }
}

/** Test hook. */
export function _resetCodexLoginForTest(): void {
  generation++;
  endSession();
  state = { state: 'idle' };
  starting = null;
}
