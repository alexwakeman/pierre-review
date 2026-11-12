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

/** A span of the NEW text, `[start, end)` in UTF-16 offsets of `normaliseNewlines(after)`. */
export interface TextRange {
  start: number;
  end: number;
}

export function normaliseNewlines(t: string): string {
  return t.replace(/\r\n?/g, '\n');
}

// Words and the whitespace between them; a change is marked word by word.
const tokens = (t: string): string[] => t.match(/\s+|[^\s]+/g) ?? [];
const isSpace = (t: string): boolean => /^\s+$/.test(t);

/** Which tokens of `b` are not in an LCS of `a` and `b` (every one past MAX_CELLS). */
function addedTokens(a: readonly string[], b: readonly string[]): boolean[] {
  if (a.length === 0 || a.length * b.length > MAX_CELLS) return b.map(() => true);
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const added = b.map(() => true);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      added[j] = false;
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return added;
}

/**
 * THE CHANGED WORDS of the new text (the ticket boxes paint them, TicketUpdatePanel.tsx): a line diff
 * first, then, inside each run of changed lines, a word diff of the old run against the new one. A
 * removal leaves nothing to mark here (the "What changes" diff shows it). Whitespace is marked when it
 * sits between two marked words (even a space the old text had), so a changed phrase reads as one wash. Empty when nothing changed.
 */
export function changedRanges(before: string, after: string): TextRange[] {
  const b = normaliseNewlines(after);
  if (normaliseNewlines(before) === b) return [];
  const diff = lineDiff(before, b);
  // Offsets of each new line.
  const out: TextRange[] = [];
  let offset = 0; // start of the next NEW line
  let k = 0;
  while (k < diff.length) {
    if (diff[k]!.kind === 'same') {
      offset += diff[k]!.text.length + 1;
      k += 1;
      continue;
    }
    // One hunk: its removed lines and its added lines.
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < diff.length && diff[k]!.kind !== 'same') {
      (diff[k]!.kind === 'del' ? dels : adds).push(diff[k]!.text);
      k += 1;
    }
    if (adds.length === 0) continue;
    const newText = adds.join('\n');
    const bt = tokens(newText);
    const added = addedTokens(tokens(dels.join('\n')), bt);
    // Whitespace counts only when it joins two marked words.
    const marked = bt.map((t, n) => {
      if (!isSpace(t)) return added[n]!;
      let p = n - 1;
      while (p >= 0 && isSpace(bt[p]!)) p -= 1;
      let q = n + 1;
      while (q < bt.length && isSpace(bt[q]!)) q += 1;
      // (a space between two changed words, even one the old text also had)
      return p >= 0 && q < bt.length && added[p]! && added[q]! && !t.includes('\n');
    });
    let at = offset;
    bt.forEach((t, n) => {
      if (marked[n]) {
        const last = out[out.length - 1];
        if (last != null && last.end === at) last.end = at + t.length;
        else out.push({ start: at, end: at + t.length });
      }
      at += t.length;
    });
    offset += newText.length + 1;
  }
  return out;
}
