// A TINY LINE DIFF (pure) — the plan panel's "What changes" under each ticket box: the current text
// against the edited one, line by line (LCS). Ticket text is small (≤ 12,000 characters a field), so the
// O(n·m) table is fine; past MAX_CELLS it falls back to "every old line out, every new line in".

export type TextDiffKind = 'same' | 'add' | 'del';

export interface TextDiffLine {
  kind: TextDiffKind;
  text: string;
}

const MAX_CELLS = 400_000;

export function lineDiff(before: string, after: string): TextDiffLine[] {
  // An empty text has no lines (not one empty line).
  const lines = (t: string): string[] => (t === '' ? [] : t.replace(/\r\n?/g, '\n').split('\n'));
  const a = lines(before);
  const b = lines(after);
  if (before === after) return a.map((text) => ({ kind: 'same', text }));
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  }
  // lcs[i][j] = the longest common subsequence of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: TextDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! });
  return out;
}

/** "3 lines added, 1 removed", or null when nothing changes. */
export function lineDiffSummary(d: readonly TextDiffLine[]): string | null {
  const add = d.filter((l) => l.kind === 'add').length;
  const del = d.filter((l) => l.kind === 'del').length;
  if (add === 0 && del === 0) return null;
  const parts: string[] = [];
  if (add > 0) parts.push(`${add} line${add === 1 ? '' : 's'} added`);
  if (del > 0) parts.push(`${del} removed`);
  return parts.join(', ');
}
