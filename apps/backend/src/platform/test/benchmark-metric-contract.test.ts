// THE CROSS-LANGUAGE METRIC CONTRACT, PROVED.
//
// The cohort's thirteen metrics are computed in Python (`bot_monitor.panel.fit`) from the corpus.
// The customer's identical thirteen are computed in TypeScript (`src/bots/benchmark/fold.ts`) from
// the host's tables. Neither language can see the other, so "identical" is a CLAIM — and this file
// is the only thing that turns it into a fact.
//
// `test/fixtures/metric-contract-v1.json` is emitted by `python -m bot_monitor.panel.contract`
// through the REAL corpus dataclasses, the REAL CorpusStore and the REAL `read_corpus` /
// `evaluate_metric` — never a hand-rolled dict, so a column rename in the walk's projection goes
// red on the Python side and a definition drift goes red here.
//
// ⚠ COMPARE COUNTERS FIRST. A metric value that disagrees says something is wrong; a counter says
// WHICH population, WHICH gate and WHICH row. The per-unit assertions below therefore assert the
// whole counter block before they look at a single value.
//
// ⚠ EXACT EQUALITY, NEVER A TOLERANCE. Every rate is one IEEE-754 division of the two integers in
// `counters`, so two correct implementations produce the same double bit for bit. A `toBeCloseTo`
// here would hide the one class of error this file exists to catch: a denominator off by one.
//
// ⚠ IF A VALUE CANNOT BE REPRODUCED, REPORT IT — never adjust the expectation to match. The
// fixture is the definition; this module is the implementation under test.
//
// Runs from the backend workspace (@pierre/pro ships no vitest devDep):
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateUnit,
  foldRepo,
  hasBandSupport,
  medianOf,
  metricDefsFor,
  type FoldParams,
  type FoldRepoInput,
  type FoldUnit,
  type MetricOutcome,
} from '../bots/benchmark/fold.js';
import { bandForValue, walkBudgetFor } from '../bots/benchmark/place.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/metric-contract-v1.json', import.meta.url));
const ARTIFACT_PATH = fileURLToPath(
  new URL('../data/benchmark/benchmark-fit.json', import.meta.url),
);

const RAW = readFileSync(FIXTURE_PATH, 'utf8');
const FIXTURE = JSON.parse(RAW) as any;

const PARAMS: FoldParams = {
  settleHours: FIXTURE.fit.params.settle_hours as number,
  overdueGraceHours: FIXTURE.fit.params.overdue_grace_hours as number[],
};

// ── The fixture's neutral schema → the fold's input rows ────────────────────────────────────────
//
// ⚠ A TRANSLATION, NOT AN INTERPRETATION. Every line below is a rename; there is no defaulting, no
// coercion and no derived field. A helper here that "fixed up" a row would be the port re-deciding
// a definition inside the test that exists to pin the definitions.
//
// `author === 'vendor'` IS the corpus's `is_review_bot`: the fixture's `machine_other` comment
// carries `vendor: "unknown"` and `is_review_bot: false`, which is exactly the gap between "a
// machine wrote this" and "a recognised review vendor wrote this".
function toFoldInput(repo: any): FoldRepoInput {
  return {
    repo: repo.repo as string,
    walkStatus: repo.walk_status as string,
    declaredVendors: repo.panel_vendors as string[],
    pulls: (repo.pulls as any[]).map((p) => ({
      number: p.number as number,
      merged: p.merged as boolean,
      authorIsMachine: p.author_is_machine as boolean,
      detailObserved: p.detail_observed as boolean,
    })),
    threads: (repo.threads as any[]).map((t) => ({
      id: t.id as string,
      pr: t.pr as number,
      vendors: t.vendors as string[],
      path: (t.path ?? null) as string | null,
      line: (t.line ?? null) as number | null,
      resolved: t.resolved as boolean,
      outdated: t.outdated as boolean,
      tailComplete: t.tail_complete as boolean,
      humanReplied: (t.human_replied ?? null) as boolean | null,
      humanFollowedLastBot: (t.human_followed_last_bot ?? null) as boolean | null,
      ageSeconds: (t.age_seconds ?? null) as number | null,
      secondsToFirstHumanReply: (t.seconds_to_first_human_reply ?? null) as number | null,
    })),
    comments: (repo.comments as any[]).map((c) => ({
      pr: c.pr as number,
      vendor: (c.vendor ?? null) as string | null,
      isVendorComment: c.author === 'vendor',
      bodyChars: c.body_chars as number,
    })),
  };
}

/** Every unit the fold produces, over every fixture repository, in the fixture's own stable order
 *  — sorted by `(repo, vendor)`, which is `sorted(facts.units)` on the Python side. */
function foldAll(): FoldUnit[] {
  const units: FoldUnit[] = [];
  for (const repo of FIXTURE.input.repos as any[]) {
    units.push(...foldRepo(toFoldInput(repo), PARAMS));
  }
  return units.sort((a, b) =>
    a.repo === b.repo ? (a.vendor < b.vendor ? -1 : 1) : a.repo < b.repo ? -1 : 1,
  );
}

/** The unit's counters in the FIXTURE's shape and key spelling, so a mismatch prints as a diff of
 *  the two counter blocks rather than of two object shapes. */
function countersOf(unit: FoldUnit): unknown {
  return {
    volume: {
      comments_observed: unit.volume.commentsObserved,
      merged_eligible: unit.volume.mergedEligible,
      finding_comments: unit.volume.findingComments,
      empty_body_comments: unit.volume.emptyBodyComments,
      prs_with_finding: unit.volume.prsWithFinding,
      threads: unit.volume.threads,
    },
    outcome: {
      comments_observed: unit.outcome.commentsObserved,
      threads_settled: unit.outcome.threadsSettled,
      threads_settled_resolved: unit.outcome.threadsSettledResolved,
      threads_settled_outdated: unit.outcome.threadsSettledOutdated,
      threads_settled_complete: unit.outcome.threadsSettledComplete,
      threads_settled_complete_replied: unit.outcome.threadsSettledCompleteReplied,
      threads_settled_complete_followed: unit.outcome.threadsSettledCompleteFollowed,
      threads_settled_complete_acted: unit.outcome.threadsSettledCompleteActed,
      threads_settled_complete_acted_outdated: unit.outcome.threadsSettledCompleteActedOutdated,
      threads_truncated: unit.outcome.threadsTruncated,
      overdue_eligible: unit.outcome.overdueEligible,
      overdue_untouched: unit.outcome.overdueUntouched,
      reply_hours: unit.outcome.replyHours,
      anchored_threads: unit.outcome.anchoredThreads,
      anchored_overlapping: unit.outcome.anchoredOverlapping,
    },
    repository_disclosure: {
      merged_machine_authored: unit.repositoryDisclosure.mergedMachineAuthored,
      prs_detail_unobserved: unit.repositoryDisclosure.prsDetailUnobserved,
      prs_observed: unit.repositoryDisclosure.prsObserved,
    },
  };
}

function metricsOf(unit: FoldUnit): Record<string, unknown> {
  const evaluated = evaluateUnit(unit, PARAMS);
  const out: Record<string, unknown> = {};
  for (const [name, outcome] of Object.entries(evaluated)) {
    out[name] =
      outcome.status === 'value'
        ? { status: 'value', value: outcome.value, units: outcome.units }
        : { status: 'excluded', reason: outcome.reason };
  }
  return out;
}

// ── The self-digest ─────────────────────────────────────────────────────────────────────────────

/**
 * The ONE serialisation both languages digest: `json.dumps(body, sort_keys=True,
 * separators=(",",":"), ensure_ascii=False)` — ported from `contract.canonical_bytes`.
 *
 * ⚠ IT IS A LEXICAL TRANSFORM OF THE FILE, NOT A RE-SERIALISATION OF THE PARSED TREE, and that is
 * forced rather than clever. `JSON.parse` DESTROYS the int/float distinction: Python writes
 * `"min_units": 5` for an int and `"value": 1.0` for a float, both of which parse to the JavaScript
 * number `1`/`5` and re-serialise as `5` and `1`. A digest computed off the parsed tree therefore
 * CANNOT reproduce Python's bytes for any integral float — and this fixture is full of them
 * (`value: 1.0`, `value: 0.0`). Stripping whitespace outside strings reproduces the compact form
 * exactly instead, because the file was emitted with `sort_keys=True` and `ensure_ascii=False`, so
 * its keys are already sorted at every level and its number literals are already Python's own
 * `repr`.
 */
function canonicalBytes(fileText: string): Buffer {
  return Buffer.from(compactOutsideStrings(fileText), 'utf8');
}

function compactOutsideStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
    out += ch;
  }
  return out;
}

/** The self-digest of a fixture FILE, with the `sha256` member itself removed. */
function digestOfFile(fileText: string): string {
  const compact = compactOutsideStrings(fileText);
  // `sha256` sorts last among the seven top-level keys, so the member is the final one. Asserted
  // rather than assumed: a shape change here must be loud, not silently digest a different body.
  const withoutDigest = compact.replace(/,"sha256":"[0-9a-f]{64}"\}$/, '}');
  if (withoutDigest === compact) {
    throw new Error('fixture does not end with its own top-level sha256 member');
  }
  return createHash('sha256').update(canonicalBytes(withoutDigest)).digest('hex');
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('the golden fixture itself', () => {
  it('is the file both repositories publish, unedited', () => {
    // TWO GUARDS ANSWERING DIFFERENT QUESTIONS. This one is a SELF-digest over the canonically
    // serialised file minus the digest key: it catches a HAND EDIT in either language, and it is
    // the only guard that survives someone "just fixing" an expectation to make a test pass.
    expect(FIXTURE.artifact).toBe('bot_monitor.metric_contract_fixture');
    expect(FIXTURE.contract_version).toBe(1);
    expect(digestOfFile(RAW)).toBe(FIXTURE.sha256);
  });

  it('moves its digest on a one-ulp value change AND on a deleted key', () => {
    // TWO IN-TEST MUTATIONS, run on every invocation: a digest that does not move is not a guard,
    // and a guard nobody perturbs is one of the six tests this package has already shipped that
    // could not fail. Both are HAND EDITS OF THE FILE TEXT, which is exactly the attack the
    // self-digest exists to catch.
    const oneUlp = RAW.replace('"value": 0.6\n', '"value": 0.6000000000000001\n');
    expect(oneUlp).not.toBe(RAW);
    expect(digestOfFile(oneUlp)).not.toBe(FIXTURE.sha256);

    const dropped = RAW.replace(/,\n\s*"walk_status": "ok"\n/, '\n');
    expect(dropped).not.toBe(RAW);
    expect(digestOfFile(dropped)).not.toBe(FIXTURE.sha256);
  });

  it('is byte-identical to the copy packages/ml publishes, when that submodule is present', () => {
    // TWO BYTE-IDENTICAL COPIES IS A DRIFT RISK BY CONSTRUCTION — packages/ml owns the definitions
    // and regenerates from the live fitter; packages/pro CI cannot see packages/ml, so it needs its
    // own. This check fires only in a checkout that has both, which is the checkout where a
    // one-sided regeneration is possible.
    const ml = fileURLToPath(
      new URL('../../../../../packages/ml/tests/fixtures/metric-contract-v1.json', import.meta.url),
    );
    let other: string;
    try {
      other = readFileSync(ml, 'utf8');
    } catch {
      return; // the ml submodule is not checked out here; the ml-side test covers this direction
    }
    expect(other).toBe(RAW);
  });

  it('was fitted by the SAME fitter that produced the artifact being served', () => {
    // The OTHER guard, and a self-digest can never do this job: a perfectly self-consistent
    // fixture emitted against last month's fitter is exactly what a stale copy looks like.
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as any;
    expect(artifact.artifact).toBe('bot_monitor.benchmark_fit');
    expect(artifact.fit_version).toBe(FIXTURE.fit.benchmark_fit_version);
    expect(artifact.params).toEqual(FIXTURE.fit.params);
    expect(artifact.metric_specs).toEqual(FIXTURE.fit.metric_specs);
  });

  it('exercises every corpus exclusion reason and every metric-population combination', () => {
    // The BRANCH-COVERAGE guard. A fixture that lost a repository would still digest correctly
    // against its own regenerated self, so byte equality is not enough — the corpus's five
    // exclusion arms have to be OBSERVED.
    const reasons = new Set<string>();
    let valued = 0;
    for (const unit of FIXTURE.expected.units as any[]) {
      for (const metric of Object.values(unit.metrics) as any[]) {
        if (metric.status === 'excluded') reasons.add(metric.reason);
        else valued += 1;
      }
    }
    expect([...reasons].sort()).toEqual([
      'below_min_units',
      'denominator_empty',
      'repo_not_walked',
      'vendor_absent_from_population',
      'vendor_silent',
    ]);
    expect(valued).toBe(92);
    expect((FIXTURE.expected.units as any[]).length).toBe(14);
  });
});

describe('the TypeScript fold reproduces the Python fold EXACTLY', () => {
  const produced = foldAll();
  const expected = FIXTURE.expected.units as any[];

  it('produces the same (repository, vendor) units, in the same order', () => {
    expect(produced.map((u) => `${u.repo}|${u.vendor}`)).toEqual(
      expected.map((u) => `${u.repo}|${u.vendor}`),
    );
  });

  // One `it` per unit, so a failure names the repository whose decision broke rather than
  // printing a fourteen-element diff.
  for (const [index, want] of expected.entries()) {
    describe(`${want.repo} · ${want.vendor}`, () => {
      it('accumulates every counter identically', () => {
        const unit = produced[index] as FoldUnit;
        expect(countersOf(unit)).toEqual(want.counters);
      });

      it('reports the same walk status and band support', () => {
        const unit = produced[index] as FoldUnit;
        expect(unit.walkStatus).toBe(want.walk_status);
        expect(hasBandSupport(unit)).toBe(want.has_band_support);
      });

      it('yields the same thirteen values and exclusions, bit for bit', () => {
        const unit = produced[index] as FoldUnit;
        expect(metricsOf(unit)).toEqual(want.metrics);
      });
    });
  }

  it('names exactly the thirteen metrics the fitter specifies', () => {
    const ours = metricDefsFor(PARAMS)
      .map((d) => d.name)
      .sort();
    expect(ours).toEqual(Object.keys(FIXTURE.fit.metric_specs).sort());
  });

  it('reads min_units and the population from the fitter, not from a local guess', () => {
    for (const def of metricDefsFor(PARAMS)) {
      const spec = (FIXTURE.fit.metric_specs as any)[def.name];
      expect(spec, def.name).toBeDefined();
      expect(def.minUnits, def.name).toBe(spec.min_units);
      expect(def.population, def.name).toBe(spec.population);
    }
  });
});

describe('the definitions a port is most likely to get wrong', () => {
  const produced = foldAll();
  const unit = (repo: string, vendor: string): FoldUnit => {
    const found = produced.find((u) => u.repo === repo && u.vendor === vendor);
    if (found == null) throw new Error(`no unit for ${repo}/${vendor}`);
    return found;
  };

  it("divides thread_resolved_rate by ALL settled threads, truncated ones INCLUDED", () => {
    // acme/typical carries one truncated settled thread. The complete-only denominator is 5 and
    // the all-settled one is 6 — a port that copied `*_complete` across the family gets 0.6 here
    // too and only diverges on repositories with long threads.
    const u = unit('acme/typical', 'coderabbit');
    expect(u.outcome.threadsTruncated).toBe(1);
    expect(u.outcome.threadsSettledComplete).toBeLessThan(u.outcome.threadsSettled);
    const m = evaluateUnit(u, PARAMS)['thread_resolved_rate'] as MetricOutcome;
    expect(m.status).toBe('value');
    if (m.status !== 'value') throw new Error('unreachable');
    expect(m.units).toBe(u.outcome.threadsSettled);
    expect(m.value).toBe(u.outcome.threadsSettledResolved / u.outcome.threadsSettled);
  });

  it('keeps the overdue family OFF the settle chain and inclusive at the boundary', () => {
    // acme/overdue-edges pins 72 h and 168 h exactly, plus the one-second-under twins.
    const u = unit('acme/overdue-edges', 'qodo');
    const want = (FIXTURE.expected.units as any[]).find(
      (x) => x.repo === 'acme/overdue-edges' && x.vendor === 'qodo',
    );
    expect(u.outcome.overdueEligible).toEqual(want.counters.outcome.overdue_eligible);
    expect(u.outcome.overdueUntouched).toEqual(want.counters.outcome.overdue_untouched);
    // The 72 h window must admit strictly more threads than the 168 h one on this repository —
    // if a port chained the grace through `settleHours` (also 72) the two would collapse.
    expect(u.outcome.overdueEligible['72']).toBeGreaterThan(
      u.outcome.overdueEligible['168'] as number,
    );
  });

  it('takes the MEAN of the two middle values on an even reply sample', () => {
    const u = unit('acme/even-replies', 'devin');
    expect(u.outcome.replyHours.length % 2).toBe(0);
    const hours = u.outcome.replyHours;
    const lowerMedian = hours[hours.length / 2 - 1] as number;
    const trueMedian = medianOf(hours);
    // The convention actually disagrees on this sample — otherwise the assertion is vacuous.
    expect(trueMedian).not.toBe(lowerMedian);
    const m = evaluateUnit(u, PARAMS)['median_hours_to_first_human_reply'] as MetricOutcome;
    if (m.status !== 'value') throw new Error('expected a fitted median');
    expect(m.value).toBe(trueMedian);
  });

  it('excludes an anchorless thread from BOTH halves of the overlap rate', () => {
    const u = unit('acme/two-bots', 'coderabbit');
    const threads = (FIXTURE.input.repos as any[]).find((r) => r.repo === 'acme/two-bots').threads;
    const anchorless = (threads as any[]).filter(
      (t) => t.line == null && t.vendors.includes('coderabbit'),
    );
    expect(anchorless.length).toBeGreaterThan(0);
    // Anchored threads are strictly fewer than settled ones: the anchorless one left both halves
    // rather than landing in the denominator as "did not overlap".
    expect(u.outcome.anchoredThreads).toBeLessThan(u.outcome.threadsSettled);
    expect(u.outcome.anchoredOverlapping).toBeGreaterThan(0);
  });

  it('separates the FOUR ways a rate can be undefined from a real 0.0', () => {
    const silent = evaluateUnit(unit('acme/silent', 'coderabbit'), PARAMS);
    const unmerged = evaluateUnit(unit('acme/unmerged-only', 'coderabbit'), PARAMS);
    const summariser = evaluateUnit(unit('acme/summariser', 'copilot'), PARAMS);
    const thin = evaluateUnit(unit('acme/thin', 'greptile'), PARAMS);
    const approver = evaluateUnit(unit('acme/silent-approver', 'sourcery'), PARAMS);

    expect(silent['pr_comment_coverage']).toEqual({
      status: 'excluded',
      reason: 'vendor_silent',
    });
    expect(unmerged['pr_comment_coverage']).toEqual({
      status: 'excluded',
      reason: 'vendor_absent_from_population',
    });
    expect(summariser['acted_on_rate']).toEqual({
      status: 'excluded',
      reason: 'denominator_empty',
    });
    expect(thin['acted_on_rate']).toEqual({ status: 'excluded', reason: 'below_min_units' });
    // …and the ONE real zero, which is a VALUE with full weight, not any of the four above. Its
    // denominator is read off the fixture, never guessed here — a hard-coded number in the test
    // would be a second statement of the expectation, drifting from the one the fixture publishes.
    const wantApprover = (FIXTURE.expected.units as any[]).find(
      (u) => u.repo === 'acme/silent-approver' && u.vendor === 'sourcery',
    );
    expect(approver['pr_comment_coverage']).toEqual(wantApprover.metrics.pr_comment_coverage);
    expect(approver['pr_comment_coverage']).toEqual({
      status: 'value',
      value: 0,
      units: wantApprover.counters.volume.merged_eligible,
    });
    expect(approver['findings_per_merged_pr']).toEqual({
      status: 'value',
      value: 0,
      units: wantApprover.counters.volume.merged_eligible,
    });
    // The vendor IS live here — every one of its comments is an empty-body review. That is what
    // separates this zero from the four undefined ones above.
    expect(wantApprover.counters.volume.comments_observed).toBeGreaterThan(0);
    expect(wantApprover.counters.volume.empty_body_comments).toBeGreaterThan(0);
    expect(wantApprover.counters.volume.finding_comments).toBe(0);
  });

  it('fits the median at 3 on the very repository the other ten refuse at 5', () => {
    const evaluated = evaluateUnit(unit('acme/thin', 'greptile'), PARAMS);
    expect(evaluated['median_hours_to_first_human_reply']?.status).toBe('value');
    expect(evaluated['acted_on_rate']).toEqual({ status: 'excluded', reason: 'below_min_units' });
  });

  it('lets repo_not_walked beat vendor_silent even with non-zero counters', () => {
    const evaluated = evaluateUnit(unit('acme/gone', 'coderabbit'), PARAMS);
    for (const outcome of Object.values(evaluated)) {
      expect(outcome).toEqual({ status: 'excluded', reason: 'repo_not_walked' });
    }
  });

  it('reads the LIVE GATE off comments, never off the thread counters', () => {
    // acme/threads-without-comments names the vendor on six threads and in no comment row: every
    // thread counter is non-zero and every metric is still vendor_silent. Reading the gate off
    // the thread counters would fit a distribution nobody observed.
    const u = unit('acme/threads-without-comments', 'coderabbit');
    expect(u.outcome.threadsSettled).toBeGreaterThan(0);
    expect(u.outcome.commentsObserved).toBe(0);
    const evaluated = evaluateUnit(u, PARAMS);
    for (const outcome of Object.values(evaluated)) {
      expect(outcome).toEqual({ status: 'excluded', reason: 'vendor_silent' });
    }
  });
});

describe('the customer-side-only arm the corpus cannot have', () => {
  // `body_unobserved`: host `reviewComments.body` / `prComments.body` / `reviews.body` are
  // NULLABLE (legacy rows from the 2026-06 lean window). A null body is UNKNOWN, not empty, so
  // the two body-reading volume metrics refuse rather than counting the row as either.
  const base = (FIXTURE.input.repos as any[]).find((r) => r.repo === 'acme/typical');

  it('refuses the two body-reading volume metrics and NOTHING else', () => {
    const input = toFoldInput(base);
    const withUnknown: FoldRepoInput = {
      ...input,
      comments: input.comments.map((c, i) => (i === 0 ? { ...c, bodyChars: null } : c)),
    };
    const [unit] = foldRepo(withUnknown, PARAMS);
    if (unit == null) throw new Error('expected a unit');
    expect(unit.volumeBodyUnobserved).toBe(true);
    const evaluated = evaluateUnit(unit, PARAMS);
    expect(evaluated['findings_per_merged_pr']).toEqual({
      status: 'excluded',
      reason: 'body_unobserved',
    });
    expect(evaluated['pr_comment_coverage']).toEqual({
      status: 'excluded',
      reason: 'body_unobserved',
    });
    // threads_per_merged_pr reads no body, so it is untouched — an unknown body must not take
    // down a metric it cannot affect.
    expect(evaluated['threads_per_merged_pr']?.status).toBe('value');
    expect(evaluated['acted_on_rate']?.status).toBe('value');
  });

  it('still counts an unknown body as PROOF THE VENDOR RAN', () => {
    const input = toFoldInput(base);
    const withUnknown: FoldRepoInput = {
      ...input,
      comments: input.comments.map((c) =>
        c.isVendorComment ? { ...c, bodyChars: null } : c,
      ),
    };
    const [unit] = foldRepo(withUnknown, PARAMS);
    if (unit == null) throw new Error('expected a unit');
    // Every body unknown, yet the vendor is NOT silent: the gate counts comments, not findings.
    expect(unit.outcome.commentsObserved).toBeGreaterThan(0);
    expect(unit.volume.findingComments).toBe(0);
    expect(unit.volume.emptyBodyComments).toBe(0);
    expect(evaluateUnit(unit, PARAMS)['acted_on_rate']?.status).toBe('value');
  });
});

describe('band placement', () => {
  const vendors = FIXTURE.band_placement.vendors as Record<string, any>;

  it('places every generated case exactly as the fitter does', () => {
    let cases = 0;
    for (const [vendor, block] of Object.entries(vendors)) {
      const highs = block.band_high_edges as number[];
      for (const c of block.cases as any[]) {
        expect(bandForValue(c.panel_prs_per_period as number, highs), `${vendor}@${c.panel_prs_per_period}`).toBe(
          c.activity_band as number,
        );
        cases += 1;
      }
    }
    expect(cases).toBe(122);
  });

  it('covers every published band of every vendor', () => {
    // A case table that never probes band 7 would pass while band 7 was unreachable.
    for (const [vendor, block] of Object.entries(vendors)) {
      const seen = new Set((block.cases as any[]).map((c) => c.activity_band as number));
      const all = Array.from({ length: block.n_bands as number }, (_, i) => i);
      expect([...seen].sort((a, b) => a - b), vendor).toEqual(all);
    }
  });

  it('reads the HIGH edges only — the low-edge reading disagrees at exactly 2 and 3', () => {
    // The ranges OVERLAP at ties because the cut is by rank over small integers: coderabbit's
    // band 0 is 2..2 and band 1 is 2..3, so "the band whose interval contains the value" is not a
    // function. An in-test mutation, run on every invocation, so the choice cannot be quietly
    // reversed: the alternative reading (the LAST band whose LOW edge is <= the value) is
    // implemented here and asserted to DISAGREE at the two most common activity values in the
    // corpus, and to AGREE away from the ties.
    const lowEdgeReading = (value: number, lows: readonly number[]): number => {
      let band = 0;
      for (let i = 0; i < lows.length; i += 1) if ((lows[i] as number) <= value) band = i;
      return band;
    };
    const cr = vendors['coderabbit'];
    const highs = cr.band_high_edges as number[];
    const lows = cr.band_low_edges_not_read as number[];
    expect(bandForValue(2, highs)).toBe(0);
    expect(lowEdgeReading(2, lows)).toBe(1);
    expect(bandForValue(3, highs)).toBe(1);
    expect(lowEdgeReading(3, lows)).toBe(2);
    // Away from the ties the two agree, which is why only the tie case decides the rule.
    expect(bandForValue(20, highs)).toBe(lowEdgeReading(20, lows));
  });

  it('clamps below and above the range with no special case, and neither is a refusal', () => {
    const highs = (vendors['devin'] as any).band_high_edges as number[];
    expect(bandForValue(0, highs)).toBe(0);
    expect(bandForValue(1, highs)).toBe(0);
    expect(bandForValue(100_000, highs)).toBe(highs.length - 1);
  });

  it('refuses to place a vendor with no bands rather than inventing band 0', () => {
    expect(() => bandForValue(5, [])).toThrow();
  });

  it("requires the artifact's published edges to be monotone — the rule's precondition", () => {
    for (const [vendor, block] of Object.entries(vendors)) {
      const highs = block.band_high_edges as number[];
      const lows = block.band_low_edges_not_read as number[];
      for (let i = 1; i < highs.length; i += 1) {
        expect((highs[i] as number) >= (highs[i - 1] as number), `${vendor} highs`).toBe(true);
        expect((lows[i] as number) >= (lows[i - 1] as number), `${vendor} lows`).toBe(true);
      }
    }
  });

  it('reproduces the walk budget the corpus enforced', () => {
    // min(150, round(prs_per_period * 90 / 14)) — MEASURED against all 2,204 corpus repo rows.
    expect(FIXTURE.band_placement.walk_budget_rule).toContain('min(150');
    expect(walkBudgetFor(0)).toBe(0);
    expect(walkBudgetFor(2)).toBe(13);
    expect(walkBudgetFor(9)).toBe(58);
    expect(walkBudgetFor(23)).toBe(148);
    expect(walkBudgetFor(24)).toBe(150);
    expect(walkBudgetFor(258)).toBe(150);
  });
});
