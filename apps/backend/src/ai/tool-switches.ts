// SETTINGS → FEATURES, THE TOOL SWITCHES (shared tool-switches.ts) — the server's half.
//
// The stored switches live on the account row (`accounts.tool_switches`) and are read SYNCHRONOUSLY from
// the cached local account, because the gates that ask are synchronous: `activeRuntimeStatus` (every AI
// surface's "set up?" and every automatic run's readiness) and the bot-scoring tick's first guard.
//
//   AI switched OFF          the active runtime reads 'absent' with AI_SWITCHED_OFF_MESSAGE, so every AI
//                            surface shows its not-set-up line and every automatic run waits. The download
//                            stays on disk, and the first-boot download is skipped.
//   Bot analysis switched OFF the scoring tick does nothing. `mlSeverity` (the badges' gate) is untouched,
//                            so labels already stored stay on screen; the model stays on disk.
// A switch left at its default follows what is installed, so an install that never touched it behaves as
// before.

import { existsSync, readdirSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { resolveToolSwitch, type ToolSwitches, type ToolSwitchesStatus } from '@pierre-review/shared';
import { getLocalAccountCached } from '../auth/account.js';
import { config } from '../config.js';
import { readEnv } from '../env-name.js';
import { getMlStatus } from '../ml/runtime.js';
import { isSeverityApiConfigured } from '../ml/severity-client.js';
import { activeProviderId } from './provider-setting.js';
import {
  aiRuntimePins,
  codexRuntimePin,
  getAiRuntimeStatus,
  getCodexRuntimeStatus,
  type AiRuntimeStatus,
} from './runtime.js';

/** What every AI surface says while AI is switched off (the not-set-up line). */
export const AI_SWITCHED_OFF_MESSAGE = 'AI is switched off. Switch it on in Settings → Features.';

function stored(): ToolSwitches | null {
  return getLocalAccountCached()?.toolSwitches ?? null;
}

/** The reader switched AI off (an explicit choice; the default never is). */
export function aiSwitchedOff(): boolean {
  return stored()?.ai === false;
}

/** The reader switched bot comment analysis off. */
export function botAnalysisSwitchedOff(): boolean {
  return stored()?.botAnalysis === false;
}

/** A runtime status as the app must see it: 'absent' while AI is switched off. */
export function withAiSwitch(status: AiRuntimeStatus): AiRuntimeStatus {
  return aiSwitchedOff() ? { runtime: 'absent', runtimeMessage: AI_SWITCHED_OFF_MESSAGE } : status;
}

/** A `claude` program on PATH, if any (a file named claude / claude.exe; nothing is run). */
export function claudeOnPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** What is installed for AI, one plain line each. */
function aiFound(): string[] {
  const out: string[] = [];
  const claude = getAiRuntimeStatus();
  const codex = getCodexRuntimeStatus();
  const own = readEnv(process.env, 'CLAUDE_PATH')?.trim();
  if (claude.runtime === 'ready') {
    const sdk = aiRuntimePins()?.['@anthropic-ai/claude-agent-sdk'];
    out.push(`Claude Agent SDK${sdk ? ` ${sdk}` : ''}`);
    out.push(own ? `Claude Code: your own, at ${own}` : 'Claude Code: the copy that came with the download');
  }
  if (codex.runtime === 'ready') {
    const pin = codexRuntimePin();
    out.push(`Codex CLI${pin ? ` ${pin}` : ''} (Ensemble's own copy)`);
  }
  // A Claude Code already on this machine: Ensemble can run it instead of the bundled program.
  if (!own) {
    const onPath = claudeOnPath();
    if (onPath) out.push(`Claude Code is also on this machine, at ${onPath}. Set ENSEMBLE_CLAUDE_PATH to use it.`);
  }
  return out;
}

/** The two model heads, by their folder names under the models directory. */
function modelHeads(modelsDir: string): string[] {
  try {
    return readdirSync(join(modelsDir, 'modernbert-onnx'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** What is installed for bot comment analysis, one plain line each. */
function botFound(): string[] {
  const out: string[] = [];
  const ml = getMlStatus();
  if (config.mlLocalEnabled && ml.state === 'ready' && ml.modelsDir) {
    const version = basename(ml.modelsDir);
    const heads = modelHeads(ml.modelsDir);
    for (const head of heads.length > 0 ? heads : ['severity', 'category']) {
      out.push(`ModernBERT ${head} model (int8 ONNX)${/^[0-9A-Za-z._-]{1,64}$/.test(version) ? `, version ${version}` : ''}`);
    }
    out.push(`In ${ml.modelsDir}`);
  }
  if (isSeverityApiConfigured()) out.push(`A severity-api at ${config.severityApiUrl}`);
  return out;
}

/** Bot comment analysis is installed: the local model, or a configured severity-api. */
function botInstalled(): boolean {
  return (
    (config.mlLocalEnabled && config.mlScorer !== 'http' && getMlStatus().state === 'ready') ||
    (config.mlScorer !== 'local' && isSeverityApiConfigured())
  );
}

/** Both switches, resolved, for /api/me and PUT /api/me/tool-switches. */
export function toolSwitchesStatus(switches: ToolSwitches | null = stored()): ToolSwitchesStatus {
  // AI is "installed" when the ACTIVE provider's runtime is (the one the next run needs).
  const rt = activeProviderId() === 'codex' ? getCodexRuntimeStatus() : getAiRuntimeStatus();
  return {
    ai: resolveToolSwitch(switches?.ai, config.aiEnabled && rt.runtime === 'ready', aiFound()),
    botAnalysis: resolveToolSwitch(switches?.botAnalysis, botInstalled(), botFound()),
  };
}
