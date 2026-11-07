// THE HOST-SIDE WORKTREE AGENT HAS NO SHELL. Since AI Fix and Implement moved into the sandboxed
// workspace session (sandbox/session/; docs/SANDBOX.md — the ONE place an agent has a shell), the only
// agent left on `coding/agent.ts` `runAgentInWorktree` is Resolve with Claude (coding/ai-resolve/run.ts),
// and it is READ-ONLY: its allow list carries no write tool and no shell, and Bash plus every write tool
// is ALSO denied outright.
//
// Why a SOURCE SCAN and not an import: those modules reach `db/client.ts`, which opens the real SQLite
// file at import time, and the Agent SDK, which has no business being loaded by a unit test. What is
// guarded is a literal array of strings, which a scan reads exactly. It slices from `const NAME = [` to
// the next `];`, drops whole `//` lines so an explanatory comment naming `'Bash'` cannot read as an
// entry, and takes the single-quoted strings that remain.
//
// ⚠ A SCAN THAT CANNOT FAIL IS WORSE THAN NO SCAN, so the last describe MUTATES the source in memory
// and asserts the predicate flips.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const AGENT = read('./agent.ts');
const RESOLVE = read('./ai-resolve/run.ts');

function toolList(name: string, source: string): string[] {
  const start = source.indexOf(`const ${name} = [`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('];', start);
  expect(end).toBeGreaterThan(start);
  const body = source
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
}

// `Bash` and every `Bash(…)` command pattern alike: re-admitting the shell behind a longer blocklist is
// the specific thing that was rejected.
const isShell = (tool: string): boolean => /^Bash\b|^Bash\(/.test(tool);
// A `(` in a DENY entry means someone is enumerating commands again, which is not a boundary.
const isPattern = (tool: string): boolean => tool.includes('(');
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

describe('Resolve with Claude reads and cannot write or reach a shell', () => {
  it('allows only reading tools and submit_resolution', () => {
    expect(toolList('READ_TOOLS', RESOLVE)).toEqual(['Read', 'Glob', 'Grep', 'mcp__resolve__submit_resolution']);
  });

  it('denies Bash and every write tool outright, never by command pattern', () => {
    const denied = toolList('DENIED_TOOLS', RESOLVE);
    for (const t of ['Bash', ...WRITE_TOOLS]) expect(denied).toContain(t);
    expect(denied.filter(isPattern)).toEqual([]);
  });

  it('hands those lists to runAgentInWorktree as a read-only run', () => {
    expect(RESOLVE).toContain('allowedTools: READ_TOOLS,');
    expect(RESOLVE).toContain('disallowedTools: DENIED_TOOLS,');
    expect(RESOLVE).toMatch(/writes: false/);
  });
});

describe('the worktree run is confined to its worktree', () => {
  // The provider builds the path guard from the run's cwd and roots (ai/providers/claude.ts): the run
  // hands the worktree as cwd with NO other root, and the provider puts the path guard over exactly
  // cwd + roots FIRST on PreToolUse, then the own-tools-only hook for the run's own servers.
  it('runs behind the path guard rooted at the worktree', () => {
    expect(AGENT).toContain('cwd: opts.worktreePath,\n    roots: [],\n    readOnlyRoots: opts.readOnlyRoots ?? [],');
    expect(AGENT).toContain('writeRoots: opts.writes ? [opts.worktreePath] : [],');
    const provider = read('../ai/providers/claude.ts');
    expect(provider).toContain('const guard = createPathGuard(spec.cwd, spec.roots, { readOnlyRoots: spec.readOnlyRoots });');
    expect(provider).toMatch(/PreToolUse: \[\s*pathGuardHook\(guard\),\s*ownToolsOnlyHook\(ownServers\),/);
    expect(provider).toContain('const ownServers = Object.keys(mcpServers);');
  });
});

describe('the scan actually catches the shell coming back', () => {
  const reAdd = (name: string, entry: string): string => {
    const at = RESOLVE.indexOf(`const ${name} = [`);
    const open = RESOLVE.indexOf('[', at) + 1;
    return `${RESOLVE.slice(0, open)}'${entry}',${RESOLVE.slice(open)}`;
  };

  it('fails on a bare Bash in the allow list', () => {
    expect(toolList('READ_TOOLS', reAdd('READ_TOOLS', 'Bash')).filter(isShell)).toEqual(['Bash']);
  });

  it('fails on a write tool in the allow list', () => {
    expect(toolList('READ_TOOLS', reAdd('READ_TOOLS', 'Edit')).filter((t) => WRITE_TOOLS.includes(t))).toEqual(['Edit']);
  });

  it('fails on a command-pattern deny entry', () => {
    expect(toolList('DENIED_TOOLS', reAdd('DENIED_TOOLS', 'Bash(git push *)')).filter(isPattern)).toEqual(['Bash(git push *)']);
  });

  it('is not fooled by the word Bash inside a comment', () => {
    const at = RESOLVE.indexOf('const READ_TOOLS = [');
    const open = RESOLVE.indexOf('[', at) + 1;
    const mutated = `${RESOLVE.slice(0, open)}\n  // re-add 'Bash' one day?${RESOLVE.slice(open)}`;
    expect(toolList('READ_TOOLS', mutated).filter(isShell)).toEqual([]);
  });
});
