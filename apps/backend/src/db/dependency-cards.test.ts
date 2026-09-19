// The Dependencies tab's PURE helpers (db/dependency-cards.ts, db/pending-classify.ts) — no DB, which
// is exactly why both modules keep away from `db/client` and `db/triage` (spec D15/D16).
//
// WHAT THIS PINS:
//   1. `dependencyPrState` is FIRST MATCH WINS in one written order, and a row we have not
//      observed is `unknown` — never `ready`. Each case below pairs two true signals, so a
//      reordered chain fails.
//   2. `authorAutomationFor`: a tool's MARKER makes a person's PR automation (source 'marker') and
//      wins the ROLE even over an automated author with another role; an unknown automation that
//      opens a PR is a `code_agent`, NOT the Reports lanes' `quality_gate`; a derived 'review' role
//      is no evidence.
//   3. The proximity base per state, the id union, and the security sentences.
import { describe, expect, it } from 'vitest';
import type { AutomatedReviewerKind, ReviewerRole } from '@pierre-review/shared';
import {
  authorAutomationFor,
  dependencyPrState,
  dependencyProximityBase,
  dependencyStateDetail,
  securityFixDetail,
  unionAdvisoryIds,
  type AuthorAutomationInputs,
} from './dependency-cards.js';
import { isConflicting, isRedCiStatus } from './pending-classify.js';

const state = (p: Partial<Parameters<typeof dependencyPrState>[0]>) =>
  dependencyPrState({
    mergeStateStatus: null,
    mergeable: null,
    ciStatus: null,
    reviewDecision: null,
    readyToMerge: false,
    ...p,
  });

describe('dependencyPrState — first match wins', () => {
  it('conflicts beat a red build', () => {
    expect(state({ mergeStateStatus: 'dirty', ciStatus: 'failure' })).toBe('conflicts');
    // …and `mergeable: 'conflicting'` alone is a conflict too.
    expect(state({ mergeStateStatus: 'clean', mergeable: 'conflicting', readyToMerge: true })).toBe(
      'conflicts',
    );
  });
  it('a red build beats behind', () => {
    expect(state({ ciStatus: 'error', mergeStateStatus: 'behind' })).toBe('ci_red');
  });
  it('⚠ a red build GitHub would still merge is ready — `unstable` is mergeable', () => {
    expect(state({ ciStatus: 'failure', mergeStateStatus: 'unstable', readyToMerge: true })).toBe(
      'ready',
    );
    // The same build on a PR GitHub will not merge is the next step.
    expect(state({ ciStatus: 'failure', mergeStateStatus: 'blocked' })).toBe('ci_red');
  });
  it('behind beats review required', () => {
    expect(state({ mergeStateStatus: 'behind', reviewDecision: 'review_required' })).toBe('behind');
  });
  it('ready beats review required (GitHub will take it)', () => {
    expect(
      state({ mergeStateStatus: 'clean', readyToMerge: true, reviewDecision: 'review_required' }),
    ).toBe('ready');
  });
  it('review required beats blocked', () => {
    expect(state({ mergeStateStatus: 'blocked', reviewDecision: 'review_required' })).toBe(
      'needs_review',
    );
    expect(state({ mergeStateStatus: 'blocked', reviewDecision: 'changes_requested' })).toBe(
      'needs_review',
    );
  });
  it('approved but blocked is blocked', () => {
    expect(state({ mergeStateStatus: 'blocked', reviewDecision: 'approved' })).toBe('blocked');
  });
  it('⚠ nothing observed is unknown, never ready', () => {
    expect(state({})).toBe('unknown');
    // `pending` CI is not red, and an unknown merge state is not ready.
    expect(state({ ciStatus: 'pending', mergeStateStatus: 'unknown' })).toBe('unknown');
  });
});

describe('dependencyStateDetail', () => {
  const p = { baseRefName: 'main', mergeStateStatus: null, reviewDecision: null } as const;
  it('names the branch a conflict is with, or says the base branch', () => {
    expect(dependencyStateDetail('conflicts', p, 'x')).toBe('Conflicts with main');
    expect(dependencyStateDetail('conflicts', { ...p, baseRefName: null }, 'x')).toBe(
      'Conflicts with the base branch',
    );
  });
  it('reads the ready sentence from the caller (the merge card’s builder)', () => {
    expect(dependencyStateDetail('ready', p, 'Nothing is blocking this — it can land now')).toBe(
      'Nothing is blocking this — it can land now',
    );
  });
  it('says which review is missing', () => {
    expect(dependencyStateDetail('needs_review', p, 'x')).toBe('Needs an approving review');
    expect(
      dependencyStateDetail('needs_review', { ...p, reviewDecision: 'changes_requested' }, 'x'),
    ).toBe('Changes were requested');
  });
  it('says the rest plainly', () => {
    expect(dependencyStateDetail('ci_red', p, 'x')).toBe('CI is failing');
    expect(dependencyStateDetail('behind', p, 'x')).toBe(
      'GitHub blocks the merge until the branch is updated',
    );
    expect(dependencyStateDetail('blocked', p, 'x')).toBe('Required checks or reviews aren’t satisfied');
    expect(dependencyStateDetail('unknown', p, 'x')).toBe(
      'GitHub has not worked out if it can merge this yet',
    );
  });
});

const PERSON = 1;
const DEPENDABOT = 2;
const GH_ACTIONS = 3;
const MYSTERY = 4;
const CODERABBIT = 5;
const DERIVED_REVIEW_CI = 6;
const DEPLOYER = 7;

function inputs(over: Partial<AuthorAutomationInputs> = {}): AuthorAutomationInputs {
  return {
    automatedIds: new Set([DEPENDABOT, GH_ACTIONS, MYSTERY, CODERABBIT, DERIVED_REVIEW_CI, DEPLOYER]),
    kindOf: new Map<number, AutomatedReviewerKind>([
      [DEPENDABOT, 'dependabot'],
      [GH_ACTIONS, 'github_actions'],
      [MYSTERY, 'in_house'],
      [CODERABBIT, 'coderabbit'],
      [DERIVED_REVIEW_CI, 'in_house'],
      [DEPLOYER, 'in_house'],
    ]),
    manualRoleOf: new Map<number, ReviewerRole>(),
    storedRoleOf: new Map<number, ReviewerRole>([
      [GH_ACTIONS, 'quality_check'],
      [DERIVED_REVIEW_CI, 'review'],
      [DEPLOYER, 'release'],
    ]),
    loginOf: new Map([
      [PERSON, 'alice-dev'],
      [DEPENDABOT, 'dependabot[bot]'],
      [GH_ACTIONS, 'github-actions[bot]'],
      [MYSTERY, 'acme-release-agent'],
      [CODERABBIT, 'coderabbitai[bot]'],
      [DERIVED_REVIEW_CI, 'acme-ci-runner'],
      [DEPLOYER, 'acme-deployer'],
    ]),
    ...over,
  };
}

describe('authorAutomationFor', () => {
  it('a person with no marker is a person', () => {
    expect(authorAutomationFor(PERSON, null, inputs())).toBeNull();
    // …and so is a deleted account.
    expect(authorAutomationFor(null, null, inputs())).toBeNull();
  });
  it('⚠ a tool’s marker on a person’s PR makes it that tool’s, via the person', () => {
    expect(authorAutomationFor(PERSON, 'snyk', inputs())).toEqual({
      role: 'dependency',
      kind: 'snyk',
      source: 'marker',
    });
  });
  it('⚠ the marker wins the ROLE over an automated author with another role', () => {
    // Frogbot / Socket Fix open PRs as github-actions, which is a quality check by login.
    expect(authorAutomationFor(GH_ACTIONS, 'frogbot', inputs())).toEqual({
      role: 'dependency',
      kind: 'frogbot',
      source: 'account',
    });
  });
  it('a dependency bot is a dependency bot by its login', () => {
    expect(authorAutomationFor(DEPENDABOT, null, inputs())).toEqual({
      role: 'dependency',
      kind: 'dependabot',
      source: 'account',
    });
  });
  it('an AI reviewer is a review bot by its login', () => {
    expect(authorAutomationFor(CODERABBIT, null, inputs())?.role).toBe('review');
  });
  it('a positively concluded stored role wins over the fallback', () => {
    // No vocabulary claims `acme-deployer`; only its stored row does.
    expect(authorAutomationFor(DEPLOYER, null, inputs())?.role).toBe('release');
  });
  it('⚠ an unknown automation that OPENS a PR is a coding agent, not a CI bot', () => {
    expect(authorAutomationFor(MYSTERY, null, inputs())).toEqual({
      role: 'code_agent',
      kind: 'in_house',
      source: 'account',
    });
  });
  it('⚠ a DERIVED "review" role is the default an unknown login gets — no evidence', () => {
    expect(authorAutomationFor(DERIVED_REVIEW_CI, null, inputs())?.role).toBe('code_agent');
  });
  it('a role a PERSON chose beats every login vocabulary', () => {
    const x = inputs({ manualRoleOf: new Map([[DEPENDABOT, 'housekeeping' as ReviewerRole]]) });
    expect(authorAutomationFor(DEPENDABOT, null, x)?.role).toBe('housekeeping');
  });
  it('an author outside the automated set is a person, whatever the login says', () => {
    // A manual "this is a human" removes the actor from the set upstream; nothing here re-adds it.
    const x = inputs({ automatedIds: new Set([GH_ACTIONS]) });
    expect(authorAutomationFor(DEPENDABOT, null, x)).toBeNull();
  });
});

describe('dependencyProximityBase', () => {
  it('a ready dependency PR splits on approval like a merge card', () => {
    expect(dependencyProximityBase('ready', 1)).toBe('merge_approved');
    expect(dependencyProximityBase('ready', 0)).toBe('merge_unapproved');
  });
  it('a person’s flagged PR starts at security_alert', () => {
    expect(dependencyProximityBase(null, 3)).toBe('security_alert');
  });
  it('every other state reads its base from the shared table', () => {
    expect(dependencyProximityBase('behind', 0)).toBe('update_branch');
    expect(dependencyProximityBase('conflicts', 0)).toBe('conflicts');
    expect(dependencyProximityBase('ci_red', 0)).toBe('unblock_ci');
    expect(dependencyProximityBase('needs_review', 0)).toBe('nudge');
    expect(dependencyProximityBase('blocked', 0)).toBe('waiting');
    expect(dependencyProximityBase('unknown', 0)).toBe('waiting');
  });
});

describe('unionAdvisoryIds', () => {
  it('lists the fix’s ids first, canonical and deduplicated across alerts', () => {
    expect(
      unionAdvisoryIds(
        ['cve-2026-1234'],
        [{ advisoryIds: ['GHSA-9QR9-H5GF-34MP', 'CVE-2026-1234'] }, { advisoryIds: ['ghsa-9qr9-h5gf-34mp'] }],
      ),
    ).toEqual(['CVE-2026-1234', 'GHSA-9qr9-h5gf-34mp']);
  });
  it('stops at the 50-id safety cap', () => {
    const many = Array.from({ length: 60 }, (_, i) => `CVE-2026-${String(1000 + i)}`);
    expect(unionAdvisoryIds(many, [])).toHaveLength(50);
  });
});

describe('securityFixDetail', () => {
  it('names the advisory a proven fix names', () => {
    expect(securityFixDetail('proven', ['GHSA-9qr9-h5gf-34mp'])).toBe('Fixes GHSA-9qr9-h5gf-34mp');
    expect(securityFixDetail('proven', ['CVE-2026-1', 'CVE-2026-2', 'CVE-2026-3'])).toBe(
      'Fixes CVE-2026-1 and 2 more',
    );
  });
  it('says a proven fix with no id is a known advisory', () => {
    expect(securityFixDetail('proven', [])).toBe('Fixes a known security advisory');
  });
  it('says nothing more for an inferred fix — the header says "Likely security fix"', () => {
    expect(securityFixDetail('inferred', [])).toBe('');
    expect(securityFixDetail('inferred', ['CVE-2026-1'])).toBe('');
  });
  it('says nothing when only alerts put the card here', () => {
    expect(securityFixDetail(null, ['CVE-2026-1'])).toBe('');
  });
});

describe('pending-classify', () => {
  it('an unobserved merge state is not a conflict', () => {
    expect(isConflicting({ mergeStateStatus: null, mergeable: null })).toBe(false);
    expect(isConflicting({ mergeStateStatus: 'dirty', mergeable: null })).toBe(true);
    expect(isConflicting({ mergeStateStatus: null, mergeable: 'conflicting' })).toBe(true);
  });
  it('red is failure OR error, and pending is not red', () => {
    expect(isRedCiStatus('error')).toBe(true);
    expect(isRedCiStatus('failure')).toBe(true);
    expect(isRedCiStatus('pending')).toBe(false);
    expect(isRedCiStatus(null)).toBe(false);
  });
});
