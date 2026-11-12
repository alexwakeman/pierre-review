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
  let hiddenBefore = 0;
  const close = (): void => {
    if (lines != null && lines.length > 0) segments.push({ text: lines.join('\n'), hiddenBefore });
    lines = null;
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
  }
  close();
  const partial = segments.some((s) => s.hiddenBefore > 0) || !patchReachesEnd(rows);
  return { segments, partial };
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
