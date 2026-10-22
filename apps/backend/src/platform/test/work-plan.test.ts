import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorkPlanEvidence, WorkPlanItem } from '@pierre-review/shared';
import {
  WORK_PLAN_PROMPT_VERSION,
  WORK_PLAN_SCHEMA_VERSION,
  workPlanPayloadHash,
} from '../work-plan/hash.js';
import { parseWorkPlanOutput } from '../work-plan/prompt.js';

// The work plan's two safety properties, pinned:
//
//   1. THE PAYLOAD HASH IS A MONEY GATE. It decides whether a click bills. Fold anything
//      clock-derived into it and a completely dormant workspace re-bills on a timer; leave a real
//      fact out and a moved board serves yesterday's plan forever. The first half of this file is
//      about exactly that boundary.
//   2. THE MODEL MAY NOT PUT AN ITEM, OR A FIGURE, ON THE BOARD. Every id it names is intersected
//      with the evidence, every string it writes passes the D4 digit gate, and prose may not claim
//      the reader owns work whose relevance says otherwise. The prompt REQUESTS all of that; the
//      parser is what ENFORCES it, and the second half of this file is about the parser.

// ── fixtures ────────────────────────────────────────────────────────────────────────────────

const mkItem = (over: Partial<WorkPlanItem> & Pick<WorkPlanItem, 'id'>): WorkPlanItem => ({
  subject: 'pr',
  kind: 'merge',
  prId: 101,
  repoId: 1,
  repoFullName: 'acme/api',
  prNumber: 12,
  prTitle: 'Add a thing',
  githubUrl: 'https://github.com/acme/api/pull/12',
  relevance: 'direct',
  facts: { approvals: 2, mergeStateStatus: 'clean', ciStatus: 'success', changedFiles: 3 },
  proximity: 0.95,
  stallRisk: 0.4,
  score: 0.8,
  reason: 'approved, checks green',
  ...over,
});

const mkEvidence = (
  items: WorkPlanItem[],
  over: Partial<WorkPlanEvidence> = {},
): WorkPlanEvidence => ({
  workspaceId: 5,
  generatedAt: '2026-08-27T09:00:00.000Z',
  items,
  totals: { merge: 1, thread: 4 },
  counts: { myTurn: 3, stalled: 1, untouchedThreads: 4, needsReviewer: 0 },
  ...over,
});

const SCOPE = 'ws:5';

// ── 1. the hash: what it must ignore ────────────────────────────────────────────────────────

describe('workPlanPayloadHash — the clock must not reach it', () => {
  it('THE MONEY TEST: identical boards differing only by the clock hash the same', () => {
    // Every field varied below is derived from `now()`: `generatedAt` stamps the fold itself,
    // `ageHours` counts from the item's own clock, and `stallRisk`/`score` are computed FROM
    // ageHours — which also means the ranked ORDER is clock-derived, so the two boards are
    // deliberately given different orders too. If any of them entered the fold, an untouched
    // workspace would re-bill the moment one PR crossed an age threshold, on every poll, forever.
    const a = mkEvidence([
      mkItem({ id: 'wp:merge:101', facts: { approvals: 2, ageHours: 3, clock: 'opened' } }),
      mkItem({ id: 'wp:review:102', kind: 'review', facts: { ageHours: 9, clock: 'requested' } }),
    ]);
    const b = mkEvidence(
      [
        // reversed order, aged, re-scored — the same two items on the same board
        mkItem({
          id: 'wp:review:102',
          kind: 'review',
          facts: { ageHours: 105, clock: 'requested' },
          stallRisk: 1,
          score: 0.93,
        }),
        mkItem({
          id: 'wp:merge:101',
          facts: { approvals: 2, ageHours: 99, clock: 'opened' },
          stallRisk: 1,
          score: 0.91,
        }),
      ],
      { generatedAt: '2026-08-31T04:00:00.000Z' },
    );
    expect(workPlanPayloadHash(SCOPE, b)).toBe(workPlanPayloadHash(SCOPE, a));
  });

  it('ignores `counts` and `totals` — they tick over on an age threshold of their own', () => {
    // `counts.stalled` is an AGE fold over the same cards, so it moves without anything on the
    // board changing. Nothing is lost by omitting it: a count cannot move without the item set or
    // a fact underneath it moving, and both of THOSE are folded (see the next block).
    const items = [mkItem({ id: 'wp:merge:101' })];
    const a = mkEvidence(items);
    const b = mkEvidence(items, {
      totals: { merge: 1, thread: 40 },
      counts: { myTurn: 30, stalled: 17, untouchedThreads: 40, needsReviewer: 6 },
    });
    expect(workPlanPayloadHash(SCOPE, b)).toBe(workPlanPayloadHash(SCOPE, a));
  });
});

// ── 2. the hash: what it must catch ─────────────────────────────────────────────────────────

describe('workPlanPayloadHash — a moved board must read stale', () => {
  const base = mkEvidence([mkItem({ id: 'wp:merge:101' })]);
  const baseHash = workPlanPayloadHash(SCOPE, base);

  it('changes when a stable fact changes', () => {
    for (const facts of [
      { approvals: 3, mergeStateStatus: 'clean' as const, ciStatus: 'success' as const, changedFiles: 3 },
      { approvals: 2, mergeStateStatus: 'dirty' as const, ciStatus: 'success' as const, changedFiles: 3 },
      { approvals: 2, mergeStateStatus: 'clean' as const, ciStatus: 'failure' as const, changedFiles: 3 },
      { approvals: 2, mergeStateStatus: 'clean' as const, ciStatus: 'success' as const, changedFiles: 40 },
      { approvals: 2, mergeStateStatus: 'clean' as const, ciStatus: 'success' as const, changedFiles: 3, untouchedThreads: 5 },
      { approvals: 2, mergeStateStatus: 'clean' as const, ciStatus: 'success' as const, changedFiles: 3, pendingReviewers: 2 },
    ]) {
      const moved = mkEvidence([mkItem({ id: 'wp:merge:101', facts })]);
      expect(workPlanPayloadHash(SCOPE, moved), JSON.stringify(facts)).not.toBe(baseHash);
    }
  });

  it('changes when an item is added, removed, or changes kind or relevance', () => {
    const added = mkEvidence([mkItem({ id: 'wp:merge:101' }), mkItem({ id: 'wp:review:102' })]);
    expect(workPlanPayloadHash(SCOPE, added)).not.toBe(baseHash);
    expect(workPlanPayloadHash(SCOPE, mkEvidence([]))).not.toBe(baseHash);
    expect(
      workPlanPayloadHash(SCOPE, mkEvidence([mkItem({ id: 'wp:merge:101', kind: 'update_branch' })])),
    ).not.toBe(baseHash);
    // Relevance drives the narrowed ownership gate, so a tier flip must re-narrate.
    expect(
      workPlanPayloadHash(SCOPE, mkEvidence([mkItem({ id: 'wp:merge:101', relevance: 'none' })])),
    ).not.toBe(baseHash);
  });

  it('changes when the SCOPE changes — one plan per population', () => {
    expect(workPlanPayloadHash('ws:6', base)).not.toBe(baseHash);
    expect(workPlanPayloadHash('ws:5|r:10,11', base)).not.toBe(baseHash);
  });
});

// ── 3. the version constants are IN the fold, so a bump is self-executing ────────────────────

describe('workPlanPayloadHash — a version bump regenerates every stored row', () => {
  // This mirrors the module's signature format on purpose: it is the only way to prove the two
  // version constants actually reach the digest, rather than merely being exported beside it.
  // ⚠ If you change the signature FORMAT, this test goes red — which is the point. Re-derive it
  // here and check the two constants are still folded; a bump that does not move the hash is a
  // wording fix that never reaches an account with a stored plan.
  const sigFor = (sv: number, pv: number, ev: WorkPlanEvidence): string =>
    createHash('sha256')
      .update(
        [
          `sv:${sv}`,
          `pv:${pv}`,
          SCOPE,
          ...ev.items
            .map((i) =>
              [
                i.id,
                `k:${i.kind}`,
                `rel:${i.relevance}`,
                `ap:${i.facts.approvals ?? '-'}`,
                `ms:${i.facts.mergeStateStatus ?? '-'}`,
                `ci:${i.facts.ciStatus ?? '-'}`,
                `ut:${i.facts.untouchedThreads ?? '-'}`,
                `pr:${i.facts.pendingReviewers ?? '-'}`,
                `cf:${i.facts.changedFiles ?? '-'}`,
              ].join('#'),
            )
            .sort(),
        ].join('|'),
      )
      .digest('hex');

  const ev = mkEvidence([mkItem({ id: 'wp:merge:101' })]);

  it('reproduces the real hash at the CURRENT versions', () => {
    expect(sigFor(WORK_PLAN_SCHEMA_VERSION, WORK_PLAN_PROMPT_VERSION, ev)).toBe(
      workPlanPayloadHash(SCOPE, ev),
    );
  });

  it('a PROMPT-version bump moves it (every stored plan flips stale at once)', () => {
    expect(sigFor(WORK_PLAN_SCHEMA_VERSION, WORK_PLAN_PROMPT_VERSION + 1, ev)).not.toBe(
      workPlanPayloadHash(SCOPE, ev),
    );
  });

  it('a SCHEMA-version bump moves it too', () => {
    expect(sigFor(WORK_PLAN_SCHEMA_VERSION + 1, WORK_PLAN_PROMPT_VERSION, ev)).not.toBe(
      workPlanPayloadHash(SCOPE, ev),
    );
  });
});

// ── 4. the parser: ids ⊆ the evidence, and every rejection is COUNTED ────────────────────────

const EV = mkEvidence([
  mkItem({ id: 'wp:merge:101', relevance: 'direct' }),
  mkItem({ id: 'wp:review:102', kind: 'review', relevance: 'maintained' }),
  mkItem({ id: 'wp:thread:103:9', kind: 'thread', relevance: 'none', threadId: 9 }),
]);

const out = (o: Record<string, unknown>): string => JSON.stringify(o);

describe('parseWorkPlanOutput — the model may not invent an item', () => {
  it('drops ids the evidence does not contain, and COUNTS them', () => {
    const parsed = parseWorkPlanOutput(
      out({
        headline: 'Two blockers, then the reviews',
        steps: [
          { id: 'wp:merge:101', why: 'Approved and green — land it first' },
          { id: 'wp:merge:999', why: 'A pull request that does not exist' },
          { id: 'not-an-id-at-all', why: 'Nor this one' },
        ],
      }),
      EV,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.steps).toEqual([
      { id: 'wp:merge:101', why: 'Approved and green — land it first' },
    ]);
    // A hallucinated reference that vanished silently would leave no evidence it happened.
    expect(parsed?.droppedIds).toBe(2);
  });

  it('counts a REPEATED id too — one item is narrated once', () => {
    const parsed = parseWorkPlanOutput(
      out({
        headline: 'Land the approved one',
        steps: [
          { id: 'wp:merge:101', why: 'Approved and green' },
          { id: 'wp:merge:101', why: 'Still approved and still green' },
        ],
      }),
      EV,
    );
    expect(parsed?.steps).toHaveLength(1);
    expect(parsed?.droppedIds).toBe(1);
  });

  it('survives code fences and surrounding prose', () => {
    const parsed = parseWorkPlanOutput(
      'Here you go:\n```json\n' +
        out({ headline: 'A calm morning', steps: [{ id: 'wp:merge:101', why: 'Land it' }] }) +
        '\n```',
      EV,
    );
    expect(parsed?.headline).toBe('A calm morning');
  });

  it('returns null when nothing usable came back (the route stores an empty row, never 502s)', () => {
    expect(parseWorkPlanOutput('I cannot help with that.', EV)).toBeNull();
    // A headline is required: `StoredWorkPlan.headline` is a non-nullable string on the wire, so a
    // rejected one is a rejected plan rather than a blank lede on the panel.
    expect(
      parseWorkPlanOutput(out({ steps: [{ id: 'wp:merge:101', why: 'Land it' }] }), EV),
    ).toBeNull();
  });

  it('a headline with no steps is still a plan (the ranked rows carry the panel)', () => {
    const parsed = parseWorkPlanOutput(out({ headline: 'Quiet board today', steps: [] }), EV);
    expect(parsed).toEqual({
      headline: 'Quiet board today',
      steps: [],
      parked: null,
      droppedIds: 0,
    });
  });
});

// ── 5. the D4 digit gate — UNICODE numerals, not [0-9] ──────────────────────────────────────

describe('parseWorkPlanOutput — the digit gate', () => {
  const withWhy = (why: string): string =>
    out({ headline: 'A calm morning', steps: [{ id: 'wp:merge:101', why }] });

  it('drops a why carrying an ASCII digit', () => {
    // Every figure is already on screen as a code-derived chip beside the prose, so a number in
    // model text is at best a duplicate and at worst a hallucination that LOOKS like the chip.
    expect(parseWorkPlanOutput(withWhy('It has 2 approvals already'), EV)?.steps).toEqual([]);
  });

  it('drops a why carrying a UNICODE numeral — the case [0-9] waves straight through', () => {
    // The model's input includes attacker-authored PR titles, so "write the count in full-width
    // digits" is a live instruction-injection path against an ASCII-only gate. All three of these
    // read as numbers to a human.
    for (const why of [
      'It has ٢ approvals already', // U+0662 ARABIC-INDIC TWO (Nd)
      'It has ２ approvals already', // U+FF12 FULLWIDTH TWO (Nd)
      'Ranked ² on the board', // U+00B2 SUPERSCRIPT TWO (No)
      'Ⅻ threads still open', // U+216B ROMAN NUMERAL TWELVE (Nl)
    ]) {
      expect(parseWorkPlanOutput(withWhy(why), EV)?.steps, why).toEqual([]);
    }
  });

  it('gates the headline and the parked line as well', () => {
    expect(parseWorkPlanOutput(out({ headline: '3 things matter today' }), EV)).toBeNull();
    const parsed = parseWorkPlanOutput(
      out({ headline: 'A calm morning', parked: 'The other 4 threads can wait' }),
      EV,
    );
    expect(parsed?.parked).toBeNull();
    expect(parsed?.headline).toBe('A calm morning'); // the rest of the plan survives
  });

  it('does not eat legitimate prose — the gate must not eat the feature', () => {
    const parsed = parseWorkPlanOutput(
      out({
        headline: 'Clear the approved work before standup',
        steps: [{ id: 'wp:merge:101', why: 'Approved and green — nothing left to wait for' }],
        parked: 'The dependency bumps can wait until tomorrow',
      }),
      EV,
    );
    expect(parsed?.steps).toHaveLength(1);
    expect(parsed?.parked).toBe('The dependency bumps can wait until tomorrow');
  });
});

// ── 6. the ownership gate — narrowed to the rows the reader does not own ─────────────────────

describe('parseWorkPlanOutput — the second-person gate, applied narrowly', () => {
  it('fires on a `none` row: shared work the reader does not own', () => {
    // The synthesis reason in full force: the model sees a tier string and a title, and cannot
    // know whose work this is. On the reporting account 149 such cards contained 5 that were
    // actually the reader's.
    const parsed = parseWorkPlanOutput(
      out({
        headline: 'A calm morning',
        steps: [{ id: 'wp:thread:103:9', why: 'Your reviewer is still waiting on a reply' }],
      }),
      EV,
    );
    expect(parsed?.steps).toEqual([]);
    // A rejected `why` is not a bad REFERENCE, so it is not counted as a dropped id — the row
    // still renders from the deterministic fold, just without a sentence.
    expect(parsed?.droppedIds).toBe(0);
  });

  it('does NOT fire on a `direct` row: second person is the fact the row is built on', () => {
    const parsed = parseWorkPlanOutput(
      out({
        headline: 'A calm morning',
        steps: [{ id: 'wp:merge:101', why: 'Your approved change is ready to land' }],
      }),
      EV,
    );
    expect(parsed?.steps).toEqual([
      { id: 'wp:merge:101', why: 'Your approved change is ready to land' },
    ]);
  });

  it('does NOT fire on a `maintained` row either — orbit is still ownership enough', () => {
    const parsed = parseWorkPlanOutput(
      out({
        headline: 'A calm morning',
        steps: [{ id: 'wp:review:102', why: 'It is waiting on you in a repo you maintain' }],
      }),
      EV,
    );
    expect(parsed?.steps).toHaveLength(1);
  });

  it('rejects only the offending step, keeping its siblings (per-item, like D4)', () => {
    const parsed = parseWorkPlanOutput(
      out({
        headline: 'A calm morning',
        steps: [
          { id: 'wp:thread:103:9', why: 'Waiting on your answer' },
          { id: 'wp:merge:101', why: 'Approved and green — land it first' },
        ],
      }),
      EV,
    );
    expect(parsed?.steps).toEqual([
      { id: 'wp:merge:101', why: 'Approved and green — land it first' },
    ]);
  });

  it('does not false-positive on words merely starting with "you"', () => {
    const parsed = parseWorkPlanOutput(
      out({
        headline: 'A calm morning',
        steps: [{ id: 'wp:thread:103:9', why: 'Younger threads are piling up behind it' }],
      }),
      EV,
    );
    expect(parsed?.steps).toHaveLength(1);
  });
});

// ── 7. the phrase cap ───────────────────────────────────────────────────────────────────────

describe('parseWorkPlanOutput — the phrase cap', () => {
  const over = 'x'.repeat(121); // PHRASE_CAP is 120, and every capped string shares it
  const under = 'x'.repeat(120);

  it('drops an over-cap headline (and with it the plan)', () => {
    expect(parseWorkPlanOutput(out({ headline: over }), EV)).toBeNull();
    expect(parseWorkPlanOutput(out({ headline: under }), EV)?.headline).toBe(under);
  });

  it('drops an over-cap parked line, keeping the rest', () => {
    const parsed = parseWorkPlanOutput(out({ headline: 'A calm morning', parked: over }), EV);
    expect(parsed?.parked).toBeNull();
    expect(parsed?.headline).toBe('A calm morning');
  });

  it('drops an over-cap why, keeping the rest', () => {
    const parsed = parseWorkPlanOutput(
      out({ headline: 'A calm morning', steps: [{ id: 'wp:merge:101', why: over }] }),
      EV,
    );
    expect(parsed?.steps).toEqual([]);
    expect(parsed?.headline).toBe('A calm morning');
  });
});
