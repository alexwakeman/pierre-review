// Finding → Intent rules: the decision thresholds that turn a core evidence CELL into a
// recommendation candidate. Pure `(data) => data` — no ctx, no I/O; imports taxonomy for
// labels only. The CELL-emission floors live in core (echoed on the payload as `floors`);
// what lives here is the DECISION layer: how bad a cell has to look before the advisor
// speaks. Every threshold is a named constant.
//
// Two inherited pairs are deliberately NOT re-declared with new numbers: LOWER_VERBOSITY
// reuses the payload's `floors.minCellFindings` (the same 20-findings bar as core's
// ML_NIT_MIN_FINDINGS — one claim, one pair) with the 0.7 nit share, and SCOPE_OFF mirrors
// core's overlap suggestion pair (share 0.4 over ≥5 threads). Drifting either would make the
// advisor disagree with the free amber box about the same bot.
import type {
  AdvisorBotTotals,
  AdvisorFindingsPayload,
  AdvisorIntentKind,
  AdvisorIntentWire,
} from '@pierre-review/shared';
import {
  evidenceFromBotTotals,
  evidenceFromCategoryCell,
  evidenceFromOverlapCell,
  evidenceFromPathCell,
} from './evidence.js';
import { retroFor } from './retro-check.js';
import { CATEGORY_PHRASING } from './taxonomy.js';

// Suppression: a (bot × path) or thread-linked (bot × category) where ≥70% went untouched —
// the same bar as the free path suggestion (untouchedPct ≥ 70), kept in lockstep on purpose.
export const SUPPRESS_MIN_UNTOUCHED_SHARE = 0.7;
// The suppression VETO: a cell containing even ONE acted-on high-severity finding never
// earns a full suppress — the team demonstrably got value there, and "4 of 5 ignored" is
// not licence to also silence the one that mattered. Vetoed path cells fall through to the
// nit-scoped QUIET_PATH_NITS check below instead.
export const SUPPRESS_MAX_ACTED_HIGH = 0;
// The MERGED-PAST gate (Alex, 2026-08-09): a suppression additionally needs at least one
// untouched thread on a PR that has SINCE MERGED. Silence on an open PR is not final — the
// team may still act; a merge over the bot's open thread is the team's final answer, and
// only that earns a suppress. (Measured on erxes: 39% of merged PRs carry an untouched
// CodeRabbit thread — the signal is real, not vestigial.)
export const SUPPRESS_MIN_MERGED_UNTOUCHED = 1;
// QUIET_PATH_NITS — the noise-focused path intent: keep the path, stop nit-level comments
// there. Fires when the path's LABELLED findings are nit-dominated (the family's 0.7 bar)
// and those nits are mostly ignored; the labelled floor reuses floors.minCellThreads (the
// same ≥5 claim, over the labelled subset).
export const QUIET_PATH_MIN_NIT_SHARE = 0.7;
export const QUIET_PATH_MAX_NIT_ACTED_SHARE = 0.3;
// Amplification: an area where ≥`floors.amplifyMinActedPct` of the bot's findings were acted
// on AND at least this many were high-severity — evidence the bot is genuinely valuable there.
export const AMPLIFY_MIN_ACTED_HIGH = 2;
// Escalation (category): the thread-linked acted-on share that marks a category the team
// consistently acts on — worth asking the bot to rank higher.
export const ESCALATE_MIN_ACTED_SHARE = 0.7;
export const ESCALATE_MIN_THREAD_LINKED = 5;
// LOWER_VERBOSITY nit share (volume bar = floors.minCellFindings — core's ML_NIT pair).
export const LOWER_VERBOSITY_MIN_NIT_SHARE = 0.7;
// SCOPE_OFF mirrors core's overlap-suggestion pair.
export const SCOPE_OFF_MIN_OVERLAP_SHARE = 0.4;
// Bootstrap: an unconfigured bot only earns a config skeleton once it has real volume.
export const BOOTSTRAP_MIN_THREADS = 10;
// PROMOTE_TO_LINT (DeepSource title templates): a rule template must fire this often.
export const PROMOTE_TO_LINT_MIN_FIRES = 20;

export interface LintTemplateStat {
  botUserId: number;
  template: string;
  fires: number;
  actedOn: number;
}

export interface DeriveIntentsOpts {
  // Bots that already have a KNOWN config target (adapter or confirmed manifest or profile
  // configPath) — BOOTSTRAP_CONFIG is for everyone else above the volume floor.
  botsWithConfigTarget: ReadonlySet<number>;
  // Optional T4 lint-template stats (DeepSource-only in v1); absent ⇒ no PROMOTE_TO_LINT.
  lintTemplates?: LintTemplateStat[];
}

const dedupeKeyFor = (
  kind: AdvisorIntentKind,
  botUserId: number,
  targetKey: string,
  windowKind: string,
): string => `${kind}|${botUserId}|${targetKey}|${windowKind}`;

export function deriveIntents(
  payload: AdvisorFindingsPayload,
  opts: DeriveIntentsOpts,
): AdvisorIntentWire[] {
  const win = payload.window;
  const botById = new Map<number, AdvisorBotTotals>(payload.bots.map((b) => [b.botUserId, b]));
  const out: AdvisorIntentWire[] = [];
  const push = (intent: AdvisorIntentWire): void => {
    out.push(intent);
  };
  const botOf = (id: number): AdvisorBotTotals | undefined => {
    const b = botById.get(id);
    // Cells never come from quality checks (core guarantees it), but the guard keeps the
    // rule visible: a linter's noise is its job, and no intent may target one.
    return b && !b.isQualityCheck ? b : undefined;
  };

  // ── Path cells → SUPPRESS_PATH / AMPLIFY_PATH / QUIET_PATH_NITS ───────────────────────
  // One intent per cell, checked in subsumption order: full suppression (only when the
  // veto passes — nothing high-severity was acted on there), then amplification, then the
  // nit-scoped quieting. A vetoed suppression cell falls through to the quiet check; a
  // vetoed cell that is not nit-dominated produces NOTHING, which is the honest outcome —
  // "mostly ignored but the one acted-on finding was a big one" is not a tuning signal.
  for (const cell of payload.pathCells) {
    const bot = botOf(cell.botUserId);
    if (!bot) continue;
    const untouchedShare = cell.volume > 0 ? cell.untouched / cell.volume : 0;
    const actedShare = cell.volume > 0 ? cell.actedOn / cell.volume : 0;
    const labelled =
      cell.bySeverity.nit + cell.bySeverity.minor + cell.bySeverity.major + cell.bySeverity.critical;
    const nitShare = labelled > 0 ? cell.bySeverity.nit / labelled : 0;
    const nitActedShare = cell.bySeverity.nit > 0 ? cell.actedOnNits / cell.bySeverity.nit : 0;
    if (
      untouchedShare >= SUPPRESS_MIN_UNTOUCHED_SHARE &&
      cell.actedOnHigh <= SUPPRESS_MAX_ACTED_HIGH &&
      cell.mergedUntouched >= SUPPRESS_MIN_MERGED_UNTOUCHED
    ) {
      push({
        kind: 'SUPPRESS_PATH',
        botUserId: bot.botUserId,
        botKey: bot.key,
        botLabel: bot.label,
        botKind: bot.kind,
        target: { kind: 'path', pathBucket: cell.pathBucket },
        targetKey: cell.pathBucket,
        dedupeKey: dedupeKeyFor('SUPPRESS_PATH', bot.botUserId, cell.pathBucket, win.kind),
        rationale: `${Math.round(untouchedShare * 100)}% of ${bot.label}'s ${cell.volume} threads in ${cell.pathBucket} went untouched (${cell.mergedUntouched} shipped in PRs that merged anyway), and nothing acted on there was high-severity — suppress this path.`,
        evidence: evidenceFromPathCell(cell, bot, win),
        retro: retroFor('SUPPRESS_PATH', { pathCell: cell }),
      });
    } else if (
      actedShare * 100 >= payload.floors.amplifyMinActedPct &&
      cell.actedOnHigh >= AMPLIFY_MIN_ACTED_HIGH
    ) {
      push({
        kind: 'AMPLIFY_PATH',
        botUserId: bot.botUserId,
        botKey: bot.key,
        botLabel: bot.label,
        botKind: bot.kind,
        target: { kind: 'path', pathBucket: cell.pathBucket },
        targetKey: cell.pathBucket,
        dedupeKey: dedupeKeyFor('AMPLIFY_PATH', bot.botUserId, cell.pathBucket, win.kind),
        rationale: `${Math.round(actedShare * 100)}% of ${bot.label}'s ${cell.volume} threads in ${cell.pathBucket} were acted on (${cell.actedOnHigh} high-severity) — ask for deeper coverage here.`,
        evidence: evidenceFromPathCell(cell, bot, win),
        retro: retroFor('AMPLIFY_PATH', { pathCell: cell }),
      });
    } else if (
      labelled >= payload.floors.minCellThreads &&
      nitShare >= QUIET_PATH_MIN_NIT_SHARE &&
      nitActedShare <= QUIET_PATH_MAX_NIT_ACTED_SHARE
    ) {
      push({
        kind: 'QUIET_PATH_NITS',
        botUserId: bot.botUserId,
        botKey: bot.key,
        botLabel: bot.label,
        botKind: bot.kind,
        target: { kind: 'path', pathBucket: cell.pathBucket },
        targetKey: cell.pathBucket,
        dedupeKey: dedupeKeyFor('QUIET_PATH_NITS', bot.botUserId, cell.pathBucket, win.kind),
        rationale: `${cell.bySeverity.nit} of ${bot.label}'s ${labelled} scored findings in ${cell.pathBucket} are nits and ${cell.bySeverity.nit - cell.actedOnNits} of those went unaddressed — keep the path, stop nit-level comments there.`,
        evidence: evidenceFromPathCell(cell, bot, win),
        retro: retroFor('QUIET_PATH_NITS', { pathCell: cell }),
      });
    }
  }

  // ── Category cells → SUPPRESS_CATEGORY / ESCALATE ─────────────────────────────────────
  for (const cell of payload.categoryCells) {
    const bot = botOf(cell.botUserId);
    if (!bot) continue;
    if (cell.category === 'praise') continue; // labelled work, never a finding target
    const phrasing = CATEGORY_PHRASING[cell.category];
    const linkedUntouchedShare =
      cell.threadLinked > 0 ? cell.untouched / cell.threadLinked : 0;
    const linkedActedShare = cell.threadLinked > 0 ? cell.actedOn / cell.threadLinked : 0;
    if (
      cell.threadLinked >= payload.floors.minCellThreads &&
      linkedUntouchedShare >= SUPPRESS_MIN_UNTOUCHED_SHARE &&
      // The same veto + merged-past gate as SUPPRESS_PATH: an acted-on high-severity finding
      // in the category is proof of value, and open-PR silence alone is not final.
      cell.actedOnHigh <= SUPPRESS_MAX_ACTED_HIGH &&
      cell.mergedUntouched >= SUPPRESS_MIN_MERGED_UNTOUCHED
    ) {
      push({
        kind: 'SUPPRESS_CATEGORY',
        botUserId: bot.botUserId,
        botKey: bot.key,
        botLabel: bot.label,
        botKind: bot.kind,
        target: { kind: 'category', category: cell.category },
        targetKey: cell.category,
        dedupeKey: dedupeKeyFor('SUPPRESS_CATEGORY', bot.botUserId, cell.category, win.kind),
        rationale: `${Math.round(linkedUntouchedShare * 100)}% of ${bot.label}'s ${phrasing.label.toLowerCase()} findings went untouched (${cell.threadLinked} thread-linked of ${cell.findings}; ${cell.mergedUntouched} shipped in PRs that merged anyway) — suppress this category.`,
        evidence: evidenceFromCategoryCell(cell, bot, win),
        retro: retroFor('SUPPRESS_CATEGORY', { categoryCell: cell }),
      });
    } else if (
      cell.threadLinked >= ESCALATE_MIN_THREAD_LINKED &&
      linkedActedShare >= ESCALATE_MIN_ACTED_SHARE
    ) {
      push({
        kind: 'ESCALATE',
        botUserId: bot.botUserId,
        botKey: bot.key,
        botLabel: bot.label,
        botKind: bot.kind,
        target: { kind: 'category', category: cell.category },
        targetKey: cell.category,
        dedupeKey: dedupeKeyFor('ESCALATE', bot.botUserId, cell.category, win.kind),
        rationale: `${Math.round(linkedActedShare * 100)}% of ${bot.label}'s ${phrasing.label.toLowerCase()} findings were acted on — ask the bot to rank this category higher.`,
        evidence: evidenceFromCategoryCell(cell, bot, win),
        retro: retroFor('ESCALATE', { categoryCell: cell }),
      });
    }
  }

  // ── Bot totals → LOWER_VERBOSITY / BOOTSTRAP_CONFIG ───────────────────────────────────
  for (const bot of payload.bots) {
    if (bot.isQualityCheck) continue;
    if (
      bot.mlFindings >= payload.floors.minCellFindings &&
      bot.mlNits / bot.mlFindings >= LOWER_VERBOSITY_MIN_NIT_SHARE
    ) {
      push({
        kind: 'LOWER_VERBOSITY',
        botUserId: bot.botUserId,
        botKey: bot.key,
        botLabel: bot.label,
        botKind: bot.kind,
        target: { kind: 'severity' },
        targetKey: 'nit',
        dedupeKey: dedupeKeyFor('LOWER_VERBOSITY', bot.botUserId, 'nit', win.kind),
        rationale: `${Math.round((bot.mlNits / bot.mlFindings) * 100)}% of ${bot.label}'s ${bot.mlFindings} scored findings are nits — raise its severity floor.`,
        evidence: evidenceFromBotTotals(bot, win),
        retro: retroFor('LOWER_VERBOSITY', { bot }),
      });
    }
    if (
      !opts.botsWithConfigTarget.has(bot.botUserId) &&
      bot.threads >= BOOTSTRAP_MIN_THREADS
    ) {
      push({
        kind: 'BOOTSTRAP_CONFIG',
        botUserId: bot.botUserId,
        botKey: bot.key,
        botLabel: bot.label,
        botKind: bot.kind,
        target: { kind: 'bootstrap' },
        targetKey: 'config',
        dedupeKey: dedupeKeyFor('BOOTSTRAP_CONFIG', bot.botUserId, 'config', win.kind),
        rationale: `${bot.label} produced ${bot.threads} threads this window with no known configuration — bootstrap a config file so it becomes tunable.`,
        evidence: evidenceFromBotTotals(bot, win),
        retro: retroFor('BOOTSTRAP_CONFIG', { bot }),
      });
    }
  }

  // ── Overlap cells → SCOPE_OFF ─────────────────────────────────────────────────────────
  // One intent per bot (its heaviest partner), not one per pair direction — the reader
  // decides which of the two to narrow, and both bots may earn one (symmetric, like the
  // free overlap suggestion).
  const bestPartner = new Map<number, (typeof payload.overlapCells)[number]>();
  for (const cell of payload.overlapCells) {
    const cur = bestPartner.get(cell.botUserId);
    if (
      !cur ||
      cell.sharedClusters > cur.sharedClusters ||
      (cell.sharedClusters === cur.sharedClusters && cell.partnerUserId < cur.partnerUserId)
    )
      bestPartner.set(cell.botUserId, cell);
  }
  for (const cell of bestPartner.values()) {
    const bot = botOf(cell.botUserId);
    if (!bot) continue;
    const share = cell.threads > 0 ? cell.overlapThreads / cell.threads : 0;
    if (share < SCOPE_OFF_MIN_OVERLAP_SHARE) continue;
    const partner = botById.get(cell.partnerUserId);
    const partnerLabel = partner?.label ?? `#${cell.partnerUserId}`;
    push({
      kind: 'SCOPE_OFF',
      botUserId: bot.botUserId,
      botKey: bot.key,
      botLabel: bot.label,
      botKind: bot.kind,
      target: { kind: 'partner', partnerUserId: cell.partnerUserId, partnerLabel },
      targetKey: `u${cell.partnerUserId}`,
      dedupeKey: dedupeKeyFor('SCOPE_OFF', bot.botUserId, `u${cell.partnerUserId}`, win.kind),
      rationale: `${cell.overlapThreads} of ${bot.label}'s ${cell.threads} threads land on lines other bots also flagged (most often ${partnerLabel}: ${cell.sharedClusters} shared cluster${cell.sharedClusters === 1 ? '' : 's'}) — narrow one of the two.`,
      evidence: evidenceFromOverlapCell(cell, bot, win),
      retro: retroFor('SCOPE_OFF', {}),
    });
  }

  // ── T4 lint templates → PROMOTE_TO_LINT (DeepSource-only in v1; advisory text) ────────
  for (const stat of opts.lintTemplates ?? []) {
    if (stat.fires < PROMOTE_TO_LINT_MIN_FIRES) continue;
    const bot = botById.get(stat.botUserId);
    if (!bot) continue;
    const actedPct = stat.fires > 0 ? Math.round((stat.actedOn / stat.fires) * 100) : 0;
    push({
      kind: 'PROMOTE_TO_LINT',
      botUserId: bot.botUserId,
      botKey: bot.key,
      botLabel: bot.label,
      botKind: bot.kind,
      target: { kind: 'lint', template: stat.template },
      targetKey: stat.template,
      dedupeKey: dedupeKeyFor('PROMOTE_TO_LINT', bot.botUserId, stat.template, win.kind),
      rationale: `"${stat.template}" fired ${stat.fires}× (${actedPct}% acted on) — a deterministic lint rule would catch this earlier and cheaper than a review bot.`,
      evidence: evidenceFromBotTotals(bot, win),
      retro: retroFor('PROMOTE_TO_LINT', { bot }),
    });
  }

  // Deterministic order: worst evidence first within a bot, bots by thread volume (the
  // payload's own order), then intent kind for stability.
  const botOrder = new Map(payload.bots.map((b, i) => [b.botUserId, i]));
  out.sort(
    (a, b) =>
      (botOrder.get(a.botUserId) ?? 0) - (botOrder.get(b.botUserId) ?? 0) ||
      b.evidence.volume - a.evidence.volume ||
      a.kind.localeCompare(b.kind) ||
      a.targetKey.localeCompare(b.targetKey),
  );
  return out;
}
