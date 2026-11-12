// THE STORY CHECK IN THE REVIEW LOOP (docs/CLAUDE-REVIEW.md § The ticket review → in the review loop):
//   1. a member with a `label` reads "branch PAY-142" in place of "#n" (prompt + MEMBERS.md); without it,
//      byte-identical;
//   2. the build agent's notes (`claims`) add ONE fenced section; absent or empty ⇒ byte-identical;
//   3. `notApplicable` joins the tool's shape ONLY when asked (zod + the strict JSON schema Codex reads);
//   4. the checker's verdicts are kept only for the "not applicable" refs it was shown.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTicketReviewPrompt, membersIndex, type PromptMember } from './prompts.js';
import { buildSubmitTicketReviewShape } from './schema.js';
import { claimVerdictsOf } from '../../coding/story-build/loop/story-check.js';
import { shapeToJsonSchema, toStrictJsonSchema } from '../../ai/result-schemas.js';

const member = (over: Partial<PromptMember> = {}): PromptMember => ({
  ref: 'PR1',
  prId: 7,
  repo: 'acme/api',
  number: 12,
  title: 'Refunds',
  state: 'open',
  headSha: 'abcdef1234567890',
  checkedOut: true,
  worktreePath: '/tmp/wt/1',
  changedFiles: ['src/refund.ts'],
  diff: 'diff --git a/src/refund.ts b/src/refund.ts\n+x',
  omittedFiles: [],
  ...over,
});
const ticket = { key: 'PAY-142', title: 'Refunds', description: 'd', acceptanceCriteria: '1. Refund a card\n2. Email the buyer' };
const NONCE = '0123456789abcdef';

describe('the story check of a branch', () => {
  it('labels a branch member, and leaves a PR member as it was', () => {
    const pr = buildTicketReviewPrompt({ ticket, members: [member()], prior: null, legacy: [], nonce: NONCE });
    const branch = buildTicketReviewPrompt({ ticket, members: [member({ number: 0, label: 'branch PAY-142' })], prior: null, legacy: [], nonce: NONCE });
    expect(pr).toContain('## PR1: acme/api #12 (open)');
    expect(branch).toContain('## PR1: acme/api branch PAY-142 (open)');
    expect(branch).not.toContain('#0');
    expect(membersIndex([member({ number: 0, label: 'branch PAY-142' })])).toContain('## PR1: acme/api branch PAY-142 (open)');
  });

  it('adds the agent\'s notes as one fenced section; none ⇒ byte-identical', () => {
    const base = buildTicketReviewPrompt({ ticket, members: [member()], prior: null, legacy: [], nonce: NONCE });
    expect(buildTicketReviewPrompt({ ticket, members: [member()], prior: null, legacy: [], nonce: NONCE, claims: [] })).toBe(base);
    expect(buildTicketReviewPrompt({ ticket, members: [member()], prior: null, legacy: [], nonce: NONCE, claims: null })).toBe(base);
    const p = buildTicketReviewPrompt({
      ticket,
      members: [member()],
      prior: null,
      legacy: [],
      nonce: NONCE,
      claims: [
        { ref: 'AC2', kind: 'not_applicable', text: 'Emails are another team\'s service.' },
        { ref: 'AC1', kind: 'answer', text: 'Refund calls the gateway.' },
      ],
    });
    expect(p).toContain("# The build agent's notes on the criteria");
    expect(p).toContain(`---BEGIN BUILD AGENT NOTES ${NONCE}---\nAC2 (NOT APPLICABLE): Emails are another team's service.\nAC1 (ANSWER): Refund calls the gateway.\n---END BUILD AGENT NOTES ${NONCE}---`);
    expect(p.indexOf("# The build agent's notes")).toBeLessThan(p.indexOf('submit_ticket_review'));
  });

  it('adds `notApplicable` to the tool only when asked (zod and the strict JSON schema)', () => {
    const plain = buildSubmitTicketReviewShape(z);
    const docs = buildSubmitTicketReviewShape(z, { docs: true });
    const na = buildSubmitTicketReviewShape(z, { notApplicable: true });
    expect('notApplicable' in plain).toBe(false);
    expect('notApplicable' in docs).toBe(false);
    expect('notApplicable' in na).toBe(true);
    expect(JSON.stringify(toStrictJsonSchema(shapeToJsonSchema(z, plain)))).not.toContain('notApplicable');
    expect(JSON.stringify(toStrictJsonSchema(shapeToJsonSchema(z, na)))).toContain('notApplicable');
    expect(z.object(na).safeParse({ alignment: 'aligned', summary: 's', notApplicable: [{ ref: 'AC2', verdict: 'accepted', why: 'Out of scope.' }] }).success).toBe(true);
    expect(z.object(na).safeParse({ alignment: 'aligned', summary: 's', notApplicable: [{ ref: 'AC2', verdict: 'maybe', why: 'x' }] }).success).toBe(false);
  });

  it('keeps a verdict only for a "not applicable" note it was shown, once', () => {
    const claims = [
      { ref: 'AC2', kind: 'not_applicable' as const, text: 'x' },
      { ref: 'AC1', kind: 'answer' as const, text: 'y' },
    ];
    expect(
      claimVerdictsOf(
        [
          { ref: 'ac2', verdict: 'accepted', why: ' Out of scope. ' },
          { ref: 'AC2', verdict: 'rejected', why: 'again' },
          { ref: 'AC1', verdict: 'accepted', why: 'an answer, not a note' },
          { ref: 'AC9', verdict: 'accepted', why: 'never shown' },
          { ref: 'AC2', verdict: 'maybe' },
          null,
        ],
        claims,
      ),
    ).toEqual([{ ref: 'AC2', verdict: 'accepted', why: 'Out of scope.' }]);
    expect(claimVerdictsOf('nope', claims)).toEqual([]);
  });
});
