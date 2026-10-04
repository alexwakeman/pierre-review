// The ticket review prompt (prompts.ts) and tool policy (agent.ts) — pure, no SDK.
//   1. The diff budget is shared fairly: a small diff is whole, the big ones split the rest.
//   2. Every untrusted string is inside a nonce fence; worktree paths are not.
//   3. A member that could not be checked out is named, with the "never not_met" rule.
//   4. ⚠ The tool policy has no shell, no write tools, no web and no sub-agent dispatch.
//
//   pnpm --filter @pierre-review/backend test ticket-review/prompts
import { describe, expect, it } from 'vitest';
import {
  TICKET_REVIEW_SYSTEM_PROMPT,
  buildTicketReviewPrompt,
  capMemberDiffs,
  shareDiffBudget,
  type PromptMember,
} from './prompts.js';
import { ticketToolPolicy } from './agent.js';

const member = (i: number, over: Partial<PromptMember> = {}): PromptMember => ({
  ref: `PR${i}`,
  prId: i * 10,
  repo: `acme/r${i}`,
  number: i,
  title: `Title ${i}`,
  state: 'open',
  headSha: 'abcdef1234567890',
  checkedOut: true,
  worktreePath: `/tmp/wt/${i}`,
  changedFiles: [`src/f${i}.ts`],
  diff: `diff --git a/src/f${i}.ts b/src/f${i}.ts\n+x`,
  omittedFiles: [],
  ...over,
});

describe('shareDiffBudget', () => {
  it('gives small diffs all they need and splits the rest', () => {
    expect(shareDiffBudget([10, 1000, 1000], 1000)).toEqual([10, 495, 495]);
    expect(shareDiffBudget([100, 200], 1000)).toEqual([100, 200]);
    expect(shareDiffBudget([], 1000)).toEqual([]);
    const caps = shareDiffBudget([5000, 7000, 9000], 9000);
    expect(caps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9000);
  });

  it('keeps an unreadable diff null', () => {
    expect(capMemberDiffs([null, 'diff --git a/x b/x\n+1'])[0]).toEqual({ diff: null, omittedFiles: [] });
  });
});

describe('buildTicketReviewPrompt', () => {
  it('fences the ticket and every member title and diff with the nonce', () => {
    const nonce = 'n0nce';
    const p = buildTicketReviewPrompt({
      ticket: { key: 'BMD-1', title: 'Export', description: 'd', acceptanceCriteria: '- CSV' },
      members: [member(1), member(2, { checkedOut: false, worktreePath: null })],
      prior: null,
      legacy: [{ prId: 10, ref: 'AC1', title: 'CSV not met', body: 'no' }],
      nonce,
    });
    for (const label of ['TICKET TITLE', 'ACCEPTANCE CRITERIA', 'PR1 TITLE', 'PR1 DIFF', 'PR2 DIFF', 'PR1 EARLIER STORY ITEMS']) {
      expect(p).toContain(`---BEGIN ${label} ${nonce}---`);
      expect(p).toContain(`---END ${label} ${nonce}---`);
    }
    expect(p).toContain('Checked out read-only at: /tmp/wt/1');
    expect(p).toContain('PR2 could not be checked out');
    expect(p).toContain('never not_met');
  });
});

describe('ticketToolPolicy', () => {
  it('allows only the read tools and the submit tool', () => {
    const p = ticketToolPolicy();
    expect(p.allowedTools.sort()).toEqual(['Glob', 'Grep', 'Read', 'mcp__ticket__submit_ticket_review']);
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task']) {
      expect(p.disallowedTools).toContain(t);
    }
  });
});

describe('the summary instruction', () => {
  it('asks for one sentence, then a bullet per gap only when there are gaps', () => {
    expect(TICKET_REVIEW_SYSTEM_PROMPT).toContain("'summary' is markdown: ONE plain sentence");
    expect(TICKET_REVIEW_SYSTEM_PROMPT).toContain('only when something is unmet, partly met or missing, a short bullet list');
    expect(TICKET_REVIEW_SYSTEM_PROMPT).not.toContain('one or two plain sentences');
  });
});
