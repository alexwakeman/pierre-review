// The Claude Review tab's "Review threads" section: the pure ordering / pill helpers, and the
// source guards (mounted once, plain text, one safe href).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { threadAssessmentCounts } from '@pierre-review/shared';
import type {
  ClaudeThreadAddressed,
  ClaudeThreadAssessment,
  ClaudeThreadValidity,
} from '@pierre-review/shared';
import {
  isThreadSettled,
  partitionThreads,
  threadAddressedClass,
  threadCountPills,
  threadNotCheckedReason,
} from '../src/lib/claudeReviewFollowUp.js';

let nextId = 1;
function thread(
  validity: ClaudeThreadValidity,
  addressed: ClaudeThreadAddressed,
  extra: Partial<ClaudeThreadAssessment> = {},
): ClaudeThreadAssessment {
  const id = nextId++;
  return {
    ref: `R${id}`,
    threadId: id,
    sent: true,
    carried: false,
    authorLogin: 'someone',
    authorIsBot: false,
    path: 'src/a.ts',
    line: 10,
    excerpt: 'x',
    commentCount: 1,
    lastCommentAt: null,
    url: null,
    validity,
    addressed,
    explanation: null,
    draftReply: null,
    assessedAtHead: 'abcdef1234567',
    ...extra,
  };
}

describe('partitionThreads', () => {
  it('puts still-to-fix first, then other open ones, then not checked; settled behind more', () => {
    const notChecked = thread('not_checked', 'not_checked');
    const unclear = thread('unclear', 'unclear');
    const fixed = thread('valid', 'addressed');
    const toFix1 = thread('valid', 'not_addressed');
    const wrong = thread('not_valid', 'not_addressed');
    const toFix2 = thread('partly_valid', 'partly_addressed');
    const { shown, more } = partitionThreads([notChecked, unclear, fixed, toFix1, wrong, toFix2]);
    expect(shown.map((t) => t.threadId)).toEqual([
      toFix1.threadId,
      toFix2.threadId,
      unclear.threadId,
      notChecked.threadId,
    ]);
    expect(more.map((t) => t.threadId)).toEqual([fixed.threadId, wrong.threadId]);
  });

  it('never hides a still-to-fix thread', () => {
    for (const v of ['valid', 'partly_valid'] as const) {
      for (const a of ['not_addressed', 'partly_addressed'] as const) {
        expect(isThreadSettled(thread(v, a))).toBe(false);
      }
    }
    expect(isThreadSettled(thread('unclear', 'addressed'))).toBe(true);
    expect(isThreadSettled(thread('not_valid', 'unclear'))).toBe(true);
    expect(isThreadSettled(thread('unclear', 'unclear'))).toBe(false);
  });

  it('is empty for an empty list', () => {
    expect(partitionThreads([])).toEqual({ shown: [], more: [] });
  });
});

describe('threadCountPills', () => {
  it('leaves out zeros and keeps the fixed order', () => {
    const counts = threadAssessmentCounts([
      thread('valid', 'not_addressed'),
      thread('valid', 'not_addressed'),
      thread('not_checked', 'not_checked'),
    ]);
    expect(threadCountPills(counts).map((p) => p.label)).toEqual([
      '2 still to fix',
      '1 not checked',
    ]);
  });

  it('paints still to fix red and not checked grey, never amber', () => {
    const pills = threadCountPills({
      total: 4,
      assessed: 3,
      validUnaddressed: 1,
      notValid: 1,
      addressed: 1,
      notChecked: 1,
    });
    expect(pills.map((p) => p.key)).toEqual(['toFix', 'addressed', 'notValid', 'notChecked']);
    expect(pills[0]?.cls).toMatch(/red/);
    expect(pills[3]?.cls).toMatch(/gray/);
    expect(pills[3]?.cls).not.toMatch(/amber|orange/);
  });
});

it('a not-valid comment never wears a red "Not addressed"', () => {
  expect(threadAddressedClass(thread('valid', 'not_addressed'))).toMatch(/red/);
  expect(threadAddressedClass(thread('not_valid', 'not_addressed'))).not.toMatch(/red/);
});

it('threadNotCheckedReason tells over-the-cap apart from unreported', () => {
  expect(threadNotCheckedReason({ sent: true })).not.toBe(threadNotCheckedReason({ sent: false }));
});

// ---- source guards ----

const SRC = new URL('../src', import.meta.url).pathname;
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('source guards', () => {
  it('mounts the section exactly once', () => {
    const all = walk(SRC)
      .map((f) => code(readFileSync(f, 'utf8')))
      .join('\n');
    expect(all.match(/<ClaudeReviewThreadsSection\b/g) ?? []).toHaveLength(1);
  });

  it('renders comment and Claude text as plain text, with one href through safeExternalUrl', () => {
    const src = code(readFileSync(join(SRC, 'components/ClaudeReviewThreads.tsx'), 'utf8'));
    expect(src).not.toMatch(/Markdown/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src.match(/\bhref=/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/href=\{href\}/);
    expect(src).toMatch(/const href = safeExternalUrl\(t\.url\)/);
  });
});
