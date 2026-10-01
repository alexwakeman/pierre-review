// THE PROMPT HALF OF "THE FIXER HAS NO SHELL" (core since the fixer left the plugin; runs in CI).
//   pnpm --filter @pierre-review/backend test no-shell
//
// The boundary itself is the tool list in apps/backend/src/coding/agent.ts (FIX_TOOLS carries no
// Bash; DISALLOWED_TOOLS denies it outright), pinned by that repo's coding/tool-surface.test.ts.
// This file pins the text, because the two failing apart is expensive in a specific way: a prompt
// that still offers a shell spends a refused tool call — one of the 40 turns and a slice of the $3
// budget — every time the model reaches for one, and the CI-analysis prompt's answer is stored raw
// and RENDERED to the reader, so a stale capability sentence is a false claim on screen, not just
// a wasted turn.
import { describe, expect, it } from 'vitest';
import { buildFixSystemPrompt, buildFixCommentsSystemPrompt } from './prompts.js';

describe('the fix prompts offer no shell', () => {
  // WORKTREE_RULES is interpolated into BOTH fix prompts, so one edit reaches both — that is the
  // point of the constant. Asserting over both is what makes a drift between them fail here.
  const both = [buildFixSystemPrompt(), buildFixCommentsSystemPrompt()];

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

// (The CI-analysis prompt's half — it DESCRIBES this fixer, and is stored raw and rendered — is
// Pro and stayed with the prompt: packages/pro/test/ai-fix-no-shell.test.ts. Change the two
// together.)
