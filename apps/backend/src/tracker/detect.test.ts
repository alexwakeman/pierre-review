// Ticket-key detection precision tests (Pro issue-links). Like isolation.test.ts this file is
// NOT in the plugin's `typecheck` include (src only) and the package ships no test script; run it
// from a workspace that has vitest, e.g.:
//   pnpm --filter @pierre-review/backend exec vitest run ../../packages/pro/test/extract.test.ts
// extractTicketKeys / parseProjectKeys are pure (no DB, type-only shared import), so no native deps.
import { describe, expect, it } from 'vitest';
import { extractTicketKeys, parseProjectKeys } from './detect.js';

describe('extractTicketKeys — no allowlist (heuristic fallback)', () => {
  it('detects an uppercase key written in the PR title', () => {
    expect(extractTicketKeys('Fix ENG-123 auth race', null)).toEqual(['ENG-123']);
    expect(extractTicketKeys('PROJ-42: refactor store', null)).toEqual(['PROJ-42']);
  });

  it('ignores lowercase keys in prose (real keys are written uppercase)', () => {
    expect(extractTicketKeys('fixes eng-123 flakiness', null)).toEqual([]);
  });

  it('drops well-known non-ticket PREFIX-NUMBER tokens (denylist)', () => {
    for (const t of ['GPT-4 support', 'Upgrade to HTTP-2', 'COVID-19 dashboard', 'Q3-2024 planning', 'RTX-4090 bench', 'SHA-256 hashing']) {
      expect(extractTicketKeys(t, null)).toEqual([]);
    }
  });

  it('rejects keys embedded in a longer version/date/alnum run (boundary hardening)', () => {
    for (const t of ['Bump v1-2-3', 'Edge abc-12.3 case', 'Try GPT-4o', 'Range p95-99', 'Ship 2024-01-15 build']) {
      expect(extractTicketKeys(t, null)).toEqual([]);
    }
  });

  it('boundary lookahead rejects a real-key-shaped prefix with a decimal / version run', () => {
    // Uppercase, non-denylisted, letter-led — so ONLY the `.\d` / `-\d` lookahead can reject these.
    expect(extractTicketKeys('Ship ENG-12.3 patch', null)).toEqual([]);
    expect(extractTicketKeys('Build ENG-1-2-3 thing', null)).toEqual([]);
  });

  it('drops V<n> version tags in the title (V2-0, V1-2)', () => {
    expect(extractTicketKeys('Release V2-0 now', null)).toEqual([]);
    expect(extractTicketKeys('Upgrade V1-2 client', null)).toEqual([]);
  });

  it('does NOT scan the branch without an allowlist (branch keys are ambiguous)', () => {
    expect(extractTicketKeys(null, 'alex/eng-123-fix')).toEqual([]);
    expect(extractTicketKeys('Upgrade deps', 'chore/node-18')).toEqual([]);
    expect(extractTicketKeys('Release', 'release/v2-0')).toEqual([]);
  });

  it('de-duplicates and preserves first-seen order', () => {
    expect(extractTicketKeys('ENG-1 relates to ENG-1 and ABC-9', null)).toEqual(['ENG-1', 'ABC-9']);
  });
});

describe('extractTicketKeys — with a project-key allowlist (exact)', () => {
  it('detects listed keys in BOTH title and branch', () => {
    expect(extractTicketKeys('Fix ENG-123', 'alex/eng-123-fix', ['ENG'])).toEqual(['ENG-123']);
    expect(extractTicketKeys('Some title', 'alex/eng-42-thing', ['ENG'])).toEqual(['ENG-42']);
  });

  it('resolves dash-joined prefix branches + digit/underscore slug continuations', () => {
    expect(extractTicketKeys('t', 'alex/fix-ENG-123', ['ENG'])).toEqual(['ENG-123']);
    expect(extractTicketKeys('t', 'bugfix-ABC-42', ['ABC'])).toEqual(['ABC-42']);
    expect(extractTicketKeys('t', 'alex/eng-123-2fa-fix', ['ENG'])).toEqual(['ENG-123']);
    expect(extractTicketKeys('t', 'eng-123_fix', ['ENG'])).toEqual(['ENG-123']);
  });

  it('emits ONLY allowlisted prefixes — GPT-4 / node-18 stay out', () => {
    expect(extractTicketKeys('GPT-4 and PROJ-9', 'chore/node-18', ['PROJ'])).toEqual(['PROJ-9']);
  });

  it('is case-insensitive once a prefix is allowlisted', () => {
    expect(extractTicketKeys('fix proj-5 now', null, ['PROJ'])).toEqual(['PROJ-5']);
    expect(extractTicketKeys(null, 'feature/ENG-7', ['eng'])).toEqual(['ENG-7']);
  });

  it('an empty allowlist behaves like no allowlist (heuristics)', () => {
    expect(extractTicketKeys('Fix ENG-1', 'alex/eng-2-x', [])).toEqual(['ENG-1']);
  });
});

// ── THE PER-WORKSPACE MATCH SCOPE: title only vs title + branch ──────────────────────────────
//
// ⚠ FIRST, THE FACT THE FEATURE REQUEST TURNED ON: NOTHING HAS EVER SCANNED COMMIT MESSAGES.
// Detection reads the PR TITLE and the HEAD BRANCH NAME, and those are the only two sources in
// this module. The two tests below pin that by construction — every key that comes out is
// traceable to one of the two arguments, and there is no third argument to carry a commit.
//
// ⚠ SECOND: `'title'` CAN ONLY EVER REMOVE A SOURCE. It never widens detection and it never
// changes what the title yields, so a workspace that sets it cannot start matching something new.
//
// ⚠ THIRD, THE ONE THAT SURPRISES: THE SCOPE IS INERT WITHOUT AN ALLOWLIST. The branch is only
// scanned in allowlist mode to begin with (a lowercase `eng-123` is indistinguishable from
// `node-18` / `release-2`), so with no configured project keys both scopes give the same answer.
// A UI that offers the choice while the keys field is empty is offering a control that does
// nothing — worth saying on screen.
describe('extractTicketKeys — the match scope', () => {
  it('defaults to title + branch, which is the behaviour that already shipped', () => {
    // The default must be reachable BY OMISSION, because every pre-existing caller omits it and a
    // stored NULL `issue_match_scope` resolves to it.
    expect(extractTicketKeys('Some title', 'alex/eng-42-thing', ['ENG'])).toEqual(['ENG-42']);
    expect(
      extractTicketKeys('Some title', 'alex/eng-42-thing', ['ENG'], 'title_branch'),
    ).toEqual(['ENG-42']);
  });

  it("'title' drops the branch key and keeps the title key", () => {
    expect(extractTicketKeys('Some title', 'alex/eng-42-thing', ['ENG'], 'title')).toEqual([]);
    expect(extractTicketKeys('Fix ENG-123', 'alex/eng-42-thing', ['ENG'], 'title')).toEqual([
      'ENG-123',
    ]);
    // The title half is untouched: allowlist mode still accepts a lowercase key written in prose.
    expect(extractTicketKeys('fix proj-5 now', 'chore/proj-9', ['PROJ'], 'title')).toEqual([
      'PROJ-5',
    ]);
  });

  it('⚠ is INERT with no allowlist — both scopes answer identically', () => {
    for (const scope of ['title', 'title_branch'] as const) {
      expect(extractTicketKeys('Fix ENG-1', 'alex/eng-2-x', null, scope)).toEqual(['ENG-1']);
      expect(extractTicketKeys('nothing here', 'alex/eng-2-x', [], scope)).toEqual([]);
    }
  });

  it('never invents a key from a source that does not exist', () => {
    // Both arguments null: no title, no branch, therefore no keys — the shape a caller that
    // thinks commit messages are scanned would expect to still produce something.
    expect(extractTicketKeys(null, null, ['ENG'])).toEqual([]);
    expect(extractTicketKeys(null, null, ['ENG'], 'title')).toEqual([]);
  });
});

describe('parseProjectKeys', () => {
  it('uppercases, dedupes, and keeps only well-shaped prefixes', () => {
    expect(parseProjectKeys('eng, proj')).toEqual(['ENG', 'PROJ']);
    expect(parseProjectKeys('ENG, eng , Eng')).toEqual(['ENG']);
    // a-b (dash), 1abc (leading digit), toolongprefixhere (>10), X (single char) all rejected.
    expect(parseProjectKeys('a-b, 1abc, toolongprefixhere, OK, ENG, X')).toEqual(['OK', 'ENG']);
  });

  it('returns [] for null / blank', () => {
    expect(parseProjectKeys(null)).toEqual([]);
    expect(parseProjectKeys('   ')).toEqual([]);
    expect(parseProjectKeys(undefined)).toEqual([]);
  });

  it('accepts space- or comma-separated input', () => {
    expect(parseProjectKeys('ENG PROJ  ABC')).toEqual(['ENG', 'PROJ', 'ABC']);
  });
});
