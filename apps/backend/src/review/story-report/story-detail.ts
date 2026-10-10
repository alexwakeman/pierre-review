import type { StoryReportCandidate, StoryReportPopulation } from '@pierre-review/shared';
import type { StoryInternals } from '../../db/stories.js';

// What the story report's agent READS — the trial harness's (scratchpad haiku/agent-exp.mts)
// `candidateTable`, `population` and `storyDetail()` verbatim, adapted only to the stored shapes. Pure.
//
// ⚠ ALL OF IT IS ATTACKER-AUTHORED TEXT (ticket titles, descriptions and criteria; PR titles; the
// ticket review's model prose). agent.ts nonce-fences every tool answer built here.

const COLOR_RE = /\{color[^}]*\}/g;

/** Drop Jira colour markup, collapse whitespace before a newline, cap. */
export function stripStoryText(s: string | null | undefined, cap: number): string {
  return (s ?? '').replace(COLOR_RE, '').replace(/\s+\n/g, '\n').slice(0, cap);
}

/** The prototype's caps on the ticket text `get_story` returns. */
export const STORY_DETAIL_DESCRIPTION_MAX = 3000;
export const STORY_DETAIL_AC_MAX = 2500;

/** "2.4 working days" / "5.0 working hours" — the agent's duration words. */
export function workingDuration(hours: number, dayHours: number): string {
  return hours >= dayHours ? `${(hours / dayHours).toFixed(1)} working days` : `${hours.toFixed(1)} working hours`;
}

/** `list_candidates`' table row. */
export function candidateRow(c: StoryReportCandidate, dayHours: number) {
  return {
    key: c.key,
    title: c.title,
    url: c.url,
    group: c.group,
    whyPicked: c.whyPicked,
    time: workingDuration(c.workingHours, dayHours),
    pullRequests: c.pullRequests,
    linesChanged: c.linesChanged,
    criteria: c.criteria,
    criteriaSource: c.criteriaSource,
    review: c.review
      ? { alignment: c.review.alignment, met: c.review.met, partlyMet: c.review.partlyMet, notMet: c.review.notMet, missing: c.review.missing }
      : null,
  };
}

/** `list_candidates`' `wholeWindow` — the raw population with the median as words, as the prototype sent. */
export function populationForAgent(p: StoryReportPopulation) {
  return {
    storiesInWindow: p.storiesInWindow,
    withWrittenCriteria: p.withWrittenCriteria,
    criteriaOnlyInDescription: p.criteriaOnlyInDescription,
    noCriteriaFound: p.noCriteriaFound,
    checkedByTicketReview: p.checkedByTicketReview,
    checkedAndFullyMet: p.checkedAndFullyMet,
    checkedWithGaps: p.checkedWithGaps,
    medianWorkingTime: workingDuration(p.medianWorkingHours ?? 0, p.workingDayHours),
  };
}

/** `get_story` for one picked key; an unknown key gets the prototype's error object. */
export function storyDetail(key: string, byKey: ReadonlyMap<string, StoryInternals>) {
  const s = byKey.get(key);
  if (!s) return { error: `Unknown ticket ${key}. Use a key from list_candidates.` };
  const snap = s.review?.snapshot,
    t = s.ticket;
  const a = s.review?.assessment;
  return {
    key,
    title: s.row.title,
    url: s.row.url,
    description: stripStoryText(snap?.description ?? t?.description, STORY_DETAIL_DESCRIPTION_MAX),
    acceptanceCriteria: stripStoryText(snap?.acceptanceCriteria ?? t?.acceptanceCriteria, STORY_DETAIL_AC_MAX),
    review: a
      ? {
          summary: a.summary,
          criteria: a.criteria.map((x) => ({ ref: x.ref, text: x.text, status: x.status, explanation: x.explanation })),
          missing: a.missing.map((m) => ({ ref: m.ref, title: m.title, explanation: m.explanation })),
          notRequested: a.notRequested.map((n) => ({ title: n.title })),
        }
      : null,
    pullRequests: [...s.prs.values()].map((p) => ({
      ref: `${p.repoFullName.split('/')[1]}#${p.number}`,
      title: p.title,
      state: p.state,
      linesChanged: p.additions + p.deletions,
    })),
  };
}

/** Every untrusted string a tool answer may carry this run — the nonce-collision scan's input. */
export function storyUntrustedTexts(
  candidates: readonly StoryReportCandidate[],
  byKey: ReadonlyMap<string, StoryInternals>,
): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    out.push(c.key, c.title ?? '', c.url ?? '');
    const s = byKey.get(c.key);
    if (s == null) continue;
    out.push(JSON.stringify(storyDetail(c.key, byKey)));
  }
  return out;
}
