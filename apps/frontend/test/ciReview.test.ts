// The CI review in the SPA (lib/ciReview.ts + CiCheckSection.tsx), the praise hiding
// (claudeReviewFollowUp.ts `withoutPraise`) and the "+ Add story" open/close (storyTabs.ts).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CI_REVIEW_STATES_MAX,
  type CiReviewState,
  type ClaudeFinding,
  type ClaudeFollowUpItem,
  type ClaudeReview,
} from '@pierre-review/shared';
import {
  anyCiRunning,
  ciCardPill,
  ciCheckButtonLabel,
  ciCountsLabel,
  ciCurrency,
  ciProgressPct,
  ciRefusalSentence,
  ciSectionShow,
  ciStatesRequestIds,
} from '../src/lib/ciReview.js';
import { withoutPraise } from '../src/lib/claudeReviewFollowUp.js';
import { storiesOnClose, storiesOnOpen } from '../src/lib/storyTabs.js';
import { EMPTY_TICKET_DRAFT, type TicketDraft } from '../src/lib/claudeReviewFollowUp.js';

const root = join(__dirname, '..', 'src');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const code = (p: string): string =>
  read(p)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');

function state(extra: Partial<CiReviewState> = {}): CiReviewState {
  return {
    prId: 1,
    status: 'current',
    staleBecause: null,
    latestRunId: 10,
    runningRunId: null,
    headSha: 'a'.repeat(40),
    counts: { failing: 2, explained: 2, fixableInPr: 1, notChecked: 0 },
    refused: null,
    checkedAt: '2026-10-05T10:00:00.000Z',
    ...extra,
  };
}

describe('the batched states request', () => {
  it('ids are unique, sorted and capped at the route limit', () => {
    expect(ciStatesRequestIds([3, 1, 3, 2])).toEqual([1, 2, 3]);
    const many = Array.from({ length: CI_REVIEW_STATES_MAX + 5 }, (_, i) => i + 1);
    expect(ciStatesRequestIds(many)).toHaveLength(CI_REVIEW_STATES_MAX);
  });
  it('polls only while a run is in flight', () => {
    expect(anyCiRunning(undefined)).toBe(false);
    expect(anyCiRunning([state()])).toBe(false);
    expect(anyCiRunning([state(), state({ status: 'running' })])).toBe(true);
  });
});

describe('the card pill', () => {
  it('counts: all explained, some, none; nothing with nothing failing', () => {
    expect(ciCountsLabel(null)).toBeNull();
    expect(ciCountsLabel({ failing: 0, explained: 0 })).toBeNull();
    expect(ciCountsLabel({ failing: 1, explained: 1 })).toBe('1 CI failure explained');
    expect(ciCountsLabel({ failing: 3, explained: 1 })).toBe('3 CI failures, 1 explained');
    expect(ciCountsLabel({ failing: 2, explained: 0 })).toBe('2 CI failures, none explained');
  });
  it('only a CURRENT run or one in flight says anything', () => {
    expect(ciCardPill(undefined)).toBeNull();
    expect(ciCardPill(state())).toEqual({ label: '2 CI failures explained', running: false });
    expect(ciCardPill(state({ status: 'running' }))).toEqual({ label: 'Checking CI…', running: true });
    expect(ciCardPill(state({ status: 'stale', staleBecause: 'pushed' }))).toBeNull();
    expect(ciCardPill(state({ status: 'none', counts: null }))).toBeNull();
  });
});

describe('the section', () => {
  it('currency names why a run is stale', () => {
    expect(ciCurrency(state({ status: 'none' }))).toBeNull();
    expect(ciCurrency(state())?.tone).toBe('current');
    expect(ciCurrency(state({ status: 'running' }))?.tone).toBe('running');
    expect(ciCurrency(state({ status: 'stale', staleBecause: 'pushed' }))?.label).toBe('Pushed since');
    expect(ciCurrency(state({ status: 'stale', staleBecause: 'checks_changed' }))?.label).toBe('Other checks failing now');
    expect(ciCurrency(state({ status: 'stale', staleBecause: 'now_passing' }))?.label).toBe('Passing now');
  });
  it('every refusal has its own sentence', () => {
    const all = ['no_failures', 'no_logs', 'logs_unavailable', 'checks_unreadable', 'head_unreadable'] as const;
    const sentences = all.map(ciRefusalSentence);
    expect(new Set(sentences).size).toBe(all.length);
    expect(ciRefusalSentence('no_logs')).toMatch(/GitHub Actions/);
  });
  it('progress is determinate per phase and never reaches 100 before the end', () => {
    expect(ciProgressPct(null)).toBeNull();
    expect(ciProgressPct({ phase: 'queued' })).toBe(5);
    expect(ciProgressPct({ phase: 'reviewing', recentActivity: Array(100).fill('x') })).toBe(90);
    expect(ciProgressPct({ phase: 'saving' })).toBe(95);
  });
  it('what shows: the CI review, else old history, else an offer on red CI, else nothing', () => {
    const none = state({ status: 'none', latestRunId: null, counts: null });
    expect(ciSectionShow({ review: { id: 1 }, state: none, legacyFailures: null, prCiStatus: 'success' })).toBe('ci');
    expect(ciSectionShow({ review: null, state: { ...none, status: 'running', runningRunId: 4 }, legacyFailures: null, prCiStatus: null })).toBe('ci');
    const legacy = [{ checkName: 'x' }] as never;
    // A CI review beats history: the old diagnosis shows only when no CI review exists.
    expect(ciSectionShow({ review: { id: 1 }, state: none, legacyFailures: legacy, prCiStatus: 'failure' })).toBe('ci');
    expect(ciSectionShow({ review: null, state: none, legacyFailures: legacy, prCiStatus: 'failure' })).toBe('legacy');
    expect(ciSectionShow({ review: null, state: none, legacyFailures: [], prCiStatus: 'failure' })).toBe('offer');
    expect(ciSectionShow({ review: null, state: none, legacyFailures: null, prCiStatus: 'success' })).toBe('hidden');
  });
  it('the button', () => {
    expect(ciCheckButtonLabel(false, false)).toBe('Check CI');
    expect(ciCheckButtonLabel(true, false)).toBe('Re-check');
    expect(ciCheckButtonLabel(true, true)).toBe('Starting…');
  });
});

describe('praise is hidden, never deleted', () => {
  const f = (id: number, severity: ClaudeFinding['severity']): ClaudeFinding => ({ id, severity }) as ClaudeFinding;
  const it_ = (priorFindingId: number, severity: ClaudeFollowUpItem['severity']): ClaudeFollowUpItem =>
    ({ priorFindingId, severity }) as ClaudeFollowUpItem;
  it('drops praise findings and follow-up items about earlier praise', () => {
    const review = {
      findings: [f(1, 'blocker'), f(2, 'praise'), f(3, 'nit')],
      followUp: { priorReviewId: 1, priorHeadSha: 'x', headMoved: false, changesSinceShown: false, items: [it_(7, 'praise'), it_(8, 'warning')] },
    } as Pick<ClaudeReview, 'findings' | 'followUp'>;
    const out = withoutPraise(review);
    expect(out.findings.map((x) => x.id)).toEqual([1, 3]);
    expect(out.followUp?.items.map((x) => x.priorFindingId)).toEqual([8]);
    // The stored run itself is untouched.
    expect(review.findings).toHaveLength(3);
  });
  it('returns the same object when there is no praise (stable memo)', () => {
    const review = { findings: [f(1, 'blocker')], followUp: null } as Pick<ClaudeReview, 'findings' | 'followUp'>;
    expect(withoutPraise(review)).toBe(review);
  });
});

describe('"+ Add story"', () => {
  const typed: TicketDraft = { title: 'T', description: '', acceptanceCriteria: 'AC' };
  const jira: TicketDraft = { ...EMPTY_TICKET_DRAFT, title: 'J', source: 'jira', key: 'BMD-1', url: 'https://x' };
  it('opens on a blank story when there is none, else on the stories already there', () => {
    expect(storiesOnOpen([])).toEqual([EMPTY_TICKET_DRAFT]);
    const kept = [typed];
    expect(storiesOnOpen(kept)).toBe(kept);
  });
  it('close drops blank typed tabs and keeps everything with content', () => {
    expect(storiesOnClose([{ ...EMPTY_TICKET_DRAFT }])).toEqual([]);
    expect(storiesOnClose([typed, { ...EMPTY_TICKET_DRAFT }, jira])).toEqual([typed, jira]);
    const kept = [typed];
    expect(storiesOnClose(kept)).toBe(kept);
  });
});

describe('source guards', () => {
  it('the tab mounts CI check after Story check and before the chat, and the code review draws no CI', () => {
    const tab = code('components/ClaudeReviewTab.tsx');
    const story = tab.indexOf('{storyCheck({');
    const ci = tab.indexOf('{ciCheck}');
    const chat = tab.indexOf('<ReviewChatSection');
    expect(story).toBeGreaterThan(-1);
    expect(ci).toBeGreaterThan(story);
    expect(chat).toBeGreaterThan(ci);
    expect(tab).not.toMatch(/ciFailures/);
  });
  it('the section never builds a log URL and shows how long ago the run finished', () => {
    const src = code('components/CiCheckSection.tsx');
    expect(src).not.toMatch(/logs?Url|blob/i);
    expect(src).not.toMatch(/dangerouslySetInnerHTML|href=/);
    expect(src).toMatch(/<ReviewedAgo at=\{shown\.completedAt\}/);
  });
  it('the boards read CI from ONE batched states request, never per card', () => {
    for (const p of ['components/Activity/OpenPrsCards.tsx', 'components/Activity/AttentionCards.tsx']) {
      const src = code(p);
      expect(src.match(/useCiReviewStates\(/g)?.length).toBe(1);
      expect(src).not.toMatch(/useCiReview\(/);
    }
    for (const p of ['components/Activity/ClaudeReviewCell.tsx', 'components/Activity/PendingClaude.tsx']) {
      const src = code(p);
      expect(src).not.toMatch(/useCiReview|summary\.ci\b/);
    }
  });
  it('Story check shows how long ago each ticket was checked, older PR-review stories included', () => {
    const src = code('components/TicketCoverage.tsx');
    expect(src).toMatch(/<ReviewedAgo at=\{shown\.completedAt\}/);
    expect(src).toMatch(/<ReviewedAgo at=\{legacy\.finishedAt\}/);
    expect(code('components/ClaudeReviewTab.tsx')).toMatch(/finishedAt: review\.finishedAt,/);
  });
  it('on a red-build card the CI pill displaces only the VERDICT, never a queued, running or failed review', () => {
    expect(code('components/Activity/PendingClaude.tsx')).toMatch(/if \(ciPill != null && cell\.kind === 'done'\) lead = null;/);
  });
  it('"+ Add story" names no element it does not render', () => {
    const src = code('components/ClaudeReviewFollowUp.tsx');
    expect(src).not.toMatch(/aria-controls=\{bodyId\}/);
  });
});
