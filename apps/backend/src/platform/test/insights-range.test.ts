// The Insights chat's per-question range → window resolver (settings/store.ts).
//
// Two things are pinned here. First, that `range == null` resolves to EXACTLY the WORKSPACE's
// configured window — the chat and every other Insights surface must agree when the user hasn't
// overridden anything, and the only way to be sure is to compare against `resolveComparisonWindow`
// itself rather than against a second copy of its ternary.
//
// Second, the 'sprint'-with-no-dates fallback. The SPA doesn't offer the chip then, so this path is
// reachable only via a direct API call or a settings change mid-session — but it must still answer,
// and it must report `kind: '14d'` with `requested: 'sprint'` so nothing captions a rolling
// fortnight "Sprint to date".
//
// ⚠ THIS RESOLVER IS NOW PINNED ON ONE SIDE ONLY, KNOWINGLY. `defaultInsightsRange` in
// apps/frontend/src/lib/insightsRange.ts used to mirror the null-range branch below, and the two
// were tested against each other. It was DELETED with the FilterBar "Range" chips: the chat's
// window precedence always sends an explicit `window` (its one mount lives inside a period
// report), so those chips could never reach the wire and the client had nothing left to resolve.
// There is therefore no client copy to drift from — but if a client-side range selector is ever
// reintroduced, restore the mirror AND its test rather than re-deriving the branch.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/insights-range.test.ts
import { describe, expect, it } from 'vitest';
import type { SprintComparisonMode } from '@pierre-review/shared';
import {
  resolveComparisonWindow,
  resolveInsightsRange,
  type SprintCadence,
} from '../settings/store.js';

const DAY = 86_400_000;
// A fixed "now" — Date.now() in a test would make the assertions time-dependent.
const NOW = Date.UTC(2026, 7, 17, 12, 0, 0); // 2026-08-17T12:00:00Z

// ⚠ BOTH RESOLVERS NOW TAKE TWO RESOLVED VALUES AND NO ROW AT ALL, and that is the contract under
// test as much as anything below it. Plugin migration 0031 made the sprint LENGTH + phase anchor
// per-workspace; plugin migration 0032 did the same to the MODE, because the two COMPOSE —
// 'sprint' is a sprint-position window on a workspace with a cadence and a rolling fortnight on one
// without, so an account-wide mode produced two different window SHAPES with nothing naming which.
// Both halves come off ONE `pro_workspace_settings` row (`comparisonModeOf` + `cadenceOf`), and
// neither resolver can reach an account row any more. These helpers keep one literal per fixture
// and split it, so a test cannot accidentally prove the two agree by handing both halves the same
// object.
interface Fixture {
  comparisonMode?: SprintComparisonMode | null;
  sprintCadenceDays?: number | null;
  sprintStartAt?: Date | null;
}

/** The fixture's mode as the resolvers now take it — a plain value, with the PRODUCT DEFAULT
 *  standing in for "unset", exactly as `comparisonModeOf` reads a row with a null column. */
function mode(over: Fixture): SprintComparisonMode {
  return over.comparisonMode ?? 'rolling_14';
}

/** The same fixture expressed as the RESOLVED cadence — what `resolveSprintCadence` hands back
 *  for a workspace that has one. There is no second source to distinguish it from. */
function cad(over: Fixture): SprintCadence {
  return {
    cadenceDays: over.sprintCadenceDays ?? null,
    startAtMs: over.sprintStartAt?.getTime() ?? null,
  };
}

const days = (w: { fromMs: number; toMs: number }): number => (w.toMs - w.fromMs) / DAY;

// 3 Aug; NOW sits on day 14 of that sprint.
const SPRINT_FIXTURE: Fixture = {
  comparisonMode: 'sprint',
  sprintCadenceDays: 14,
  sprintStartAt: new Date(Date.UTC(2026, 7, 3)),
};

describe('resolveInsightsRange — explicit ranges', () => {
  it.each([
    ['7d', 7],
    ['14d', 14],
    ['30d', 30],
    ['90d', 90],
  ] as const)('%s is a trailing window of %i days ending now', (key, expected) => {
    const w = resolveInsightsRange(mode({}), cad({}), NOW, key);
    expect(w.kind).toBe(key);
    expect(w.toMs).toBe(NOW);
    expect(days(w)).toBe(expected);
    expect(w.requested).toBeUndefined();
  });

  it('an explicit range OVERRIDES the configured mode', () => {
    // Configured for sprints, asked for 90 days: the answer covers 90 days.
    const configured = mode(SPRINT_FIXTURE);
    const w = resolveInsightsRange(configured, cad(SPRINT_FIXTURE), NOW, '90d');
    expect(w.kind).toBe('90d');
    expect(days(w)).toBe(90);
  });
});

describe('resolveInsightsRange — sprint', () => {
  const sprintMode = mode(SPRINT_FIXTURE);

  it('is the CURRENT sprint window, ending in the future', () => {
    const w = resolveInsightsRange(sprintMode, cad(SPRINT_FIXTURE), NOW, 'sprint');
    expect(w.kind).toBe('sprint');
    expect(w.fromMs).toBe(Date.UTC(2026, 7, 17)); // the sprint that began at midnight today
    expect(days(w)).toBe(14);
    // "To date" — the window's end is the sprint's end, which has not happened yet.
    expect(w.toMs).toBeGreaterThan(NOW);
  });

  it('falls back to rolling 14d — and SAYS SO — when no cadence/start is stored', () => {
    const w = resolveInsightsRange(mode({ comparisonMode: 'sprint' }), cad({}), NOW, 'sprint');
    expect(w.kind).toBe('14d');
    expect(w.requested).toBe('sprint');
    expect(w.toMs).toBe(NOW);
    expect(days(w)).toBe(14);
  });

  it('a cadence with no start date is NOT a usable sprint', () => {
    // The chip is hidden in this state precisely because a cadence alone can't locate a window.
    const w = resolveInsightsRange(mode({}), cad({ sprintCadenceDays: 14 }), NOW, 'sprint');
    expect(w.kind).toBe('14d');
    expect(w.requested).toBe('sprint');
  });
});

describe('resolveInsightsRange — no override matches the configured window', () => {
  it.each([
    ['rolling_7', '7d'],
    ['rolling_14', '14d'],
  ] as const)('mode %s → %s, identical to resolveComparisonWindow', (modeKey, key) => {
    const m = mode({ comparisonMode: modeKey });
    const chat = resolveInsightsRange(m, cad({}), NOW, null);
    const configured = resolveComparisonWindow(m, cad({}), NOW);
    expect(chat.kind).toBe(key);
    expect(chat.fromMs).toBe(configured.fromMs);
    expect(chat.toMs).toBe(configured.toMs);
  });

  it('an unset mode is rolling 14 — the documented default', () => {
    const w = resolveInsightsRange(mode({}), cad({}), NOW, null);
    expect(w.kind).toBe('14d');
    expect(days(w)).toBe(14);
  });

  it('mode sprint with dates → the same sprint window the metrics use', () => {
    const m = mode(SPRINT_FIXTURE);
    const c = cad(SPRINT_FIXTURE);
    const chat = resolveInsightsRange(m, c, NOW, null);
    const configured = resolveComparisonWindow(m, c, NOW);
    expect(chat.kind).toBe('sprint');
    expect(chat.fromMs).toBe(configured.fromMs);
    expect(chat.toMs).toBe(configured.toMs);
  });

  it('mode sprint WITHOUT dates degrades the same way on both paths', () => {
    const m = mode({ comparisonMode: 'sprint' });
    const chat = resolveInsightsRange(m, cad({}), NOW, null);
    const configured = resolveComparisonWindow(m, cad({}), NOW);
    expect(chat.kind).toBe('14d');
    expect(chat.requested).toBe('sprint');
    expect(configured.mode).toBe('rolling_14');
    expect(chat.fromMs).toBe(configured.fromMs);
  });
});

// ── BOTH HALVES ARE PER-WORKSPACE ────────────────────────────────────────────────────────────
//
// The mode and the cadence both arrive resolved, off one workspace row, so a workspace running a
// 7-day sprint gets a 7-day window while its neighbour on the same account gets its own. Before
// the splits, both read `pro_settings` — one team saw the other's fortnight under its own heading
// (0031), and one team's chosen mode framed every other team's window (0032).
describe('the two resolved arguments, not a settings row, decide the window', () => {
  const sprintMode = mode(SPRINT_FIXTURE); // 'sprint'; the cadence arrives separately

  it('a workspace cadence of 7 days yields a 7-day sprint window', () => {
    const w = resolveInsightsRange(
      sprintMode,
      { cadenceDays: 7, startAtMs: Date.UTC(2026, 7, 3) },
      NOW,
      'sprint',
    );
    expect(w.kind).toBe('sprint');
    expect(days(w)).toBe(7);
    // 3 Aug + two whole 7-day sprints = 17 Aug, the sprint containing NOW.
    expect(w.fromMs).toBe(Date.UTC(2026, 7, 17));
  });

  it('resolveComparisonWindow reads the same cadence — the two paths cannot diverge', () => {
    const cadence: SprintCadence = { cadenceDays: 7, startAtMs: Date.UTC(2026, 7, 3) };
    const chat = resolveInsightsRange(sprintMode, cadence, NOW, null);
    const configured = resolveComparisonWindow(sprintMode, cadence, NOW);
    expect(chat.kind).toBe('sprint');
    expect(chat.fromMs).toBe(configured.fromMs);
    expect(chat.toMs).toBe(configured.toMs);
  });

  it('⚠ A WORKSPACE WITH NO CADENCE GETS NO SPRINT — not somebody else\'s fortnight', () => {
    // Plugin migration 0031 removed the account-level fallback this case used to exercise. The
    // 'sprint' chip is still ANSWERABLE (a bare API call, or a settings change mid-session), and
    // it must degrade to the rolling default while CARRYING THE ASK, never caption a rolling
    // fortnight "Sprint to date", and never inherit a cadence from anywhere.
    const w = resolveInsightsRange(sprintMode, cad({}), NOW, 'sprint');
    expect(w.kind).toBe('14d');
    expect(w.requested).toBe('sprint');
    expect(days(w)).toBe(14);
    expect(w.toMs).toBe(NOW);
  });
});
