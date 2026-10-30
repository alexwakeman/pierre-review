// THE FIRST-BOOT AI DOWNLOAD — Claude and Codex come with Limn, without a click.
//
// The SDKs and the Codex CLI stay OUT of the npm manifest (a fast `npx limn-review`; the guardrails in
// scripts/build-release.mjs are unchanged), so on a boot that finds either runtime missing, stale or
// without its native program, Limn downloads what is missing in the background — the same
// single-flight `installAiRuntime` that `limn ai install codex` and the SPA's Retry run. ⚠ A Claude
// that is already ready is never fetched again or swapped (`['codex']` alone: the existing install
// adding Codex). After it, signing in to each provider is the only step.
//
// ⚠ IT NEVER DELAYS THE SERVER. `index.ts` calls `startAiAutoInstall` AFTER `listen`, with `void`;
// nothing awaits it. `/api/me` reads `runtime: 'installing'` (and the current step in
// `runtimeMessage`) the moment it starts, because `install()` claims its slot synchronously.
//
// ⚠ A FAILURE IS RETRIED ONCE, a few minutes later (a laptop waking on a dead network), then left for
// the reader's Retry, `limn ai install`, or the next boot — never a loop. A Codex-only failure is
// Codex's alone (ai/runtime.ts): Claude stays set up.
//
// Skipped when AI is off (LIMN_AI_DISABLED=true) or LIMN_AI_AUTO_INSTALL=false.
import { config } from '../config.js';
import {
  getAiRuntimeStatus,
  getCodexRuntimeStatus,
  installAiRuntime,
  type AiRuntimeInstallResult,
  type AiRuntimeProvider,
  type AiRuntimeStatus,
} from './runtime.js';

/** How long after a failed automatic download the one automatic retry waits. */
export const AUTO_INSTALL_RETRY_MS = 3 * 60_000;

interface Log {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface AutoInstallDeps {
  enabled: boolean;
  claude: () => AiRuntimeStatus;
  codex: () => AiRuntimeStatus;
  install: (providers: AiRuntimeProvider[]) => Promise<AiRuntimeInstallResult>;
  schedule: (fn: () => void, ms: number) => void;
  log: Log;
}

/**
 * The providers a download must bring, or null when nothing is missing. ['codex'] alone over a ready
 * Claude downloads Codex only (ai/runtime.ts): an existing install neither fetches nor swaps Claude.
 */
export function autoInstallProviders(claude: AiRuntimeStatus, codex: AiRuntimeStatus): AiRuntimeProvider[] | null {
  // Already running (a `limn ai install` started by the same process cannot be, but a Retry can).
  if (claude.runtime === 'installing' || codex.runtime === 'installing') return null;
  const needClaude = claude.runtime !== 'ready';
  const needCodex = codex.runtime !== 'ready';
  if (!needClaude && !needCodex) return null;
  if (!needCodex) return ['claude'];
  return needClaude ? ['claude', 'codex'] : ['codex'];
}

/** The testable body: one attempt, and on failure ONE scheduled retry. */
export function runAutoInstall(deps: AutoInstallDeps, attempt = 1): void {
  if (!deps.enabled) return;
  const providers = autoInstallProviders(deps.claude(), deps.codex());
  if (!providers) return;
  const names = providers.map((p) => (p === 'codex' ? 'Codex' : 'Claude')).join(' and ');
  deps.log.info(`ai: downloading ${names} in the background`);
  void deps
    .install(providers)
    .then((r) => {
      if (r.ok) {
        deps.log.info(`ai: ${names} downloaded — sign in to use ${providers.length > 1 ? 'them' : 'it'}`);
        return;
      }
      deps.log.warn(`ai: the download did not finish: ${r.message}`);
      if (attempt === 1) deps.schedule(() => runAutoInstall(deps, 2), AUTO_INSTALL_RETRY_MS);
    })
    .catch(() => {
      /* installAiRuntime never throws; belt and braces for the boot */
    });
}

/** Start the first-boot download (a no-op when nothing is missing). Never throws, never awaited. */
export function startAiAutoInstall(log: Log): void {
  try {
    runAutoInstall({
      enabled: config.aiEnabled && config.aiAutoInstall,
      claude: getAiRuntimeStatus,
      codex: getCodexRuntimeStatus,
      install: (providers) => installAiRuntime(undefined, { providers }),
      schedule: (fn, ms) => {
        setTimeout(fn, ms).unref?.();
      },
      log,
    });
  } catch (err) {
    log.warn(`ai: the background download could not start: ${(err as Error).message}`);
  }
}
