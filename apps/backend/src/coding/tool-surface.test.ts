// THE FIX AGENT HAS NO SHELL — and neither does the conflict resolver.
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

describe('the coding agents run without a shell', () => {
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

  it('the conflict resolver still has none either', () => {
    expect(toolList('RESOLVE_TOOLS').filter(isShell)).toEqual([]);
    expect(toolList('RESOLVE_DISALLOWED_TOOLS')).toContain('Bash');
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
