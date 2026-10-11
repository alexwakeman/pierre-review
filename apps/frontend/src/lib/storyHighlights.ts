// THE HIGHLIGHTS IN A RENDERED TICKET (Reports → This sprint, the opened card). Pure HAST transforms,
// unit-tested in test/storyHighlights.test.ts.
//
//   • `rehypeStoryHighlights` wraps each anchored finding's QUOTE in a `<mark class="story-mark">`.
//     The quote is matched against the RENDERED text of one block (a paragraph, a list item, a
//     heading, a cell), across its inline nodes (bold, links, code), whitespace-normalised and with
//     curly quotes read as straight — the same normalisation the server's `verifyStoryQuote` applies.
//     Case-sensitive first, then case-insensitive, then with Markdown markup stripped from the quote
//     (the server verified it against the SOURCE, where `**` and `- [ ]` still stand).
//   • A quote spanning several inline nodes becomes several `<mark>`s with the same `data-mark`; only
//     the FIRST is a tab stop (`tabIndex 0`, `role="button"`).
//   • Findings with the same quote share ONE mark (`data-findings` lists every id).
//   • Each mark is placed ONCE (the first block in document order that holds it), never on text another
//     mark already covers. A quote found nowhere gets no mark — the card lists it under "Not in the
//     text" (read off the DOM, never guessed).
//   • `rehypeSoftBreaks` turns single newlines inside text into `<br>` (outside code), because tracker
//     text uses them as line breaks (GIVEN / AND / THEN lines).
//
// Both run AFTER the sanitizer (Markdown.tsx), so nothing they add comes from the ticket beyond its
// own text.

interface HText {
  type: 'text';
  value: string;
}
interface HElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HNode[];
}
interface HRoot {
  type: 'root';
  children: HNode[];
}
type HNode = HText | HElement | HRoot | { type: string; children?: HNode[] };

/** One mark to place: every finding id sharing this quote. */
export interface StoryAnchor {
  /** Stable within one render ("m0", "m1", …) — the `data-mark` value. */
  key: string;
  quote: string;
  ids: string[];
}

const QUOTE_CHARS: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"' };

/** Whitespace-collapsed, trimmed, curly quotes straightened. */
export function normaliseHighlightText(s: string): string {
  let out = '';
  for (const ch of s.replace(/\s+/g, ' ').trim()) out += QUOTE_CHARS[ch] ?? ch;
  return out;
}

/** The quote with Markdown markup removed: emphasis / code marks, a leading list or task marker. */
export function stripMarkdownMarks(s: string): string {
  return normaliseHighlightText(
    s
      .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
      .replace(/^\s*\[[ xX]\]\s+/, '')
      .replace(/(\*\*|__|`|~~)/g, '')
      .replace(/(^|\s)[*_](\S)/g, '$1$2')
      .replace(/(\S)[*_](?=\s|$|[.,;:!?])/g, '$1'),
  );
}

/** Group findings by their (normalised) quote, in first-seen order; unanchored findings are skipped. */
export function storyAnchors(findings: ReadonlyArray<{ id: string; quote: string | null }>): StoryAnchor[] {
  const out: StoryAnchor[] = [];
  const byQuote = new Map<string, StoryAnchor>();
  for (const f of findings) {
    if (f.quote == null) continue;
    const q = normaliseHighlightText(f.quote);
    if (q === '') continue;
    const hit = byQuote.get(q);
    if (hit != null) {
      hit.ids.push(f.id);
      continue;
    }
    const a: StoryAnchor = { key: `m${out.length}`, quote: q, ids: [f.id] };
    byQuote.set(q, a);
    out.push(a);
  }
  return out;
}

// ── Runs: the inline text of one block ────────────────────────────────────────────────────────────

const BLOCK_TAGS = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'dt', 'dd', 'blockquote', 'div', 'ul', 'ol',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'section', 'details', 'summary', 'figure', 'hr', 'dl',
]);
// Never highlighted inside: a code block is code, not ticket prose.
const SKIP_TAGS = new Set(['pre', 'script', 'style', 'mark']);

type Seg = { kind: 'text'; node: HText } | { kind: 'br' };

function collectRuns(root: HNode): Seg[][] {
  const runs: Seg[][] = [];
  const ctx: { cur: Seg[] | null } = { cur: null };
  const push = (s: Seg): void => {
    if (ctx.cur == null) {
      ctx.cur = [];
      runs.push(ctx.cur);
    }
    ctx.cur.push(s);
  };
  const visit = (node: HNode): void => {
    const children = (node as { children?: HNode[] }).children ?? [];
    for (const child of children) {
      if (child.type === 'text') {
        push({ kind: 'text', node: child as HText });
        continue;
      }
      if (child.type !== 'element') continue;
      const tag = (child as HElement).tagName;
      if (SKIP_TAGS.has(tag)) {
        ctx.cur = null;
        continue;
      }
      if (tag === 'br') {
        push({ kind: 'br' });
        continue;
      }
      if (BLOCK_TAGS.has(tag)) {
        ctx.cur = null;
        visit(child);
        ctx.cur = null;
        continue;
      }
      visit(child); // inline: same run
    }
  };
  visit(root);
  return runs;
}

interface RunText {
  /** Normalised text and, per normalised char, its offset in the run's raw concatenation. */
  text: string;
  lower: string;
  map: number[];
  /** Each segment's [start, end) in the raw concatenation. */
  spans: Array<[number, number]>;
}

function runText(run: Seg[]): RunText {
  let raw = '';
  const spans: Array<[number, number]> = [];
  for (const s of run) {
    const v = s.kind === 'text' ? s.node.value : '\n';
    spans.push([raw.length, raw.length + v.length]);
    raw += v;
  }
  let text = '';
  const map: number[] = [];
  let pendingSpace = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (/\s/.test(ch)) {
      if (text !== '' && pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0) {
      text += ' ';
      map.push(pendingSpace);
      pendingSpace = -1;
    }
    text += QUOTE_CHARS[ch] ?? ch;
    map.push(i);
  }
  return { text, lower: text.toLowerCase(), map, spans };
}

/** The first occurrence of `q` in `hay` at or after 0 that overlaps no taken range. */
function findFree(hay: string, q: string, taken: Array<[number, number]>): number {
  if (q === '') return -1;
  for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, at + 1)) {
    const end = at + q.length;
    if (!taken.some(([a, b]) => at < b && end > a)) return at;
  }
  return -1;
}

interface Placed {
  /** [start, end) in the run's raw concatenation. */
  from: number;
  to: number;
  anchor: StoryAnchor;
}

function placeInRun(rt: RunText, anchors: StoryAnchor[], placed: Set<string>): Placed[] {
  const taken: Array<[number, number]> = [];
  const out: Placed[] = [];
  // Longest first, so a short quote never splits a long one.
  const order = [...anchors].sort((a, b) => b.quote.length - a.quote.length);
  for (const a of order) {
    if (placed.has(a.key)) continue;
    const variants = [a.quote, stripMarkdownMarks(a.quote)].filter((v, i, all) => v !== '' && all.indexOf(v) === i);
    let at = -1;
    let len = 0;
    for (const v of variants) {
      at = findFree(rt.text, v, taken);
      if (at < 0) at = findFree(rt.lower, v.toLowerCase(), taken);
      if (at >= 0) {
        len = v.length;
        break;
      }
    }
    if (at < 0) continue;
    taken.push([at, at + len]);
    placed.add(a.key);
    out.push({ from: rt.map[at]!, to: rt.map[at + len - 1]! + 1, anchor: a });
  }
  return out;
}

function markElement(a: StoryAnchor, value: string, first: boolean): HElement {
  return {
    type: 'element',
    tagName: 'mark',
    properties: {
      className: ['story-mark'],
      dataMark: a.key,
      dataFindings: a.ids.join(' '),
      ...(first ? { tabIndex: 0, role: 'button' } : {}),
    },
    children: [{ type: 'text', value }],
  };
}

/** Splits one text node by the marks covering it. */
function splitText(node: HText, start: number, marks: Placed[], firstSeen: Set<string>): HNode[] | null {
  const end = start + node.value.length;
  const hits = marks.filter((m) => m.from < end && m.to > start).sort((a, b) => a.from - b.from);
  if (hits.length === 0) return null;
  const out: HNode[] = [];
  let at = 0;
  for (const m of hits) {
    const a = Math.max(m.from - start, 0);
    const b = Math.min(m.to - start, node.value.length);
    if (b <= a) continue;
    if (a > at) out.push({ type: 'text', value: node.value.slice(at, a) });
    const first = !firstSeen.has(m.anchor.key);
    firstSeen.add(m.anchor.key);
    out.push(markElement(m.anchor, node.value.slice(a, b), first));
    at = b;
  }
  if (at < node.value.length) out.push({ type: 'text', value: node.value.slice(at) });
  return out;
}

function replaceNodes(node: HNode, swap: Map<HText, HNode[]>): void {
  const children = (node as { children?: HNode[] }).children;
  if (children == null) return;
  const next: HNode[] = [];
  let changed = false;
  for (const c of children) {
    const s = c.type === 'text' ? swap.get(c as HText) : undefined;
    if (s != null) {
      next.push(...s);
      changed = true;
    } else {
      replaceNodes(c, swap);
      next.push(c);
    }
  }
  if (changed) (node as { children: HNode[] }).children = next;
}

/** Apply the anchors to a HAST tree in place. Exported for the tests. */
export function highlightTree(tree: HNode, anchors: readonly StoryAnchor[]): void {
  if (anchors.length === 0) return;
  const placed = new Set<string>();
  const firstSeen = new Set<string>();
  const swap = new Map<HText, HNode[]>();
  for (const run of collectRuns(tree)) {
    if (placed.size === anchors.length) break;
    const rt = runText(run);
    if (rt.text === '') continue;
    const marks = placeInRun(rt, [...anchors], placed);
    if (marks.length === 0) continue;
    run.forEach((s, i) => {
      if (s.kind !== 'text') return;
      const pieces = splitText(s.node, rt.spans[i]![0], marks, firstSeen);
      if (pieces != null) swap.set(s.node, pieces);
    });
  }
  if (swap.size > 0) replaceNodes(tree, swap);
}

/** Rehype plugin: `[rehypeStoryHighlights, { anchors }]`. */
export function rehypeStoryHighlights(options: { anchors: readonly StoryAnchor[] }): (tree: HRoot) => void {
  return (tree) => highlightTree(tree, options.anchors);
}

// ── Soft line breaks ─────────────────────────────────────────────────────────────────────────────

const NO_BREAK_TAGS = new Set(['pre', 'code', 'script', 'style']);

function breakText(node: HNode): void {
  const children = (node as { children?: HNode[] }).children;
  if (children == null) return;
  const next: HNode[] = [];
  let changed = false;
  for (const c of children) {
    const v = c.type === 'text' ? (c as HText).value : '';
    // Whitespace-only text between blocks is layout, not a line break.
    if (v.includes('\n') && v.trim() !== '') {
      v.split('\n').forEach((p, i) => {
        if (i > 0) next.push({ type: 'element', tagName: 'br', properties: {}, children: [] } as HElement);
        if (p !== '') next.push({ type: 'text', value: p });
      });
      changed = true;
      continue;
    }
    if (c.type === 'element' && NO_BREAK_TAGS.has((c as HElement).tagName)) {
      next.push(c);
      continue;
    }
    breakText(c);
    next.push(c);
  }
  if (changed) (node as { children: HNode[] }).children = next;
}

/** Rehype plugin: a newline inside prose text becomes `<br>` (never in code, never between blocks). */
export function rehypeSoftBreaks(): (tree: HRoot) => void {
  return (tree) => breakText(tree);
}
