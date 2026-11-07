// ── OPEN POINTS IN A PR REVIEW (docs/CLAUDE-REVIEW.md § Open points) ────────────────────────────────
// Pinned here:
//   1. THE PROMPT: no open points ⇒ byte-identical to the golden prompts (no section, no field); with
//      them, the "Open points on the ticket" section is pinned whole (golden `worktreeOpenPoints`), the
//      nonce scan sees every point, and the Codex rendering keeps no Claude-only word.
//   2. THE TOOL SHAPE: `openPoints` only when asked; otherwise the shape's keys are unchanged.
//   3. RECONCILE: every point shown is kept; only refs that were sent carry code; code is capped/clipped.
//   4. THE POSTED BODY: the section says it does not affect the outcome; before the auto footer; the
//      stored copy is named; a pair merges both halves' code.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildUserPrompt, untrustedTexts } from './prompts.js';
import {
  mergeOpenPoints,
  openPointsForPrompt,
  openPointsFromStored,
  openPointsPostBlock,
  reconcileOpenPoints,
  withOpenPointsBeforeFooter,
  withOpenPointsBlock,
} from './open-points.js';
import { CLAUDE_ONLY_WORDS, codexReviewUserPrompt } from '../codex-wording.js';
import { buildSubmitReviewShape } from '../schema.js';
import { loadZod } from '../../ai/runtime.js';

const golden = JSON.parse(readFileSync(new URL('./__fixtures__/prompt-golden.json', import.meta.url), 'utf8')) as Record<string, string>;

const base = {
  repoFullName: 'acme/api',
  prNumber: 42,
  title: 'Add password reset',
  body: 'Adds a reset link.\n\nSee ticket.',
  headSha: 'b'.repeat(40),
  baseRef: 'main',
  changedFiles: ['src/reset.ts', 'src/mail.ts'],
  excludedFiles: ['pnpm-lock.yaml'],
  diff: 'diff --git a/src/reset.ts b/src/reset.ts\n@@ -1,1 +1,2 @@\n a\n+b',
};
const NONCE = '0123456789abcdef';
const POINTS = [
  { ref: 'OP1', ticketKey: 'ENG-12', text: 'Reset email copy depends on UCD confirming.' },
  { ref: 'OP2', ticketKey: 'ENG-12', text: 'Link expiry TBC with security.' },
];

describe('the prompt', () => {
  it('is byte-identical without open points (null or empty)', () => {
    expect(buildUserPrompt({ ...base, mode: 'diff_only', openPoints: null })).toBe(golden.diffOnly);
    expect(buildUserPrompt({ ...base, mode: 'diff_only', openPoints: [] })).toBe(golden.diffOnly);
  });

  it('pins the open points section whole (golden), with the field named', () => {
    const p = buildUserPrompt({ ...base, mode: 'worktree', openPoints: POINTS, nonce: NONCE });
    expect(p).toBe(golden.worktreeOpenPoints);
    expect(p).toContain('{ summary, verdict, scopeUsed, findings, openPoints }');
    expect(p).toContain('do NOT change your verdict');
  });

  it('needs a nonce, and the nonce scan sees every point', () => {
    expect(() => buildUserPrompt({ ...base, openPoints: POINTS })).toThrow(/nonce/);
    const texts = untrustedTexts(null, null, null, null, null, null, null, POINTS);
    expect(texts).toEqual(expect.arrayContaining(['ENG-12', POINTS[0]!.text, POINTS[1]!.text]));
  });

  it('renders for Codex with no Claude-only word', () => {
    const codex = codexReviewUserPrompt(buildUserPrompt({ ...base, mode: 'worktree', openPoints: POINTS, nonce: NONCE }));
    for (const w of CLAUDE_ONLY_WORDS) expect(codex).not.toMatch(w);
    expect(codex).toContain('Open points on the ticket');
  });
});

describe('the submit_review shape', () => {
  it('gains openPoints only when asked', async () => {
    const z = await loadZod();
    const plain = Object.keys(buildSubmitReviewShape(z, {})).sort();
    expect(plain).not.toContain('openPoints');
    expect(Object.keys(buildSubmitReviewShape(z, { openPoints: false })).sort()).toEqual(plain);
    expect(Object.keys(buildSubmitReviewShape(z, { openPoints: true })).sort()).toEqual([...plain, 'openPoints'].sort());
    expect(Object.keys(buildSubmitReviewShape(z, { docs: true, openPoints: true }))).toEqual(
      expect.arrayContaining(['docReferences', 'openPoints']),
    );
  });
});

describe('openPointsForPrompt + reconcileOpenPoints', () => {
  const plan = openPointsForPrompt([
    { key: 'ENG-12', points: [{ text: 'A', source: 'field' }, { text: 'B', source: 'description' }], fresh: true, fetchedAt: '2026-11-06T10:00:00.000Z' },
    { key: 'ENG-13', points: [], fresh: false, fetchedAt: null },
    { key: 'ENG-14', points: [{ text: 'C', source: 'description' }], fresh: false, fetchedAt: '2026-11-01T10:00:00.000Z' },
  ])!;

  it('numbers points across tickets; freshness and the oldest read come from tickets with points', () => {
    expect(plan.prompt.map((p) => `${p.ref}:${p.ticketKey}:${p.text}`)).toEqual(['OP1:ENG-12:A', 'OP2:ENG-12:B', 'OP3:ENG-14:C']);
    expect(plan.fresh).toBe(false);
    expect(plan.readAt).toBe('2026-11-01T10:00:00.000Z');
    expect(openPointsForPrompt([{ key: 'X-1', points: [], fresh: true, fetchedAt: null }])).toBeNull();
  });

  it('keeps every point; only sent refs carry code; bad entries dropped', () => {
    const out = reconcileOpenPoints(plan, [
      { ref: 'op1', code: [{ path: 'src/a.html', line: 12, note: 'Heading copy waits on UCD.' }, { path: '', note: 'x' }] },
      { ref: 'OP9', code: [{ path: 'src/b.ts', note: 'unknown ref' }] },
      { ref: 'OP1', code: [{ path: 'src/dup.ts', note: 'a second entry for the same ref' }] },
      'junk',
      { ref: 'OP3', code: [{ path: 'src/c.ts', line: -4, note: 'x'.repeat(1000) }] },
    ]);
    expect(out.points.map((p) => p.ref)).toEqual(['OP1', 'OP2', 'OP3']);
    expect(out.points[0]!.code).toEqual([{ path: 'src/a.html', line: 12, note: 'Heading copy waits on UCD.' }]);
    expect(out.points[0]!.source).toBe('field');
    expect(out.points[1]!.code).toEqual([]);
    expect(out.points[2]!.code[0]!.line).toBeNull();
    expect(out.points[2]!.code[0]!.note.length).toBeLessThanOrEqual(300);
    // A run that reported nothing still records every point.
    expect(reconcileOpenPoints(plan, undefined).points.every((p) => p.code.length === 0)).toBe(true);
  });

  it('round-trips through the stored reader', () => {
    const out = reconcileOpenPoints(plan, []);
    expect(openPointsFromStored(JSON.parse(JSON.stringify(out)))).toEqual(out);
    expect(openPointsFromStored(null)).toBeNull();
    expect(openPointsFromStored({ points: 'no' })).toBeNull();
  });
});

describe('the posted body', () => {
  const op = {
    fresh: true,
    readAt: '2026-11-06T10:00:00.000Z',
    points: [
      { ref: 'OP1', ticketKey: 'ENG-12', text: 'Copy depends on UCD.', source: 'field' as const, code: [{ path: 'src/page.html', line: 4, note: 'The heading.' }] },
      { ref: 'OP2', ticketKey: 'ENG-12', text: 'Expiry <!-- x --> TBC.', source: 'description' as const, code: [] },
    ],
  };

  it('says the points do not affect the outcome and lists each with its code', () => {
    const block = openPointsPostBlock(op);
    expect(block).toContain('#### Open points on the ticket (not blocking)');
    expect(block).toContain("They do not affect this review's outcome.");
    expect(block).toContain('- **ENG-12:** Copy depends on UCD.\n  - `src/page.html:4` The heading.');
    // No HTML comment can ride a point into the body (the marker rules stay the seam's).
    expect(block).not.toContain('<!--');
    expect(block).not.toContain('stored copy');
  });

  it('names the stored copy when the tickets could not be read again', () => {
    expect(openPointsPostBlock({ ...op, fresh: false })).toContain("From Limn's stored copy of the ticket (read 2026-11-06).");
  });

  it('is nothing without points; appended to a manual body; before the auto footer', () => {
    expect(openPointsPostBlock(null)).toBe('');
    expect(withOpenPointsBlock('My review.', null)).toBe('My review.');
    expect(withOpenPointsBlock('My review.\n', op)).toBe(`My review.\n\n${openPointsPostBlock(op)}`);
    expect(withOpenPointsBlock('', op)).toBe(openPointsPostBlock(op));
    const footer = '_Posted automatically by Limn._';
    const body = withOpenPointsBeforeFooter(`Lead.\n\nNot approved: x.\n\n${footer}`, footer, op);
    expect(body).toBe(`Lead.\n\nNot approved: x.\n\n${openPointsPostBlock(op)}\n\n${footer}`);
    expect(withOpenPointsBeforeFooter(`Lead.\n\n${footer}`, footer, null)).toBe(`Lead.\n\n${footer}`);
  });

  it("merges a pair's halves into one section", () => {
    const other = { ...op, fresh: false, points: [{ ...op.points[0]!, code: [{ path: 'src/b.ts', line: null, note: 'Codex saw this.' }] }] };
    const merged = mergeOpenPoints([op, other])!;
    expect(merged.points).toHaveLength(2);
    expect(merged.points[0]!.code.map((c) => c.path)).toEqual(['src/page.html', 'src/b.ts']);
    expect(merged.fresh).toBe(false);
    expect(mergeOpenPoints([null, undefined])).toBeNull();
  });
});
