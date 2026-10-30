import type { PrFileDiffStatus } from '@pierre-review/shared';

// The one-letter status glyph + colour a changed file carries, shared by the per-file diff
// header (FileDiffView) and the Changes-tab navigation rail (FileTree) so the two never
// disagree about what "R" means. The app ships no icon library — status is a plain letter,
// like the carets elsewhere in the diff.
export const STATUS_META: Record<
  PrFileDiffStatus,
  { icon: string; label: string; cls: string }
> = {
  added: { icon: 'A', label: 'added', cls: 'text-ui-success' },
  removed: { icon: 'D', label: 'removed', cls: 'text-ui-danger' },
  modified: { icon: 'M', label: 'modified', cls: 'text-ui-warn' },
  renamed: { icon: 'R', label: 'renamed', cls: 'text-ui-accent' },
  copied: { icon: 'C', label: 'copied', cls: 'text-ui-accent' },
  changed: { icon: 'M', label: 'changed', cls: 'text-ui-warn' },
  unchanged: { icon: '·', label: 'unchanged', cls: 'text-ui-faint' },
};

// The selected treatment, shared by the Changes-tab rail row (FileTree) and the file's own
// diff block (FileDiffView) so clicking a file marks BOTH with the same 2px cyan line. Both
// sides carry `border-l-2` unconditionally and only switch the colour, so selecting a file
// shifts nothing.
export const SELECTED_BORDER = 'border-ui-accent/50';
// …and the same FILL behind the whole name row: the rail row and the diff block's sticky file
// header. A bright cyan, a step more vivid than the app's sky accents, so the selected file is
// unmistakable while scrolling; opaque in the header (it is sticky over the code).
export const SELECTED_FILL = 'bg-ui-accent/10';
export const UNSELECTED_BORDER = 'border-transparent';
