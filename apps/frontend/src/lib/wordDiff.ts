// WORD-LEVEL DIFF for proposed ticket text (Reports → This sprint: a suggestion against its quote, the
// proposed criteria / description against the current text). Pure; test/wordDiff.test.ts.
//
// Words are compared with whitespace collapsed and curly quotes read as straight, so a re-wrapped line
// is not a change. The output keeps the NEW text's spacing for kept and added words.

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffPart {
  kind: DiffKind;
  text: string;
}

const QUOTES: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"' };

function core(w: string): string {
  return w.trim().replace(/[‘’“”]/g, (c) => QUOTES[c] ?? c);
}

/** Words with their trailing whitespace. */
function tokens(s: string): string[] {
  return s.trimStart().match(/\S+\s*/g) ?? [];
}

/** Above this many cells the middle is shown as one removal and one addition. */
const MAX_CELLS = 1_500_000;

function push(out: DiffPart[], kind: DiffKind, text: string): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last != null && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

/** Removed words keep one trailing space so they never run into the next word. */
function removedText(tok: string): string {
  return /\s$/.test(tok) ? tok.replace(/\s+$/, ' ') : `${tok} `;
}

export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  const out: DiffPart[] = [];
  let pre = 0;
  while (pre < a.length && pre < b.length && core(a[pre]!) === core(b[pre]!)) pre += 1;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    core(a[a.length - 1 - suf]!) === core(b[b.length - 1 - suf]!)
  ) {
    suf += 1;
  }
  for (let i = 0; i < pre; i += 1) push(out, 'same', b[i]!);
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  if (n * m > MAX_CELLS) {
    for (const t of am) push(out, 'removed', removedText(t));
    for (const t of bm) push(out, 'added', t);
  } else if (n > 0 || m > 0) {
    // LCS table over the middle.
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * w + j] =
          core(am[i]!) === core(bm[j]!) ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (core(am[i]!) === core(bm[j]!)) {
        push(out, 'same', bm[j]!);
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
        push(out, 'removed', removedText(am[i]!));
        i += 1;
      } else {
        push(out, 'added', bm[j]!);
        j += 1;
      }
    }
    for (; i < n; i += 1) push(out, 'removed', removedText(am[i]!));
    for (; j < m; j += 1) push(out, 'added', bm[j]!);
  }
  for (let k = b.length - suf; k < b.length; k += 1) push(out, 'same', b[k]!);
  return out;
}

/** Whether a diff changes anything. */
export function diffChanged(parts: readonly DiffPart[]): boolean {
  return parts.some((p) => p.kind !== 'same');
}

/** One proposed list item against the current list. */
export interface ItemDiff {
  /** 'added' = no current item resembles it; 'same' = unchanged; 'changed' = a word diff. */
  kind: 'added' | 'same' | 'changed';
  parts: DiffPart[];
}

function wordSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w !== ''),
  );
}

/** Shared words over the SHORTER item's words (so "Subheading: Targets" pairs with its own longer
 *  rewrite), falling back to shared-over-all when either side is a single word. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  const small = Math.min(a.size, b.size);
  return small >= 2 ? n / small : n / (a.size + b.size - n);
}

/**
 * The proposed list against the current one: each proposed item is paired with the most similar unused
 * current item (at least half the shorter one's words shared) and word-diffed against it; else it is new. `removed`
 * is every current item no proposed item was paired with, in order.
 */
export function listDiff(before: readonly string[], after: readonly string[]): { items: ItemDiff[]; removed: string[] } {
  const used = new Set<number>();
  const sets = before.map(wordSet);
  const items = after.map((item): ItemDiff => {
    const s = wordSet(item);
    let best = -1;
    let bestScore = 0;
    sets.forEach((bs, i) => {
      if (used.has(i)) return;
      const score = core(before[i]!) === core(item) ? 2 : overlap(s, bs);
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    if (best < 0 || bestScore < 0.5) return { kind: 'added', parts: [{ kind: 'added', text: item }] };
    used.add(best);
    const parts = wordDiff(before[best]!, item);
    return { kind: diffChanged(parts) ? 'changed' : 'same', parts };
  });
  return { items, removed: before.filter((_, i) => !used.has(i)) };
}
