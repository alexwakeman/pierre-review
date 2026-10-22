// The deterministic post-LLM guard — the four specced rejections (dropped markers, altered
// intents header, busted char budget, smuggled structure) and the accept path. Whatever the
// model (or a client claiming to be the model) returns, only text that passes here may
// replace the templated block.
import { describe, expect, it } from 'vitest';
import { guardRefinedBlock } from '../../advisor/refine/diff-guard.js';
import { MARKER_END, MARKER_START } from '../../advisor/emitters/prose.js';

const HEADER = '<!-- limn:advisor:intents: SUPPRESS_PATH|src/** LOWER_VERBOSITY|nit -->';
const TEMPLATED = [
  MARKER_START,
  HEADER,
  '',
  '- Do not review files under `src/**`.',
  '- Raise the severity floor.',
  '',
  MARKER_END,
].join('\n');

const refinedWith = (lines: string[]): string =>
  [MARKER_START, HEADER, '', ...lines, '', MARKER_END].join('\n');

describe('guardRefinedBlock', () => {
  it('accepts a reworded block that keeps markers + header verbatim', () => {
    const out = guardRefinedBlock(TEMPLATED, refinedWith(['- Please skip `src/**` files.', '- Keep comments at minor severity and above.']));
    expect(out.ok).toBe(true);
  });

  it('rejects when the markers are dropped', () => {
    const out = guardRefinedBlock(TEMPLATED, `no markers here`);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('marker');
  });

  it('rejects when the intents header is altered', () => {
    const tampered = [MARKER_START, HEADER.replace('SUPPRESS_PATH', 'AMPLIFY_PATH'), '- text', MARKER_END].join('\n');
    const out = guardRefinedBlock(TEMPLATED, tampered);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('header');
  });

  it('rejects when the char budget is busted; the templated version is what ships', () => {
    const huge = refinedWith(['- ' + 'x'.repeat(5000)]);
    const out = guardRefinedBlock(TEMPLATED, huge, { charBudget: 500 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('budget');
  });

  it('rejects a fenced block (structure smuggled into prose)', () => {
    const out = guardRefinedBlock(TEMPLATED, refinedWith(['```yaml', 'reviews:', '```']));
    expect(out.ok).toBe(false);
  });

  it('rejects stray extra markers (a second managed block)', () => {
    const doubled = `${TEMPLATED}\n${TEMPLATED}`;
    const out = guardRefinedBlock(TEMPLATED, doubled);
    expect(out.ok).toBe(false);
  });
});
