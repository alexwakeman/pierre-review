// THE FIX PICKER'S FOLDS (components/AiFix/fixPickerModel.ts): which keys a Start sends, and which
// ticked items the prompt budget will leave out — the same fold as the server's `budgetCut`, over
// the preview's order (already priority order), the first ticked item always fitting.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend fixPicker
import { describe, expect, it } from 'vitest';
import type { AiFixPickerItem, AiFixPickerPreview } from '@pierre-review/shared';
import { budgetCutKeys, onlySectionOverrides, pickedKeys } from '../src/components/AiFix/fixPickerModel.js';

const item = (key: string, chars: number, defaultIncluded = true): AiFixPickerItem => ({
  key,
  section: key.startsWith('thread') ? 'style_bots' : 'findings',
  label: key,
  detail: null,
  path: null,
  line: null,
  severity: null,
  defaultIncluded,
  chars,
});
const preview: AiFixPickerPreview = {
  sourceReviewId: 1,
  items: [item('finding:1', 600), item('finding:2', 600), item('finding:3', 600), item('thread:9', 100, false)],
  budgetChars: 1_300,
  cutByBudget: ['finding:3'],
};

describe('the fix picker folds', () => {
  it('sends the defaults until the reader ticks, then the reader’s ticks', () => {
    expect(pickedKeys(preview, {})).toEqual(['finding:1', 'finding:2', 'finding:3']);
    expect(pickedKeys(preview, { 'finding:2': false, 'thread:9': true })).toEqual(['finding:1', 'finding:3', 'thread:9']);
  });

  it('agrees with the server’s cut on the defaults, and re-folds after the reader’s selection', () => {
    expect([...budgetCutKeys(preview, {})]).toEqual(preview.cutByBudget);
    expect([...budgetCutKeys(preview, { 'finding:2': false })]).toEqual([]);
    // The first ticked item always fits, however big.
    expect([...budgetCutKeys({ ...preview, budgetChars: 10 }, { 'finding:2': false, 'finding:3': false })]).toEqual([]);
  });
});

describe('"Fix with AI" from the CI check — only the CI failures ticked', () => {
  const withCi: AiFixPickerPreview = {
    ...preview,
    items: [{ ...item('ci:4', 300), section: 'ci_failures' }, ...preview.items],
  };

  it('ticks every CI item and unticks everything else, defaults included', () => {
    const o = onlySectionOverrides(withCi, 'ci_failures');
    expect(pickedKeys(withCi, o)).toEqual(['ci:4']);
    // The reader can still tick more on top.
    expect(pickedKeys(withCi, { ...o, 'finding:2': true })).toEqual(['ci:4', 'finding:2']);
  });

  it('the CI-only preview (no review) sends its CI items', () => {
    const ciOnly: AiFixPickerPreview = { ...withCi, sourceReviewId: null, items: [withCi.items[0]!] };
    expect(pickedKeys(ciOnly, onlySectionOverrides(ciOnly, 'ci_failures'))).toEqual(['ci:4']);
  });
});
