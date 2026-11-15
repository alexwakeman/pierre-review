// SETTINGS → FEATURES, THE TOOL SWITCHES — AI (Claude and Codex) and Bot comment analysis.
//
// Not sidebar pages (features.ts holds those): each switch turns a downloaded tool on or off, and Settings →
// Features is the ONE place in the app that downloads either (the CLI's `ensemble ai install` /
// `ensemble ml install` do the same from a terminal; the first boot still fetches the AI runtime itself).
//
// ACCOUNT grain, stored server-side (`accounts.tool_switches`), OVERRIDES ONLY: an absent key follows the
// default, and the default follows the facts:
//   ai           on when the active provider's runtime is downloaded. Off: every AI surface shows the
//                not-set-up line (the server reports the runtime absent), automatic runs stop. Files stay.
//   botAnalysis  on when something can score bot comments (the local model, or a severity-api). Off:
//                nothing new is scored; badges already stored stay on screen; the model stays on disk.

export type ToolId = 'ai' | 'botAnalysis';

/** Settings order. */
export const TOOL_IDS: readonly ToolId[] = ['ai', 'botAnalysis'];

/** The stored switches, overrides only. An absent key = the default. */
export type ToolSwitches = Partial<Record<ToolId, boolean>>;

/** One switch, resolved. */
export interface ToolSwitchStatus {
  /** What applies right now: the stored switch, else the default. */
  on: boolean;
  /** The stored switch; null = the default applies. */
  setting: boolean | null;
  /** What the default is right now (the tool is downloaded). */
  defaultOn: boolean;
  /** Is the tool downloaded (or, for bot analysis, a severity-api configured)? */
  installed: boolean;
  /** What is installed, in the reader's words, one line each (versions, models, a path). Empty when nothing is. */
  found: string[];
}

export type ToolSwitchesStatus = Record<ToolId, ToolSwitchStatus>;

/** The ONE resolver: stored switch, else the default (on when installed). */
export function resolveToolSwitch(
  setting: boolean | null | undefined,
  installed: boolean,
  found: string[] = [],
): ToolSwitchStatus {
  const s = typeof setting === 'boolean' ? setting : null;
  return { on: s ?? installed, setting: s, defaultOn: installed, installed, found };
}

/** Keep only known keys with boolean values; `{}` → null (nothing stored). */
export function compactToolSwitches(switches: ToolSwitches | null | undefined): ToolSwitches | null {
  if (switches == null) return null;
  const out: ToolSwitches = {};
  for (const id of TOOL_IDS) {
    const v = switches[id];
    if (typeof v === 'boolean') out[id] = v;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** Body of PUT /api/me/tool-switches: ONE switch, `null` = back to its default. */
export interface ToolSwitchBody {
  id: ToolId;
  on: boolean | null;
}

/** Response of PUT /api/me/tool-switches. */
export interface ToolSwitchesResponse {
  status: 'ok';
  toolSwitches: ToolSwitches | null;
  tools: ToolSwitchesStatus;
}

/** Body of PUT /api/repos/:id/bot-scoring: score this repo's bot comments (opt-in), or stop. */
export interface RepoBotScoringBody {
  enabled: boolean;
}

/** GET /api/repos/:id/overview: the Repos & workspaces panel for one repo. DB only. */
export interface RepoOverviewResponse {
  repoId: number;
  /** Pull requests synced (the last 90 days), by state. */
  prs: { total: number; open: number; merged: number; closed: number };
  /** People and bots who opened those pull requests. */
  authors: number;
  botScoring: {
    enabled: boolean;
    /** This repo's bot comments with a stored label. */
    labelled: number;
    /** This repo's bot comments still to score (0 while scoring is off). */
    pending: number;
  };
}
