// deriveIntents — golden decisions over a synthetic AdvisorFindingsPayload. Pure (no DB, no
// ctx): the cap-diff.test.ts pattern. Each fixture cell is built to sit just over or just
// under one named threshold, so a drifted constant fails here by name.
import { describe, expect, it } from 'vitest';
import type {
  AdvisorBotTotals,
  AdvisorFindingsPayload,
  AdvisorPathCell,
  MlCategory,
} from '@pierre-review/shared';
import { deriveIntents } from '../../advisor/intents.js';
import { parseFindingsPayload } from '../../advisor/findings.js';

const sev = (over: Partial<Record<'nit' | 'minor' | 'major' | 'critical', number>> = {}) => ({
  nit: 0,
  minor: 0,
  major: 0,
  critical: 0,
  ...over,
});

const bot = (over: Partial<AdvisorBotTotals> & { botUserId: number }): AdvisorBotTotals => ({
  key: `u${over.botUserId}`,
  kind: 'in_house',
  label: `bot${over.botUserId}`,
  login: `bot${over.botUserId}`,
  isQualityCheck: false,
  threads: 0,
  actedOn: 0,
  untouched: 0,
  mergedUntouched: 0,
  overdueUntouched: 0,
  dissent: 0,
  mlLabelled: 0,
  mlFindings: 0,
  mlNits: 0,
  actedOnNits: 0,
  pathCoveragePct: 50,
  verdict: 'keep',
  ...over,
});

const pathCell = (
  over: Partial<AdvisorPathCell> & { botUserId: number; pathBucket: string },
): AdvisorPathCell => ({
  volume: 0,
  actedOn: 0,
  actedOnHigh: 0,
  actedOnNits: 0,
  untouched: 0,
  mergedUntouched: 0,
  overdueUntouched: 0,
  dissent: 0,
  bySeverity: sev(),
  samplePrIds: [101],
  sampleThreadIds: [1],
  ...over,
});

const payload: AdvisorFindingsPayload = {
  generatedAt: '2026-08-09T00:00:00.000Z',
  window: { kind: 'rolling_30', from: '2026-07-10T00:00:00.000Z', to: '2026-08-09T00:00:00.000Z' },
  workspaceId: 7,
  bots: [
    // coderabbit-shaped: nit share EXACTLY at the 0.7 gate (14/20), busy everywhere.
    bot({ botUserId: 1, kind: 'coderabbit', label: 'CodeRabbit', threads: 30, actedOn: 12, untouched: 14, mlLabelled: 40, mlFindings: 20, mlNits: 14, actedOnNits: 3, pathCoveragePct: 41 }),
    // greptile-shaped: over the bootstrap volume floor, no config target.
    bot({ botUserId: 2, kind: 'greptile', label: 'Greptile', threads: 12, actedOn: 6, untouched: 4 }),
    // A quality check with terrible numbers — must produce NOTHING.
    bot({ botUserId: 3, label: 'SonarQube', isQualityCheck: true, threads: 40, untouched: 40, overdueUntouched: 40 }),
  ],
  pathCells: [
    // 8/10 untouched (5 shipped in merged PRs), NO acted-on high → SUPPRESS_PATH (the veto
    // AND the merged-past gate pass); retro = the 2 acted it would also hide.
    pathCell({ botUserId: 1, pathBucket: 'src/**', volume: 10, actedOn: 2, actedOnHigh: 0, untouched: 8, mergedUntouched: 5, overdueUntouched: 6, bySeverity: sev({ minor: 4, major: 2 }) }),
    // 8/10 acted, 3 high → AMPLIFY_PATH (80 ≥ the 70 floor, 3 ≥ 2 high).
    pathCell({ botUserId: 1, pathBucket: 'lib/**', volume: 10, actedOn: 8, actedOnHigh: 3, untouched: 1 }),
    // The erxes shape: 8/10 untouched BUT one acted-on high-severity → the veto blocks the
    // full suppress, and the nit-dominated labels (6/7 nits, 1 of 6 acted) downgrade it to
    // QUIET_PATH_NITS instead.
    pathCell({ botUserId: 1, pathBucket: 'apps/**', volume: 10, actedOn: 2, actedOnHigh: 1, actedOnNits: 1, untouched: 8, mergedUntouched: 4, overdueUntouched: 6, bySeverity: sev({ nit: 6, major: 1 }) }),
    // 3/6 untouched — under both bars → nothing.
    pathCell({ botUserId: 2, pathBucket: 'docs/**', volume: 6, actedOn: 2, untouched: 3 }),
    // Vetoed AND not nit-dominated → NOTHING (silence is the honest outcome: mostly ignored,
    // but what was acted on there was a big one).
    pathCell({ botUserId: 2, pathBucket: 'web/**', volume: 5, actedOn: 1, actedOnHigh: 1, untouched: 4, mergedUntouched: 3, bySeverity: sev({ minor: 3, major: 2 }) }),
    // Crossed the untouched bar with a clean veto but EVERY ignoring PR is still open
    // (mergedUntouched 0) → no suppress. Open-PR silence is not the team's final answer.
    pathCell({ botUserId: 2, pathBucket: 'pkg/**', volume: 6, actedOn: 1, actedOnHigh: 0, untouched: 5, mergedUntouched: 0 }),
  ],
  categoryCells: [
    // 8/10 thread-linked untouched (5 in merged PRs) → SUPPRESS_CATEGORY (findings 25 ≥ 20 floor).
    { botUserId: 1, category: 'documentation', findings: 25, bySeverity: sev({ nit: 20, minor: 5 }), threadLinked: 10, actedOn: 2, actedOnHigh: 0, untouched: 8, mergedUntouched: 5, overdueUntouched: 5, dissent: 0, samplePrIds: [101] },
    // 5/6 thread-linked acted → ESCALATE.
    { botUserId: 1, category: 'security', findings: 21, bySeverity: sev({ major: 15, critical: 6 }), threadLinked: 6, actedOn: 5, actedOnHigh: 5, untouched: 1, mergedUntouched: 0, overdueUntouched: 0, dissent: 0, samplePrIds: [102] },
    // 8/10 untouched but one acted-on high → the category veto blocks the suppress.
    { botUserId: 2, category: 'style' as MlCategory, findings: 22, bySeverity: sev({ nit: 10, minor: 10, major: 2 }), threadLinked: 10, actedOn: 2, actedOnHigh: 1, untouched: 8, mergedUntouched: 4, overdueUntouched: 5, dissent: 0, samplePrIds: [103] },
  ],
  overlapCells: [
    // 13/30 = 0.43 ≥ 0.4 → SCOPE_OFF for bot 1 (partner 2).
    { botUserId: 1, partnerUserId: 2, sharedClusters: 4, overlapThreads: 13, threads: 30 },
    // 4/12 = 0.33 < 0.4 → nothing for bot 2.
    { botUserId: 2, partnerUserId: 1, sharedClusters: 4, overlapThreads: 4, threads: 12 },
  ],
  pathCoveragePct: 41,
  floors: { minCellThreads: 5, minCellFindings: 20, amplifyMinActedPct: 70, overdueGraceMs: 129_600_000 },
};

const intents = deriveIntents(parseFindingsPayload(payload), {
  botsWithConfigTarget: new Set([1]),
  lintTemplates: [
    { botUserId: 2, template: 'Unused variable found', fires: 25, actedOn: 5 },
    { botUserId: 2, template: 'Rare rule', fires: 3, actedOn: 1 }, // under the 20-fire floor
  ],
});

const kindsFor = (botUserId: number): string[] =>
  intents.filter((i) => i.botUserId === botUserId).map((i) => i.kind);

describe('deriveIntents decisions', () => {
  it('derives the expected intent set per bot', () => {
    expect(kindsFor(1).sort()).toEqual([
      'AMPLIFY_PATH',
      'ESCALATE',
      'LOWER_VERBOSITY',
      'QUIET_PATH_NITS',
      'SCOPE_OFF',
      'SUPPRESS_CATEGORY',
      'SUPPRESS_PATH',
    ]);
    // web/** (vetoed, not nit-heavy) and style (vetoed category) both produce NOTHING.
    expect(kindsFor(2).sort()).toEqual(['BOOTSTRAP_CONFIG', 'PROMOTE_TO_LINT']);
  });

  it('the veto: acted-on high-severity blocks a full suppress; nit-dominated cells downgrade to QUIET_PATH_NITS', () => {
    // apps/** crossed the untouched bar but carries 1 acted-on high → no SUPPRESS_PATH …
    const suppressTargets = intents
      .filter((i) => i.kind === 'SUPPRESS_PATH')
      .map((i) => i.targetKey);
    expect(suppressTargets).toEqual(['src/**']);
    // … it downgrades to the nit-scoped quiet instead (6/7 labelled are nits, 1/6 acted).
    const quiet = intents.find((i) => i.kind === 'QUIET_PATH_NITS')!;
    expect(quiet.targetKey).toBe('apps/**');
    expect(quiet.dedupeKey).toBe('QUIET_PATH_NITS|1|apps/**|rolling_30');
    expect(quiet.retro).toMatchObject({
      applicable: true,
      computable: true,
      wouldHideActedOn: 1, // the one acted-on nit
      wouldHideActedOnHigh: 0, // a nit is never high-severity
      wouldHideTotal: 6, // the nit-labelled findings on the path
    });
    // The category veto: bot 2's style cell crossed the untouched bar with 1 acted-on high.
    expect(intents.some((i) => i.kind === 'SUPPRESS_CATEGORY' && i.botUserId === 2)).toBe(false);
  });

  it('the merged-past gate: open-PR silence alone never earns a suppress', () => {
    // pkg/** crossed the untouched bar with a clean high-severity veto, but every ignoring
    // PR is still open (mergedUntouched 0) — no suppress until a PR merges past the bot.
    expect(intents.some((i) => i.targetKey === 'pkg/**')).toBe(false);
    // The evidence carries the merged-past count for the one that DID fire.
    const sp = intents.find((i) => i.kind === 'SUPPRESS_PATH')!;
    expect(sp.evidence.mergedUntouched).toBe(5);
    expect(sp.rationale).toContain('5 shipped in PRs that merged anyway');
  });

  it('a quality check produces NOTHING, however bad its numbers', () => {
    expect(kindsFor(3)).toEqual([]);
  });

  it('dedupe keys carry intent|bot|target|window', () => {
    const sp = intents.find((i) => i.kind === 'SUPPRESS_PATH')!;
    expect(sp.dedupeKey).toBe('SUPPRESS_PATH|1|src/**|rolling_30');
    const lv = intents.find((i) => i.kind === 'LOWER_VERBOSITY')!;
    expect(lv.dedupeKey).toBe('LOWER_VERBOSITY|1|nit|rolling_30');
  });

  it('suppress-shaped intents carry a COMPUTABLE retro-check with the hidden-acted numbers', () => {
    const sp = intents.find((i) => i.kind === 'SUPPRESS_PATH')!;
    expect(sp.retro).toMatchObject({
      applicable: true,
      computable: true,
      wouldHideActedOn: 2,
      wouldHideActedOnHigh: 0,
      wouldHideTotal: 10,
    });
    const sc = intents.find((i) => i.kind === 'SUPPRESS_CATEGORY')!;
    expect(sc.retro.computable).toBe(true);
    expect(sc.retro.wouldHideActedOn).toBe(2);
    expect(sc.retro.disclosure).toContain('thread-linked');
    const lv = intents.find((i) => i.kind === 'LOWER_VERBOSITY')!;
    expect(lv.retro.wouldHideActedOn).toBe(3); // actedOnNits
    expect(lv.retro.wouldHideTotal).toBe(14);
  });

  it('SCOPE_OFF is honest about being unsimulatable — config-PR blocked, brief allowed', () => {
    const so = intents.find((i) => i.kind === 'SCOPE_OFF')!;
    expect(so.retro.applicable).toBe(true);
    expect(so.retro.computable).toBe(false);
  });

  it('additive intents are retro-exempt (applicable: false)', () => {
    for (const kind of ['AMPLIFY_PATH', 'ESCALATE', 'BOOTSTRAP_CONFIG', 'PROMOTE_TO_LINT']) {
      const i = intents.find((x) => x.kind === kind)!;
      expect(i.retro.applicable, kind).toBe(false);
    }
  });

  it('every intent discloses path coverage on its evidence', () => {
    for (const i of intents.filter((x) => x.botUserId === 1)) {
      expect(i.evidence.pathCoveragePct).toBe(41);
    }
  });

  it('a bot WITH a config target never earns BOOTSTRAP_CONFIG; the lint floor holds', () => {
    expect(kindsFor(1)).not.toContain('BOOTSTRAP_CONFIG');
    expect(
      intents.filter((i) => i.kind === 'PROMOTE_TO_LINT').map((i) => i.targetKey),
    ).toEqual(['Unused variable found']);
  });
});
