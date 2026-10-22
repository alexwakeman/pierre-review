// Vendor key → adapter. Only vendors whose config surface was actually verified get an
// adapter: CodeRabbit, Greptile, Copilot-prose. Qodo and Sourcery are ENTIRELY ABSENT (not
// stubbed) on purpose — their config surfaces are unverified, and a stub that emits a
// guessed schema is worse than the brief (verification task scheduled before any adapter
// work; brief §9). Everything else routes through the profile: a confirmed T3 manifest
// (manifest.ts) or a prose configPath (prose.ts), resolved by the routes.
import type { BotAdapter } from './adapter.js';
import { coderabbitAdapter } from './coderabbit.js';
import { greptileAdapter } from './greptile.js';
import { copilotProseAdapter } from './copilot-prose.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBotAdapter = BotAdapter<any, any>;

const ADAPTERS: Record<string, AnyBotAdapter> = {
  coderabbit: coderabbitAdapter as AnyBotAdapter,
  greptile: greptileAdapter as AnyBotAdapter,
  copilot: copilotProseAdapter as AnyBotAdapter,
};

// `kind` is the AutomatedReviewerKind from the classifier; adapter keys deliberately match
// the kinds they serve so a profile `kindHint` of 'known:coderabbit' round-trips.
export function adapterForKind(kind: string): AnyBotAdapter | null {
  return ADAPTERS[kind] ?? null;
}

export function adapterByKey(key: string): AnyBotAdapter | null {
  return ADAPTERS[key] ?? null;
}

export function listAdapters(): AnyBotAdapter[] {
  return Object.values(ADAPTERS);
}
