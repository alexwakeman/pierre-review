import { describe, expect, it } from 'vitest';
// Runtime import of the shared VALUE is fine in a TEST (vitest transpiles the .ts source;
// only the RELEASE build forbids a real shared import in dist). This is deliberate — it's
// how we guarantee the backend's local review-bot copy never drifts from the shared map.
import { REVIEW_BOTS, reviewBotKind as sharedReviewBotKind } from '@pierre-review/shared';
import { isLikelyBot, isReviewBot, reviewBotKind, reviewBotLogins } from './bot-detection.js';

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
