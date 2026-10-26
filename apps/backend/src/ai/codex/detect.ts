// CODEX DETECTION AND ITS USAGE SOURCE — what the provider seam's `detect()`, `credentialRoute()` and
// `usage` answer for Codex (docs/CODEX-PLAN.md § 3.1, § 8.1). Installed (the first-use download, or
// LIMN_CODEX_PATH)? Signed in (Limn's own home, by `account/read`)? Which plan? Which credential rung?
//
// Every answer here is a fact about the install and the sign-in. Whether Codex can RUN is decided
// above this (`codexRunnable()`, true since Phase 3 completed, plus a ChatGPT sign-in).
import type { AiUsageReading } from '@pierre-review/shared';
import { config } from '../../config.js';
import { codexCredentialRunnable, resolveCodexCredential } from '../credentials.js';
import type { ProviderUsageSource } from '../provider.js';
import { codexBinaryPath, getCodexRuntimeStatus, type AiRuntimeState } from '../runtime.js';
import {
  codexAccount,
  codexSignedInCached,
  codexStateCached,
  kickCodexProbe,
  limnAppServerOptions,
  probeCodexAccount,
} from './app-server.js';
import { CODEX_NOT_INSTALLED_MESSAGE } from './home.js';
import { readingFromCodexRateLimits } from './readings.js';

/** The one line shown when Codex is installed but nothing can pay for a run. */
export const NO_CODEX_AUTH_MESSAGE = 'Sign in to Codex with ChatGPT: limn ai login codex';

/**
 * ⚠ The API-key route is REFUSED until Limn can price it (ai/providers/codex.ts CODEX_PRICES_PER_MTOK
 * is all null): a run there would record US$ 0, so the api_key budget and every per-pass US$ cap would
 * never trip. Shown wherever that route is the one a run would take.
 */
export const CODEX_API_KEY_NOT_AVAILABLE_MESSAGE =
  'Codex with an OpenAI API key is not available yet — sign in with ChatGPT';

/**
 * auth.json is in Limn's home but no `account/read` has said what KIND of sign-in it is (and the file
 * does not say). FAIL CLOSED: nothing runs on it (ai/credentials.ts `codexCredentialRunnable`).
 */
export const CODEX_SIGN_IN_UNCHECKED_MESSAGE = 'Limn could not check the Codex sign-in yet — try again in a moment';

export interface CodexDetail {
  /** The Codex program is there (the download, or LIMN_CODEX_PATH). */
  installed: boolean;
  runtime: AiRuntimeState;
  runtimeMessage: string | null;
  /** Limn's Codex home holds a live sign-in (ChatGPT, or a key stored there by hand). */
  signedIn: boolean;
  /** The ChatGPT plan ('plus', 'pro', …), when signed in with one. */
  plan: string | null;
  /** The credential rung a run would use. */
  route: 'login' | 'api_key' | 'none';
  /** A run may start: installed, and a sign-in KNOWN to be ChatGPT (never the refused key route,
   *  never a sign-in whose kind is not known yet). */
  runnable: boolean;
  /** One sentence when Codex could not run for want of the install or a credential; else null. */
  message: string | null;
}

function detailFrom(signed: { signedIn: boolean; plan: string | null }): CodexDetail {
  const rt = getCodexRuntimeStatus();
  const installed = rt.runtime === 'ready';
  const credential = resolveCodexCredential();
  const route = credential.route;
  const message = !installed
    ? (rt.runtimeMessage ?? CODEX_NOT_INSTALLED_MESSAGE)
    : route === 'none'
      ? NO_CODEX_AUTH_MESSAGE
      : route === 'api_key'
        ? CODEX_API_KEY_NOT_AVAILABLE_MESSAGE
        : codexCredentialRunnable(credential)
          ? null
          : CODEX_SIGN_IN_UNCHECKED_MESSAGE;
  return {
    installed,
    runtime: rt.runtime,
    runtimeMessage: rt.runtimeMessage,
    signedIn: signed.signedIn,
    plan: signed.plan,
    route,
    runnable: installed && codexCredentialRunnable(credential),
    message,
  };
}

/**
 * The CACHED detail — for `/api/me` and every other request path: no process is awaited. When Codex
 * is installed, a stale cache kicks the background probe (at most every 5 minutes), so the next call
 * knows more. Under LIMN_AI_DISABLED nothing is probed.
 */
export function codexDetailCached(): CodexDetail {
  if (config.aiEnabled && codexBinaryPath()) kickCodexProbe();
  const c = codexSignedInCached();
  return detailFrom({ signedIn: !!c?.signedIn, plan: c?.plan ?? null });
}

/** The detail after a real `account/read` (waits for the first probe; the CLI and `detect()`). */
export async function detectCodex(): Promise<CodexDetail> {
  if (!codexBinaryPath()) return detailFrom({ signedIn: false, plan: null });
  return detailFrom(await codexAccount());
}

/**
 * Codex's usage source for the spend budget: ONE normalised AiUsageReading from the app-server's
 * `account/rateLimits/read` (the exec stream carries none — docs/CODEX-SPIKE.md § 6, so
 * `readingFromMessage` is always null).
 */
export const codexUsageSource: ProviderUsageSource = {
  readingFromMessage: () => null,
  probe: async () => {
    const opts = limnAppServerOptions();
    if (!opts) throw new Error(CODEX_NOT_INSTALLED_MESSAGE);
    return probeCodexAccount(opts);
  },
  readingFromProbe: (raw: unknown, nowMs: number): AiUsageReading | null => {
    // Either a probe result (`probeCodexAccount`) or the raw `account/rateLimits/read` answer.
    if (raw && typeof raw === 'object' && 'reading' in raw && 'atMs' in raw) {
      return (raw as { reading: AiUsageReading | null }).reading;
    }
    return readingFromCodexRateLimits(raw, nowMs);
  },
  probeReady: () => codexBinaryPath() !== null,
};

/** The last probe's error, for logs. */
export function codexLastProbeError(): string | null {
  return codexStateCached().lastError;
}
