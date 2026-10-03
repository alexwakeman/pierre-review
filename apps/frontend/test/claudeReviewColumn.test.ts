// THE OPEN PRs CARDS' CLAUDE REVIEW PANEL — the pure half.
//
//   1. THE CELL: no run → Review; a start in flight → disabled "Starting…"; queued / running →
//      disabled; succeeded → the verdict as a link, plus Re-review only when the head moved;
//      failed / cancelled → Review again.
//   2. THE SORT RANK leads with the rows that still need a review.
//   3. THE FILL: one helper (`fillDraftFromJira`) for the panel and the list.
//   4. THE LIST'S USER STORY: a re-review reuses the stored ticket; else the first FILLABLE Jira
//      ticket is filled the panel's way; the run starts EITHER WAY, with a note, never a throw.
//   5. THE WIRING: the panel is capability-gated and every panel control stops propagation.
//   7. THE PANEL: its outcome accent, the CI-failure line and the threads-to-fix line, each null
//      (render nothing) where the run did not look.
//   6. AUTO REVIEW: a queued (in its lane, no row) or running auto review HOLDS the PR — no button,
//      even over a start in flight — the column keeps polling while one is queued, every auto run
//      carries the "Auto review" marker, and a 409 AutoReviewInProgress keeps the button shut.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/claudeReviewColumn.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAUDE_REVIEW_TICKET_LIMITS,
  type ClaudeReviewPrState,
  type JiraAcCandidate,
  type JiraTicketDetails,
  type TicketRef,
} from '@pierre-review/shared';
import {
  NO_STORY_NOTE,
  findingTotal,
  findingsRank,
  followUpTally,
  reviewCurrency,
  severityPills,
  anyReviewInFlight,
  heldByAutoReview,
  resolveListTicket,
  reviewCellFor,
  reviewCellRank,
  reviewTone,
  ciDiagnosisLabel,
  threadsToFixLabel,
} from '../src/lib/claudeReviewColumn.js';
import { fillDraftFromJira, type AcMemoryStore } from '../src/lib/jiraTicket.js';
import { EMPTY_TICKET_DRAFT } from '../src/lib/claudeReviewFollowUp.js';

const st = (over: Partial<ClaudeReviewPrState> = {}): ClaudeReviewPrState => ({
  prId: 1,
  reviewId: 10,
  status: 'succeeded',
  verdict: 'APPROVE',
  reviewedHeadSha: 'a'.repeat(40),
  finishedAt: '2026-09-30T10:00:00.000Z',
  ticket: null,
  headMoved: false,
  ...over,
});

describe('the cell', () => {
  it('no run ⇒ Review', () => {
    expect(reviewCellFor(undefined, false)).toEqual({ kind: 'start' });
  });
  it('a start in flight wins over any stored state', () => {
    expect(reviewCellFor(undefined, true)).toEqual({ kind: 'starting' });
    expect(reviewCellFor(st(), true)).toEqual({ kind: 'starting' });
  });
  it('queued / running ⇒ their own disabled states', () => {
    expect(reviewCellFor(st({ status: 'queued', verdict: null }), false)).toEqual({ kind: 'queued' });
    expect(reviewCellFor(st({ status: 'running', verdict: null }), false)).toEqual({ kind: 'running' });
  });
  it('succeeded ⇒ the verdict in words, Re-review only when the head moved', () => {
    expect(reviewCellFor(st(), false)).toEqual({
      kind: 'done',
      reviewId: 10,
      verdict: 'APPROVE',
      verdictLabel: 'Approve',
      headMoved: false,
    });
    expect(reviewCellFor(st({ verdict: 'REQUEST_CHANGES', headMoved: true }), false)).toMatchObject({
      verdictLabel: 'Request changes',
      headMoved: true,
    });
    expect(reviewCellFor(st({ verdict: null }), false)).toMatchObject({ verdictLabel: 'Reviewed' });
  });
  it('failed / cancelled ⇒ Review again (never Re-review)', () => {
    expect(reviewCellFor(st({ status: 'failed', headMoved: true }), false)).toEqual({ kind: 'start', failed: true });
    expect(reviewCellFor(st({ status: 'cancelled' }), false)).toEqual({ kind: 'start' });
  });
});

describe('the strip figures', () => {
  const summary = {
    findings: { blocker: 1, warning: 3, nit: 0, question: 2, praise: 1 },
    lenses: { design: 2 },
    postedFindings: 0,
    reviewPosted: false,
    tickets: [],
    followUp: null,
  };

  it('one pill per severity found, most pressing first, praise left out', () => {
    expect(severityPills(summary).map((p) => p.label)).toEqual(['1 blocker', '3 warnings', '2 questions']);
    expect(findingTotal(summary)).toBe(7);
    const clean = { ...summary, findings: { blocker: 0, warning: 0, nit: 0, question: 0, praise: 2 } };
    expect(severityPills(clean)).toEqual([]);
  });

  it('currency: on the latest commit, N newer, 1 newer, branch changed, or nothing when unknown', () => {
    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);
    const cur = reviewCurrency({ reviewedHeadSha: A, currentHeadSha: A, commitsSince: 0 });
    expect(cur).toMatchObject({ tone: 'current', label: 'On latest commit', sha: 'aaaaaaa' });
    expect(cur!.className).toContain('green');
    // A stray count never makes a current review "behind".
    expect(reviewCurrency({ reviewedHeadSha: A, currentHeadSha: A, commitsSince: 3 })!.tone).toBe('current');

    const many = reviewCurrency({ reviewedHeadSha: A, currentHeadSha: B, commitsSince: 4 });
    expect(many).toMatchObject({ tone: 'behind', label: '4 newer commits', sha: 'bbbbbbb' });
    expect(many!.className).toContain('orange');
    expect(reviewCurrency({ reviewedHeadSha: A, currentHeadSha: B, commitsSince: 1 })!.label).toBe('1 newer commit');
    expect(reviewCurrency({ reviewedHeadSha: A, currentHeadSha: B, commitsSince: 0 })!.label).toBe('Branch changed');
    expect(reviewCurrency({ reviewedHeadSha: A, currentHeadSha: B, commitsSince: null })!.label).toBe('Branch changed');
    expect(reviewCurrency({ reviewedHeadSha: A, currentHeadSha: B })!.label).toBe('Branch changed');

    // Unknown either side: say nothing (no reading is never "current").
    expect(reviewCurrency({ reviewedHeadSha: A, currentHeadSha: null })).toBeNull();
    expect(reviewCurrency({ reviewedHeadSha: A, currentHeadSha: undefined })).toBeNull();
    expect(reviewCurrency({ reviewedHeadSha: null, currentHeadSha: A })).toBeNull();
  });

  it('follow-up folds to fixed / still open; nothing to say is null, never zeros', () => {
    expect(followUpTally(null)).toBeNull();
    const none = { addressed: 0, partly_addressed: 0, not_addressed: 0, no_longer_applies: 1, not_checked: 2 };
    expect(followUpTally(none)).toBeNull();
    expect(followUpTally({ ...none, addressed: 2, partly_addressed: 1, not_addressed: 1 })).toEqual({ fixed: 2, open: 2 });
  });

  it('the findings sort puts a PR with no finished run below a clean one', () => {
    expect(findingsRank(undefined)).toBe(-1);
    expect(findingsRank(st())).toBe(-1);
    expect(findingsRank(st({ summary: { ...summary, findings: { blocker: 0, warning: 0, nit: 0, question: 0, praise: 0 } } }))).toBe(0);
    expect(findingsRank(st({ summary }))).toBeGreaterThan(findingsRank(st({ summary: { ...summary, findings: { ...summary.findings, blocker: 0 } } })));
  });
});

describe('auto review in the cell', () => {
  // What the states route sends for a PR whose auto review still waits in its lane.
  const lane = st({
    reviewId: null,
    status: 'queued',
    verdict: null,
    reviewedHeadSha: null,
    finishedAt: null,
    trigger: 'auto',
  });

  it('queued (in its lane, no row) and running auto runs hold the PR: no button, marked auto', () => {
    expect(reviewCellFor(lane, false)).toEqual({ kind: 'queued', auto: true });
    expect(reviewCellFor(st({ status: 'running', verdict: null, trigger: 'auto' }), false)).toEqual({
      kind: 'running',
      auto: true,
    });
    expect(heldByAutoReview(lane)).toBe(true);
    expect(heldByAutoReview(st({ status: 'running', trigger: 'auto' }))).toBe(true);
  });

  it('⚠ the hold wins over a start in flight (that start is about to be refused)', () => {
    expect(reviewCellFor(lane, true)).toEqual({ kind: 'queued', auto: true });
    // A manual run in flight does not hold anything: the start shows as usual.
    expect(reviewCellFor(st({ status: 'queued', trigger: 'manual' }), true)).toEqual({ kind: 'starting' });
  });

  it('a finished auto run is a normal result, marked auto; it holds nothing', () => {
    expect(reviewCellFor(st({ trigger: 'auto', headMoved: true }), false)).toEqual({
      kind: 'done',
      reviewId: 10,
      verdict: 'APPROVE',
      verdictLabel: 'Approve',
      headMoved: true,
      auto: true,
    });
    expect(heldByAutoReview(st({ trigger: 'auto' }))).toBe(false);
    expect(heldByAutoReview(st({ status: 'failed', trigger: 'auto' }))).toBe(false);
    expect(heldByAutoReview(undefined)).toBe(false);
  });

  it('a manual or older-server run carries no marker', () => {
    expect(reviewCellFor(st({ trigger: 'manual' }), false)).not.toHaveProperty('auto');
    expect(reviewCellFor(st({ status: 'queued' }), false)).toEqual({ kind: 'queued' });
  });

  it('keeps the column polling while an auto review waits in its lane', () => {
    expect(anyReviewInFlight([st(), lane])).toBe(true);
  });
});

describe('the sort rank and the poll', () => {
  it('needs-a-review first, reviewed-at-head last', () => {
    const ranks = [
      reviewCellRank({ kind: 'start' }),
      reviewCellRank(reviewCellFor(st({ headMoved: true }), false)),
      reviewCellRank({ kind: 'queued' }),
      reviewCellRank({ kind: 'running' }),
      reviewCellRank(reviewCellFor(st(), false)),
    ];
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
  it('polls only while something is queued or running', () => {
    expect(anyReviewInFlight(undefined)).toBe(false);
    expect(anyReviewInFlight([st(), st({ status: 'failed' })])).toBe(false);
    expect(anyReviewInFlight([st(), st({ status: 'queued' })])).toBe(true);
    expect(anyReviewInFlight([st({ status: 'running' })])).toBe(true);
  });
});

const cand = (id: string, name: string, match: JiraAcCandidate['match'], text = `${name} text`) => ({
  id,
  name,
  text,
  match,
});
const details = (over: Partial<JiraTicketDetails> = {}): JiraTicketDetails => ({
  prId: 1,
  key: 'ACME-1',
  title: 'Reset password',
  description: 'As a user…',
  issueType: { id: '10001', name: 'Story' },
  candidates: [
    cand('customfield_1', 'Acceptance Criteria', 'strong', 'Given… When… Then…'),
    cand('customfield_2', 'Notes', 'none', 'notes'),
  ],
  omittedCandidates: 0,
  ...over,
});
const mem = (entries: Record<string, string> = {}): AcMemoryStore => {
  const m = new Map(Object.entries(entries));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
};
const jira = (key: string, canFetchDetails: boolean): TicketRef => ({
  key,
  url: `https://acme.atlassian.net/browse/${key}`,
  provider: 'jira',
  canFetchDetails,
});

describe('fillDraftFromJira — the one fill', () => {
  it('replaces title + description and preselects the best strong match', () => {
    const r = fillDraftFromJira({ ...EMPTY_TICKET_DRAFT, acceptanceCriteria: 'old' }, details(), null);
    expect(r.chosen).toBe('customfield_1');
    expect(r.draft).toEqual({
      title: 'Reset password',
      description: 'As a user…',
      acceptanceCriteria: 'Given… When… Then…',
    });
  });
  it('a remembered field wins; nothing preselected leaves the criteria as they were', () => {
    expect(fillDraftFromJira(EMPTY_TICKET_DRAFT, details(), 'customfield_2').draft.acceptanceCriteria).toBe(
      'notes',
    );
    const none = fillDraftFromJira(
      { ...EMPTY_TICKET_DRAFT, acceptanceCriteria: 'kept' },
      details({ candidates: [cand('customfield_2', 'Notes', 'none')] }),
      null,
    );
    expect(none.chosen).toBe('');
    expect(none.draft.acceptanceCriteria).toBe('kept');
  });
});

describe("resolveListTicket — the list's user story", () => {
  const never = async (): Promise<never> => {
    throw new Error('must not be called');
  };

  it('a re-review reuses the stored ticket and fetches nothing', async () => {
    const r = await resolveListTicket({
      previous: { title: 'Stored', description: null, acceptanceCriteria: '- a' },
      loadTickets: never,
      loadDetails: never,
      memory: null,
    });
    expect(r).toEqual({ ticket: { title: 'Stored', acceptanceCriteria: '- a' }, note: null });
  });

  it('no stored ticket ⇒ the first FILLABLE Jira ticket, filled the panel way', async () => {
    const asked: string[] = [];
    const r = await resolveListTicket({
      previous: { title: null, description: null, acceptanceCriteria: null },
      loadTickets: async () => [jira('ACME-9', false), jira('ACME-1', true), jira('ACME-2', true)],
      loadDetails: async (key) => {
        asked.push(key);
        return details({ key });
      },
      memory: mem({ 'limn:jira-ac-field:v1:acme.atlassian.net:10001': 'customfield_2' }),
    });
    expect(asked).toEqual(['ACME-1']);
    expect(r.note).toBeNull();
    expect(r.ticket).toMatchObject({
      title: 'Reset password',
      description: 'As a user…',
      acceptanceCriteria: 'notes',
      source: 'jira',
      key: 'ACME-1',
    });
  });

  it('no ticket, no token, a failed lookup or a failed fetch ⇒ starts without, with a note', async () => {
    const base = { previous: null, loadDetails: never, memory: null };
    expect(await resolveListTicket({ ...base, loadTickets: async () => null })).toEqual({
      ticket: undefined,
      note: NO_STORY_NOTE,
    });
    expect(await resolveListTicket({ ...base, loadTickets: async () => [jira('ACME-1', false)] })).toEqual({
      ticket: undefined,
      note: NO_STORY_NOTE,
    });
    expect((await resolveListTicket({ ...base, loadTickets: never })).ticket).toBeUndefined();
    const failed = await resolveListTicket({
      previous: null,
      memory: null,
      loadTickets: async () => [jira('ACME-1', true)],
      loadDetails: async () => {
        throw new Error('401');
      },
    });
    expect(failed.ticket).toBeUndefined();
    expect(failed.note).toContain('without a user story');
  });

  it('a Jira ticket over a cap ⇒ starts without it and says why', async () => {
    const r = await resolveListTicket({
      previous: null,
      memory: null,
      loadTickets: async () => [jira('ACME-1', true)],
      loadDetails: async () => details({ title: 'x'.repeat(CLAUDE_REVIEW_TICKET_LIMITS.titleChars + 1) }),
    });
    expect(r.ticket).toBeUndefined();
    expect(r.note).toMatch(/^Started without ACME-1: Title is/);
  });
});

describe('the wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

  it('the panel and its request are gated on the FREE agentic AI flag (me.ai), never Pro', () => {
    const cards = src('components/Activity/OpenPrsCards.tsx');
    expect(cards).toMatch(/const claudeOn = useAiCapabilities\(\)\.enabled;/);
    expect(cards).not.toMatch(/useProCapabilities/);
    expect(cards).toMatch(/useClaudeReviewStates\(prIds, claudeOn\)/);
    expect(cards).toMatch(/claudeOn \? \(\s*<ClaudeReviewPanel/);
    // One batched request for the list — never a states hook inside the card.
    expect(src('components/Activity/ClaudeReviewCell.tsx')).not.toMatch(/useClaudeReviewStates/);
  });

  it('no column headings: the order comes from the Sort menu', () => {
    const cards = src('components/Activity/OpenPrsCards.tsx');
    expect(cards).not.toMatch(/SortHeader|columnheader|role="table"/);
    expect(src('components/Activity/OpenPrsDetail.tsx')).toMatch(/<OpenPrsSortMenu sort=\{sort\} onChange=\{setSort\} \/>/);
  });

  it('every cell control stops propagation (the row opens the PR)', () => {
    const cell = src('components/Activity/ClaudeReviewCell.tsx');
    const onClicks = cell.match(/onClick=\{[^}]*\}?/g) ?? [];
    expect(onClicks.length).toBeGreaterThan(0);
    for (const c of onClicks) expect(c).toMatch(/onClick=\{(run|stop|open|\(e\) => \{)/);
    // Every inline handler starts by stopping propagation.
    expect(cell.match(/onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);/g)?.length).toBe(
      cell.match(/onClick=\{\(e\) => \{/g)?.length,
    );
    expect(cell).toMatch(/const run = \(e: MouseEvent\): void => \{\s*e\.stopPropagation\(\);/);
    expect(cell).toMatch(/const open = \(e: MouseEvent\): void => \{\s*e\.stopPropagation\(\);/);
  });

  it('the outcome pill opens the review (done, running and failed)', () => {
    const cell = src('components/Activity/ClaudeReviewCell.tsx');
    expect((cell.match(/onClick=\{open\}/g) ?? []).length).toBe(3);
  });

  it('the cell marks auto runs and shows a 409 AutoReviewInProgress only while the hold lasts', () => {
    const cell = src('components/Activity/ClaudeReviewCell.tsx');
    expect(cell).toMatch(/AUTO_REVIEW_LABEL/);
    expect((cell.match(/\{cell\.auto && <AutoMark \/>\}/g) ?? []).length).toBe(3);
    expect(cell).toMatch(/held \|\| !isAutoReviewHoldError\(start\.error\)/);
  });

  it('a 409 AutoReviewInProgress from the list re-reads the column BEFORE the button can return', () => {
    const hooks = src('hooks/useClaudeReview.ts');
    expect(hooks).toMatch(
      /onError: \(err\) =>\s*isAutoReviewHoldError\(err\)\s*\? Promise\.all\(\[\s*qc\.invalidateQueries\(\{ queryKey: CLAUDE_REVIEW_STATES_KEY \}\)/,
    );
    expect(hooks).toMatch(/err\.status === 409 && err\.code === 'AutoReviewInProgress'/);
    // The client carries the body's `error` code onto the ApiError.
    expect(src('api/client.ts')).toMatch(/if \(typeof body\.error === 'string'\) code = body\.error;/);
  });

  it('the tab and the list share ONE start mutation key', () => {
    const hooks = src('hooks/useClaudeReview.ts');
    expect(hooks.match(/mutationKey: claudeReviewStartKey\(prId\),\n/g)).toHaveLength(2);
    expect(src('components/ClaudeReviewTab.tsx')).toMatch(/disabled=\{isRunning \|\| starting/);
  });
});

describe('the panel', () => {
  it('the accent follows the outcome', () => {
    expect(reviewTone({ kind: 'start' })).toBe('none');
    expect(reviewTone({ kind: 'start', failed: true })).toBe('bad');
    expect(reviewTone({ kind: 'running' })).toBe('active');
    expect(reviewTone({ kind: 'queued', auto: true })).toBe('active');
    expect(reviewTone(reviewCellFor(st({ verdict: 'REQUEST_CHANGES' }), false))).toBe('bad');
    expect(reviewTone(reviewCellFor(st({ verdict: 'APPROVE' }), false))).toBe('ok');
    expect(reviewTone(reviewCellFor(st({ verdict: 'COMMENT' }), false))).toBe('neutral');
    expect(reviewTone(reviewCellFor(st({ verdict: null }), false))).toBe('neutral');
  });

  it('CI failures: nothing when the run did not look or nothing failed', () => {
    expect(ciDiagnosisLabel(undefined)).toBeNull();
    expect(ciDiagnosisLabel({ failing: 0, diagnosed: 0 })).toBeNull();
    expect(ciDiagnosisLabel({ failing: 1, diagnosed: 1 })).toBe('1 CI failure explained');
    expect(ciDiagnosisLabel({ failing: 3, diagnosed: 3 })).toBe('3 CI failures explained');
    expect(ciDiagnosisLabel({ failing: 3, diagnosed: 1 })).toBe('3 CI failures, 1 explained');
    expect(ciDiagnosisLabel({ failing: 2, diagnosed: 0 })).toBe('2 CI failures, none explained');
  });

  it('threads to fix: nothing when none, or when the run did not judge threads', () => {
    expect(threadsToFixLabel({})).toBeNull();
    const counts = { total: 3, assessed: 3, validUnaddressed: 0, notValid: 1, addressed: 2, notChecked: 0 };
    expect(threadsToFixLabel({ threadAssessments: counts })).toBeNull();
    expect(threadsToFixLabel({ threadAssessments: { ...counts, validUnaddressed: 1 } })).toBe('1 thread to fix');
    expect(threadsToFixLabel({ threadAssessments: { ...counts, validUnaddressed: 2 } })).toBe('2 threads to fix');
  });
});
