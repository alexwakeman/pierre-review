// The Claude Review tab's "CI failures" section: the pure helpers (when it shows, order, pills,
// sentences) and the source guards (mounted once, plain text, one safe href, never a log URL).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeCiFailure } from '@pierre-review/shared';
import {
  ciCountPills,
  ciFailingLabel,
  ciNotCheckedSentence,
  ciSectionMode,
  orderCiFailures,
} from '../src/lib/claudeReviewCi.js';

const root = join(__dirname, '..', 'src');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

let n = 0;
function failure(extra: Partial<ClaudeCiFailure> = {}): ClaudeCiFailure {
  n += 1;
  return {
    ref: `F${n}`,
    checkName: `check-${n}`,
    jobId: n,
    step: null,
    url: null,
    sent: true,
    carried: false,
    status: 'diagnosed',
    notCheckedReason: null,
    cause: 'c',
    explanation: 'e',
    category: 'code',
    fixableInPr: true,
    relatedFiles: [],
    assessedAtHead: 'abc',
    ...extra,
  };
}
const notChecked = (reason: ClaudeCiFailure['notCheckedReason']): ClaudeCiFailure =>
  failure({ status: 'not_checked', notCheckedReason: reason, cause: null, explanation: null, category: null, fixableInPr: null });

describe('ciSectionMode', () => {
  it('null = did not look: nothing renders', () => {
    expect(ciSectionMode({ ciFailures: null, ciState: null })).toBe('hidden');
    expect(ciSectionMode({})).toBe('hidden');
  });
  it('[] on a green head says CI passing; on a running head says so; no checks says nothing', () => {
    expect(ciSectionMode({ ciFailures: [], ciState: { state: 'passing', checkCount: 4 } })).toBe('passing');
    expect(ciSectionMode({ ciFailures: [], ciState: { state: 'pending', checkCount: 4 } })).toBe('pending');
    expect(ciSectionMode({ ciFailures: [], ciState: { state: 'none', checkCount: 0 } })).toBe('hidden');
  });
  it('any failure lists', () => {
    expect(ciSectionMode({ ciFailures: [failure()], ciState: { state: 'failing', checkCount: 1 } })).toBe('list');
  });
});

describe('order, pills and sentences', () => {
  it('fixable here first, then other diagnoses, then the unchecked — stable', () => {
    const a = notChecked('no_log');
    const b = failure({ fixableInPr: false, category: 'flaky_or_infra' });
    const c = failure();
    const d = failure();
    expect(orderCiFailures([a, b, c, d])).toEqual([c, d, b, a]);
  });
  it('pills count each population and leave zeros out', () => {
    expect(ciCountPills([failure(), failure({ fixableInPr: false }), notChecked('over_cap')]).map((p) => p.label)).toEqual([
      '1 fixable here',
      '1 not from this change',
      '1 not checked',
    ]);
    expect(ciCountPills([failure()]).map((p) => p.key)).toEqual(['fixable']);
  });
  it('a not-checked row names its own reason, never a cause', () => {
    expect(ciNotCheckedSentence('no_log')).toMatch(/No log available/);
    expect(ciNotCheckedSentence('log_unavailable')).toMatch(/couldn't be read/);
    expect(ciNotCheckedSentence('over_cap')).toMatch(/too many failing checks/);
    expect(ciNotCheckedSentence('not_reported')).toMatch(/didn't report/);
    expect(ciFailingLabel(1)).toBe('1 failing check');
    expect(ciFailingLabel(3)).toBe('3 failing checks');
  });
});

describe('source guards', () => {
  // Code only: the header comment names what the file must not do.
  const src = read('components/ClaudeReviewCiFailures.tsx')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
  it('renders model text as plain text, its one href through safeExternalUrl', () => {
    expect(src).not.toMatch(/Markdown/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src.match(/href=/g)?.length).toBe(1);
    expect(src).toMatch(/const href = safeExternalUrl\(f\.url\)/);
    expect(src).not.toMatch(/logs?Url|blob/i);
  });
  it('is mounted exactly once, in the review tab', () => {
    const tab = read('components/ClaudeReviewTab.tsx');
    expect(tab.match(/<ClaudeReviewCiFailuresSection/g)?.length).toBe(1);
  });
});
