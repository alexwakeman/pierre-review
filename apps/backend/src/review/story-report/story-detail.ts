import {
  STORY_DEPENDENCY_KIND_LABEL,
  STORY_ISSUES,
  STORY_ISSUE_BY_ID,
  STORY_SPEC_GAP_TYPE_LABEL,
  type StoryIssue,
  type StoryReportCandidate,
  type StoryReportPopulation,
} from '@pierre-review/shared';
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
    // The three story issues by LABEL (what the agent quotes), each with a state: present (and the
    // specific detail behind it), false = known absent, null = NOT KNOWN. ⚠ An unread ticket is
    // `issues: null` and an unlabelled one says null per issue — never `[]` ("avoids all three").
    ...(c.issues !== undefined ? { issues: candidateIssues(c) } : {}),
  };
}

/** The SPECIFIC detail behind one present issue — which criteria and why, what the story waited on
 *  (who, ticket, status, finished or not), which details the spec leaves out. Ticket-derived strings:
 *  fenced with the rest of the tool answer, and in `storyUntrustedTexts`. */
export function issueDetailForAgent(i: StoryIssue) {
  switch (i.id) {
    case 'unclear_done':
      return i.reasons.includes('no_criteria')
        ? { noCriteria: true }
        : { criteria: i.criteria.map((c) => ({ criterion: c.n, reason: c.reason })) };
    case 'blocked':
      return {
        waitsOn: i.blockers.map((b) => ({
          what: b.what,
          kind: STORY_DEPENDENCY_KIND_LABEL[b.kind],
          ticket: b.ticketKey,
          owner: b.owner,
          status: b.status,
          finished: b.resolved,
          source: b.source === 'link' ? 'tracker link' : 'named in the ticket text',
        })),
      };
    case 'spec_gaps':
      return { gaps: i.gaps.map((g) => ({ type: STORY_SPEC_GAP_TYPE_LABEL[g.type], gap: g.text })) };
  }
}

/** One candidate's three issues for the agent; null when the ticket text was never read. Old rows'
 *  retired ids never reach here (the list is STORY_ISSUES, looked up by id). */
export function candidateIssues(c: StoryReportCandidate) {
  if (c.issues == null) return null;
  const states = c.issueStates ?? null;
  return STORY_ISSUES.map((m) => {
    const hit = c.issues!.find((i) => i.id === m.id);
    if (hit != null) return { issue: m.label, present: true as const, ...issueDetailForAgent(hit) };
    // An issue code did not raise is known absent only when its state says so; old rows had no state.
    return { issue: m.label, present: states != null ? (states[m.id] ?? null) : null };
  });
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
    // Whole-window, by code: the ONLY issue rates the agent may quote, each in its own unit (`count` of
    // `of` criteria or stories) — the same measures as Story health; no-criteria is `noCriteriaFound`.
    ...(p.issueRates != null
      ? {
          issueRates: p.issueRates.map((r) => ({
            measure: STORY_ISSUE_BY_ID[r.id].measureLabel,
            count: r.stories,
            of: r.of,
            unit: r.unit ?? 'stories',
          })),
        }
      : {}),
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
    if (c.issues != null) out.push(JSON.stringify(candidateIssues(c)));
    const s = byKey.get(c.key);
    if (s == null) continue;
    out.push(JSON.stringify(storyDetail(c.key, byKey)));
  }
  return out;
}
