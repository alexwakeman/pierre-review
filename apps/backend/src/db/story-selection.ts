import {
  STORY_ISSUE_IDS,
  STORY_REPORT_GROUP_CAPS,
  foldStoryIssues,
  storyIssueMeasure,
  storyIssueStates,
  storyReportWindowDays,
  type StoryIssueInput,
  type StoryReportIssueRate,
  type StoryReportCandidate,
  type StoryReportGroup,
  type StoryReportPopulation,
  type StoryReportRange,
  type StoryReportWindowChoice,
} from '@pierre-review/shared';
import type { BotScope } from './queries.js';
import { getReportingWindow, measuredTo, reportingWindowInfo, type ReportingWindow } from './reporting-window.js';
import { foldStories, type StoryInternals } from './stories.js';
import { storyLabelInput } from './story-label-input.js';
import { currentLabelRowsFor } from './story-health.js';

// THE STORY REPORT'S PICKS — which 10-20 stories the agent reads (docs/CLAUDE-REVIEW.md § Story
// report). CODE decides, never the model: four groups with caps, each pick carrying code-written
// `whyPicked` reasons, plus WHOLE-WINDOW figures (`population`) — the only numbers the agent may
// generalise from, since the picks are a hand-picked sample (best, worst, odd).
//
// The rules are the trial harness's (scratchpad haiku/agent-exp.mts, round 2) VERBATIM, with ONE
// change: ⚠ A STORY WITH NO CRITERIA (`criteria.source === 'none'`) IS NEVER FILED UNDER fell_short.
// With nothing written to check against, its outcome is UNKNOWN, not bad; it falls through to
// no_criteria.
//
// THE FOUR STORY ISSUES (shared `story-issues.ts`): each pick carries `foldStoryIssues` over today's
// criteria + its CURRENT label with a per-issue state (`storyIssueStates`: true / false / null = not
// known — never "avoided"), and `population.issueRates` counts every story in the window by THE rate
// rule `storyIssueMeasure` (labelled stories only; "no criteria" stays its own `noCriteriaFound`) — so
// the agent's rates come from code over the whole window, never from the picks.
//
// ⚠ DETERMINISTIC: the input order is the fold's (newest last merge first, then ident) and the sort is
// stable with explicit tie-breaks, so the same data always picks the same stories — the fingerprint
// (review/story-report/fingerprint.ts) depends on it.

type Cand = { s: StoryInternals; why: string[]; group: StoryReportGroup; score: number };

export interface StorySelection {
  candidates: StoryReportCandidate[];
  population: StoryReportPopulation;
  /** Tracker key → the picked story's internals (what `get_story` reads). */
  internalsByKey: Map<string, StoryInternals>;
}

const pct = (vals: number[], v: number) => vals.filter((x) => x <= v).length / Math.max(vals.length, 1);

/** Whole-window issue rates by THE rate rule; a story whose input is null (ticket never read) is out. */
export function storyIssueRates(inputs: Iterable<StoryIssueInput | null>): StoryReportIssueRate[] {
  const rates = STORY_ISSUE_IDS.map((id): StoryReportIssueRate => ({ id, stories: 0, of: 0 }));
  for (const input of inputs) {
    if (input == null) continue;
    const m = storyIssueMeasure(input);
    for (const r of rates) {
      const v = m[r.id];
      if (v == null) continue;
      r.of += 1;
      if (v) r.stories += 1;
    }
  }
  return rates;
}

/** The pure half: the picks and the whole-window figures over the fold's stories. `issueInputs` (by
 *  ident; null = ticket text never read) adds the story issues — absent, no issue fields are written. */
export function selectStories(
  stories: readonly StoryInternals[],
  workingDayHours: number,
  truncated = false,
  issueInputs?: ReadonlyMap<string, StoryIssueInput | null>,
): StorySelection {
  const hrs = stories.map((s) => s.row.workingHours);
  const lines = stories.map((s) => s.row.linesChanged ?? 0);
  const prs = stories.map((s) => s.row.prs.total);
  const cands: Cand[] = [];
  for (const s of stories) {
    const r = s.row;
    const why: string[] = [];
    const hp = pct(hrs, r.workingHours),
      lp = pct(lines, r.linesChanged ?? 0),
      pp = pct(prs, r.prs.total);
    if (hp >= 0.85) why.push(`slow (top ${Math.round((1 - hp) * 100) || 1}% for working time)`);
    if (lp >= 0.85 && r.linesChanged != null) why.push('large change for this team');
    if (pp >= 0.9) why.push(`many PRs (${r.prs.total})`);
    const c = r.criteria.count ?? 0;
    const aligned = r.review?.alignment === 'aligned' && r.unmetCount === 0;
    let group: StoryReportGroup | null = null;
    let score = 0;
    // ⚠ THE ONE CHANGE: `source !== 'none'` — a no-criteria story is never "fell short".
    if (r.criteria.source !== 'none' && (r.unmetCount > 0 || (r.review && r.review.alignment !== 'aligned'))) {
      group = 'fell_short';
      why.push(`${r.unmetCount} criteria unmet or missing in the review`);
      score = 2 + r.unmetCount;
    } else if (r.criteria.source === 'none') {
      group = 'no_criteria';
      why.push('no acceptance criteria written (outcome not checked by this)');
      score = 1 + hp + lp;
    } else if (aligned && c >= 3) {
      group = 'done_well';
      why.push(`review: all ${c} criteria met`);
      score = 2 + Math.min(c, 10) / 5 + (1 - hp);
    } else if (c >= 3 && hp <= 0.4 && r.criteria.source === 'acceptance_criteria') {
      group = 'done_well';
      why.push(`${c} written criteria, quick to merge`);
      score = 1 + (1 - hp);
    }
    const outlierBits: string[] = [];
    if (c >= 15 && lp <= 0.3) outlierBits.push(`${c} criteria for a small change`);
    if (hp >= 0.8 && lp <= 0.3) outlierBits.push('small change that took a long time');
    if (pp >= 0.9 && lp <= 0.5) outlierBits.push('many PRs for its size');
    if (outlierBits.length) {
      why.push(...outlierBits);
      if (!group) {
        group = 'outlier';
        score = 1 + outlierBits.length;
      }
    }
    if (group) cands.push({ s, why, group, score: score + (hp >= 0.85 ? 0.5 : 0) + (lp >= 0.85 ? 0.5 : 0) });
  }
  const lastMs = (c: Cand) => Date.parse(c.s.row.lastMergedAt);
  const take = (g: StoryReportGroup, n: number) =>
    cands
      .filter((c) => c.group === g)
      .sort((a, b) => b.score - a.score || lastMs(b) - lastMs(a) || a.s.row.ident.localeCompare(b.s.row.ident))
      .slice(0, n);
  const picked = [
    ...take('done_well', STORY_REPORT_GROUP_CAPS.done_well),
    ...take('fell_short', STORY_REPORT_GROUP_CAPS.fell_short),
    ...take('no_criteria', STORY_REPORT_GROUP_CAPS.no_criteria),
    ...take('outlier', STORY_REPORT_GROUP_CAPS.outlier),
  ];

  // Whole-window figures, computed by code — the ONLY numbers the agent may generalise from.
  const reviewed = stories.filter((s) => s.row.review != null);
  const sortedHrs = [...hrs].sort((a, b) => a - b);
  const population: StoryReportPopulation = {
    storiesInWindow: stories.length,
    withWrittenCriteria: stories.filter((s) => s.row.criteria.source === 'acceptance_criteria').length,
    criteriaOnlyInDescription: stories.filter((s) => s.row.criteria.source === 'description_heading').length,
    noCriteriaFound: stories.filter((s) => s.row.criteria.source === 'none').length,
    checkedByTicketReview: reviewed.length,
    checkedAndFullyMet: reviewed.filter((s) => s.row.unmetCount === 0 && s.row.review!.alignment === 'aligned').length,
    checkedWithGaps: reviewed.filter((s) => s.row.unmetCount > 0 || s.row.review!.alignment !== 'aligned').length,
    medianWorkingHours: sortedHrs.length > 0 ? sortedHrs[Math.floor(sortedHrs.length / 2)]! : null,
    workingDayHours,
    truncated,
  };
  if (issueInputs != null) population.issueRates = storyIssueRates(stories.map((s) => issueInputs.get(s.row.ident) ?? null));

  const candidates: StoryReportCandidate[] = picked.map((c) => {
    const r = c.s.row;
    const input = issueInputs?.get(r.ident) ?? null;
    const issues =
      issueInputs == null
        ? {}
        : input == null
          ? { issues: null, issueStates: null }
          : { issues: foldStoryIssues(input), issueStates: storyIssueStates(input) };
    return {
      ident: r.ident,
      key: r.key,
      title: r.title,
      url: r.url,
      provider: r.provider,
      group: c.group,
      whyPicked: c.why,
      workingHours: r.workingHours,
      pullRequests: r.prs.total,
      linesChanged: r.linesChanged,
      criteria: r.criteria.count,
      criteriaSource: r.criteria.source,
      review: r.review
        ? {
            alignment: r.review.alignment,
            met: r.review.met,
            partlyMet: r.review.partlyMet,
            notMet: r.review.notMet,
            missing: r.review.missing,
          }
        : null,
      ...issues,
    };
  });
  return { candidates, population, internalsByKey: new Map(picked.map((c) => [c.s.row.key, c.s])) };
}

const DAY_MS = 86_400_000;

/** The window a choice names. 'reporting' asks the ONE resolver (`getReportingWindow`); a day choice
 *  is a trailing span ending now (`mode` is only the fold's echo field and is never shown). */
export async function storyReportWindow(
  accountId: number,
  workspaceId: number,
  choice: StoryReportWindowChoice,
  nowMs: number,
): Promise<{ window: ReportingWindow; range: StoryReportRange }> {
  const days = storyReportWindowDays(choice);
  if (days == null) {
    const window = await getReportingWindow(accountId, workspaceId, nowMs);
    return {
      window,
      range: {
        choice,
        from: new Date(window.fromMs).toISOString(),
        to: new Date(Math.max(window.fromMs, measuredTo(window, nowMs))).toISOString(),
        days: Math.round((window.toMs - window.fromMs) / DAY_MS),
        reporting: reportingWindowInfo(window, nowMs),
      },
    };
  }
  const window: ReportingWindow = { fromMs: nowMs - days * DAY_MS, toMs: nowMs, mode: 'rolling_14' };
  return {
    window,
    range: { choice, from: new Date(window.fromMs).toISOString(), to: new Date(nowMs).toISOString(), days, reporting: null },
  };
}

/** The async wrapper: resolve the window, fold the stories, pick. Code only — no model, no GitHub. */
export async function loadStorySelection(
  accountId: number,
  scope: BotScope,
  choice: StoryReportWindowChoice,
  nowMs: number,
): Promise<StorySelection & { range: StoryReportRange; trackerOn: boolean }> {
  const { window, range } = await storyReportWindow(accountId, scope.workspaceId, choice, nowMs);
  const fold = await foldStories(accountId, scope, nowMs, window);
  const stories = [...fold.internals.values()];
  const issueInputs = await storyIssueInputs(accountId, stories);
  const sel = selectStories(stories, fold.workingDayHours, fold.truncated, issueInputs);
  return { ...sel, range, trackerOn: fold.trackerOn };
}

/** Each story's issue input: today's criteria (the labeller's list — the ONE extractor) and its CURRENT
 *  label (rubric + text hash match), in ONE batched, account-predicated label read. null = the ticket
 *  text was never read. */
export async function storyIssueInputs(
  accountId: number,
  stories: readonly StoryInternals[],
): Promise<Map<string, StoryIssueInput | null>> {
  const labels = stories.length > 0 ? await currentLabelRowsFor(accountId, stories.map((s) => s.row.ident)) : new Map();
  const out = new Map<string, StoryIssueInput | null>();
  for (const s of stories) {
    if (s.ticket == null) {
      out.set(s.row.ident, null);
      continue;
    }
    const input = storyLabelInput(s.ticket, s.row.provider);
    const label = input != null ? (labels.get(s.row.ident)?.get(input.textHash) ?? null) : null;
    out.set(s.row.ident, { criteria: input?.criteria ?? [], label });
  }
  return out;
}
