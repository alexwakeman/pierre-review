// "Copy all" on the Claude Review tab's Findings section (`lib/findingsMarkdown.ts`): one markdown
// string of every finding the reader has not set aside.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeFinding } from '@pierre-review/shared';
import {
  copyableFindings,
  findingMarkdownBlock,
  findingsMarkdown,
  isIgnoredFinding,
} from '../src/lib/findingsMarkdown.js';

let nextId = 1;
function finding(over: Partial<ClaudeFinding> = {}): ClaudeFinding {
  return {
    id: nextId++,
    reviewId: 1,
    path: 'src/a.ts',
    line: 12,
    side: 'RIGHT',
    diffAnchorId: 'x',
    severity: 'warning',
    title: 'Null deref',
    body: 'This can be null.',
    editedBody: null,
    suggestion: null,
    diffHunk: null,
    anchored: true,
    fileInDiff: true,
    included: true,
    postedAt: null,
    githubCommentId: null,
    postedCommentKind: null,
    createdAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

describe('findingMarkdownBlock', () => {
  it('heading, path:line, body', () => {
    expect(findingMarkdownBlock(finding())).toBe(
      '### Warning: Null deref\n\n`src/a.ts:12`\n\nThis can be null.',
    );
  });

  it('a PR-level finding (no file) says Whole PR', () => {
    const block = findingMarkdownBlock(finding({ path: '', line: null, severity: 'blocker', title: 'AC2 not met' }));
    expect(block.split('\n\n').slice(0, 2)).toEqual(['### Blocker: AC2 not met', 'Whole PR']);
  });

  it('a file-level finding with no line names the file alone', () => {
    expect(findingMarkdownBlock(finding({ line: null }))).toContain('\n\n`src/a.ts`\n\n');
  });

  it("the reader's reword wins over Claude's body", () => {
    const block = findingMarkdownBlock(finding({ editedBody: 'Guard it before use.' }));
    expect(block).toContain('Guard it before use.');
    expect(block).not.toContain('This can be null.');
  });

  it('a blank reword does not wipe the body', () => {
    expect(findingMarkdownBlock(finding({ editedBody: '   ' }))).toContain('This can be null.');
  });

  it('the suggestion goes in a fenced block', () => {
    expect(findingMarkdownBlock(finding({ suggestion: 'if (x) y();' }))).toMatch(
      /\n\n```suggestion\nif \(x\) y\(\);\n```$/,
    );
  });
});

describe('findingsMarkdown', () => {
  it('separates findings with a line holding only ---', () => {
    const out = findingsMarkdown([finding({ title: 'A' }), finding({ title: 'B' })], true);
    const blocks = out.split('\n\n---\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatch(/^### Warning: A/);
    expect(blocks[1]).toMatch(/^### Warning: B/);
    expect(out.split('\n').filter((l) => l === '---')).toHaveLength(1);
  });

  it('leaves out ignored findings and praise', () => {
    const out = findingsMarkdown(
      [
        finding({ title: 'Kept' }),
        finding({ title: 'Ignored', included: false }),
        finding({ title: 'Nice', severity: 'praise' }),
      ],
      true,
    );
    expect(out).toContain('Kept');
    expect(out).not.toContain('Ignored');
    expect(out).not.toContain('Nice');
    expect(out).not.toContain('---');
  });

  it('ignores `included` where the card shows no Ignore state (older run, or posted)', () => {
    expect(isIgnoredFinding({ included: false, postedAt: null }, false)).toBe(false);
    expect(isIgnoredFinding({ included: false, postedAt: '2026-10-01T00:00:00Z' }, true)).toBe(false);
    expect(isIgnoredFinding({ included: false, postedAt: null }, true)).toBe(true);
    expect(copyableFindings([finding({ included: false })], false)).toHaveLength(1);
  });

  it('is empty when nothing is copyable', () => {
    expect(findingsMarkdown([finding({ included: false })], true)).toBe('');
  });
});

describe('mount', () => {
  it('the Copy all button is mounted once, in the Findings header', () => {
    const src = readFileSync(join(new URL('../src', import.meta.url).pathname, 'components/ClaudeReviewTab.tsx'), 'utf8');
    expect(src.match(/<CopyAllFindingsButton /g)).toHaveLength(1);
  });
});
