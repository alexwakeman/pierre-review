// The BotAdapter interface + capability types — types only, no logic. An adapter turns a
// set of intents into ADDITIVE edits against a bot's fetched config file(s):
// parse → plan → serialize → validate, all pure functions over plain data (no ctx — the
// deterministic-pipeline rule). File contents are REPO-AUTHORED, i.e. attacker-authored in
// cloud: every parse is size-capped, tolerates garbage by returning {ok:false, reason}, and
// never throws.
import type { AdvisorIntentKind, AdvisorIntentWire } from '@pierre-review/shared';

export type IntentSupport =
  | { level: 'expressible' }
  // Surfaced to the user plainly: what the adapter does INSTEAD (e.g. "prose instruction —
  // the vendor has no structured key for this").
  | { level: 'degraded'; alternative: string }
  | { level: 'unsupported' };

export interface AdapterFileInput {
  path: string;
  // null = the file does not exist (a 404 read) — distinct from an empty file.
  text: string | null;
}

export interface AdapterPlanItem {
  intentKind: AdvisorIntentKind;
  targetKey: string;
  status: 'applied' | 'degraded' | 'unsupported' | 'noop';
  note?: string; // 'degraded'/'unsupported'/'noop' explain themselves here
}

// `state` is adapter-private (the parsed docs the serialize step needs); routes treat it as
// opaque and only read `items`.
export interface AdapterPlan<S = unknown> {
  items: AdapterPlanItem[];
  state: S;
}

export interface AdapterOutputFile {
  path: string;
  content: string;
}

export interface ParseResult<P = unknown> {
  ok: boolean;
  reason?: string;
  config: P;
}

export interface BotAdapter<P = unknown, S = unknown> {
  key: string;
  displayName: string;
  capabilities: Record<AdvisorIntentKind, IntentSupport>;
  // Ordered probes — the discovery/read step fetches these (at the default-branch ref) and
  // hands the results to parse().
  configTargets: { path: string; format: 'yaml' | 'json' | 'prose' | 'dir' }[];
  parse(files: AdapterFileInput[]): ParseResult<P>;
  // ADDITIVE edits only: nothing outside our managed entries/blocks is rewritten, and a
  // value the user set is never overwritten (those degrade instead).
  plan(intents: AdvisorIntentWire[], current: P): AdapterPlan<S>;
  serialize(plan: AdapterPlan<S>): AdapterOutputFile[];
  validate(files: AdapterOutputFile[]): { ok: boolean; errors: string[] };
}

// The size cap every adapter applies BEFORE parsing repo-authored bytes (the CODEOWNERS
// precedent: truncation caps the attacker's input, and a config over this size is not a
// config we should be editing programmatically anyway — refuse, don't truncate-and-mangle).
export const MAX_CONFIG_BYTES = 256 * 1024;
