// The People report's pure folds (src/lib/peopleReport.ts): section ordering, the disclosed
// where-it-works sample, the sequential narration queue, and the ref → card anchor mapping.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { PeopleReportSelection } from '../src/store/filters.js';
import type { DigestPrRef, PersonPeriodEvidence } from '@pierre-review/shared';
import {
  NARRATION_QUEUE_IDLE,
  beginDisabledReason,
  evidencePrGroups,
  foldWhereItWorks,
  orderSelections,
  pathBucket,
  reduceNarrationQueue,
  refAnchorKey,
  type NarrationQueueState,
} from '../src/lib/peopleReport.js';

const sel = (
  userId: number,
  label: string,
  kind: 'human' | 'bot' = 'human',
): PeopleReportSelection => ({ kind, userId, login: null, label, avatarUrl: null });

describe('orderSelections', () => {
  it('sorts alphabetically by label, humans and bots INTERLEAVED (never kind-grouped)', () => {
    const out = orderSelections([
      sel(1, 'Zoë'),
      sel(2, 'CodeRabbit', 'bot'),
      sel(3, 'Alice'),
      sel(4, 'Dependabot', 'bot'),
    ]);
    expect(out.map((s) => s.label)).toEqual(['Alice', 'CodeRabbit', 'Dependabot', 'Zoë']);
    // The bot rows sit between the humans — the interleave IS the claim.
    expect(out.map((s) => s.kind)).toEqual(['human', 'bot', 'bot', 'human']);
  });

  it('breaks label ties by userId so the order is total and stable', () => {
    const out = orderSelections([sel(9, 'Same'), sel(2, 'Same')]);
    expect(out.map((s) => s.userId)).toEqual([2, 9]);
  });

  it('does not mutate the seed array (store state)', () => {
    const input = [sel(2, 'B'), sel(1, 'A')];
    orderSelections(input);
    expect(input.map((s) => s.userId)).toEqual([2, 1]);
  });
});

describe('evidencePrGroups — the human-evidence grouping', () => {
  const ref = (prId: number): DigestPrRef => ({
    prNumber: prId,
    prId,
    repoId: 1,
    repoFullName: 'acme/api',
    title: `PR ${prId}`,
    authorLogin: null,
    authorId: null,
    state: 'open',
    ciStatus: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    openedAt: null,
  });

  it('renders groups in PERSON_METRIC_KEYS order, never the payload object order', () => {
    // Object literal ordered backwards on purpose — the fold must not care.
    const prs: PersonPeriodEvidence['prs'] = {
      open_prs_authored: { rows: [ref(3)], more: 0 },
      merged_prs_authored: { rows: [ref(1)], more: 2 },
      awaiting_their_review: { rows: [ref(2)], more: 0 },
    };
    expect(evidencePrGroups(prs).map((g) => g.key)).toEqual([
      'merged_prs_authored',
      'awaiting_their_review',
      'open_prs_authored',
    ]);
  });

  it('drops absent AND present-but-empty groups, keeps each group’s own `more`', () => {
    const prs: PersonPeriodEvidence['prs'] = {
      merged_prs_authored: { rows: [], more: 0 }, // present-and-empty — no heading over nothing
      opened_prs_authored: { rows: [ref(9)], more: 4 },
    };
    const out = evidencePrGroups(prs);
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe('opened_prs_authored');
    expect(out[0]?.more).toBe(4);
  });
});

describe('beginDisabledReason — the Begin-report gate', () => {
  const base = {
    chipCount: 1,
    reportKey: 'sprint-2026-08-18',
    periodKeys: ['sprint-2026-08-18', 'sprint-2026-08-04'],
    listLoading: false,
  };

  it('enables iff ≥1 chip AND the selected key resolves in the period list', () => {
    expect(beginDisabledReason(base)).toBeNull();
  });

  it('names the missing chip first (the commonest state)', () => {
    expect(beginDisabledReason({ ...base, chipCount: 0 })).toMatch(/at least one/);
  });

  it('a loading list, an empty list, and an unresolved key each get their own reason', () => {
    expect(
      beginDisabledReason({ ...base, periodKeys: [], listLoading: true }),
    ).toMatch(/period list to load/);
    expect(beginDisabledReason({ ...base, periodKeys: [] })).toMatch(/No completed periods/);
    expect(beginDisabledReason({ ...base, reportKey: 'sprint-1999-01-01' })).toMatch(
      /selection to resolve/,
    );
    expect(beginDisabledReason({ ...base, reportKey: null })).toMatch(/selection to resolve/);
  });
});

describe('pathBucket / foldWhereItWorks', () => {
  it('buckets >2-segment paths to the first two segments, shorter paths stay themselves', () => {
    expect(pathBucket('apps/backend/src/db/queries.ts')).toBe('apps/backend/**');
    expect(pathBucket('apps/backend')).toBe('apps/backend');
    expect(pathBucket('README.md')).toBe('README.md');
  });

  it('counts repos and path areas over exactly the given rows, discloses the sample size', () => {
    const rows = [
      { repoFullName: 'acme/api', path: 'apps/backend/src/a.ts' },
      { repoFullName: 'acme/api', path: 'apps/backend/src/b.ts' },
      { repoFullName: 'acme/web', path: 'apps/frontend/src/c.tsx' },
      { repoFullName: 'acme/api', path: null }, // PR comment — no path, still a repo count
    ];
    const w = foldWhereItWorks(rows);
    expect(w.sampleSize).toBe(4);
    expect(w.repos).toEqual([
      ['acme/api', 3],
      ['acme/web', 1],
    ]);
    expect(w.areas).toEqual([
      ['apps/backend/**', 2],
      ['apps/frontend/**', 1],
    ]);
  });

  it('caps the lists and orders count-desc then alphabetical', () => {
    const rows = ['e', 'd', 'c', 'b', 'a', 'f'].map((n) => ({
      repoFullName: `acme/${n}`,
      path: null,
    }));
    const w = foldWhereItWorks(rows, 3);
    // All counts 1 → alphabetical, capped at 3.
    expect(w.repos).toEqual([
      ['acme/a', 1],
      ['acme/b', 1],
      ['acme/c', 1],
    ]);
    expect(w.areas).toEqual([]);
  });
});

describe('reduceNarrationQueue', () => {
  const run = (
    actions: Array<{ type: 'request' | 'release'; userId: number }>,
    from: NarrationQueueState = NARRATION_QUEUE_IDLE,
  ): NarrationQueueState => actions.reduce(reduceNarrationQueue, from);

  it('grants the first request immediately, queues the rest FIFO', () => {
    const s = run([
      { type: 'request', userId: 1 },
      { type: 'request', userId: 2 },
      { type: 'request', userId: 3 },
    ]);
    expect(s.current).toBe(1);
    expect(s.queue).toEqual([2, 3]);
  });

  it('NEVER holds two grants: every reachable state has exactly one current', () => {
    // Exhaustive-ish interleaving sweep: every prefix of a request/release storm keeps the
    // single-grant invariant (the whole reason the queue exists).
    let s = NARRATION_QUEUE_IDLE;
    const storm: Array<{ type: 'request' | 'release'; userId: number }> = [
      { type: 'request', userId: 1 },
      { type: 'request', userId: 2 },
      { type: 'request', userId: 1 }, // duplicate request — idempotent
      { type: 'release', userId: 2 }, // waiter withdraws
      { type: 'request', userId: 3 },
      { type: 'release', userId: 1 }, // grant ends → 3 promoted
      { type: 'request', userId: 2 },
      { type: 'release', userId: 3 },
      { type: 'release', userId: 2 },
      { type: 'release', userId: 9 }, // unknown release — no-op
    ];
    for (const a of storm) {
      s = reduceNarrationQueue(s, a);
      const granted = s.current == null ? 0 : 1;
      expect(granted).toBeLessThanOrEqual(1);
      // The grant never also waits in the queue.
      if (s.current != null) expect(s.queue).not.toContain(s.current);
      // No duplicates in the queue.
      expect(new Set(s.queue).size).toBe(s.queue.length);
    }
    expect(s).toEqual({ queue: [], current: null });
  });

  it('release of the grant promotes the next waiter in the SAME transition', () => {
    const s = run([
      { type: 'request', userId: 1 },
      { type: 'request', userId: 2 },
      { type: 'release', userId: 1 },
    ]);
    expect(s.current).toBe(2);
    expect(s.queue).toEqual([]);
  });

  it('a waiter releasing (cache landed) leaves the line without touching the grant', () => {
    const s = run([
      { type: 'request', userId: 1 },
      { type: 'request', userId: 2 },
      { type: 'request', userId: 3 },
      { type: 'release', userId: 2 },
    ]);
    expect(s.current).toBe(1);
    expect(s.queue).toEqual([3]);
  });

  it('idempotent transitions return the SAME state object (React bail-out)', () => {
    const s1 = run([{ type: 'request', userId: 1 }]);
    expect(reduceNarrationQueue(s1, { type: 'request', userId: 1 })).toBe(s1);
    expect(reduceNarrationQueue(s1, { type: 'release', userId: 9 })).toBe(s1);
  });
});

describe('refAnchorKey', () => {
  it('maps the person_report item families to their card anchors', () => {
    expect(refAnchorKey('pm1:merged_prs_authored:5')).toBe('metric:merged_prs_authored');
    expect(refAnchorKey('pe1:pr:123')).toBe('pr:123');
    expect(refAnchorKey('pe1:rc:45')).toBe('rc:45');
    expect(refAnchorKey('pe1:pc:46')).toBe('pc:46');
    expect(refAnchorKey('pe1:th:9')).toBe('th:9');
    expect(refAnchorKey('pe1:area:apps/backend/**:12')).toBe('area:apps/backend/**');
  });

  it('is version-tolerant: a bumped item vocabulary still anchors', () => {
    expect(refAnchorKey('pe2:pr:123')).toBe('pr:123');
    expect(refAnchorKey('pm3:reviews_given:7')).toBe('metric:reviews_given');
  });

  it('returns null for unknown or malformed refs (the chip renders inert, never throws)', () => {
    expect(refAnchorKey('')).toBeNull();
    expect(refAnchorKey('pe1:pr:abc')).toBeNull();
    expect(refAnchorKey('rc:45')).toBeNull();
    expect(refAnchorKey('pe1:banana:1')).toBeNull();
  });
});
