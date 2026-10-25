// THE PROMPT SEAM FOR TOOL NAMES (ai/prompt-tools.ts). What this pins:
//   1. ⚠ CLAUDE IS BYTE-IDENTICAL: rendering drops the braces around a known tool name and touches
//      nothing else — so a prompt ported onto `{Read}` refs renders exactly today's text for Claude;
//   2. every prompt source in the tree renders to ITSELF for Claude today (no stray `{Read}` that the
//      seam would silently rewrite), so adopting it cannot move a prompt-golden byte;
//   3. Codex gets its own names (the workspace MCP tools, apply_patch) and the final-answer sentence;
//   4. a brace that is not a known tool (a JSON shape in prose) is text, on both providers.
//
//   pnpm --filter @pierre-review/backend test ai/prompt-tools
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODEX_FINAL_ANSWER_SENTENCE,
  either,
  promptTools,
  renderToolRefs,
  submitSentence,
  toolName,
} from './prompt-tools.js';

const SAMPLE =
  '- You may use {Read}, {Glob} and {Grep}, and {Write}/{Edit}/{MultiEdit} to fix. No {Bash}.\nWhen you are done, call {submit_review} EXACTLY ONCE with { summary, failures }.';

describe('Claude: byte-identical', () => {
  it('drops the braces around a known name and nothing else', () => {
    expect(renderToolRefs(SAMPLE, 'claude')).toBe(
      '- You may use Read, Glob and Grep, and Write/Edit/MultiEdit to fix. No Bash.\nWhen you are done, call submit_review EXACTLY ONCE with { summary, failures }.',
    );
    expect(toolName('Read', 'claude')).toBe('Read');
    expect(toolName('submit_fix', 'claude')).toBe('submit_fix');
    const s = 'Call submit_paths once with the whole answer.';
    expect(submitSentence(s, 'claude')).toBe(s);
    expect(either('a', 'b', 'claude')).toBe('a');
  });

  it('every prompt source in the tree renders to itself today', () => {
    const SRC = join(import.meta.dirname, '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== 'node_modules') walk(p);
        } else if (/prompts?\.ts$/.test(name) && !name.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(renderToolRefs(text, 'claude'), f).toBe(text);
    }
    const golden = readFileSync(join(SRC, 'review/claude-review/__fixtures__/prompt-golden.json'), 'utf8');
    expect(renderToolRefs(golden, 'claude')).toBe(golden);
  });
});

describe('Codex: its own tools and the final answer', () => {
  it('renames each tool, and a result tool becomes the final JSON answer', () => {
    expect(renderToolRefs(SAMPLE, 'codex')).toBe(
      '- You may use read_file, list_files and search, and apply_patch/apply_patch/apply_patch to fix. No shell.\nWhen you are done, call your final JSON answer EXACTLY ONCE with { summary, failures }.',
    );
    expect(toolName('record_sections', 'codex')).toBe('your final JSON answer');
    expect(toolName('finish_document', 'codex')).toBe('your final JSON answer');
    expect(toolName('SomethingElse', 'codex')).toBe('SomethingElse');
    expect(submitSentence('Call submit_paths once with the whole answer.', 'codex')).toBe(CODEX_FINAL_ANSWER_SENTENCE);
    expect(either('a', 'b', 'codex')).toBe('b');
  });

  it('a bound set says the same', () => {
    const t = promptTools('codex');
    expect(t.provider).toBe('codex');
    expect(t.render('{Grep} the {tree}')).toBe('search the {tree}');
    expect(t.name('Glob')).toBe('list_files');
    expect(promptTools('claude').render('{Grep} the {tree}')).toBe('Grep the {tree}');
  });
});
