// THE BOTTLENECKS PANEL'S THREE LOAD-BEARING RULES, none of which any type can enforce.
//
//  (a) THE VISIBLE TAB IS DERIVED, NEVER WRITTEN BACK. The pane normalises a value it cannot
//      render FOR THE RENDER only; a corrective `setInsightsInnerTab()` would permanently forget
//      the reader's choice the moment a member became gated. `botsInnerTab` / `feedInnerTab`
//      carry the same comment because it has already cost a real bug there.
//  (b) REFUSALS RENDER, AND ARE NOT THE SAME AS "NOTHING STANDS OUT". A kind that could not clear
//      its sample floor gets a NAMED line; a kind that cleared its floors and found nothing gets a
//      different one. Silently dropping either upgrades "we could not say" into "we checked and
//      there is nothing here", which is a much stronger claim than the data supports.
//  (c) THE SUBJECT OF A ROW IS THE FLOW, NEVER A PERSON. Every row's identity is a directory, a
//      repo or a size band; people reach the screen only as chips INSIDE a row. The moment a row's
//      subject becomes an engineer this is a performance dashboard.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  FlowCoverage,
  FlowFinding,
  FlowFindingKind,
  FlowFindingsResponse,
  User,
} from '@pierre-review/shared';
import {
  buildBottlenecksModel,
  coverageCautionFor,
  effectiveInsightsTab,
  formatFlowPair,
  formatFlowValue,
  FLOW_KIND_LABEL,
  FLOW_KIND_ORDER,
} from '../src/components/Activity/bottlenecksModel.js';
import { useFilters } from '../src/store/filters.js';

const ANNA: User = {
  id: 41,
  githubLogin: 'anna',
  displayName: 'Anna Novak',
  avatarUrl: null,
  isBot: false,
};
const BEN: User = {
  id: 42,
  githubLogin: 'ben',
  displayName: 'Ben Ortiz',
  avatarUrl: null,
  isBot: false,
};

const COVERAGE: FlowCoverage = {
  reposInWorkspace: 4,
  reposWithData: 4,
  prsScanned: 210,
  truncated: false,
  filesTruncatedPrs: 0,
};

function finding(over: Partial<FlowFinding> = {}): FlowFinding {
  return {
    id: 'single_reviewer_path:3:packages/api/**',
    kind: 'single_reviewer_path',
    subjectKind: 'path',
    subject: 'packages/api/**',
    repoId: 3,
    headline:
      'One reviewer takes 78% of the 40 human reviews in packages/api/**, and a first read there waits 22h against 9.1h across the workspace.',
    detail:
      'Widening who reviews packages/api/** — a second name in its CODEOWNERS, or routing its pull requests to a group — is what shortens that wait.',
    value: 22,
    baseline: 9.1,
    unit: 'hours',
    sampleSize: 14,
    evidence: [
      {
        prId: 900,
        repoFullName: 'acme/api',
        prNumber: 412,
        prTitle: 'Split the request builder',
        githubUrl: 'https://github.com/acme/api/pull/412',
      },
    ],
    actorIds: [ANNA.id],
    ...over,
  };
}

function response(over: Partial<FlowFindingsResponse> = {}): FlowFindingsResponse {
  return {
    workspaceId: 5,
    windowDays: 30,
    findings: [],
    refusals: [],
    coverage: COVERAGE,
    users: [],
    ...over,
  };
}

const sectionFor = (
  model: ReturnType<typeof buildBottlenecksModel>,
  kind: FlowFindingKind,
): NonNullable<typeof model>['sections'][number] => {
  const s = model?.sections.find((x) => x.kind === kind);
  if (s == null) throw new Error(`no section for ${kind} — every kind must render one`);
  return s;
};

// ── (a) the derived tab ──────────────────────────────────────────────────────────────────────

describe('the Reports sub-tab is DERIVED, never written back', () => {
  beforeEach(() => {
    useFilters.setState({ insightsInnerTab: 'overview' });
  });

  it('passes a known member through', () => {
    expect(effectiveInsightsTab('overview')).toBe('overview');
    expect(effectiveInsightsTab('bottlenecks')).toBe('bottlenecks');
  });

  it('normalises a value it cannot render to the default', () => {
    // A hand-edited `?insightsTab=`, or a member a later build removed whose literal still sits
    // in a history entry a browser Back replays.
    expect(effectiveInsightsTab('sprint')).toBe('overview');
    expect(effectiveInsightsTab('')).toBe('overview');
    expect(effectiveInsightsTab(null)).toBe('overview');
    expect(effectiveInsightsTab(undefined)).toBe('overview');
  });

  // ⚠ THE ACTUAL PIN. Deriving must leave the STORE alone: the raw choice survives so the tab
  // comes back when whatever made it unrenderable goes away. A `set…()` in the deriver — or in
  // the component that calls it — makes this assertion fail, and only this assertion.
  it('leaves the stored choice untouched, even when it normalises', () => {
    useFilters.setState({ insightsInnerTab: 'sprint' as never });
    expect(effectiveInsightsTab(useFilters.getState().insightsInnerTab)).toBe('overview');
    expect(useFilters.getState().insightsInnerTab).toBe('sprint');

    useFilters.getState().setInsightsInnerTab('bottlenecks');
    expect(effectiveInsightsTab(useFilters.getState().insightsInnerTab)).toBe('bottlenecks');
    expect(useFilters.getState().insightsInnerTab).toBe('bottlenecks');
  });

  // The store field is TRANSIENT — freshDefaults() only, never in the persisted filter blob — so
  // no FILTER_STORAGE_VERSION bump is owed for it. (Persistence and "Clear filters" share one
  // list; a key in it would also be wiped by clearing a date range.)
  it('is not part of the persisted filter bar', async () => {
    const { pickFilterBarState } = await import('../src/store/filters.js');
    expect(Object.keys(pickFilterBarState(useFilters.getState()))).not.toContain(
      'insightsInnerTab',
    );
  });
});

// ── (b) refusals ─────────────────────────────────────────────────────────────────────────────

describe('refusals render, by name', () => {
  it('renders a section for EVERY kind, in a fixed order, whatever the data says', () => {
    const model = buildBottlenecksModel(response());
    expect(model?.sections.map((s) => s.kind)).toEqual([...FLOW_KIND_ORDER]);
  });

  it('names the refused kind and carries the server reason verbatim', () => {
    const reason =
      'No directory reached the floor of 8 reviewed pull requests and 12 human reviews in the last 30 days.';
    const model = buildBottlenecksModel(
      response({
        refusals: [{ kind: 'single_reviewer_path', reason, basis: 'insufficient_data' }],
      }),
    );
    const s = sectionFor(model, 'single_reviewer_path');
    expect(s.state).toBe('refused');
    expect(s.refusalReason).toBe(reason);
    // The NAME is what makes "not enough data to say X" a sentence — an enum spelling is not one.
    expect(s.label).toBe(FLOW_KIND_LABEL.single_reviewer_path);
  });

  // ⚠ THE DISTINCTION THIS PANEL EXISTS TO KEEP. The server refuses only when NO cell cleared its
  // floor; a kind whose cells cleared but crossed no threshold returns neither a finding nor a
  // refusal. Collapsing the two would let "we could not measure this" render as "we measured it
  // and it is fine".
  it('separates "could not say" from "measured, nothing stands out"', () => {
    const model = buildBottlenecksModel(
      response({ refusals: [{ kind: 'round_trips', reason: 'No review thread drew a human comment.', basis: 'insufficient_data' }] }),
    );
    expect(sectionFor(model, 'round_trips').state).toBe('refused');
    expect(sectionFor(model, 'approval_parked').state).toBe('measured');
    expect(sectionFor(model, 'approval_parked').refusalReason).toBeNull();
  });

  // ⚠ THE REGRESSION THAT MADE `basis` NECESSARY. The server used to refuse ONLY when nothing
  // cleared a floor, so a kind that measured cleanly returned neither a finding nor a refusal —
  // and rendered as an ABSENT SECTION, which asserts "we checked and there is nothing here", the
  // strongest of the three claims. Fixing that made the server refuse in BOTH cases, which
  // collapsed them onto one wire shape and put a clean bill of health under "Not enough data to
  // say" — sending the reader after a sync problem that does not exist. `basis` is the
  // discriminator; the STATE MUST COME OFF IT, never off "is there a refusal at all".
  it('reads a measured_clean refusal as MEASURED, not as a lack of data', () => {
    const model = buildBottlenecksModel(
      response({
        refusals: [
          {
            kind: 'size_latency',
            reason: 'Large changes are picked up about as quickly as small ones here.',
            basis: 'measured_clean',
          },
          {
            kind: 'round_trips',
            reason: 'No review thread opened in the last 30 days drew a human comment.',
            basis: 'insufficient_data',
          },
        ],
      }),
    );
    const clean = sectionFor(model, 'size_latency');
    expect(clean.state).toBe('measured');
    // The server's own sentence is kept and shown: it names WHAT was measured, which is the
    // useful half and is strictly better than the panel's generic fallback line.
    expect(clean.refusalReason).toContain('about as quickly');

    expect(sectionFor(model, 'round_trips').state).toBe('refused');
  });

  it('only claims "nothing stands out" when nothing was found AND nothing was refused', () => {
    expect(buildBottlenecksModel(response())?.nothingStandsOut).toBe(true);
    expect(
      buildBottlenecksModel(response({ refusals: [{ kind: 'size_latency', reason: 'x', basis: 'insufficient_data' }] }))
        ?.nothingStandsOut,
    ).toBe(false);
    expect(
      buildBottlenecksModel(response({ findings: [finding()], users: [ANNA] }))?.nothingStandsOut,
    ).toBe(false);
  });

  it('renders no model at all while the response is absent — no empty-state claim it has not earned', () => {
    expect(buildBottlenecksModel(undefined)).toBeNull();
  });

  // The empty-workspace answer: the server refuses all four kinds with ONE reason. `allRefused`
  // frames that so four identical dashed boxes read as intentional — ⚠ it must not COLLAPSE them,
  // because the kind name is the "X" in "not enough data to say X".
  it('flags an all-refused response for framing, and still renders every named refusal', () => {
    const reason = 'This workspace has no repositories yet.';
    const model = buildBottlenecksModel(
      response({
        refusals: FLOW_KIND_ORDER.map((kind) => ({ kind, reason })),
        coverage: { reposInWorkspace: 0, reposWithData: 0, prsScanned: 0, truncated: false },
      }),
    );
    expect(model?.allRefused).toBe(true);
    expect(model?.nothingStandsOut).toBe(false);
    expect(model?.sections).toHaveLength(FLOW_KIND_ORDER.length);
    for (const s of model?.sections ?? []) {
      expect(s.state).toBe('refused');
      expect(s.refusalReason).toBe(reason);
      expect(s.label).toBe(FLOW_KIND_LABEL[s.kind]);
    }
  });

  it('does not flag allRefused when a single kind still has something to say', () => {
    const model = buildBottlenecksModel(
      response({
        findings: [finding()],
        users: [ANNA],
        refusals: FLOW_KIND_ORDER.filter((k) => k !== 'single_reviewer_path').map((kind) => ({
          kind,
          reason: 'x',
          basis: 'insufficient_data' as const,
        })),
      }),
    );
    expect(model?.allRefused).toBe(false);
  });
});

// ── (c) the subject is the flow; people are evidence INSIDE the row ──────────────────────────

describe('a finding row is about the flow, and people are evidence inside it', () => {
  it('leads with the finding subject, not a person', () => {
    const model = buildBottlenecksModel(response({ findings: [finding()], users: [ANNA] }));
    const row = sectionFor(model, 'single_reviewer_path').rows[0];
    expect(row?.subject).toBe('packages/api/**');
    expect(row?.subjectKindLabel).toBe('Directory');
    // ⚠ The structural half: no row's identity may be a person's name or login. A row whose
    // subject became an engineer is the performance dashboard this feature is licensed not to be.
    for (const u of [ANNA, BEN]) {
      expect(row?.subject).not.toBe(u.githubLogin);
      expect(row?.subject).not.toBe(u.displayName);
      expect(row?.id).not.toContain(u.githubLogin);
    }
  });

  it('resolves actorIds through the response users table, INSIDE the row', () => {
    const model = buildBottlenecksModel(
      response({ findings: [finding({ actorIds: [ANNA.id, BEN.id] })], users: [ANNA, BEN] }),
    );
    const row = sectionFor(model, 'single_reviewer_path').rows[0];
    expect(row?.actors.map((a) => a.id)).toEqual([ANNA.id, BEN.id]);
    expect(row?.actors[0]?.user).toEqual(ANNA);
    // A caption saying what the chips are evidence OF — a bare row of faces beside a slow number
    // reads as an accusation.
    expect(row?.actorCaption).toBe('Taking most of the reviews here');
  });

  it('keeps an unresolved actor as a chip rather than dropping the evidence', () => {
    const model = buildBottlenecksModel(
      response({ findings: [finding({ actorIds: [999] })], users: [] }),
    );
    const row = sectionFor(model, 'single_reviewer_path').rows[0];
    expect(row?.actors).toEqual([{ id: 999, user: undefined }]);
  });

  // ⚠ The model exposes people ONLY per row. There is no cross-row actor list, no count and no
  // ordering by person anywhere on the model — which is what stops a leaderboard being one
  // `.flatMap()` away in the panel.
  it('exposes no cross-row person shape', () => {
    const model = buildBottlenecksModel(
      response({ findings: [finding()], users: [ANNA] }),
    );
    expect(Object.keys(model ?? {}).some((k) => /actor|people|person|user/i.test(k))).toBe(false);
    for (const s of model?.sections ?? []) {
      expect(Object.keys(s).some((k) => /actor|people|person|user/i.test(k))).toBe(false);
    }
  });

  it('renders value AND baseline together, and a sample size on every row', () => {
    const model = buildBottlenecksModel(
      response({
        findings: [
          finding(),
          finding({
            id: 'round_trips:3:packages/ui/**',
            kind: 'round_trips',
            subject: 'packages/ui/**',
            value: 5,
            baseline: 2,
            unit: 'comments',
            sampleSize: 31,
            actorIds: [],
          }),
        ],
        users: [ANNA],
      }),
    );
    const path = sectionFor(model, 'single_reviewer_path').rows[0];
    // ⚠ ONE UNIT **AND ONE ROUNDING RULE** ACROSS THE PAIR. Formatted independently these are
    // "22h" and "9.1h" — two spellings of one measurement on one row, which is the same defect
    // this file's header warns about for the sentence-vs-chip case. `formatFlowPair` picks the
    // scale off the LARGER figure and applies it to both, so 9.1 rounds like 22 does.
    expect(path?.value).toBe('22h');
    expect(path?.baseline).toBe('9h');
    expect(path?.baselineLabel).toBe('across the workspace');
    expect(path?.sample).toBe('14 pull requests');

    const trips = sectionFor(model, 'round_trips').rows[0];
    expect(trips?.value).toBe('5 comments');
    expect(trips?.baseline).toBe('2 comments');
    // The sample noun follows the kind's population — a round trip is measured in THREADS.
    expect(trips?.sample).toBe('31 threads');
    expect(trips?.actors).toEqual([]);
  });

  // ⚠ These mirror `fmtHours` / `fmtCount` in apps/backend/src/db/flow-findings.ts. The server
  // already wrote the same figure into its templated headline; a divergent rounding rule puts two
  // spellings of one number on one row, which reads as two measurements.
  it('formats a figure exactly as the server spelled it in the headline', () => {
    expect(formatFlowValue(0.4, 'hours')).toBe('24 min');
    expect(formatFlowValue(9.14, 'hours')).toBe('9.1h');
    expect(formatFlowValue(22.4, 'hours')).toBe('22h');
    expect(formatFlowValue(72, 'hours')).toBe('3 days');
    expect(formatFlowValue(0.78, 'pct')).toBe('78%');
    expect(formatFlowValue(1, 'comments')).toBe('1 comment');
  });
});

// ── coverage ─────────────────────────────────────────────────────────────────────────────────

describe('coverage is always on screen', () => {
  it('states what it measured', () => {
    const model = buildBottlenecksModel(response());
    expect(model?.coverageLine).toBe('Measured 4 of 4 repositories · 210 pull requests · last 30 days.');
    expect(model?.coverageCaution).toBeNull();
  });

  // ⚠ Retroactive history is COVERAGE-BIASED (docs/PERIOD-REPORTING.md): a workspace where most
  // repos are silent is describing a minority of its own work, and the reader should not have to
  // know that to read the panel.
  it('cautions when repos are silent or a scan was capped', () => {
    expect(coverageCautionFor({ ...COVERAGE, reposWithData: 1 })).toContain(
      '3 of these repositories had no measurable review activity',
    );
    expect(coverageCautionFor({ ...COVERAGE, truncated: true })).toContain('reached its cap');
    expect(
      coverageCautionFor({ reposInWorkspace: 0, reposWithData: 0, prsScanned: 0, truncated: false }),
    ).toBeNull();
  });

  it('renders the window the SERVER measured, not the one the client asked for', () => {
    // The route clamps `?days=` to [7, 90]; a bookmarked 400 comes back as 90 and every sentence
    // on screen has to say 90 or it describes a window nobody computed.
    const model = buildBottlenecksModel(response({ windowDays: 90 }));
    expect(model?.windowDays).toBe(90);
    expect(model?.coverageLine).toContain('last 90 days');
  });
});

// ── The straddle case: the one that shipped wrong ──────────────────────────────────────────────
//
// `bevyengine/bevy` rendered "2.6 days vs 36h" on screen. Both figures were correct; the row was
// still bad, because 62.4h crosses the 48h day threshold and 36h does not, so the reader had to
// convert before they could see the gap. Straddling the threshold is WHAT A LARGE GAP LOOKS LIKE,
// so per-value formatting broke down on exactly the rows most worth reading.
describe('a value/baseline pair never straddles a unit boundary', () => {
  it('renders both sides in days when the larger figure crosses into days', () => {
    const { value, baseline } = formatFlowPair(62.4, 36, 'hours');
    expect(value).toBe('2.6 days');
    expect(baseline).toBe('1.5 days');
    expect(value.replace(/[\d.]+ /, '')).toBe(baseline.replace(/[\d.]+ /, ''));
  });

  it('keeps hours on both sides when neither crosses', () => {
    const { value, baseline } = formatFlowPair(22, 9.1, 'hours');
    expect(value).toBe('22h');
    expect(baseline).toBe('9h');
  });

  it('leaves the non-duration units alone — only hours has a switching threshold', () => {
    expect(formatFlowPair(5, 2, 'comments')).toEqual({
      value: '5 comments',
      baseline: '2 comments',
    });
  });

  it('is stable when the baseline is the LARGER of the two', () => {
    // `size_latency` can hand the pair either way round depending on which band is slowest, and
    // the scale must come from the larger figure regardless of which argument it arrived in.
    const a = formatFlowPair(60, 2, 'hours');
    const b = formatFlowPair(2, 60, 'hours');
    expect(a.value.endsWith('days')).toBe(true);
    expect(b.baseline.endsWith('days')).toBe(true);
    expect(a.value).toBe(b.baseline);
    expect(a.baseline).toBe(b.value);
  });
});


// ── The two coverage caveats are DIFFERENT CLAIMS ─────────────────────────────────────────────
//
// They shipped as ONE boolean, and a single 120-file pull request made a 262-PR workspace announce
// "these figures come from part of the window only" — a claim about the PERIOD that had not
// happened. A caveat the reader cannot act on is worse than none: it teaches them to ignore the
// line that matters.
describe('coverage separates a cut scan from a capped file list', () => {
  it('says nothing when neither happened', () => {
    expect(coverageCautionFor({ ...COVERAGE })).toBeNull();
  });

  it('a CUT SCAN is a claim about the window', () => {
    const line = coverageCautionFor({ ...COVERAGE, truncated: true });
    expect(line).toContain('part of the window');
  });

  it('a CAPPED FILE LIST is a claim about the per-directory split, and never about the window', () => {
    const line = coverageCautionFor({ ...COVERAGE, filesTruncatedPrs: 3 });
    expect(line).toContain('per-directory');
    expect(line).not.toContain('part of the window');
    expect(line).toContain('3 scanned pull requests');
  });

  it('renders BOTH when both happened, as two sentences', () => {
    const line = coverageCautionFor({ ...COVERAGE, truncated: true, filesTruncatedPrs: 1 });
    expect(line).toContain('part of the window');
    expect(line).toContain('per-directory');
    // Singular, because "1 scanned pull requests" is the kind of thing nobody reports.
    expect(line).toContain('1 scanned pull request ');
  });
});

// ── A positive figure never prints as zero ────────────────────────────────────────────────────
//
// The pair takes its unit from the LARGER figure, so the smaller one can round away entirely:
// (60h, 1h) picked days and rendered "2.5 days vs 0 days" — on a row that exists BECAUSE the two
// differ. Self-refuting, and it lands on the widest gaps, which are the rows worth reading.
describe('a strictly positive figure never renders as zero', () => {
  it('floors the small side rather than printing 0 days', () => {
    const { value, baseline } = formatFlowPair(60, 1, 'hours');
    expect(value).toBe('2.5 days');
    expect(baseline).toBe('<0.1 days');
    expect(baseline).not.toBe('0 days');
  });

  it('floors on the hours scale too', () => {
    const { baseline } = formatFlowPair(90, 0.2, 'hours');
    expect(baseline).not.toMatch(/^0/);
  });

  it('still prints a real zero as zero', () => {
    // A genuine 0 is not a rounding artefact and must not claim to be "less than" anything.
    expect(formatFlowPair(60, 0, 'hours').baseline).toBe('0 days');
  });
});
