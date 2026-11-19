// THE ACTIVE PROVIDER'S DOWNLOAD — is the program the next run needs installed? Claude's runs need the
// Claude SDK download (`getAiRuntimeStatus`); Codex's need the Codex program (`getCodexRuntimeStatus`,
// installed WITH the shared download, so its zod is there too). `/api/me`'s top-level `ai.runtime`
// and the background sweepers' gate (`agenticRunReady`) both ask this, so a Codex machine is never
// held back for a missing Claude program, nor a Claude one for a missing Codex.
import { getAiRuntimeStatus, getCodexRuntimeStatus, type AiRuntimeStatus } from './runtime.js';
import { activeProviderId } from './provider-setting.js';
import { withAiSwitch } from './tool-switches.js';

// ⚠ AI SWITCHED OFF in Settings → Features reads as 'absent' here (ai/tool-switches.ts), so every surface
// that asks shows the not-set-up line and every automatic run waits, with the download left on disk.
export function activeRuntimeStatus(): AiRuntimeStatus {
  return runtimeStatusFor(activeProviderId());
}

/** One provider's download (a run resolved to a vendor other than the default asks about ITS program). */
export function runtimeStatusFor(provider: 'claude' | 'codex'): AiRuntimeStatus {
  return withAiSwitch(provider === 'codex' ? getCodexRuntimeStatus() : getAiRuntimeStatus());
}
