// The Claude Review chat agent's tool surface. Its input (the review, the diff, the PR text) is
// attacker-authored, so the one thing that must never drift is what it is allowed to run.
import { describe, expect, it } from 'vitest';
import { chatToolsFor } from './chat-agent.js';

const WRITE_OR_SHELL = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'];

describe('chatToolsFor', () => {
  it('gives a worktree chat read-only file tools and nothing else', () => {
    const { allowedTools, disallowedTools } = chatToolsFor('worktree');
    expect(allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    for (const t of WRITE_OR_SHELL) {
      expect(allowedTools).not.toContain(t);
      expect(disallowedTools).toContain(t);
    }
  });

  it('gives a diff-only chat no tools at all', () => {
    const { allowedTools, disallowedTools } = chatToolsFor('diff_only');
    expect(allowedTools).toEqual([]);
    expect(disallowedTools).toContain('Bash');
  });

  it('hands out copies, so a caller cannot widen the shared lists', () => {
    chatToolsFor('worktree').allowedTools.push('Bash');
    expect(chatToolsFor('worktree').allowedTools).not.toContain('Bash');
  });
});
