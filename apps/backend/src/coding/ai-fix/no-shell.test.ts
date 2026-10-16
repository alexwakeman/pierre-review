// THE PROMPT HALF OF "THE FIXER HAS NO SHELL" (core since the fixer left the plugin; runs in CI).
//   pnpm --filter @pierre-review/backend test no-shell
//
// The boundary itself is the tool list in apps/backend/src/coding/agent.ts (FIX_TOOLS carries no
// Bash; DISALLOWED_TOOLS denies it outright), pinned by that repo's coding/tool-surface.test.ts.
// This file pins the text, because the two failing apart is expensive in a specific way: a prompt
// that still offers a shell spends a refused tool call — one of the 40 turns and a slice of the $3
// budget — every time the model reaches for one.
import { describe, expect, it } from 'vitest';
import {
  buildFixSystemPrompt,
  buildFixUserPrompt,
  buildPlanSystemPrompt,
  buildPlanUserPrompt,
} from './prompts.js';

describe('the fix prompts offer no shell', () => {
  // ONE fix system prompt now (both seeds share it); WORKTREE_RULES is the constant it carries.
  const both = [buildFixSystemPrompt()];

  it('never names Bash or offers to run a command', () => {
    for (const p of both) {
      expect(p).not.toMatch(/\bBash\b/);
      expect(p).toContain('You have NO shell here');
    }
  });

  it('says plainly that nothing is built or tested, and promises nothing about CI', () => {
    // ⚠ THE SECOND CLAUSE WENT, AND IT IS THE SAME DEFECT THE SPA'S LINE HAD. "CI runs on push" is
    // a claim about the REPOSITORY, not about this run: `ciStatusFrom(null)` is `'unknown'` for a
    // pull request with no check rollup at all, and whole repositories are like that (62 of 63 PRs
    // on one real repo). The sentence exists to stop anybody assuming verification, so a clause
    // inventing some is the thing it was written to remove.
    for (const p of both) {
      expect(p).toContain('Nothing is installed, built or tested here');
      expect(p).not.toMatch(/CI runs on push/);
    }
  });

  it('still leaves the commit to the host', () => {
    // Removing Bash removed the `Bash(git commit *)` deny entries that used to be the mechanical
    // half of this rule. The rule is unchanged — a denied shell cannot run git at all — and the
    // prompt is where it is still SAID.
    for (const p of both) {
      expect(p).toContain('Do NOT commit, push, create branches');
    }
  });
});


// PLAN MODE: the planning pass's prompt is the prompt half of PLAN_TOOLS (Read/Glob/Grep +
// submit_plan) — it offers no shell AND no edit, and it carries none of WORKTREE_RULES' write text.
describe('the plan prompt offers neither a shell nor an edit', () => {
  const plan = buildPlanSystemPrompt();

  it('says it cannot edit and has no shell, and never names Bash or the write tools', () => {
    expect(plan).not.toMatch(/\bBash\b/);
    expect(plan).toContain('You CANNOT edit files and you have NO shell here');
    expect(plan).not.toMatch(/Write\/Edit\/MultiEdit/);
    expect(plan).toContain('Nothing is installed, built or tested here');
  });

  it('caps the summary at five short bullets in the instructions too', () => {
    expect(plan).toContain('5 bullets at most');
  });
});

describe('approve and build: the agreed plan reaches the build prompt', () => {
  const pr = {
    prId: 7,
    repoId: 3,
    owner: 'acme',
    name: 'app',
    number: 12,
    repoFullName: 'acme/app',
    title: 'Fix auth',
    body: null,
  } as unknown as Parameters<typeof buildFixUserPrompt>[0]['pr'];
  const plan = {
    revision: 2,
    summary: ['Guard the null user'],
    steps: [{ title: 'Null guard', files: ['src/auth.ts'], change: 'Return early.', refs: ['F1'] }],
    notAddressed: [{ ref: 'F2', reason: 'Already handled.' }],
    notCovered: [],
  };

  it('fences the plan as the agreed brief, and the system prompt keeps WORKTREE_RULES', () => {
    const p = buildFixUserPrompt({ pr, diff: '', seed: { kind: 'plain', text: 'Fix it' }, plan: { plan, nonce: 'n0nce' } });
    expect(p).toContain('The agreed plan.');
    expect(p).toContain('---BEGIN AGREED PLAN n0nce---');
    expect(p).toContain('1. Null guard (src/auth.ts) [F1]');
    expect(p).toContain('- F2: Already handled.');
    expect(buildFixSystemPrompt()).toContain('You have NO shell here');
  });

  it('a build with no plan carries none', () => {
    const p = buildFixUserPrompt({ pr, diff: '', seed: { kind: 'plain', text: 'Fix it' } });
    expect(p).not.toContain('AGREED PLAN');
  });
});

describe('a re-plan carries the chat', () => {
  it('fences the reader as steering and earlier replies and the previous plan as context', () => {
    const pr = { number: 12, repoFullName: 'acme/app', title: 'T', body: null } as unknown as Parameters<
      typeof buildPlanUserPrompt
    >[0]['pr'];
    const p = buildPlanUserPrompt({
      pr,
      diff: '',
      seed: { kind: 'plain', text: 'Fix it' },
      previous: { revision: 1, summary: ['Old idea'], steps: [], notAddressed: [], notCovered: [] },
      transcript: [
        { role: 'reader', text: 'Do not touch the API', revision: 1, at: '' },
        { role: 'claude', text: 'Kept the API as is.', revision: 2, at: '' },
        { role: 'reader', text: 'Also add a test', revision: 2, at: '' },
      ],
      nonce: 'abc',
    });
    expect(p).toContain('---BEGIN PREVIOUS PLAN abc---');
    expect(p).toContain('- Old idea');
    expect(p.match(/---BEGIN STEERING FROM THE PERSON RUNNING THIS FIX abc---/g)).toHaveLength(2);
    expect(p).toContain('Do not touch the API');
    expect(p).toContain('Also add a test');
    expect(p).toContain('---BEGIN YOUR EARLIER REPLY (context only) abc---');
    expect(p).toContain("LATEST steering message");
  });
});
