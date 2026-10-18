// THE STORY DOCS READ's TOOLS AND ROOTS: no shell, no write tool, no dispatch; the path guard's only
// read-only roots are the SHORTLISTED documents' folders — never the library folder itself, so INDEX.md
// and every other document are unreachable.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPathGuard } from '../path-guard.js';
import { storyDocsRoots, storyDocsToolPolicy } from './agent.js';
import { buildStoryDocsPrompt } from './prompts.js';

describe('the tool policy', () => {
  it('Read, Glob, Grep and the submit tool only; Bash and every write tool denied', () => {
    const p = storyDocsToolPolicy();
    expect(p.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'mcp__storydocs__submit_alignment']);
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']) expect(p.disallowedTools).toContain(t);
    expect(p.disallowedTools).toContain('Task');
  });
});

describe('the roots', () => {
  let root: string;
  let lib: string;
  let cwd: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'limn-storydocs-guard-'));
    lib = join(root, 'library');
    for (const slug of ['refunds', 'billing']) {
      mkdirSync(join(lib, slug, 'sections'), { recursive: true });
      writeFileSync(join(lib, slug, 'CONTENTS.md'), '# c');
      writeFileSync(join(lib, slug, 'sections', '01-a.md'), 'text');
    }
    writeFileSync(join(lib, 'INDEX.md'), '# i');
    cwd = join(root, 'scratch');
    mkdirSync(cwd);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const denied = (d: unknown): boolean => JSON.stringify(d).includes('"deny"');

  it('are only the shortlisted documents, deduped', () => {
    const roots = storyDocsRoots(lib, [{ docSlug: 'refunds' }, { docSlug: 'refunds' }]);
    expect(roots).toEqual([join(lib, 'refunds')]);
    expect(roots).not.toContain(lib);
  });

  it('the guard reads a shortlisted document and nothing else, and never writes', () => {
    const guard = createPathGuard(cwd, [], { readOnlyRoots: storyDocsRoots(lib, [{ docSlug: 'refunds' }]) });
    expect(denied(guard.decide('Read', { file_path: join(lib, 'refunds', 'sections', '01-a.md') }))).toBe(false);
    expect(denied(guard.decide('Grep', { path: join(lib, 'refunds') }))).toBe(false);
    expect(denied(guard.decide('Read', { file_path: join(lib, 'INDEX.md') }))).toBe(true);
    expect(denied(guard.decide('Read', { file_path: join(lib, 'billing', 'sections', '01-a.md') }))).toBe(true);
    expect(denied(guard.decide('Read', { file_path: join(lib, 'refunds', '..', 'billing', 'CONTENTS.md') }))).toBe(true);
    expect(denied(guard.decide('Write', { file_path: join(lib, 'refunds', 'sections', '01-a.md') }))).toBe(true);
    expect(denied(guard.decide('Glob', { pattern: '../**', path: join(lib, 'refunds') }))).toBe(true);
  });

  it('the prompt names the same folders and fences the shortlist', () => {
    const p = buildStoryDocsPrompt({
      story: { title: 't', description: 'd', acceptanceCriteria: '' },
      criteriaSource: 'derived',
      criteria: [],
      shortlist: [{ path: 'refunds/sections/01-a.md', workspaceId: 1, anchor: null, docSlug: 'refunds', docTitle: 'Refunds', sectionTitle: 'A', reason: 'why' }],
      libraryDir: lib,
      nonce: 'abc123',
    });
    expect(p).toContain(`- ${join(lib, 'refunds')}`);
    expect(p).not.toContain(`- ${join(lib, 'billing')}`);
    expect(p).toContain('---BEGIN SHORTLIST abc123---');
    expect(p).toContain('derivedCriteria');
  });
});
