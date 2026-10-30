// THE FIX AGENT HAS NO SHELL. (AI Fix's agentic conflict resolver, which this file also used to
// pin, was removed with the rest of AI Fix's trunk reconciliation — the fixer is the only agent
// left in coding/agent.ts.)
//
// Why a SOURCE SCAN and not an import: `coding/agent.ts` reaches `db/client.ts`, which opens the
// real SQLite file at import time, and the Agent SDK, which has no business being loaded by a unit
// test. What is being guarded is a literal array of strings, which a scan reads exactly — this
// parses nothing and understands nothing (the failure mode a previous source-scan guard in this
// repo hit, blinded by a `;` inside a comment). It slices from `const NAME = [` to the next `];`,
// drops whole `//` lines so an explanatory comment naming `'Bash'` cannot read as an entry, and
// takes the single-quoted strings that remain.
//
// ⚠ A SCAN THAT CANNOT FAIL IS WORSE THAN NO SCAN, so the last describe below MUTATES the source
// in memory — re-adds `'Bash'` to the allow list, re-adds a `Bash(git push *)` deny pattern — and
// asserts the predicate flips. That is the mutation test, run every time rather than once by hand.
//
// The rule these pin is in the comment above FIX_TOOLS: Bash is denied for the fixer because its
// input is attacker-authored (review/agent.ts made the identical call) and because the builds and
// tests it ran were never read by anything downstream while costing the single global job slot.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  fileURLToPath(new URL('./agent.ts', import.meta.url)),
  'utf8',
);

function toolList(name: string, source: string = SRC): string[] {
  const start = source.indexOf(`const ${name} = [`);
  expect(start, `${name} not found in coding/agent.ts`).toBeGreaterThan(-1);
  const end = source.indexOf('];', start);
  expect(end).toBeGreaterThan(start);
  const body = source
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
}

// `Bash` and every `Bash(…)` command pattern alike. The patterns matter as much as the bare
// name: re-admitting the shell behind a longer blocklist is the specific thing that was rejected.
const isShell = (tool: string): boolean => /^Bash\b|^Bash\(/.test(tool);
// A `(` in a DENY entry means someone is enumerating commands again, which is not a boundary.
const isPattern = (tool: string): boolean => tool.includes('(');

describe('the coding agent runs without a shell', () => {
  it('the fixer can edit but cannot reach Bash', () => {
    const allowed = toolList('FIX_TOOLS');
    // Sanity: the scan is reading a real list, and the run is still a WRITE run.
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Edit');
    expect(allowed).toContain('mcp__fix__submit_fix');
    expect(allowed.filter(isShell)).toEqual([]);
  });

  it('denies Bash outright rather than by command prefix', () => {
    const denied = toolList('DISALLOWED_TOOLS');
    expect(denied).toContain('Bash');
    expect(denied.filter(isPattern)).toEqual([]);
  });
});

describe('the fixer is confined to its worktree', () => {
  // The fixer WRITES under bypassPermissions; without this hook an absolute path (~/.zshrc) in a
  // seed item would be written outside the worktree. Behaviour: review/path-guard.test.ts.
  // Since the provider seam (ai/provider.ts) the hook is built by the provider from the run's cwd and
  // roots (ai/providers/claude.ts), so the pin is split in two: the fixer hands the worktree as cwd
  // with NO other root, and the provider puts the path guard over exactly cwd + roots FIRST on
  // PreToolUse, then the own-tools-only hook for the run's own servers (its result tools, plus
  // `checks` when "Run tests" hands it run_check — and nothing else).
  it('runs behind the path guard rooted at the worktree', () => {
    // No other READ-WRITE root, ever. Read-only roots (a story build's earlier worktrees, never a fix's)
    // can only be read: the path guard refuses any other tool there (review/path-guard.ts).
    expect(SRC).toContain('cwd: opts.worktreePath,\n    roots: [],\n    readOnlyRoots: opts.readOnlyRoots ?? [],');
    expect(SRC).toContain('writeRoots: opts.writes ? [opts.worktreePath] : [],');
    const provider = readFileSync(fileURLToPath(new URL('../ai/providers/claude.ts', import.meta.url)), 'utf8');
    expect(provider).toContain('const guard = createPathGuard(spec.cwd, spec.roots, { readOnlyRoots: spec.readOnlyRoots });');
    expect(provider).toMatch(
      /PreToolUse: \[\s*pathGuardHook\(guard\),\s*ownToolsOnlyHook\(ownServers\),/,
    );
    expect(provider).toContain('const ownServers = Object.keys(mcpServers);');
  });
});

describe('the scan actually catches the shell coming back', () => {
  const reAdd = (name: string, entry: string): string => {
    const at = SRC.indexOf(`const ${name} = [`);
    const open = SRC.indexOf('[', at) + 1;
    return `${SRC.slice(0, open)}'${entry}',${SRC.slice(open)}`;
  };

  it('fails on a bare Bash in the fixer allow list', () => {
    expect(toolList('FIX_TOOLS', reAdd('FIX_TOOLS', 'Bash')).filter(isShell)).toEqual([
      'Bash',
    ]);
  });

  it('fails on a command-pattern deny entry', () => {
    const mutated = reAdd('DISALLOWED_TOOLS', 'Bash(git push *)');
    expect(toolList('DISALLOWED_TOOLS', mutated).filter(isPattern)).toEqual([
      'Bash(git push *)',
    ]);
  });

  it('is not fooled by the word Bash inside a comment', () => {
    // The comment above FIX_TOOLS names `'Bash'` in quotes several times, on purpose — it is the
    // record of why it was removed. If the `//` filter ever stopped working, the first test in
    // this file would pass for the wrong reason, so pin it: a comment line INSIDE the literal
    // must still read as no entry at all.
    const at = SRC.indexOf('const FIX_TOOLS = [');
    const open = SRC.indexOf('[', at) + 1;
    const mutated = `${SRC.slice(0, open)}\n  // re-add 'Bash' one day?${SRC.slice(open)}`;
    expect(toolList('FIX_TOOLS', mutated).filter(isShell)).toEqual([]);
  });
});

// PLAN MODE (ai-fix/plan.ts): the planning pass is READ-ONLY. Its allow list carries no write tool
// and no shell, and every write tool is ALSO denied outright — so even a later edit re-adding one to
// the allow list cannot let a plan pass change the worktree the build is about to edit.
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

describe('the plan pass reads and cannot write', () => {
  it('allows only reading tools and submit_plan', () => {
    expect(toolList('PLAN_TOOLS')).toEqual(['Read', 'Glob', 'Grep', 'mcp__plan__submit_plan']);
  });

  it('denies Bash and every write tool outright', () => {
    const denied = toolList('PLAN_DISALLOWED_TOOLS');
    for (const t of ['Bash', ...WRITE_TOOLS]) expect(denied).toContain(t);
    expect(denied.filter(isPattern)).toEqual([]);
  });

  it('runs through the same worktree runner, behind the same path guard', () => {
    // runPlanAgent hands its lists to runAgentInWorktree, whose `hooks:` line the fixer test above
    // pins — one runner, one guard.
    expect(SRC).toContain('allowedTools: PLAN_TOOLS,');
    expect(SRC).toContain('disallowedTools: PLAN_DISALLOWED_TOOLS,');
  });

  it('the scan catches a write tool coming back to the plan allow list', () => {
    const at = SRC.indexOf('const PLAN_TOOLS = [');
    const open = SRC.indexOf('[', at) + 1;
    const mutated = `${SRC.slice(0, open)}'Edit',${SRC.slice(open)}`;
    expect(toolList('PLAN_TOOLS', mutated).filter((t) => WRITE_TOOLS.includes(t))).toEqual(['Edit']);
  });
});

// "RUN TESTS" (coding/checks/): the fixer may run the project's own checks through ONE extra tool,
// `run_check`, which takes a check NAME — never a command. The shell stays denied either way.
describe('"Run tests" adds run_check and nothing else', () => {
  it('FIX_TOOLS_WITH_CHECKS is FIX_TOOLS plus the one checks tool, still no shell', async () => {
    const start = SRC.indexOf('const FIX_TOOLS_WITH_CHECKS = [');
    expect(start).toBeGreaterThan(-1);
    const line = SRC.slice(start, SRC.indexOf('];', start) + 2);
    expect(line).toBe("const FIX_TOOLS_WITH_CHECKS = [...FIX_TOOLS, 'mcp__checks__run_check'];");
    const { CHECKS_TOOL_SERVER, RUN_CHECK_TOOL } = await import('../ai/check-tool.js');
    expect(`mcp__${CHECKS_TOOL_SERVER}__${RUN_CHECK_TOOL}`).toBe('mcp__checks__run_check');
    // Whatever the allow list, a run with checks is still handed DISALLOWED_TOOLS (Bash denied).
    expect(SRC).toMatch(/allowedTools: checkTool \? FIX_TOOLS_WITH_CHECKS : FIX_TOOLS,\s*\n\s*disallowedTools: DISALLOWED_TOOLS,/);
  });
});
