import { describe, expect, it } from 'vitest';
// Runtime import of the shared VALUE is fine in a TEST (vitest transpiles the .ts source;
// only the RELEASE build forbids a real shared import in dist). This is deliberate — it's
// how we guarantee the backend's local review-bot copy never drifts from the shared map.
import {
  AUTOMATION_VENDORS,
  DEPENDENCY_BOTS,
  QUALITY_CHECK_BOTS,
  REVIEW_BOTS,
  REVIEW_BOT_KINDS,
  REVIEWER_ROLES,
  automationVendorKind as sharedAutomationVendorKind,
  isBenchmarkableVendorKind,
  roleForAutomationLogin as sharedRoleForLogin,
  codeAgentBot as sharedCodeAgentBot,
  dependencyBot as sharedDependencyBot,
  housekeepingBot as sharedHousekeepingBot,
  qualityCheckBot as sharedQualityCheckBot,
  releaseBot as sharedReleaseBot,
  reviewBotKind as sharedReviewBotKind,
} from '@pierre-review/shared';
import { BENCHMARKABLE_VENDOR_KINDS } from '../db/queries.js';
import {
  automationVendorFor,
  automationVendorKind,
  automationVendorLogins,
  codeAgentBot,
  codeAgentBotLogins,
  dependencyBot,
  dependencyBotLogins,
  housekeepingBot,
  housekeepingBotLogins,
  isLikelyBot,
  isReviewBot,
  qualityCheckBot,
  qualityCheckBotLogins,
  releaseBot,
  releaseBotLogins,
  reviewBotKind,
  reviewBotLogins,
  roleForBotLogin,
} from './bot-detection.js';

describe('bot-detection', () => {
  describe('review-bot classifier ⇄ shared parity (kept in lockstep BY HAND)', () => {
    it('exposes exactly the same login set as @pierre-review/shared REVIEW_BOTS', () => {
      expect(reviewBotLogins().sort()).toEqual(Object.keys(REVIEW_BOTS).sort());
    });

    it('maps every login to the same vendor kind as shared', () => {
      for (const login of Object.keys(REVIEW_BOTS)) {
        expect(reviewBotKind(login)).toBe(sharedReviewBotKind(login));
      }
    });
  });

  // The SECOND hand-synced list (the quality-check ROLE seed). Same contract, same failure mode:
  // drift here means the backend's default role disagrees with the SPA's, and — worse — with
  // migration 0042's backfill `IN (…)` list, so a login would be re-roled by the migration and
  // then flipped back on the next classification pass.
  describe('quality-check classifier ⇄ shared parity (kept in lockstep BY HAND)', () => {
    it('exposes exactly the same login set as @pierre-review/shared QUALITY_CHECK_BOTS', () => {
      expect(qualityCheckBotLogins().sort()).toEqual([...QUALITY_CHECK_BOTS].sort());
    });

    it('agrees with shared on every login in either list', () => {
      for (const login of [...QUALITY_CHECK_BOTS, ...Object.keys(REVIEW_BOTS)]) {
        expect(qualityCheckBot(login)).toBe(sharedQualityCheckBot(login));
      }
    });
  });

  describe('qualityCheckBot', () => {
    it('flags static-analysis / coverage automations', () => {
      expect(qualityCheckBot('sonarqubecloud')).toBe(true);
      expect(qualityCheckBot('codecov')).toBe(true);
      expect(qualityCheckBot('houndci-bot')).toBe(true);
    });

    it('normalises case + the [bot] suffix', () => {
      expect(qualityCheckBot('SonarQubeCloud[bot]')).toBe(true);
      expect(qualityCheckBot('CODECOV')).toBe(true);
    });

    it('does NOT flag AI review bots — role and vendor identity are orthogonal axes', () => {
      expect(qualityCheckBot('coderabbitai')).toBe(false);
      expect(qualityCheckBot('greptile-apps')).toBe(false);
      // Deliberately left `review` even though they are arguably quality-check tools: all three
      // are already named ReviewBotKind vendors, so seeding them would move existing dashboards.
      expect(qualityCheckBot('deepsource-io')).toBe(false);
      expect(qualityCheckBot('github-code-quality')).toBe(false);
      expect(qualityCheckBot('github-advanced-security')).toBe(false);
    });

    it('returns false for humans / empty', () => {
      expect(qualityCheckBot('octocat')).toBe(false);
      expect(qualityCheckBot('')).toBe(false);
      expect(qualityCheckBot(null)).toBe(false);
      expect(qualityCheckBot(undefined)).toBe(false);
    });
  });

  describe('reviewBotKind', () => {
    it('classifies known review bots by vendor', () => {
      expect(reviewBotKind('coderabbitai')).toBe('coderabbit');
      expect(reviewBotKind('greptile-apps')).toBe('greptile');
      expect(reviewBotKind('korbit-ai')).toBe('korbit');
      expect(reviewBotKind('baz-reviewer')).toBe('baz');
    });

    it('normalises case + the [bot] suffix (GraphQL bare slug vs REST slug[bot])', () => {
      expect(reviewBotKind('CodeRabbitAI[bot]')).toBe('coderabbit');
      expect(reviewBotKind('coderabbitai[bot]')).toBe('coderabbit');
      expect(reviewBotKind('SOURCERY-AI')).toBe('sourcery');
    });

    it('folds every hosted/historical Qodo login onto one vendor', () => {
      for (const login of ['qodo-ai', 'qodo-merge', 'qodo-merge-pro', 'codiumai-pr-agent-free']) {
        expect(reviewBotKind(login)).toBe('qodo');
      }
    });

    it('returns null for humans / empty', () => {
      expect(reviewBotKind('octocat')).toBeNull();
      expect(reviewBotKind('')).toBeNull();
      expect(reviewBotKind(null)).toBeNull();
      expect(reviewBotKind(undefined)).toBeNull();
    });

    it('does NOT classify coding agents that author PRs as review bots', () => {
      // Verified 2026-07: these are code-writing agents / dependency automation, not
      // reviewers — they must never carry a review-bot vendor badge.
      expect(reviewBotKind('sweep-ai')).toBeNull();
      expect(reviewBotKind('copilot-swe-agent')).toBeNull();
      expect(reviewBotKind('dependabot')).toBeNull();
      expect(reviewBotKind('renovate')).toBeNull();
      expect(reviewBotKind('snyk-bot')).toBeNull();
    });

    it('disambiguates the Copilot reviewer from the Copilot coding agent', () => {
      expect(reviewBotKind('copilot-pull-request-reviewer')).toBe('copilot');
      expect(reviewBotKind('copilot-swe-agent')).toBeNull();
    });

    it('matches OpenAI Codex on its App slug ONLY, never on the brand word', () => {
      expect(reviewBotKind('chatgpt-codex-connector')).toBe('codex');
      expect(reviewBotKind('chatgpt-codex-connector[bot]')).toBe('codex');
      // `codex` and `openai` are ordinary GitHub user accounts owned by other people — one of
      // them is a HUMAN in this project's own dev database. Matching the brand word would badge
      // a person as a vendor, which no manual override can undo before the damage is on screen.
      expect(reviewBotKind('codex')).toBeNull();
      expect(reviewBotKind('openai')).toBeNull();
    });
  });

  describe('isReviewBot', () => {
    it('is true for review bots, false otherwise', () => {
      expect(isReviewBot('coderabbitai')).toBe(true);
      expect(isReviewBot('dependabot')).toBe(false);
      expect(isReviewBot('octocat')).toBe(false);
    });
  });

  describe('isLikelyBot', () => {
    it('flags every review-bot login as a bot too (review bots ⊆ bots)', () => {
      for (const login of reviewBotLogins()) {
        expect(isLikelyBot(login)).toBe(true);
      }
    });

    it('still flags classic bots + any [bot]-suffixed login', () => {
      expect(isLikelyBot('dependabot')).toBe(true);
      expect(isLikelyBot('github-actions')).toBe(true);
      expect(isLikelyBot('some-random-app[bot]')).toBe(true);
    });

    it('does not flag ordinary humans', () => {
      expect(isLikelyBot('morgan-diaz')).toBe(false);
      expect(isLikelyBot('octocat')).toBe(false);
    });
  });
});

// The THIRD hand-synced list (the dependency-automation lane). Same contract, same failure mode:
// drift means the backend and the SPA disagree about whether an actor AUTHORS or REVIEWS, which
// decides whether its PRs land in the throughput metrics or its comments in the review ones.
describe('dependency-bot classifier ⇄ shared parity (kept in lockstep BY HAND)', () => {
  it('exposes exactly the same login set as @pierre-review/shared DEPENDENCY_BOTS', () => {
    expect(dependencyBotLogins().sort()).toEqual([...DEPENDENCY_BOTS].sort());
  });

  it('agrees with shared on every login across all three lists', () => {
    for (const login of [
      ...DEPENDENCY_BOTS,
      ...QUALITY_CHECK_BOTS,
      ...Object.keys(REVIEW_BOTS),
    ]) {
      expect(dependencyBot(login)).toBe(sharedDependencyBot(login));
    }
  });

  // ⚠ THE DUPLICATE-IDENTITY DEFENCE. Real accounts carry `dependabot` AND `dependabot[bot]` as
  // separate user rows with CONFLICTING automated flags. Login normalisation is what stops one
  // actor being split across two lanes and under-counting both.
  it('matches whether the login arrived bare or `[bot]`-suffixed, in any case', () => {
    expect(dependencyBot('dependabot')).toBe(true);
    expect(dependencyBot('dependabot[bot]')).toBe(true);
    expect(dependencyBot('Dependabot[bot]')).toBe(true);
    expect(dependencyBot('renovate[bot]')).toBe(true);
  });

  // The three lanes must not overlap, or an actor's classification depends on predicate order.
  it('does not claim a login that belongs to another lane', () => {
    for (const login of Object.keys(REVIEW_BOTS)) expect(dependencyBot(login)).toBe(false);
    for (const login of QUALITY_CHECK_BOTS) {
      if (DEPENDENCY_BOTS.has(login)) continue;
      expect(dependencyBot(login)).toBe(false);
    }
  });

  it('does not flag a human login', () => {
    expect(dependencyBot('alexwakeman')).toBe(false);
    expect(dependencyBot(null)).toBe(false);
  });
});

// ⚠ THE DRIFT GUARD FOR THE HAND-SYNCED VENDOR TABLE.
//
// The backend cannot import shared at RUNTIME (a value import fails the release build), so
// `AUTOMATION_VENDORS` is spelled twice — ~68 logins, each carrying a vendor kind AND a default
// role. A typo in either column is invisible: the wrong kind renders someone else's brand on a
// card, and the wrong role moves the actor between metric cohorts. Neither throws.
describe('AUTOMATION_VENDORS ⇄ shared parity (kept in lockstep BY HAND)', () => {
  it('covers exactly the same logins', () => {
    expect(automationVendorLogins().sort()).toEqual(Object.keys(AUTOMATION_VENDORS).sort());
  });

  it('agrees on the kind AND the role of every login', () => {
    for (const [login, expected] of Object.entries(AUTOMATION_VENDORS)) {
      expect(automationVendorFor(login), login).toEqual(expected);
    }
  });

  it('agrees with the shared predicates on every login in every vocabulary', () => {
    const all = [
      ...Object.keys(AUTOMATION_VENDORS),
      ...Object.keys(REVIEW_BOTS),
      'alexwakeman',
      'some-unknown-app',
    ];
    for (const login of all) {
      expect(codeAgentBot(login), login).toBe(sharedCodeAgentBot(login));
      expect(releaseBot(login), login).toBe(sharedReleaseBot(login));
      expect(housekeepingBot(login), login).toBe(sharedHousekeepingBot(login));
      expect(dependencyBot(login), login).toBe(sharedDependencyBot(login));
      expect(qualityCheckBot(login), login).toBe(sharedQualityCheckBot(login));
      expect(roleForBotLogin(login), login).toBe(sharedRoleForLogin(login));
      expect(automationVendorKind(login), login).toBe(sharedAutomationVendorKind(login));
    }
  });

  it('normalises the `[bot]` suffix and case, like every other vocabulary', () => {
    expect(codeAgentBot('devin-ai-integration[bot]')).toBe(true);
    expect(codeAgentBot('Pre-Commit-CI[bot]')).toBe(true);
    expect(releaseBot('mergify[bot]')).toBe(true);
    expect(housekeepingBot('Stale[bot]')).toBe(true);
    expect(automationVendorKind('Dependabot[bot]')).toBe('dependabot');
  });
});

// The per-family sets are DERIVED from one table now, so "no login is in two families" is true by
// construction and a test asserting it would be theatre. What is NOT free is the relationship
// between the two tables that DO overlap.
describe('the two vendor tables agree where they overlap', () => {
  it('gives a login in BOTH REVIEW_BOTS and AUTOMATION_VENDORS the same kind', () => {
    // `devin-ai-integration` is the live case: a brand that reviews in some accounts and authors
    // in others. Kind (who it is) and role (what it does) are ORTHOGONAL, so appearing in both is
    // legal — but the two tables disagreeing about the BRAND is not, and would silently repaint
    // the actor depending on which lookup ran.
    for (const [login, kind] of Object.entries(REVIEW_BOTS)) {
      const other = AUTOMATION_VENDORS[login];
      if (other) expect(other.kind, login).toBe(kind);
    }
  });

  it('gives every ReviewerRole except `review` a login vocabulary', () => {
    // A role nothing can be classified INTO is a dead option in the picker.
    const covered = new Set(Object.values(AUTOMATION_VENDORS).map((v) => v.role));
    for (const role of REVIEWER_ROLES) {
      if (role === 'review') continue;
      expect(covered.has(role), `role '${role}' has no login vocabulary`).toBe(true);
    }
  });

  it('roleForBotLogin returns null for anything no vocabulary claims', () => {
    // Null is NOT "it reviews". The two callers diverge on purpose: `defaultRoleFor` falls back
    // to 'review' (so the actor keeps its row in the panel that can reclassify it) while
    // `resolveActorLanes` falls back to the quality gate (so it is never CREDITED as a reviewer).
    expect(roleForBotLogin('some-unknown-app')).toBeNull();
    expect(roleForBotLogin('alexwakeman')).toBeNull();
    expect(roleForBotLogin(null)).toBeNull();
    // A known AI reviewer carries no role of its own — 'review' is the fallback, not a claim.
    expect(roleForBotLogin('coderabbitai')).toBeNull();
  });
});

// ⚠ THE HIGHEST-STAKES ASSERTION IN THIS FILE.
//
// `getBenchmarkContributions` contributes rows keyed on a vendor kind to a CROSS-ORG dataset.
// Those rows leave the tenant and cannot be recalled, so a kind that is not a comparable AI
// reviewer must never reach it. The check used to be a DENY-list (`!== in_house && !== pierre &&
// !== vendor`), which was correct only while ReviewBotKind was the entire branded universe — every
// kind added for quality gates, dependency bots, code agents, release and housekeeping automation
// would have passed it.
describe('the benchmark allow-list', () => {
  it('admits exactly the AI-review vendor kinds', () => {
    for (const kind of Object.values(REVIEW_BOTS)) {
      expect(isBenchmarkableVendorKind(kind), kind).toBe(true);
    }
  });

  it('rejects EVERY non-review vendor kind, the generics, and the unknown', () => {
    for (const { kind } of Object.values(AUTOMATION_VENDORS)) {
      // `devin` is in both tables and is a genuine review vendor — it is benchmarkable, and that
      // is the one legitimate exception rather than a hole in the rule.
      if ((Object.values(REVIEW_BOTS) as string[]).includes(kind)) continue;
      expect(isBenchmarkableVendorKind(kind), kind).toBe(false);
    }
    for (const k of ['in_house', 'pierre', 'vendor', 'sonarqube', 'dependabot', 'google_cla']) {
      expect(isBenchmarkableVendorKind(k), k).toBe(false);
    }
    expect(isBenchmarkableVendorKind(null)).toBe(false);
    expect(isBenchmarkableVendorKind(undefined)).toBe(false);
  });

  it('matches the copy the query layer actually runs', () => {
    // queries.ts keeps its own mirrored Set for the release-guard reason. A drift here is a
    // governance failure, not a lint issue: the two lists deciding differently means the code
    // that ships data disagrees with the code that documents what ships.
    expect([...BENCHMARKABLE_VENDOR_KINDS].sort()).toEqual([...REVIEW_BOT_KINDS].sort());
  });
});

// The actors that made this change necessary, asserted by name. These are not hypothetical
// logins: every one was observed in the dev corpus sitting in the wrong role.
describe('the logins this change was built for', () => {
  it('files github-actions as a quality check, not an AI reviewer', () => {
    // 385 submitted reviews and 3,116 comments across its two user rows while roled 'review' —
    // the largest "AI reviewer" in the account's ROI table was a CI runner.
    expect(roleForBotLogin('github-actions')).toBe('quality_check');
    expect(roleForBotLogin('github-actions[bot]')).toBe('quality_check');
  });

  it('files the code-authoring automations away from review', () => {
    expect(roleForBotLogin('devin-ai-integration[bot]')).toBe('code_agent');
    expect(roleForBotLogin('deepsource-autofix[bot]')).toBe('code_agent');
    expect(roleForBotLogin('pre-commit-ci[bot]')).toBe('code_agent');
    expect(roleForBotLogin('imgbot')).toBe('code_agent');
    expect(roleForBotLogin('transifex-integration')).toBe('code_agent');
  });

  it('keeps the AI reviewers that merely SOUND like agents out of code_agent', () => {
    // Cursor, Codex and Copilot's reviewer all post inline findings and author nothing on this
    // corpus (269 / 420 / 415 inline comments, zero authored PRs). A login is placed by what it
    // DOES, not by whose logo is on it — and the per-workspace override exists for the account
    // where the same brand does the other job.
    for (const login of ['cursor', 'chatgpt-codex-connector', 'copilot-pull-request-reviewer']) {
      expect(codeAgentBot(login)).toBe(false);
      expect(reviewBotKind(login)).not.toBeNull();
    }
  });
});
