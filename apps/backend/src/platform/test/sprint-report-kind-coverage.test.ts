// Every InsightKind must be NAMED in the sprint report's card loop.
//
// WHY THIS IS A SOURCE SCAN AND NOT AN ASSERTION ABOUT BEHAVIOUR. `buildSprintPayload`'s loop
// (src/insights/sprint-report.ts) does its `bump(c.repoFullName)` / `agg.cards += 1` /
// `agg.loc += additions + deletions` / `addRef(c)` work BEFORE its if/else chain, so a kind that
// matches no branch is not dropped — it is counted into that repo's `importance` (cards × 3 +
// LOC/50) and added to the linkable PR table while contributing zero action items. The report
// silently re-orders itself around work it never lists.
//
// Nothing else can catch that. Every card kind that carries a PR extends `InsightPrRef`, so every
// field the fall-through reads EXISTS on the new kind: no compile error, no failing assertion,
// no runtime throw. And the two halves live in TWO REPOSITORIES — `InsightKind` is declared in
// the host's `packages/shared`, this loop is in the private plugin submodule — so a host-side
// union member can ship on its own and this file is the only thing standing between it and a
// quietly wrong report. `conflicts` (the merge-conflict Pending card) is the kind that proved it.
//
// The scan is deliberately dumb: pull the union's members out of the host's types file, pull the
// `c.kind === '<x>'` literals out of the loop's own body, and diff the two sets.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/sprint-report-kind-coverage.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SHARED_TYPES = fileURLToPath(new URL('../../../../../packages/shared/src/types.ts', import.meta.url));
const SPRINT_REPORT = fileURLToPath(new URL('../insights/sprint-report.ts', import.meta.url));

/**
 * The ONE kind that reaches the fall-through today, recorded rather than blessed.
 *
 * `my_turn` is PR-bearing, so `bump`/`addRef` read real values off it and the report counts it as
 * repository activity without listing an action item of its own — the behaviour this loop has
 * always had. This list exists so the test can still fail on a NEW arrival; it is not a licence to
 * add a second entry instead of a `continue`. Anything added here needs the argument written down
 * beside it.
 */
const KNOWN_FALL_THROUGH: readonly string[] = ['my_turn'];

/** The `InsightKind` union's members, straight out of the host's declaration. */
function insightKinds(): string[] {
  const src = readFileSync(SHARED_TYPES, 'utf8');
  const start = src.indexOf('export type InsightKind =');
  expect(start, 'InsightKind was renamed or moved in packages/shared/src/types.ts').toBeGreaterThan(
    -1,
  );
  // ⚠ STRIP THE PROSE BEFORE LOOKING FOR THE TERMINATOR. The union is heavily commented, and one
  // of those comments contains a semicolon ("Every kind above is something that is WRONG; these
  // two are…"). Slicing at the first raw `;` stopped the scan mid-union at SEVEN of eleven
  // members — `merge`, `update_branch`, `bot_signal` and `bot_only_review` were never seen, and
  // neither would a NEW member appended to the end, which is the only case this test exists for.
  // The `> 5` floor below passed at 7, so the blindness was invisible. It was caught by appending
  // a fake kind and watching this file stay green.
  const commentless = src
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const semi = commentless.indexOf(';');
  expect(semi, 'the InsightKind union has no terminating semicolon').toBeGreaterThan(-1);
  const block = commentless.slice(0, semi);
  const kinds = [...block.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1] as string);
  // ⚠ THE FLOOR IS THE REAL COUNT, NOT A TOKEN ONE. A `> 5` floor is satisfied by a parse that
  // silently truncates, which is exactly how this test shipped blind. Eleven is what the union
  // holds today; a member REMOVED should fail here and be re-counted deliberately.
  expect(
    kinds.length,
    `parsed ${kinds.length} members out of the InsightKind union: ${kinds.join(', ')}. ` +
      'If a kind was deliberately removed, lower this floor in the same commit; if the parse is ' +
      'truncating again, a comment inside the union probably reintroduced a stray terminator.',
  ).toBeGreaterThanOrEqual(11);
  return kinds;
}

/** Every kind literal tested inside `for (const c of cards) { … }` in the sprint report. */
function kindsNamedInLoop(): Set<string> {
  const src = readFileSync(SPRINT_REPORT, 'utf8');
  const start = src.indexOf('for (const c of cards) {');
  expect(start, 'the sprint report card loop was renamed or restructured').toBeGreaterThan(-1);
  // The loop closes on the first `}` at TWO-space indent — every block inside it is indented
  // four or more.
  const end = src.indexOf('\n  }\n', start);
  expect(end, 'could not find the end of the card loop').toBeGreaterThan(start);
  const body = src.slice(start, end);
  return new Set([...body.matchAll(/c\.kind === '([a-z_]+)'/g)].map((m) => m[1] as string));
}

describe("the sprint report's card loop", () => {
  it('names every InsightKind, so a new one cannot fall through into repo importance', () => {
    const named = kindsNamedInLoop();
    const missing = insightKinds().filter(
      (k) => !named.has(k) && !KNOWN_FALL_THROUGH.includes(k),
    );
    // The message is the whole point of the test: it tells the next person what to write.
    expect(
      missing,
      `InsightKind(s) ${missing.join(', ')} are not named in buildSprintPayload's card loop. ` +
        'An unnamed PR-bearing kind still bumps repo importance and adds a PR ref while ' +
        "contributing no action item. Add an explicit `if (c.kind === '…') continue;` beside the " +
        'existing ones, with the reason, or give it a branch that emits an issue.',
    ).toEqual([]);
  });

  it('skips conflicts explicitly — the kind that would have been swallowed silently', () => {
    // Pinned by name because `ConflictsCard extends InsightPrRef`: every field below the loop's
    // guards exists on it, so removing this `continue` type-checks and breaks nothing loudly.
    expect(kindsNamedInLoop().has('conflicts')).toBe(true);
  });

  it('still skips the two forward kinds and ci_failing', () => {
    const named = kindsNamedInLoop();
    for (const kind of ['merge', 'update_branch', 'ci_failing']) {
      expect(named.has(kind), `${kind} lost its explicit branch`).toBe(true);
    }
  });

  it('skips EVERY my_turn card — the report is for a team, not the reader', () => {
    // My Turn is one person's board (whoever set the digest up); the sprint report posts to a
    // team channel, so no my_turn card — promoted or not — may bump repo importance or add a PR ref.
    // The skip sits BEFORE the fall-through that bumps repo importance.
    const src = readFileSync(SPRINT_REPORT, 'utf8');
    const start = src.indexOf('for (const c of cards) {');
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    expect(body).toContain("if (c.kind === 'my_turn') continue;");
    expect(body).not.toContain('MY_TURN_OWN_WORK_REASONS');
    expect(body.indexOf("if (c.kind === 'my_turn') continue;")).toBeLessThan(
      body.indexOf('const agg = bump('),
    );
  });
});
