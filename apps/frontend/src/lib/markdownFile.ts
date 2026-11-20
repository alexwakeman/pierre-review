import { isNoNewlineRow, patchReachesEnd, splitDiffMarker, type DiffRow } from './diff.js';
import { safeExternalUrl } from './ui.js';

// The Changes tab's RENDERED view of a Markdown file (`FileDiffView`'s `MarkdownFileView`).
//
// What it renders is the file's NEW side. The whole file is a live GitHub read
// (`GET …/files/content`), and every such read in the Changes tab is CLICK-GATED (docs/FRONTEND.md
// § No diff notation…): a docs PR with 40 `.md` files must not spend 40 calls to paint. So the
// default render is built from the PATCH — the added and unchanged lines in order, the removed ones
// dropped, one segment per hunk — and says so when the patch is not the whole file. The reader's
// "Show whole file" press reads it (the same query the gap arrows use, so either click serves both).

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);

/** A Markdown file by its extension (`.md`, `.mdx`, `.markdown`, any case). */
export function isMarkdownPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return MARKDOWN_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** One hunk's new side, and how many unchanged lines GitHub left out before it. */
export interface MarkdownSegment {
  text: string;
  hiddenBefore: number;
  /** The lines of `text` (1-based) that the PR ADDED; every other line is unchanged. */
  added: number[];
}

/**
 * The new side of a parsed patch, one segment per hunk: context + added lines in order, removed
 * lines dropped. `partial` is true when the patch is NOT the whole new file — lines are hidden
 * before a hunk, or after the last one (`patchReachesEnd` cannot prove the patch runs to EOF).
 * Each hunk is its own segment because a code fence or a list that crosses a hidden gap would
 * otherwise swallow the next hunk.
 */
export function markdownFromPatch(rows: readonly DiffRow[]): {
  segments: MarkdownSegment[];
  partial: boolean;
} {
  const segments: MarkdownSegment[] = [];
  let lines: string[] | null = null;
  let added: number[] = [];
  let hiddenBefore = 0;
  const close = (): void => {
    if (lines != null && lines.length > 0) segments.push({ text: lines.join('\n'), hiddenBefore, added });
    lines = null;
    added = [];
  };
  for (const row of rows) {
    if (row.kind === 'hunk') {
      close();
      lines = [];
      hiddenBefore = row.gap?.count ?? 0;
      continue;
    }
    if (row.kind === 'del' || isNoNewlineRow(row)) continue;
    lines ??= [];
    lines.push(splitDiffMarker(row).body.replace(/\r$/, ''));
    if (row.kind === 'add') added.push(lines.length);
  }
  close();
  const partial = segments.some((s) => s.hiddenBefore > 0) || !patchReachesEnd(rows);
  return { segments, partial };
}

/** The new-side line numbers of the patch's ADDED lines — which lines of the whole new file the PR
 *  added (`MarkdownFileView` once the file is loaded). */
export function addedNewLines(rows: readonly DiffRow[]): number[] {
  const out: number[] = [];
  for (const row of rows) if (row.kind === 'add' && row.newLine != null) out.push(row.newLine);
  return out;
}

/**
 * A link in a PR's Markdown file, or null to print the link text alone. Only an ABSOLUTE http(s)
 * URL becomes a link (through `safeExternalUrl`): a relative one (`./setup.md`, `#install`) is
 * relative to the REPOSITORY, and would resolve against Limn's own server here.
 */
export function markdownFileLinkHref(href: string | null | undefined): string | null {
  const safe = safeExternalUrl(href);
  if (safe == null || !/^https?:\/\//i.test(safe)) return null;
  return safe;
}

// Minimal HAST shapes (no dependency on @types/hast — `lib/reviewPrRefs.ts` does the same).
interface HNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  value?: string;
}

/**
 * A rehype plugin (run after the sanitizer) that drops every `<img>` whose `src` is not an
 * absolute http(s) URL. A relative image path names a file in the repository; requested from here
 * it would hit Limn's own server. The alt text stays, as plain text.
 */
export function rehypeDropRelativeImages(): (tree: HNode) => void {
  return (tree: HNode): void => {
    const walk = (node: HNode): void => {
      if (node.children == null) return;
      node.children = node.children.flatMap((child): HNode[] => {
        if (child.type !== 'element') return [child];
        if (child.tagName === 'img') {
          const src = child.properties?.src;
          if (typeof src === 'string' && markdownFileLinkHref(src) != null) return [child];
          const alt = child.properties?.alt;
          return typeof alt === 'string' && alt !== '' ? [{ type: 'text', value: alt }] : [];
        }
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}

/** The class `rehypeMarkAddedBlocks` puts on a block that holds an added line (index.css draws the
 *  gutter's `+` from it). */
export const ADDED_BLOCK_CLASS = 'md-file-added';

interface HPosition {
  start?: { line?: number };
  end?: { line?: number };
}

/** The node's first and last source line, or null when the parser left no position (then its
 *  provenance is unknown and it gets no marker). */
function lineRange(node: HNode): [number, number] | null {
  const pos = (node as HNode & { position?: HPosition }).position;
  const from = pos?.start?.line;
  const to = pos?.end?.line;
  return from != null && to != null && to >= from ? [from, to] : null;
}

/**
 * A rehype plugin (run after the sanitizer) that marks each rendered BLOCK built from a line the PR
 * added: every top-level block is wrapped in a `<div class="md-file-added">`, except a list, whose
 * items are marked one by one (a list item's own lines only — a nested list is judged item by item
 * too). `added` holds 1-based lines of the rendered text. A block with no source position is left
 * unmarked: its provenance is unknown.
 */
export function rehypeMarkAddedBlocks(added: readonly number[]): () => (tree: HNode) => void {
  const set = new Set(added);
  const touches = (from: number, to: number, skip: readonly [number, number][]): boolean => {
    for (let l = from; l <= to; l += 1) {
      if (!set.has(l)) continue;
      if (!skip.some(([a, b]) => l >= a && l <= b)) return true;
    }
    return false;
  };
  const isList = (n: HNode): boolean => n.type === 'element' && (n.tagName === 'ul' || n.tagName === 'ol');
  const markItems = (list: HNode): void => {
    for (const li of list.children ?? []) {
      if (li.type !== 'element' || li.tagName !== 'li') continue;
      const nested = (li.children ?? []).filter(isList);
      for (const n of nested) markItems(n);
      const range = lineRange(li);
      if (range == null) continue;
      const skip = nested.map(lineRange).filter((r): r is [number, number] => r != null);
      if (!touches(range[0], range[1], skip)) continue;
      const props = (li.properties ??= {});
      const cls = props.className;
      props.className = Array.isArray(cls) ? [...cls, ADDED_BLOCK_CLASS] : [ADDED_BLOCK_CLASS];
    }
  };
  return () =>
    (tree: HNode): void => {
      if (set.size === 0 || tree.children == null) return;
      tree.children = tree.children.map((child): HNode => {
        if (child.type !== 'element') return child;
        if (isList(child)) {
          markItems(child);
          return child;
        }
        const range = lineRange(child);
        if (range == null || !touches(range[0], range[1], [])) return child;
        return { type: 'element', tagName: 'div', properties: { className: [ADDED_BLOCK_CLASS] }, children: [child] };
      });
    };
}
