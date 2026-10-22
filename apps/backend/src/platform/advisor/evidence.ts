// Evidence assembly: one AdvisorEvidence per intent, built from the cell that produced it.
// Pure functions over plain data — no ctx, no I/O. The path-coverage disclosure rides EVERY
// evidence object (the 41%-corpus rule: only review_comment-kind labels can carry a path, so
// any path-keyed claim must say how much of the bot's output it can even see).
import type {
  AdvisorBotTotals,
  AdvisorCategoryCell,
  AdvisorEvidence,
  AdvisorFindingsPayload,
  AdvisorOverlapCell,
  AdvisorPathCell,
} from '@pierre-review/shared';

const pct = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 100) : null;

type Win = AdvisorFindingsPayload['window'];

export function evidenceFromPathCell(
  cell: AdvisorPathCell,
  bot: AdvisorBotTotals,
  win: Win,
): AdvisorEvidence {
  return {
    windowKind: win.kind,
    from: win.from,
    to: win.to,
    volume: cell.volume,
    actedOn: cell.actedOn,
    actedOnPct: pct(cell.actedOn, cell.volume),
    untouched: cell.untouched,
    untouchedPct: pct(cell.untouched, cell.volume),
    mergedUntouched: cell.mergedUntouched,
    overdueUntouched: cell.overdueUntouched,
    dissent: cell.dissent,
    actedOnHigh: cell.actedOnHigh,
    bySeverity: cell.bySeverity,
    samplePrIds: cell.samplePrIds,
    pathCoveragePct: bot.pathCoveragePct,
  };
}

export function evidenceFromCategoryCell(
  cell: AdvisorCategoryCell,
  bot: AdvisorBotTotals,
  win: Win,
): AdvisorEvidence {
  return {
    windowKind: win.kind,
    from: win.from,
    to: win.to,
    volume: cell.findings,
    actedOn: cell.actedOn,
    // Acted-on facts exist only for the THREAD-LINKED subset — the denominator is disclosed
    // via `threadLinked`, never silently swapped for `findings`.
    actedOnPct: pct(cell.actedOn, cell.threadLinked),
    untouched: cell.untouched,
    untouchedPct: pct(cell.untouched, cell.threadLinked),
    mergedUntouched: cell.mergedUntouched,
    overdueUntouched: cell.overdueUntouched,
    dissent: cell.dissent,
    actedOnHigh: cell.actedOnHigh,
    bySeverity: cell.bySeverity,
    threadLinked: cell.threadLinked,
    samplePrIds: cell.samplePrIds,
    pathCoveragePct: bot.pathCoveragePct,
  };
}

export function evidenceFromBotTotals(bot: AdvisorBotTotals, win: Win): AdvisorEvidence {
  return {
    windowKind: win.kind,
    from: win.from,
    to: win.to,
    volume: bot.threads,
    actedOn: bot.actedOn,
    actedOnPct: pct(bot.actedOn, bot.threads),
    untouched: bot.untouched,
    untouchedPct: pct(bot.untouched, bot.threads),
    mergedUntouched: bot.mergedUntouched,
    overdueUntouched: bot.overdueUntouched,
    dissent: bot.dissent,
    actedOnHigh: 0,
    samplePrIds: [],
    pathCoveragePct: bot.pathCoveragePct,
  };
}

export function evidenceFromOverlapCell(
  cell: AdvisorOverlapCell,
  bot: AdvisorBotTotals,
  win: Win,
): AdvisorEvidence {
  return {
    windowKind: win.kind,
    from: win.from,
    to: win.to,
    volume: cell.threads,
    actedOn: bot.actedOn,
    actedOnPct: pct(bot.actedOn, bot.threads),
    untouched: bot.untouched,
    untouchedPct: pct(bot.untouched, bot.threads),
    mergedUntouched: bot.mergedUntouched,
    overdueUntouched: bot.overdueUntouched,
    dissent: bot.dissent,
    actedOnHigh: 0,
    samplePrIds: [],
    pathCoveragePct: bot.pathCoveragePct,
  };
}
