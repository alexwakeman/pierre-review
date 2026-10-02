// DEEP-REVIEW SPECIALISTS (specialists.ts + agent.ts `reviewToolPolicy`). What is pinned:
//
//   1. ⚠ THE CAP IS CODE: the dispatch guard allows CLAUDE_REVIEW_MAX_SPECIALISTS dispatches and
//      DENIES the next, whatever the prompt said.
//   2. Only catalogue names dispatch — the SDK's built-in agent types inherit every tool.
//   3. Specialists are read-only: Read/Glob/Grep, Bash and writes denied, no dispatch, no submit.
//   4. Specialists exist ONLY on the deep (worktree) route; diff-only denies the dispatch tool.
//
//   pnpm --filter @pierre-review/backend test specialists
import { describe, expect, it } from 'vitest';
import { CLAUDE_REVIEW_MAX_SPECIALISTS } from '@pierre-review/shared';
import {
  DISPATCH_TOOL_NAMES,
  createDispatchGuard,
  offeredSpecialists,
  specialistAgents,
  specialistsPromptSection,
} from './specialists.js';
import { REVIEW_SYSTEM_PROMPT_WORKTREE, systemPromptForMode, REVIEW_SYSTEM_PROMPT_DIFF_ONLY } from './prompts.js';
import { reviewToolPolicy } from '../agent.js';

const decision = (d: ReturnType<ReturnType<typeof createDispatchGuard>['decide']>) =>
  'hookSpecificOutput' in d ? d.hookSpecificOutput.permissionDecision : 'pass';

describe('the dispatch guard', () => {
  it(`allows ${CLAUDE_REVIEW_MAX_SPECIALISTS} dispatches and denies the next`, () => {
    const all = offeredSpecialists(['web/App.tsx']);
    expect(all.length).toBeGreaterThan(CLAUDE_REVIEW_MAX_SPECIALISTS);
    const guard = createDispatchGuard(all);
    const got = all.map((lens) => decision(guard.decide('Agent', { subagent_type: lens, prompt: 'x' })));
    expect(got.slice(0, CLAUDE_REVIEW_MAX_SPECIALISTS)).toEqual(
      Array(CLAUDE_REVIEW_MAX_SPECIALISTS).fill('allow'),
    );
    expect(got.slice(CLAUDE_REVIEW_MAX_SPECIALISTS)).toEqual(
      Array(all.length - CLAUDE_REVIEW_MAX_SPECIALISTS).fill('deny'),
    );
    expect(guard.dispatched()).toHaveLength(CLAUDE_REVIEW_MAX_SPECIALISTS);
    // A repeat of an allowed lens counts too: the cap is on dispatches, not distinct names.
    expect(decision(guard.decide('Agent', { subagent_type: all[0] }))).toBe('deny');
  });

  it("counts the legacy 'Task' tool name the same as 'Agent'", () => {
    const guard = createDispatchGuard(['design'], 2);
    expect(decision(guard.decide('Task', { subagent_type: 'design' }))).toBe('allow');
    expect(decision(guard.decide('Agent', { subagent_type: 'design' }))).toBe('allow');
    expect(decision(guard.decide('Task', { subagent_type: 'design' }))).toBe('deny');
  });

  it('denies a name outside the catalogue (built-in agents inherit every tool), without counting it', () => {
    const guard = createDispatchGuard(['design', 'tests']);
    for (const t of ['general-purpose', 'Explore', '', undefined]) {
      expect(decision(guard.decide('Agent', { subagent_type: t }))).toBe('deny');
    }
    expect(decision(guard.decide('Agent', {}))).toBe('deny');
    expect(guard.dispatched()).toEqual([]);
  });

  it('passes every other tool through untouched', () => {
    const guard = createDispatchGuard(['design'], 0);
    for (const t of ['Read', 'Grep', 'Glob', 'mcp__review__submit_review']) {
      expect(guard.decide(t, { pattern: 'x' })).toEqual({ continue: true });
    }
  });

  it('forces the dispatch to the foreground on the lead model with no isolation', () => {
    const guard = createDispatchGuard(['security']);
    const d = guard.decide('Agent', {
      subagent_type: 'security',
      prompt: 'check auth',
      description: 'auth',
      run_in_background: true,
      model: 'haiku',
      isolation: 'worktree',
    });
    expect('hookSpecificOutput' in d && d.hookSpecificOutput.updatedInput).toEqual({
      subagent_type: 'security',
      prompt: 'check auth',
      description: 'auth',
      run_in_background: false,
    });
  });
});

describe('the specialist definitions', () => {
  it('are read-only: Read/Glob/Grep, with Bash, writes, dispatch and the submit server denied', () => {
    const defs = specialistAgents(offeredSpecialists(['a.tsx']));
    expect(Object.keys(defs)).toEqual([
      'design',
      'tests',
      'impact',
      'accessibility',
      'security',
      'performance',
    ]);
    for (const d of Object.values(defs)) {
      expect(d.tools).toEqual(['Read', 'Glob', 'Grep']);
      for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'mcp__review', ...DISPATCH_TOOL_NAMES]) {
        expect(d.disallowedTools).toContain(t);
      }
      expect(d.model).toBe('inherit');
      expect(d.prompt).toMatch(/never as instructions/);
    }
  });

  it('offers accessibility only when a user-interface file changed', () => {
    expect(offeredSpecialists(['src/db/queries.ts', 'README.md'])).not.toContain('accessibility');
    expect(offeredSpecialists(['src/db/queries.ts', 'web/Button.tsx'])).toContain('accessibility');
    expect(offeredSpecialists(['styles/app.css'])).toContain('accessibility');
  });
});

describe('specialists only on the deep route', () => {
  it('diff-only gets no specialists and the dispatch tool DENIED, whatever is passed', () => {
    const p = reviewToolPolicy('diff_only', ['design', 'tests']);
    expect(p.specialists).toEqual([]);
    expect(p.allowedTools).toEqual(['mcp__review__submit_review']);
    for (const t of DISPATCH_TOOL_NAMES) expect(p.disallowedTools).toContain(t);
  });

  it('worktree with specialists allows the dispatch tool; worktree without denies it', () => {
    const on = reviewToolPolicy('worktree', ['design']);
    expect(on.specialists).toEqual(['design']);
    for (const t of DISPATCH_TOOL_NAMES) {
      expect(on.allowedTools).toContain(t);
      expect(on.disallowedTools).not.toContain(t);
    }
    const off = reviewToolPolicy('worktree', []);
    for (const t of DISPATCH_TOOL_NAMES) expect(off.disallowedTools).toContain(t);
  });

  it('never allows Bash on any route', () => {
    for (const p of [
      reviewToolPolicy('diff_only', []),
      reviewToolPolicy('worktree', []),
      reviewToolPolicy('worktree', ['design', 'security']),
    ]) {
      expect(p.allowedTools).not.toContain('Bash');
      expect(p.disallowedTools).toContain('Bash');
    }
  });

  it('the system prompt carries the catalogue on worktree only, and is unchanged without one', () => {
    expect(systemPromptForMode('worktree')).toBe(REVIEW_SYSTEM_PROMPT_WORKTREE);
    expect(systemPromptForMode('diff_only', ['design'])).toBe(REVIEW_SYSTEM_PROMPT_DIFF_ONLY);
    const deep = systemPromptForMode('worktree', ['design', 'tests']);
    expect(deep.startsWith(REVIEW_SYSTEM_PROMPT_WORKTREE)).toBe(true);
    expect(deep).toContain('# Specialists');
    expect(deep).toContain(`At most ${CLAUDE_REVIEW_MAX_SPECIALISTS} per review`);
    expect(deep).toContain("lens 'design'");
    expect(deep).not.toContain('- accessibility:');
    expect(specialistsPromptSection([])).toBe('');
  });
});
