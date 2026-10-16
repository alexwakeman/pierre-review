// The path guard (path-guard.ts) over a REAL temp directory tree, symlinks included.
//   pnpm --filter @pierre-review/backend test review/path-guard
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPathGuard, isWithin, pathGuardHook } from './path-guard.js';

let top = '';
let cwd = '';
let wtA = '';
let wtB = '';
let secret = '';

const denied = (d: unknown): boolean =>
  (d as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny';

beforeAll(() => {
  top = mkdtempSync(join(tmpdir(), 'path-guard-'));
  cwd = join(top, 'run');
  wtA = join(top, 'clones', 'acme__api', '.worktrees', 'a');
  wtB = join(top, 'clones', 'acme__web', '.worktrees', 'b');
  secret = join(top, 'secret');
  for (const d of [cwd, wtA, wtB, secret]) mkdirSync(d, { recursive: true });
  writeFileSync(join(wtA, 'index.ts'), 'x');
  writeFileSync(join(secret, 'key'), 'k');
  symlinkSync(secret, join(wtA, 'escape'));
  symlinkSync(join(secret, 'key'), join(wtA, 'key-link'));
});

afterAll(() => {
  rmSync(top, { recursive: true, force: true });
});

describe('path guard', () => {
  it('allows cwd and every member worktree, by absolute or relative path', () => {
    const g = createPathGuard(cwd, [wtA, wtB]);
    expect(g.decide('Read', { file_path: join(wtA, 'index.ts') })).toEqual({ continue: true });
    expect(g.decide('Read', { file_path: 'MEMBERS.md' })).toEqual({ continue: true });
    expect(g.decide('Grep', { pattern: 'TODO', path: wtB })).toEqual({ continue: true });
    expect(g.decide('Glob', { pattern: '**/*.ts', path: wtA })).toEqual({ continue: true });
    expect(g.decide('Glob', { pattern: `${wtA}/src/**/*.ts` })).toEqual({ continue: true });
    expect(g.decide('Read', { file_path: join(wtA, 'not-yet', 'there.ts') })).toEqual({ continue: true });
  });

  it('denies paths outside, including .. escapes and ~', () => {
    const g = createPathGuard(cwd, [wtA]);
    expect(denied(g.decide('Read', { file_path: join(secret, 'key') }))).toBe(true);
    expect(denied(g.decide('Read', { file_path: '/etc/passwd' }))).toBe(true);
    expect(denied(g.decide('Read', { file_path: '../secret/key' }))).toBe(true);
    expect(denied(g.decide('Read', { file_path: join(wtA, '..', '..', '..', '..', 'secret', 'key') }))).toBe(true);
    expect(denied(g.decide('Read', { file_path: '~/.ssh/id_rsa' }))).toBe(true);
    expect(denied(g.decide('Grep', { pattern: 'x', path: '/' }))).toBe(true);
    expect(denied(g.decide('Read', { file_path: join(wtB, 'index.ts') }))).toBe(true);
    // A sibling whose name merely starts like a root is outside it.
    expect(denied(g.decide('Read', { file_path: `${wtA}-evil/x` }))).toBe(true);
  });

  it('follows symlinks out of a worktree and denies them', () => {
    const g = createPathGuard(cwd, [wtA]);
    expect(denied(g.decide('Read', { file_path: join(wtA, 'escape', 'key') }))).toBe(true);
    expect(denied(g.decide('Read', { file_path: join(wtA, 'key-link') }))).toBe(true);
    expect(denied(g.decide('Grep', { pattern: 'k', path: join(wtA, 'escape') }))).toBe(true);
  });

  it('Glob patterns: absolute outside, .. segments and outside paths are denied', () => {
    const g = createPathGuard(cwd, [wtA]);
    expect(denied(g.decide('Glob', { pattern: '/etc/**' }))).toBe(true);
    expect(denied(g.decide('Glob', { pattern: '**/../../secret/*' }))).toBe(true);
    expect(denied(g.decide('Glob', { pattern: '*', path: secret }))).toBe(true);
    expect(denied(g.decide('Glob', { pattern: `${secret}/*` , path: wtA }))).toBe(true);
  });

  it("never reads Grep's pattern as a path, and refuses a non-string path", () => {
    const g = createPathGuard(cwd, [wtA]);
    expect(g.decide('Grep', { pattern: '/etc/passwd', path: wtA })).toEqual({ continue: true });
    expect(denied(g.decide('Read', { file_path: 42 }))).toBe(true);
    expect(denied(g.decide('Read', { file_path: `${wtA}/a\u0000b` }))).toBe(true);
  });

  it('checks path arguments of any tool, and passes tools with none', async () => {
    const g = createPathGuard(cwd, [wtA]);
    expect(denied(g.decide('NotebookRead', { notebook_path: join(secret, 'n.ipynb') }))).toBe(true);
    expect(g.decide('mcp__ticket__submit_ticket_review', { alignment: 'aligned' })).toEqual({ continue: true });
    const hook = pathGuardHook(g).hooks[0]!;
    expect(denied(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }))).toBe(true);
    expect(await hook({ hook_event_name: 'PostToolUse' })).toEqual({ continue: true });
  });

  it("the fixer's write tools: inside the worktree only (coding/agent.ts)", () => {
    // The fixer's guard is rooted at its worktree alone (no extra roots).
    const g = createPathGuard(wtA);
    expect(g.decide('Write', { file_path: join(wtA, 'src', 'new.ts'), content: 'x' })).toEqual({ continue: true });
    expect(g.decide('Edit', { file_path: 'index.ts', old_string: 'x', new_string: 'y' })).toEqual({ continue: true });
    expect(denied(g.decide('Write', { file_path: '~/.zshrc', content: 'export X=1' }))).toBe(true);
    expect(denied(g.decide('Edit', { file_path: join(secret, 'key'), old_string: 'k', new_string: 'j' }))).toBe(true);
    expect(denied(g.decide('MultiEdit', { file_path: '../../../secret/key', edits: [] }))).toBe(true);
    expect(denied(g.decide('Write', { file_path: join(wtA, 'escape', 'planted'), content: 'x' }))).toBe(true);
  });

  it('isWithin is boundary-exact', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c')).toBe(true);
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/a/b/..c/d')).toBe(true);
  });
});

// READ-ONLY ROOTS — the workspace's reference library (docs/REFERENCE-DOCS.md § Use in reviews).
describe('path guard: a read-only root (the reference library)', () => {
  let lib = '';
  beforeAll(() => {
    lib = join(top, 'docs', '1', '1', 'library');
    mkdirSync(join(lib, 'handbook', 'sections'), { recursive: true });
    writeFileSync(join(lib, 'INDEX.md'), '# Index');
    writeFileSync(join(lib, 'handbook', 'sections', '01-refunds.md'), '# Refunds');
    symlinkSync(secret, join(lib, 'handbook', 'escape'));
  });

  it('the read tools may reach it, by absolute path or by Glob / Grep', () => {
    const g = createPathGuard(cwd, [wtA], { readOnlyRoots: [lib] });
    expect(g.decide('Read', { file_path: join(lib, 'INDEX.md') })).toEqual({ continue: true });
    expect(g.decide('Read', { file_path: join(lib, 'handbook', 'sections', '01-refunds.md') })).toEqual({ continue: true });
    expect(g.decide('Grep', { pattern: 'refund', path: lib })).toEqual({ continue: true });
    expect(g.decide('Glob', { pattern: `${lib}/**/*.md` })).toEqual({ continue: true });
    expect(g.decide('Glob', { pattern: '**/*.md', path: lib })).toEqual({ continue: true });
    expect(g.readOnlyRoots().length).toBe(1);
  });

  it('every write (or any other tool) naming it is refused', () => {
    const g = createPathGuard(cwd, [wtA], { readOnlyRoots: [lib] });
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(denied(g.decide(tool, { file_path: join(lib, 'INDEX.md') }))).toBe(true);
      expect(denied(g.decide(tool, { file_path: join(lib, 'handbook', 'new.md') }))).toBe(true);
    }
    expect(denied(g.decide('NotebookEdit', { notebook_path: join(lib, 'x.ipynb') }))).toBe(true);
    expect(denied(g.decide('mcp__other__write', { path: lib }))).toBe(true);
    const d = g.decide('Write', { file_path: join(lib, 'INDEX.md') }) as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(d.hookSpecificOutput.permissionDecisionReason).toContain('can only be read');
  });

  it('a write inside an ordinary root is decided as before', () => {
    const g = createPathGuard(cwd, [wtA], { readOnlyRoots: [lib] });
    expect(g.decide('Write', { file_path: join(cwd, 'notes.md') })).toEqual({ continue: true });
  });

  it('it does not widen anything else: outside paths, traversal and links out stay refused', () => {
    const g = createPathGuard(cwd, [wtA], { readOnlyRoots: [lib] });
    expect(denied(g.decide('Read', { file_path: join(secret, 'key') }))).toBe(true);
    expect(denied(g.decide('Read', { file_path: join(lib, '..', '..', 'staging', 'x.md') }))).toBe(true);
    expect(denied(g.decide('Read', { file_path: join(lib, 'handbook', 'escape', 'key') }))).toBe(true);
    expect(denied(g.decide('Glob', { pattern: '../**', path: lib }))).toBe(true);
  });

  it('without the option the library is outside like any other folder', () => {
    const g = createPathGuard(cwd, [wtA]);
    expect(denied(g.decide('Read', { file_path: join(lib, 'INDEX.md') }))).toBe(true);
    expect(g.readOnlyRoots()).toEqual([]);
  });
});
