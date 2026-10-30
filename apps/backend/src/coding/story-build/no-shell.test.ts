// "IMPLEMENT STORY" HAS NO SHELL (docs/STORY-BUILD.md § Phases and agents; docs/SECURITY.md). The plan
// pass (`story_plan`) is READ-ONLY by CODE: its allow list is Read / Glob / Grep + submit_story_plan, and
// Bash, every write tool, the web tools and sub-agent dispatch are ALSO denied outright. The prompt says
// the same — the two change together, so both are pinned here. (WP2 pins the build's own list.)
import { describe, expect, it } from 'vitest';
import { STORY_PLAN_DISALLOWED_TOOLS, STORY_PLAN_TOOL, STORY_PLAN_TOOLS, storyPlanToolPolicy } from './plan-agent.js';
import { buildStoryPlanSystemPrompt } from './prompts.js';

describe('the story plan pass', () => {
  it('may read and submit, nothing else', () => {
    expect([...STORY_PLAN_TOOLS]).toEqual(['Read', 'Glob', 'Grep', STORY_PLAN_TOOL]);
    expect(STORY_PLAN_TOOL).toBe('mcp__storyplan__submit_story_plan');
  });

  it('denies Bash, every write tool, the web and dispatch OUTRIGHT', () => {
    const { allowedTools, disallowedTools } = storyPlanToolPolicy();
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task']) {
      expect(disallowedTools, t).toContain(t);
      expect(allowedTools, t).not.toContain(t);
    }
    expect(new Set(disallowedTools).size).toBe(disallowedTools.length);
    expect([...STORY_PLAN_DISALLOWED_TOOLS]).toEqual(expect.arrayContaining(['Bash']));
  });

  it('the prompt offers no edit and no shell, on both providers', () => {
    for (const p of ['claude', 'codex'] as const) {
      const sys = buildStoryPlanSystemPrompt(p);
      expect(sys).toContain('You CANNOT edit files and you have NO shell here');
      expect(sys).toContain('Nothing is installed, built or tested here');
    }
  });
});
