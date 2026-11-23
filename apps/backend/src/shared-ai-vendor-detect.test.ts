// AI VENDOR DETECTION (packages/shared/src/ai-vendor-detect.ts; docs/AI-ADOPTION-REPORT.md § Detection).
//
// What this pins:
//   1. Every marker has a POSITIVE fixture and every known near-miss a NEGATIVE one
//      (sync/__fixtures__/ai-vendors/). Each fixture's EXACT signal list is asserted.
//   2. HIGH PRECISION: a tool's name in prose, a person who shares a tool's name or login, a review
//      bot, a non-AI Ensemble run (conflict, auto-merge, deps, update-branch) are never a signal.
//   3. The text is attacker-authored: pathological inputs (a megabyte of spaces, of '<', a trailer
//      with no closing bracket) finish fast.
//   4. The stored-JSON helpers: NULL = never scanned, malformed or unknown entries drop, never throw.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AI_CODING_VENDORS,
  AI_CODING_VENDOR_LABEL,
  AI_CODING_VENDOR_MAKER,
  AI_SIGNAL_SOURCES,
  AI_SIGNAL_SOURCE_LABEL,
  AI_SIGNALS_VERSION,
  aiVendorsOf,
  detectAiCommitSignals,
  detectAiPrSignals,
  mergeAiSignals,
  parseStoredAiSignals,
  serializeAiSignals,
  sortAiSignals,
  type AiCommitSignalInput,
  type AiPrSignalInput,
  type AiSignal,
} from '@pierre-review/shared';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'sync', '__fixtures__', 'ai-vendors');

interface Fixture<T> {
  name: string;
  provenance: 'observed' | 'documented' | 'unconfirmed' | 'negative';
  input: T & { messageFile?: string; bodyTextFile?: string; bodyFile?: string };
  expect: AiSignal[];
}

const text = (file: string): string => readFileSync(join(DIR, file), 'utf8');

function load<T>(file: string): Fixture<T>[] {
  return JSON.parse(text(file)) as Fixture<T>[];
}

function commitInput(f: Fixture<AiCommitSignalInput>): AiCommitSignalInput {
  const { messageFile, ...rest } = f.input;
  return messageFile ? { ...rest, message: text(messageFile) } : rest;
}

function prInput(f: Fixture<AiPrSignalInput>): AiPrSignalInput {
  const { bodyTextFile, bodyFile, ...rest } = f.input;
  return {
    ...rest,
    ...(bodyTextFile ? { bodyText: text(bodyTextFile) } : {}),
    ...(bodyFile ? { body: text(bodyFile) } : {}),
  };
}

const COMMITS = load<AiCommitSignalInput>('commits.json');
const PRS = load<AiPrSignalInput>('prs.json');

describe('detectAiCommitSignals — fixtures', () => {
  it.each(COMMITS.map((f) => [f.name, f] as const))('%s', (_name, f) => {
    expect(detectAiCommitSignals(commitInput(f))).toEqual(f.expect);
  });
});

describe('detectAiPrSignals — fixtures', () => {
  it.each(PRS.map((f) => [f.name, f] as const))('%s', (_name, f) => {
    expect(detectAiPrSignals(prInput(f))).toEqual(f.expect);
  });
});

describe('fixture coverage', () => {
  it('has a positive for every vendor except Ensemble-on-read, and negatives for both kinds', () => {
    const seen = new Set<string>();
    for (const f of [...COMMITS, ...PRS]) for (const s of f.expect) seen.add(s.vendor);
    for (const v of AI_CODING_VENDORS) expect(seen.has(v), v).toBe(true);
    expect(COMMITS.filter((f) => f.provenance === 'negative').length).toBeGreaterThanOrEqual(5);
    expect(PRS.filter((f) => f.provenance === 'negative').length).toBeGreaterThanOrEqual(5);
    for (const f of [...COMMITS, ...PRS]) {
      expect(f.provenance === 'negative', f.name).toBe(f.expect.length === 0);
    }
  });

  it('has a positive for every source the detector writes (ensemble is added on read)', () => {
    const seen = new Set<string>();
    for (const f of [...COMMITS, ...PRS]) for (const s of f.expect) seen.add(s.source);
    for (const src of AI_SIGNAL_SOURCES.filter((s) => s !== 'ensemble')) expect(seen.has(src), src).toBe(true);
  });
});

describe('precision rules', () => {
  it('reads a co-author trailer case-blind and only at the start of a line', () => {
    expect(detectAiCommitSignals({ message: 'x\n\nco-authored-by: Claude <NOREPLY@ANTHROPIC.COM>' })).toEqual([
      { vendor: 'claude', source: 'commit_trailer' },
    ]);
    expect(detectAiCommitSignals({ message: 'x\n\nSee Co-authored-by: Claude <noreply@anthropic.com>' })).toEqual([]);
  });

  it('counts a login as a bot only when GitHub types it Bot or it carries [bot]', () => {
    expect(detectAiPrSignals({ authorLogin: 'claude', authorType: 'User' })).toEqual([]);
    expect(detectAiPrSignals({ authorLogin: 'claude', authorType: 'Bot' })).toEqual([{ vendor: 'claude', source: 'pr_author' }]);
    expect(detectAiPrSignals({ authorLogin: 'claude[bot]' })).toEqual([{ vendor: 'claude', source: 'pr_author' }]);
    expect(detectAiPrSignals({ authorLogin: 'devin-ai-integration', authorType: 'User' })).toEqual([]);
    // GitHub's own reserved Copilot account.
    expect(detectAiPrSignals({ authorLogin: 'Copilot', authorType: 'Bot' })).toEqual([{ vendor: 'copilot', source: 'pr_author' }]);
  });

  it('never reads an Ensemble run that is not AI work', () => {
    for (const ref of ['conflict/4', 'auto-merge/9', 'deps/2', 'update-branch', 'ai-fixes', 'story-builds']) {
      expect(detectAiCommitSignals({ message: `x\n\nEnsemble-Run: ${ref}` }), ref).toEqual([]);
    }
    expect(detectAiCommitSignals({ message: 'x\n\nensemble-run: ai-fix/1' })).toEqual([{ vendor: 'ensemble', source: 'commit_trailer' }]);
  });

  it('reads both the markdown body and bodyText, once per (vendor, source)', () => {
    const got = detectAiPrSignals({ bodyText: text('pr-bodytext-claude-code.txt'), body: text('pr-body-claude-code.md') });
    expect(got).toEqual([{ vendor: 'claude', source: 'pr_body' }]);
  });

  it('ignores a marker past the text cap', () => {
    const late = `${'x\n'.repeat(700)}Co-Authored-By: Claude <noreply@anthropic.com>`;
    expect(detectAiCommitSignals({ message: late })).toEqual([]);
  });

  it('counts a footer phrase only at the start of a line or title, never inside a sentence or quotes', () => {
    expect(
      detectAiPrSignals({
        title: "Strip the 'Generated with Claude Code' footer from commit messages",
        bodyText: 'We no longer want the "Generated with Claude Code" line. Also stop links like chatgpt.com/codex/tasks/ in docs.',
      }),
    ).toEqual([]);
    expect(detectAiCommitSignals({ message: 'Docs: explain that commits are generated with Claude Code when the flag is on' })).toEqual([]);
    expect(detectAiCommitSignals({ message: 'x\n\n`Generated with Claude Code`' })).toEqual([]);
    expect(detectAiPrSignals({ title: 'Generated with Claude Code: add the export button' })).toEqual([{ vendor: 'claude', source: 'pr_title' }]);
    expect(detectAiPrSignals({ bodyText: '  🤖 Generated with Claude Code' })).toEqual([{ vendor: 'claude', source: 'pr_body' }]);
  });

  it('counts a task URL only as the tool writes it: a line of its own, a link target, or after a label', () => {
    const codex = [{ vendor: 'codex', source: 'pr_body' }];
    expect(detectAiPrSignals({ bodyText: 'https://chatgpt.com/codex/tasks/task_e_1' })).toEqual(codex);
    expect(detectAiPrSignals({ bodyText: 'Codex task: https://chatgpt.com/codex/tasks/task_e_1' })).toEqual(codex);
    expect(detectAiPrSignals({ body: '[task](https://chatgpt.com/codex/tasks/task_e_1)' })).toEqual(codex);
    expect(detectAiPrSignals({ bodyText: 'stop links like chatgpt.com/codex/tasks/ in docs' })).toEqual([]);
    expect(detectAiPrSignals({ bodyText: 'links like https://chatgpt.com/codex/tasks/task_e_1 break' })).toEqual([]);
    expect(detectAiPrSignals({ bodyText: 'https://chatgpt.com/codex/tasks/' })).toEqual([]);
    expect(detectAiPrSignals({ bodyText: '> https://chatgpt.com/codex/tasks/task_e_1' })).toEqual([]);
  });

  it('a branch prefix only corroborates the same vendor, never counts alone', () => {
    expect(detectAiPrSignals({ authorLogin: 'alice', authorType: 'User', headRefName: 'claude/fix-typo' })).toEqual([]);
    expect(detectAiPrSignals({ authorLogin: 'alice', authorType: 'User', headRefName: 'copilot/cleanup' })).toEqual([]);
    expect(detectAiPrSignals({ bodyText: 'https://claude.ai/code/session_01Ab', headRefName: 'claude/keen-faraday' })).toEqual([
      { vendor: 'claude', source: 'pr_body' },
      { vendor: 'claude', source: 'pr_branch' },
    ]);
    expect(detectAiPrSignals({ bodyText: '🤖 Generated with Claude Code', headRefName: 'codex/tidy' })).toEqual([{ vendor: 'claude', source: 'pr_body' }]);
  });

  it('absent and null fields are simply not read', () => {
    expect(detectAiCommitSignals({})).toEqual([]);
    expect(detectAiPrSignals({ title: null, bodyText: null, body: null, headRefName: null, authorLogin: null, authorType: null })).toEqual([]);
  });
});

describe('pathological input finishes fast', () => {
  const MB = 1024 * 1024;
  const cases: [string, string][] = [
    ['a megabyte line of spaces', ' '.repeat(MB)],
    ["a megabyte line of '<'", '<'.repeat(MB)],
    ['a trailer with a megabyte of unclosed brackets', `x\n\nCo-authored-by: ${'<'.repeat(MB)}`],
    ['a megabyte of near-miss phrases', 'generated with generated by '.repeat(MB / 28)],
    ['a megabyte of newlines', '\n'.repeat(MB)],
    ['a megabyte of near-miss URLs', 'chatgpt.com/codex/task'.repeat(MB / 22)],
  ];
  it.each(cases)('%s', (_name, input) => {
    const t0 = performance.now();
    detectAiCommitSignals({ message: input, authorName: input, authorEmail: input, committerName: input });
    detectAiPrSignals({ title: input, bodyText: input, body: input, headRefName: input, authorLogin: input });
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('stored JSON', () => {
  const list: AiSignal[] = [
    { vendor: 'copilot', source: 'pr_author' },
    { vendor: 'claude', source: 'commit_trailer' },
    { vendor: 'claude', source: 'commit_author' },
  ];

  it('serialises in canonical order and round-trips', () => {
    const json = serializeAiSignals(list);
    expect(JSON.parse(json)).toEqual([
      { vendor: 'claude', source: 'commit_author' },
      { vendor: 'claude', source: 'commit_trailer' },
      { vendor: 'copilot', source: 'pr_author' },
    ]);
    expect(parseStoredAiSignals(json)).toEqual(sortAiSignals(list));
  });

  it('NULL is never scanned; [] is scanned clean; junk drops, never throws', () => {
    expect(parseStoredAiSignals(null)).toBeNull();
    expect(parseStoredAiSignals(undefined)).toBeNull();
    expect(parseStoredAiSignals('[]')).toEqual([]);
    expect(parseStoredAiSignals('not json')).toEqual([]);
    expect(parseStoredAiSignals('{"vendor":"claude"}')).toEqual([]);
    expect(
      parseStoredAiSignals('[{"vendor":"claude","source":"pr_body"},{"vendor":"mystery","source":"pr_body"},{"vendor":"claude","source":"telepathy"},null,7]'),
    ).toEqual([{ vendor: 'claude', source: 'pr_body' }]);
  });

  it('merges and dedupes across lists, and lists vendors in vendor order', () => {
    const merged = mergeAiSignals(list, null, [{ vendor: 'claude', source: 'commit_author' }, { vendor: 'ensemble', source: 'ensemble' }]);
    expect(merged).toHaveLength(4);
    expect(aiVendorsOf(merged)).toEqual(['claude', 'copilot', 'ensemble']);
  });
});

describe('vocabulary', () => {
  it('labels every vendor and source with no digits (the commentary digit gate allows them)', () => {
    for (const v of AI_CODING_VENDORS) {
      expect(AI_CODING_VENDOR_LABEL[v]).toMatch(/^[^\p{Nd}\p{No}\p{Nl}]+$/u);
      expect(AI_CODING_VENDOR_MAKER[v].length).toBeGreaterThan(0);
    }
    for (const s of AI_SIGNAL_SOURCES) expect(AI_SIGNAL_SOURCE_LABEL[s]).toMatch(/^[^\p{Nd}\p{No}\p{Nl}]+$/u);
    // Version 2: footer phrases anchored to a line's start, task URLs as written, branches corroborate only.
    expect(AI_SIGNALS_VERSION).toBe(2);
  });
});
