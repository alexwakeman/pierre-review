import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  AUTO_FIX_DEFAULT_AUTO_PUSH,
  AUTO_FIX_DEFAULT_INCLUDE,
  AUTO_POST_DEFAULT_APPROVE_IMPACT,
  AUTO_POST_DEFAULT_AUTO_RESOLVE,
  AUTO_POST_DEFAULT_AUTO_VERDICT,
  AUTO_POST_DEFAULT_KINDS,
  AUTO_POST_DEFAULT_SCOPE,
  type ApproveLeftovers,
  type AutoApproveImpact,
  type AutoFixInclude,
  type AutoFixSettings,
  type AutoPostKinds,
  type AutoPostScope,
  type AutoReviewSweepBody,
  type AutoReviewSweepResponse,
  type AutoReviewUsage,
  type PairVerdictStrictness,
  type SetWorkspaceAutoReviewBody,
  type StoredAutoFixSettings,
  type StoredAutoPostSettings,
  type WorkspaceAutoPostSettings,
  type WorkspaceAutoReviewResponse,
  type WorkspaceAutoReviewSettings,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { dropAutoReviews } from './manager.js';
import { resolveAutoReviewProviders } from './pair.js';
import {
  DEFAULT_VERDICT_RULES,
  resolveApproveLeftovers,
  resolvePairStrictness,
  type VerdictRules,
} from './auto-verdict.js';
import { onOff, writeSettingEvent } from '../../db/setting-event-write.js';

// AUTO CLAUDE REVIEW — THE PER-WORKSPACE SWITCH (CORE since migration 0074 / pg 0061; it lived on
// the plugin's `pro_workspace_settings` until Claude Review left the plugin, and plugin migration
// 0037 copied each workspace's value across). Two columns on `workspaces`:
//   auto_review_enabled     true = review each new human PR in this workspace. NULL/false = off.
//   auto_review_enabled_at  when it was last switched ON — the floor: only PRs OPENED at or after
//                           it are reviewed, so a first sync, a backfill or a new repo can never
//                           make an old PR look new.
//
// ⚠ OFF UNTIL SOMEONE SWITCHES IT ON. It runs the user's own Claude in the background on every new
// human PR, so it is never a default.
//
// ⚠ THE FLOOR MOVES ONLY ON AN OFF → ON FLIP. Re-sending `enabled: true` keeps the stored moment
// (or every PR opened in between would silently be skipped); switching off clears it, so the next
// switch-on starts from then. `setWorkspaceAutoReview` is the ONE writer.
//
// AUTO AI FIX rides the same route as a THIRD column, `auto_fix_enabled` (migration 0083 / pg
// 0070): may a succeeded auto review of the reader's OWN PR prepare a fix? ⚠ OFF BY DEFAULT since
// 0084 / pg 0071 — ONLY a stored `true` is on, in every reader and in the writer (SQLite's DDL
// default is still 1, so both workspace inserts write false). Stored independently of
// `auto_review_enabled` (switching auto review off and on keeps it), read by `maybeStartAutoFix`
// (coding/ai-fix/auto-fix.ts) through `readWorkspaceAutoFixForPr`. Its CONTENTS and its PUSH
// switch are `auto_fix_settings` (migration 0091 / pg 0078), OVERRIDES ONLY
// ({ include?, autoPush? }), resolved through `resolveAutoFixSettings` — the ONE fold. A fix is
// pushed only when `autoPush` is on.
//
// THE DAILY CAP rides the same route as a FOURTH column, `auto_review_daily_cap` (migration 0085 /
// pg 0072): how many auto runs this workspace may start per UTC day. OVERRIDES ONLY — NULL means
// the product default, `AUTO_REVIEW_DAILY_CAP`; `resolveAutoReviewDailyCap` is the ONE fold, read
// by the wire shape and the sweeper's roster alike. Bounded 1..500 at the route.
//
// AUTO-POSTING rides the same route as two more columns (migration 0087 / pg 0074):
// `auto_post_enabled` (NULL/false = OFF — for every workspace, existing and new, until someone
// switches it on: it writes to GitHub AS THE READER) and `auto_post_settings`, OVERRIDES ONLY
// ({ scope?, kinds? }; NULL = the product defaults), resolved through `resolveAutoPostSettings`.
// Stored independently of `auto_review_enabled`: it only ever acts on AUTO runs, so it does nothing
// while auto review is off, but switching auto review off and on keeps it. The `autoVerdict` and
// `autoResolve` switches (both OFF by default) ride the same overrides JSON (no column), and so
// does `approveImpact` (which blast-radius levels an auto verdict may APPROVE; all by default).
//
// THE AUTO VERDICT'S TWO RULES ride the same route as two more columns (migration 0145), OVERRIDES
// ONLY (NULL = today's rule): `pair_verdict_strictness` ('relaxed', else strict — wire
// `pairStrictness`) and `approve_leftovers` ('nits' / 'none', else 'nits_questions' — wire
// `autoPost.approveLeftovers`). `readVerdictRulesForPr` is what every verdict reads.
//
// TEAM CLAIMS ("Mark auto reviews on GitHub") ride the same route as one more column,
// `team_claims_enabled` (migration 0134): may an AUTO review post a status line on the PR's head so
// teammates' Limn skips it (team-claim.ts)? OFF by default — only a stored true is on.
//
// AUTOMATIC DESIGN DIAGRAMS ride the same route as one more column, `auto_diagrams_enabled`
// (migration 0126): may a succeeded review (MANUAL OR AUTO) queue its design diagrams
// (review/diagrams/trigger.ts)? ⚠ ON BY DEFAULT — only a stored false is off, in every reader and
// in the writer. Independent of `auto_review_enabled`. Off stops only the automatic draw; the
// Draw / Redraw button still works. Read by the trigger through `diagramsSwitchedOnForPr`
// (review/diagrams/persist.ts).

/** Auto Claude reviews started per workspace per UTC day. Past it, PRs wait for the next day. */
export const AUTO_REVIEW_DAILY_CAP = 20;
/** The bounds a stored per-workspace cap must sit inside (the PUT 400s outside them). */
export const AUTO_REVIEW_DAILY_CAP_MIN = 1;
export const AUTO_REVIEW_DAILY_CAP_MAX = 500;

/** The stored override → the cap in force. NULL (or anything out of bounds) ⇒ the default. */
export function resolveAutoReviewDailyCap(stored: number | null | undefined): number {
  return typeof stored === 'number' &&
    Number.isInteger(stored) &&
    stored >= AUTO_REVIEW_DAILY_CAP_MIN &&
    stored <= AUTO_REVIEW_DAILY_CAP_MAX
    ? stored
    : AUTO_REVIEW_DAILY_CAP;
}

const AUTO_POST_KIND_KEYS = Object.keys(AUTO_POST_DEFAULT_KINDS) as Array<keyof AutoPostKinds>;
export const APPROVE_IMPACT_KEYS = Object.keys(AUTO_POST_DEFAULT_APPROVE_IMPACT) as Array<keyof AutoApproveImpact>;
const APPROVE_LEFTOVERS: ApproveLeftovers[] = ['none', 'nits', 'nits_questions'];
const isScope = (v: unknown): v is AutoPostScope => v === 'mine' || v === 'all';

/** The stored switch + overrides → the settings in force. Anything malformed reads as the default. */
export function resolveAutoPostSettings(
  enabled: boolean | null | undefined,
  stored: StoredAutoPostSettings | null | undefined,
  // `workspaces.approve_leftovers` (migration 0145): its own column, NULL = the default.
  approveLeftovers?: string | null,
): WorkspaceAutoPostSettings {
  const kinds = { ...AUTO_POST_DEFAULT_KINDS };
  const sk = stored?.kinds;
  if (sk != null && typeof sk === 'object') {
    for (const k of AUTO_POST_KIND_KEYS) if (typeof sk[k] === 'boolean') kinds[k] = sk[k] as boolean;
  }
  const approveImpact = { ...AUTO_POST_DEFAULT_APPROVE_IMPACT };
  const si = stored?.approveImpact;
  if (si != null && typeof si === 'object') {
    for (const k of APPROVE_IMPACT_KEYS) if (typeof si[k] === 'boolean') approveImpact[k] = si[k] as boolean;
  }
  return {
    enabled: enabled === true,
    scope: isScope(stored?.scope) ? stored!.scope! : AUTO_POST_DEFAULT_SCOPE,
    kinds,
    autoVerdict: typeof stored?.autoVerdict === 'boolean' ? stored.autoVerdict : AUTO_POST_DEFAULT_AUTO_VERDICT,
    autoResolve: typeof stored?.autoResolve === 'boolean' ? stored.autoResolve : AUTO_POST_DEFAULT_AUTO_RESOLVE,
    approveImpact,
    approveLeftovers: resolveApproveLeftovers(approveLeftovers),
  };
}

/** The settings in force → what to store: only what differs from the product default (null = none). */
export function autoPostOverrides(
  s: Pick<WorkspaceAutoPostSettings, 'scope' | 'kinds'> &
    Partial<Pick<WorkspaceAutoPostSettings, 'autoVerdict' | 'autoResolve' | 'approveImpact'>>,
): StoredAutoPostSettings | null {
  const out: StoredAutoPostSettings = {};
  if (s.scope !== AUTO_POST_DEFAULT_SCOPE) out.scope = s.scope;
  const kinds: Partial<AutoPostKinds> = {};
  for (const k of AUTO_POST_KIND_KEYS) if (s.kinds[k] !== AUTO_POST_DEFAULT_KINDS[k]) kinds[k] = s.kinds[k];
  if (Object.keys(kinds).length > 0) out.kinds = kinds;
  if (s.autoVerdict !== undefined && s.autoVerdict !== AUTO_POST_DEFAULT_AUTO_VERDICT) out.autoVerdict = s.autoVerdict;
  if (s.autoResolve !== undefined && s.autoResolve !== AUTO_POST_DEFAULT_AUTO_RESOLVE) out.autoResolve = s.autoResolve;
  if (s.approveImpact !== undefined) {
    const levels: Partial<AutoApproveImpact> = {};
    for (const k of APPROVE_IMPACT_KEYS) {
      if (s.approveImpact[k] !== AUTO_POST_DEFAULT_APPROVE_IMPACT[k]) levels[k] = s.approveImpact[k];
    }
    if (Object.keys(levels).length > 0) out.approveImpact = levels;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const AUTO_FIX_INCLUDE_KEYS = Object.keys(AUTO_FIX_DEFAULT_INCLUDE) as Array<keyof AutoFixInclude>;

/** THE ONE FOLD: the stored overrides → the auto-fix settings in force. Malformed reads as default. */
export function resolveAutoFixSettings(stored: StoredAutoFixSettings | null | undefined): AutoFixSettings {
  const include = { ...AUTO_FIX_DEFAULT_INCLUDE };
  const si = stored?.include;
  if (si != null && typeof si === 'object') {
    for (const k of AUTO_FIX_INCLUDE_KEYS) if (typeof si[k] === 'boolean') include[k] = si[k] as boolean;
  }
  return {
    include,
    autoPush: typeof stored?.autoPush === 'boolean' ? stored.autoPush : AUTO_FIX_DEFAULT_AUTO_PUSH,
  };
}

/** The auto-fix settings in force → what to store: only what differs from the default (null = none). */
export function autoFixOverrides(s: AutoFixSettings): StoredAutoFixSettings | null {
  const out: StoredAutoFixSettings = {};
  const include: Partial<AutoFixInclude> = {};
  for (const k of AUTO_FIX_INCLUDE_KEYS) if (s.include[k] !== AUTO_FIX_DEFAULT_INCLUDE[k]) include[k] = s.include[k];
  if (Object.keys(include).length > 0) out.include = include;
  if (s.autoPush !== AUTO_FIX_DEFAULT_AUTO_PUSH) out.autoPush = s.autoPush;
  return Object.keys(out).length > 0 ? out : null;
}

const toMs = (v: Date | number | null | undefined): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : Number(v);

interface AutoRow {
  // Who runs auto reviews (migration 0135): NULL = the default provider, 'both' = a pair.
  providers?: string | null;
  // The auto verdict's two rules (migration 0145): NULL = the defaults.
  pairStrictness?: string | null;
  approveLeftovers?: string | null;
  enabled: boolean | null;
  enabledAt: Date | number | null;
  autoFixEnabled: boolean | null;
  autoDiagramsEnabled: boolean | null;
  // "Mark auto reviews on GitHub" (migration 0134). Only a stored true is on.
  teamClaimsEnabled?: boolean | null;
  dailyCap: number | null;
  autoPostEnabled: boolean | null;
  autoPostSettings: StoredAutoPostSettings | null;
  autoFixSettings: StoredAutoFixSettings | null;
}

/** The stored row → the wire shape. Off ⇒ `enabledAt: null`. Auto fix: OFF unless explicitly switched on (0084). */
export function autoReviewOf(row: AutoRow | null): WorkspaceAutoReviewSettings {
  const enabled = row?.enabled === true;
  const atMs = enabled ? toMs(row?.enabledAt ?? null) : null;
  return {
    enabled,
    enabledAt: atMs == null ? null : new Date(atMs).toISOString(),
    dailyCap: resolveAutoReviewDailyCap(row?.dailyCap),
    autoFixEnabled: row?.autoFixEnabled === true,
    // ON unless explicitly switched off (0126).
    autoDiagramsEnabled: row?.autoDiagramsEnabled !== false,
    autoReviewProviders: resolveAutoReviewProviders(row?.providers),
    pairStrictness: resolvePairStrictness(row?.pairStrictness),
    autoPost: resolveAutoPostSettings(row?.autoPostEnabled, row?.autoPostSettings, row?.approveLeftovers),
    autoFix: resolveAutoFixSettings(row?.autoFixSettings),
    // OFF unless explicitly switched on (0134).
    teamClaimsEnabled: row?.teamClaimsEnabled === true,
  };
}

/**
 * The auto-post settings of the workspace holding this PR's repo, with that workspace's id — read
 * by auto-posting before it touches GitHub. A repo with no membership row (or an unknown PR) reads
 * null, i.e. OFF: this switch WRITES as the reader, so a workspace it cannot find never says yes.
 */
export async function readWorkspaceAutoPostForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<{ workspaceId: number; settings: WorkspaceAutoPostSettings; pairStrictness: PairVerdictStrictness } | null> {
  const { workspaces: w, workspaceRepos: wr, pullRequests: prs } = ctx.schema;
  const rows = (await ctx.db
    .select({
      workspaceId: w.id,
      enabled: w.autoPostEnabled,
      stored: w.autoPostSettings,
      ...verdictRuleCols(w),
    })
    .from(prs)
    .innerJoin(wr, and(eq(wr.repoId, prs.repoId), eq(wr.accountId, accountId)))
    .innerJoin(w, and(eq(w.id, wr.workspaceId), eq(w.accountId, accountId)))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{
    workspaceId: number;
    enabled: boolean | null;
    stored: StoredAutoPostSettings | null;
    pairStrictness?: string | null;
    approveLeftovers?: string | null;
  }>;
  const r = rows[0];
  return r
    ? {
        workspaceId: r.workspaceId,
        settings: resolveAutoPostSettings(r.enabled, r.stored, r.approveLeftovers),
        pairStrictness: resolvePairStrictness(r.pairStrictness),
      }
    : null;
}

// The two rule columns (migration 0145), when the schema has them (an older test schema may not).
const verdictRuleCols = (w: AgentContext['schema'][string]) => ({
  ...(w.pairVerdictStrictness ? { pairStrictness: w.pairVerdictStrictness } : {}),
  ...(w.approveLeftovers ? { approveLeftovers: w.approveLeftovers } : {}),
});

/**
 * THE AUTO VERDICT'S RULES for the workspace holding this PR's repo (strict / relaxed, what may stay
 * open), with whether its auto verdict is on. A PR with no membership row reads the defaults, off.
 */
export async function readVerdictRulesForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<VerdictRules & { autoVerdict: boolean }> {
  const ws = await readWorkspaceAutoPostForPr(ctx, accountId, prId);
  if (!ws) return { ...DEFAULT_VERDICT_RULES, autoVerdict: false };
  return { pairStrictness: ws.pairStrictness, approveLeftovers: ws.settings.approveLeftovers, autoVerdict: ws.settings.autoVerdict };
}

/**
 * Is auto AI Fix on for the workspace holding this PR's repo? Read by `maybeStartAutoFix`. Only a
 * stored true is on; a repo with no membership row (or an unknown PR) reads OFF.
 */
export async function readWorkspaceAutoFixForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<boolean> {
  const { workspaces: w, workspaceRepos: wr, pullRequests: prs } = ctx.schema;
  const rows = (await ctx.db
    .select({ on: w.autoFixEnabled })
    .from(prs)
    .innerJoin(wr, and(eq(wr.repoId, prs.repoId), eq(wr.accountId, accountId)))
    .innerJoin(w, and(eq(w.id, wr.workspaceId), eq(w.accountId, accountId)))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ on: boolean | null }>;
  return rows[0]?.on === true;
}

/**
 * The auto-fix settings (contents + push) of the workspace holding this PR's repo, with whether
 * auto fix is on at all. null (no membership row, unknown PR) = OFF with the defaults — a
 * workspace it cannot find never says "push".
 */
export async function readWorkspaceAutoFixSettingsForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<{ workspaceId: number; enabled: boolean; settings: AutoFixSettings } | null> {
  const { workspaces: w, workspaceRepos: wr, pullRequests: prs } = ctx.schema;
  const rows = (await ctx.db
    .select({ workspaceId: w.id, on: w.autoFixEnabled, stored: w.autoFixSettings })
    .from(prs)
    .innerJoin(wr, and(eq(wr.repoId, prs.repoId), eq(wr.accountId, accountId)))
    .innerJoin(w, and(eq(w.id, wr.workspaceId), eq(w.accountId, accountId)))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ workspaceId: number; on: boolean | null; stored: StoredAutoFixSettings | null }>;
  const r = rows[0];
  return r ? { workspaceId: r.workspaceId, enabled: r.on === true, settings: resolveAutoFixSettings(r.stored) } : null;
}

const autoCols = (w: AgentContext['schema'][string]) => ({
  providers: w.autoReviewProviders,
  ...verdictRuleCols(w),
  enabled: w.autoReviewEnabled,
  enabledAt: w.autoReviewEnabledAt,
  autoFixEnabled: w.autoFixEnabled,
  autoDiagramsEnabled: w.autoDiagramsEnabled,
  ...(w.teamClaimsEnabled ? { teamClaimsEnabled: w.teamClaimsEnabled } : {}),
  dailyCap: w.autoReviewDailyCap,
  autoPostEnabled: w.autoPostEnabled,
  autoPostSettings: w.autoPostSettings,
  autoFixSettings: w.autoFixSettings,
});

/** One workspace's switch, or null when the workspace is not this account's. */
export async function readWorkspaceAutoReview(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
): Promise<WorkspaceAutoReviewSettings | null> {
  const w = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select(autoCols(w))
    .from(w)
    .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
    .limit(1)
    .execute()) as AutoRow[];
  const row = rows[0];
  return row ? autoReviewOf(row) : null;
}

/**
 * The ONE writer. null when the workspace is not this account's (→ 404). Each of `enabled` /
 * `autoFixEnabled` / `autoDiagramsEnabled` / `dailyCap` is optional and a field left out keeps its stored value. A
 * `dailyCap` equal to the default is stored as NULL (overrides only). Switching auto review
 * OFF also drops this workspace's items still WAITING in the auto lane (no row yet, so nothing is
 * lost) — they are not reviewed, and not billed, after the switch. A run already started keeps
 * its Stop. Switching auto fix off stops only FUTURE auto fixes; one already started keeps going.
 */
export async function setWorkspaceAutoReview(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  change: SetWorkspaceAutoReviewBody,
  nowMs: number = Date.now(),
): Promise<WorkspaceAutoReviewSettings | null> {
  const w = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select(autoCols(w))
    .from(w)
    .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
    .limit(1)
    .execute()) as AutoRow[];
  const existing = rows[0];
  if (!existing) return null;
  const {
    enabled,
    autoFixEnabled,
    autoDiagramsEnabled,
    teamClaimsEnabled,
    dailyCap,
    autoPost,
    autoFix,
    autoReviewProviders,
    pairStrictness,
  } = change;
  const wasOn = existing.enabled === true && toMs(existing.enabledAt) != null;
  let review: Pick<AutoRow, 'enabled' | 'enabledAt'>;
  if (enabled === undefined || (enabled && wasOn)) review = existing;
  // Already off (the Settings Save always sends `enabled`): keep the row, so nothing is written
  // and no "switched off" marker reaches Chronology's settings history.
  else if (!enabled) {
    review =
      existing.enabled !== true && existing.enabledAt == null
        ? existing
        : { enabled: false, enabledAt: null };
  }
  // Whole seconds: SQLite stores this column in seconds, so an un-truncated stamp would make the
  // PUT's echo disagree with every later read by the milliseconds the column dropped.
  else review = { enabled: true, enabledAt: new Date(Math.floor(nowMs / 1000) * 1000) };
  // Only a stored true is on (NULL / false = OFF since 0084).
  const fixWas = existing.autoFixEnabled === true;
  const fix = autoFixEnabled ?? fixWas;
  // Only a stored false is off (ON by default, 0126).
  const diagramsWas = existing.autoDiagramsEnabled !== false;
  const diagrams = autoDiagramsEnabled ?? diagramsWas;
  // Only a stored true is on (OFF by default, 0134).
  const claimsWas = existing.teamClaimsEnabled === true;
  const claims = teamClaimsEnabled ?? claimsWas;
  const capOverride =
    dailyCap === undefined ? existing.dailyCap : dailyCap === AUTO_REVIEW_DAILY_CAP ? null : dailyCap;
  // Auto-posting: each field optional; a kind left out keeps its stored value.
  const postBefore = resolveAutoPostSettings(existing.autoPostEnabled, existing.autoPostSettings, existing.approveLeftovers);
  const postAfter: WorkspaceAutoPostSettings = {
    enabled: autoPost?.enabled ?? postBefore.enabled,
    scope: autoPost?.scope ?? postBefore.scope,
    kinds: { ...postBefore.kinds },
    autoVerdict: autoPost?.autoVerdict ?? postBefore.autoVerdict,
    autoResolve: autoPost?.autoResolve ?? postBefore.autoResolve,
    approveImpact: { ...postBefore.approveImpact },
    approveLeftovers: autoPost?.approveLeftovers ?? postBefore.approveLeftovers,
  };
  // The leftovers rule is its own column (migration 0145): NULL = the default.
  const leftoversStored: string | null = postAfter.approveLeftovers === 'nits_questions' ? null : postAfter.approveLeftovers;
  // How a pair's verdict folds (migration 0145): NULL = strict.
  const strictnessWas = resolvePairStrictness(existing.pairStrictness);
  const strictness: PairVerdictStrictness = pairStrictness ?? strictnessWas;
  for (const k of AUTO_POST_KIND_KEYS) {
    const v = autoPost?.kinds?.[k];
    if (typeof v === 'boolean') postAfter.kinds[k] = v;
  }
  for (const k of APPROVE_IMPACT_KEYS) {
    const v = autoPost?.approveImpact?.[k];
    if (typeof v === 'boolean') postAfter.approveImpact[k] = v;
  }
  const postOverrides = autoPostOverrides(postAfter);
  // Auto fix contents + push: each field optional; a section left out keeps its stored value.
  const fixBefore = resolveAutoFixSettings(existing.autoFixSettings);
  const fixAfter: AutoFixSettings = {
    include: { ...fixBefore.include },
    autoPush: autoFix?.autoPush ?? fixBefore.autoPush,
  };
  for (const k of AUTO_FIX_INCLUDE_KEYS) {
    const v = autoFix?.include?.[k];
    if (typeof v === 'boolean') fixAfter.include[k] = v;
  }
  const fixOverrides = autoFixOverrides(fixAfter);
  // Who runs auto reviews: stored 'both' or NULL (the default) — overrides only.
  const providersWas = resolveAutoReviewProviders(existing.providers);
  const providers = autoReviewProviders ?? providersWas;
  const next: AutoRow = {
    providers: providers === 'both' ? 'both' : null,
    pairStrictness: strictness === 'relaxed' ? 'relaxed' : null,
    approveLeftovers: leftoversStored,
    enabled: review.enabled,
    enabledAt: review.enabledAt,
    autoFixEnabled: fix,
    autoDiagramsEnabled: diagrams,
    teamClaimsEnabled: claims,
    dailyCap: capOverride,
    autoPostEnabled: postAfter.enabled,
    autoPostSettings: postOverrides,
    autoFixSettings: fixOverrides,
  };
  const set: Record<string, unknown> = {};
  if (review !== existing) {
    set.autoReviewEnabled = review.enabled;
    set.autoReviewEnabledAt = review.enabledAt;
  }
  if (autoFixEnabled !== undefined && autoFixEnabled !== fixWas) {
    set.autoFixEnabled = autoFixEnabled;
  }
  if (autoDiagramsEnabled !== undefined && autoDiagramsEnabled !== diagramsWas) {
    set.autoDiagramsEnabled = autoDiagramsEnabled;
  }
  if (teamClaimsEnabled !== undefined && teamClaimsEnabled !== claimsWas) {
    set.teamClaimsEnabled = teamClaimsEnabled;
  }
  if (dailyCap !== undefined && capOverride !== existing.dailyCap) {
    set.autoReviewDailyCap = capOverride;
  }
  if (autoReviewProviders !== undefined && providers !== providersWas) {
    set.autoReviewProviders = providers === 'both' ? 'both' : null;
  }
  if (pairStrictness !== undefined && strictness !== strictnessWas) {
    set.pairVerdictStrictness = strictness === 'relaxed' ? 'relaxed' : null;
  }
  if (autoPost?.approveLeftovers !== undefined && postAfter.approveLeftovers !== postBefore.approveLeftovers) {
    set.approveLeftovers = leftoversStored;
  }
  if (autoPost !== undefined) {
    if (postAfter.enabled !== (existing.autoPostEnabled === true)) set.autoPostEnabled = postAfter.enabled;
    if (JSON.stringify(postOverrides) !== JSON.stringify(existing.autoPostSettings ?? null)) {
      set.autoPostSettings = postOverrides;
    }
  }
  if (autoFix !== undefined && JSON.stringify(fixOverrides) !== JSON.stringify(existing.autoFixSettings ?? null)) {
    set.autoFixSettings = fixOverrides;
  }
  if (Object.keys(set).length > 0) {
    await ctx.db
      .update(w)
      .set(set)
      .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
      .execute();
    // Chronology's settings history (docs/BOTTLENECKS.md § Over time): one line per setting that
    // really moved, written through the context's own executor (no core DB import here).
    for (const [kind, summary] of settingChanges(set, existing, next)) {
      await writeSettingEvent(ctx, accountId, workspaceId, kind, summary, new Date(nowMs));
    }
  }
  if (enabled === false) dropAutoReviews((a, ws) => !(a === accountId && ws === workspaceId));
  return autoReviewOf(next);
}

/** The settings-history lines for one write: the `set` object names what actually changed. */
function settingChanges(
  set: Record<string, unknown>,
  existing: AutoRow,
  next: AutoRow,
): ['auto_review' | 'auto_fix' | 'auto_post', string][] {
  const out: ['auto_review' | 'auto_fix' | 'auto_post', string][] = [];
  // A REAL flip only — compared on the effective state, never on the key being present in `set`.
  const wasOn = existing.enabled === true && toMs(existing.enabledAt) != null;
  const isOn = next.enabled === true && toMs(next.enabledAt) != null;
  if ('autoReviewEnabled' in set && wasOn !== isOn) out.push(['auto_review', `Auto review ${onOff(isOn)}`]);
  if ('autoReviewDailyCap' in set) out.push(['auto_review', 'Auto review daily limit changed']);
  if ('autoReviewProviders' in set) {
    out.push(['auto_review', next.providers === 'both' ? 'Auto reviews use Claude + Codex' : 'Auto reviews use the default provider']);
  }
  if ('autoDiagramsEnabled' in set) {
    out.push(['auto_review', `Design diagrams after each review ${onOff(next.autoDiagramsEnabled !== false)}`]);
  }
  if ('teamClaimsEnabled' in set) {
    out.push(['auto_review', `Mark auto reviews on GitHub ${onOff(next.teamClaimsEnabled === true)}`]);
  }
  if ('autoFixEnabled' in set) out.push(['auto_fix', `Auto fix ${onOff(next.autoFixEnabled === true)}`]);
  if ('autoFixSettings' in set) {
    const was = resolveAutoFixSettings(existing.autoFixSettings).autoPush;
    const now = resolveAutoFixSettings(next.autoFixSettings).autoPush;
    out.push(['auto_fix', was !== now ? `Auto fix push ${onOff(now)}` : 'Auto fix contents changed']);
  }
  if ('pairVerdictStrictness' in set) {
    out.push([
      'auto_post',
      next.pairStrictness === 'relaxed'
        ? 'Claude + Codex verdict: relaxed (approve if one approves and neither asks for changes)'
        : 'Claude + Codex verdict: strict (approve only if both approve)',
    ]);
  }
  if ('approveLeftovers' in set) {
    const now = resolveApproveLeftovers(next.approveLeftovers);
    out.push([
      'auto_post',
      now === 'none'
        ? 'Auto-approve: only with nothing open'
        : now === 'nits'
          ? 'Auto-approve: nits may stay open'
          : 'Auto-approve: nits and questions may stay open',
    ]);
  }
  if ('autoPostEnabled' in set) out.push(['auto_post', `Auto-posting ${onOff(next.autoPostEnabled === true)}`]);
  else if ('autoPostSettings' in set) out.push(['auto_post', 'Auto-posting settings changed']);
  return out;
}

export interface AutoReviewRosterEntry {
  accountId: number;
  workspaceId: number;
  enabledAtMs: number;
  /** The cap in force for this workspace (the stored override, else the default). */
  dailyCap: number;
}

/**
 * Every workspace with auto review ON, across every account — the sweeper's roster. A row whose
 * `enabled_at` is missing is skipped: with no floor there is no safe answer to "which PRs are new".
 */
export async function listAutoReviewWorkspaces(
  ctx: AgentContext,
): Promise<AutoReviewRosterEntry[]> {
  const w = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select({
      accountId: w.accountId,
      workspaceId: w.id,
      enabledAt: w.autoReviewEnabledAt,
      dailyCap: w.autoReviewDailyCap,
    })
    .from(w)
    .where(eq(w.autoReviewEnabled, true))
    .execute()) as Array<{
    accountId: number;
    workspaceId: number;
    enabledAt: Date | number | null;
    dailyCap: number | null;
  }>;
  const out: AutoReviewRosterEntry[] = [];
  for (const r of rows) {
    const ms = toMs(r.enabledAt);
    if (ms != null) {
      out.push({
        accountId: r.accountId,
        workspaceId: r.workspaceId,
        enabledAtMs: ms,
        dailyCap: resolveAutoReviewDailyCap(r.dailyCap),
      });
    }
  }
  return out;
}

/**
 * Today's auto CODE reviews against the cap, for the Open PRs counter. null while auto review is
 * off (or the host has no candidate query). `used` is the sweeper's own count
 * (`getAutoReviewCandidates(...).autoToday`, asked with `limit: 0` so it reads nothing else).
 */
export async function readAutoReviewUsage(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  settings: WorkspaceAutoReviewSettings,
  nowMs: number = Date.now(),
): Promise<AutoReviewUsage | null> {
  const candidatesOf = ctx.queries?.getAutoReviewCandidates?.bind(ctx.queries);
  if (!settings.enabled || !candidatesOf) return null;
  // 00:00 UTC today — the same day `utcDayStartMs` (auto.ts) gives the sweeper (not imported:
  // auto.ts imports this module).
  const d = new Date(nowMs);
  const dayStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const res = await candidatesOf(accountId, workspaceId, { openedSinceMs: nowMs, dayStartMs, limit: 0 });
  if (!res) return null;
  return {
    used: res.autoToday,
    cap: settings.dailyCap,
    resetsAt: new Date(dayStartMs + 86_400_000).toISOString(),
  };
}

const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
};

/**
 * GET / PUT /api/workspaces/:id/auto-review. Registered only where Claude Review runs (local, the
 * agentic switch on) — in cloud both 404 like every other agentic route. DB-only.
 */
export function registerAutoReviewSettingsRoutes(app: FastifyInstance, ctx: AgentContext): void {
  app.get('/api/workspaces/:id/auto-review', { schema: idParam }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const autoReview = await readWorkspaceAutoReview(ctx, ctx.accountIdOf(req), id);
    if (!autoReview) {
      reply.status(404);
      return { error: 'NotFound', message: `Workspace ${id} not found` };
    }
    const usage = await readAutoReviewUsage(ctx, ctx.accountIdOf(req), id, autoReview);
    const resp: WorkspaceAutoReviewResponse = { workspaceId: id, autoReview, ...(usage ? { usage } : {}) };
    return resp;
  });

  // RUN AUTO REVIEWS NOW (the Open PRs header) / RETRY ONE PR (the AI Review tab): ONE sweep of this
  // workspace through the sweeper itself (auto.ts `runAutoReviewSweep` with a press), so every auto
  // rule still holds — trigger 'auto', the default provider, auto-post settings, the daily cap, the
  // lane cap — and never two sweeps at once (its in-flight guard answers `busy`). The press waives
  // the settle waits, the retry backoff and the attempt cap; the spend budget's over-limit confirm is
  // the SPA's two-press (`OverBudgetConfirm`). Rate limit: `ai` + `aiHourly` (it starts model runs).
  // 404 for another account's workspace. `prId` outside the workspace queues nothing.
  app.post(
    '/api/workspaces/:id/auto-review/sweep',
    {
      schema: {
        ...idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { prId: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const accountId = ctx.accountIdOf(req);
      const body = (req.body ?? {}) as AutoReviewSweepBody;
      const autoReview = await readWorkspaceAutoReview(ctx, accountId, id);
      if (!autoReview) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      const base: AutoReviewSweepResponse = {
        workspaceId: id,
        queued: 0,
        retried: 0,
        checksQueued: 0,
        repliesQueued: 0,
        capped: false,
        laneFull: false,
        aiNotReady: false,
        busy: false,
        off: false,
      };
      if (!autoReview.enabled) return { ...base, off: true };
      // Lazy: auto.ts imports this module.
      const { runAutoReviewSweep } = await import('./auto.js');
      const r = await runAutoReviewSweep(ctx, Date.now(), {
        accountId,
        workspaceId: id,
        ...(body.prId != null ? { prId: body.prId } : {}),
      });
      const resp: AutoReviewSweepResponse = {
        ...base,
        queued: r.queued,
        retried: r.retried ?? 0,
        checksQueued: r.checksQueued ?? 0,
        repliesQueued: r.repliesQueued ?? 0,
        capped: r.capped === true,
        laneFull: r.stopped === 'lane_full',
        aiNotReady: r.stopped === 'ai_not_ready',
        busy: r.busy === true,
        off: r.off === true,
      };
      return resp;
    },
  );

  app.put(
    '/api/workspaces/:id/auto-review',
    {
      schema: {
        ...idParam,
        // ⚠ AT LEAST ONE FIELD, so an empty `{}` cannot read as a switch.
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            autoFixEnabled: { type: 'boolean' },
            autoDiagramsEnabled: { type: 'boolean' },
            teamClaimsEnabled: { type: 'boolean' },
            autoReviewProviders: { type: 'string', enum: ['default', 'both'] },
            pairStrictness: { type: 'string', enum: ['strict', 'relaxed'] },
            // An integer 1..500; anything else (a fraction, a string, out of range) is a 400.
            dailyCap: {
              type: 'integer',
              minimum: AUTO_REVIEW_DAILY_CAP_MIN,
              maximum: AUTO_REVIEW_DAILY_CAP_MAX,
            },
            autoPost: {
              type: 'object',
              minProperties: 1,
              additionalProperties: false,
              properties: {
                enabled: { type: 'boolean' },
                scope: { type: 'string', enum: ['mine', 'all'] },
                kinds: {
                  type: 'object',
                  minProperties: 1,
                  additionalProperties: false,
                  properties: Object.fromEntries(AUTO_POST_KIND_KEYS.map((k) => [k, { type: 'boolean' }])),
                },
                autoVerdict: { type: 'boolean' },
                autoResolve: { type: 'boolean' },
                approveImpact: {
                  type: 'object',
                  minProperties: 1,
                  additionalProperties: false,
                  properties: Object.fromEntries(APPROVE_IMPACT_KEYS.map((k) => [k, { type: 'boolean' }])),
                },
                approveLeftovers: { type: 'string', enum: APPROVE_LEFTOVERS },
              },
            },
            autoFix: {
              type: 'object',
              minProperties: 1,
              additionalProperties: false,
              properties: {
                include: {
                  type: 'object',
                  minProperties: 1,
                  additionalProperties: false,
                  properties: Object.fromEntries(AUTO_FIX_INCLUDE_KEYS.map((k) => [k, { type: 'boolean' }])),
                },
                autoPush: { type: 'boolean' },
              },
            },
          },
        },
      },
      // ⚠ Fastify's validator COERCES types, so `true` would arrive as 1 and `"40"` as 40. The cap
      // must be a real JSON number: checked on the RAW body, before the schema coerces it.
      preValidation: async (req, reply) => {
        const raw = (req.body ?? {}) as Record<string, unknown>;
        // The same for the auto-post booleans: `"true"` or `1` must not read as a switch.
        const post = raw.autoPost as Record<string, unknown> | undefined;
        const kinds = post != null && typeof post === 'object' ? (post.kinds as Record<string, unknown> | undefined) : undefined;
        const impact =
          post != null && typeof post === 'object' ? (post.approveImpact as Record<string, unknown> | undefined) : undefined;
        const notBool = (o: Record<string, unknown>, k: string) => k in o && typeof o[k] !== 'boolean';
        if (
          (post != null &&
            typeof post === 'object' &&
            (notBool(post, 'enabled') || notBool(post, 'autoVerdict') || notBool(post, 'autoResolve'))) ||
          (kinds != null && typeof kinds === 'object' && Object.values(kinds).some((v) => typeof v !== 'boolean')) ||
          (impact != null && typeof impact === 'object' && Object.values(impact).some((v) => typeof v !== 'boolean'))
        ) {
          reply.status(400);
          return reply.send({ error: 'BadRequest', message: 'autoPost switches must be true or false' });
        }
        const fx = raw.autoFix as Record<string, unknown> | undefined;
        const inc = fx != null && typeof fx === 'object' ? (fx.include as Record<string, unknown> | undefined) : undefined;
        if (
          (fx != null && typeof fx === 'object' && notBool(fx, 'autoPush')) ||
          (inc != null && typeof inc === 'object' && Object.values(inc).some((v) => typeof v !== 'boolean'))
        ) {
          reply.status(400);
          return reply.send({ error: 'BadRequest', message: 'autoFix switches must be true or false' });
        }
        if ('dailyCap' in raw && typeof raw.dailyCap !== 'number') {
          reply.status(400);
          return reply.send({
            error: 'BadRequest',
            message: `dailyCap must be a whole number from ${AUTO_REVIEW_DAILY_CAP_MIN} to ${AUTO_REVIEW_DAILY_CAP_MAX}`,
          });
        }
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const body = req.body as SetWorkspaceAutoReviewBody;
      const autoReview = await setWorkspaceAutoReview(ctx, ctx.accountIdOf(req), id, body);
      if (!autoReview) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      const resp: WorkspaceAutoReviewResponse = { workspaceId: id, autoReview };
      return resp;
    },
  );
}
