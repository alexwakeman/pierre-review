import type { AiFixPickerItem, AiFixPickerPreview, AiFixPickerSection } from '@pierre-review/shared';

// THE FIX PICKER'S PURE FOLDS (no JSX, so `test/fixPicker.test.ts` imports them without pulling in
// the Claude Review cards the picker draws). The SERVER builds the list (`GET …/ai-fix/preview`) with
// stable keys and its defaults (everything except style-bot threads); the reader's ticks travel as
// `include` keys on the start, and the server applies the prompt budget AFTER that selection. The
// budget fold here mirrors the server's (`budgetCut`): items in the preview's order (already
// priority order), the first ticked one always fits.

export const PICKER_SECTION_ORDER: readonly AiFixPickerSection[] = [
  'findings',
  'earlier_findings',
  'judged_threads',
  'untouched_threads',
  'ci_failures',
  'style_bots',
  'story',
];

export const PICKER_SECTION_LABEL: Record<AiFixPickerSection, string> = {
  findings: 'Claude’s findings',
  earlier_findings: 'Earlier findings still open',
  judged_threads: 'Threads Claude says need a fix',
  untouched_threads: 'Unanswered threads',
  ci_failures: 'CI failures',
  style_bots: 'Style bot comments',
  story: 'Ticket gaps',
};

/** The reader's ticks: an override per key over the server's default. */
export type PickerOverrides = Record<string, boolean>;

export function isPicked(item: AiFixPickerItem, overrides: PickerOverrides): boolean {
  return overrides[item.key] ?? item.defaultIncluded;
}

/** The keys that will be sent, in the preview's order. */
export function pickedKeys(preview: AiFixPickerPreview, overrides: PickerOverrides): string[] {
  return preview.items.filter((i) => isPicked(i, overrides)).map((i) => i.key);
}

/** Which ticked keys the prompt budget will leave out — the server's fold over the same order. */
export function budgetCutKeys(preview: AiFixPickerPreview, overrides: PickerOverrides): Set<string> {
  const cut = new Set<string>();
  let used = 0;
  for (const i of preview.items) {
    if (!isPicked(i, overrides)) continue;
    if (used > 0 && used + i.chars > preview.budgetChars) {
      cut.add(i.key);
      continue;
    }
    used += i.chars;
  }
  return cut;
}
