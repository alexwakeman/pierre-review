import type { TrackerCall } from '../types.js';
import { notionRequest } from './client.js';

// NOTION PAGE BODY → MARKDOWN (docs/TRACKERS.md § Notion). A page's body is a tree of blocks, read
// with `GET /v1/blocks/{id}/children` (100 a page, paginated). Kept MODEST: headings, paragraphs,
// bulleted / numbered lists, to-dos, code, quotes, callouts, toggles, tables and dividers. Everything
// else (images, embeds, child pages and databases, synced blocks, …) is skipped.
//
// BOUNDED: at most `NOTION_BLOCK_CALLS_MAX` calls and `NOTION_BLOCKS_MAX` blocks per page, children
// followed `NOTION_BLOCK_DEPTH_MAX` levels down, and only under block types that are drawn. A body cut
// short ends with one line saying so — the story is still read, and a cut never throws.

export const NOTION_BLOCK_CALLS_MAX = 20;
export const NOTION_BLOCKS_MAX = 400;
export const NOTION_BLOCK_DEPTH_MAX = 3;

export interface NotionRichText {
  plain_text?: string | null;
  href?: string | null;
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean } | null;
}

export interface NotionBlock {
  id?: string;
  type?: string;
  has_children?: boolean;
  /** Filled by the reader for a followed block. */
  children?: NotionBlock[];
  [type: string]: unknown;
}

const httpsOnly = (u: string | null | undefined): string | null => (u != null && /^https:\/\//i.test(u) ? u : null);

/** Rich text → markdown (bold, italic, strikethrough, inline code, https links). */
export function richTextMarkdown(rt: readonly NotionRichText[] | null | undefined): string {
  let out = '';
  for (const t of rt ?? []) {
    let s = t?.plain_text ?? '';
    if (s === '') continue;
    const a = t.annotations ?? {};
    if (a.code) s = `\`${s.replace(/`/g, '')}\``;
    else {
      const lead = /^\s*/.exec(s)![0];
      const trail = /\s*$/.exec(s)![0];
      let core = s.trim();
      if (core !== '') {
        if (a.bold) core = `**${core}**`;
        if (a.italic) core = `*${core}*`;
        if (a.strikethrough) core = `~~${core}~~`;
      }
      s = `${lead}${core}${trail}`;
    }
    const href = httpsOnly(t.href);
    if (href != null && !a.code) s = `[${s}](${href})`;
    out += s;
  }
  return out;
}

/** Rich text → plain text. */
export function richTextPlain(rt: readonly NotionRichText[] | null | undefined): string {
  return (rt ?? []).map((t) => t?.plain_text ?? '').join('');
}

function textOf(b: NotionBlock): string {
  const body = b[b.type ?? ''] as { rich_text?: NotionRichText[] } | undefined;
  return richTextMarkdown(body?.rich_text);
}

const indent = (s: string, by: string): string =>
  s
    .split('\n')
    .map((l) => (l === '' ? l : `${by}${l}`))
    .join('\n');

function tableMarkdown(b: NotionBlock): string {
  const rows = (b.children ?? []).filter((r) => r.type === 'table_row');
  if (rows.length === 0) return '';
  const cells = rows.map((r) =>
    (((r.table_row as { cells?: NotionRichText[][] } | undefined)?.cells ?? []) as NotionRichText[][]).map((c) =>
      richTextMarkdown(c).replace(/\|/g, '\\|').replace(/\n/g, ' '),
    ),
  );
  const width = Math.max(...cells.map((c) => c.length));
  if (width === 0) return '';
  const line = (c: string[]): string => `| ${Array.from({ length: width }, (_, i) => c[i] ?? '').join(' | ')} |`;
  return [line(cells[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
}

/** One block (and its followed children) → markdown lines; '' for a skipped block. */
function blockMarkdown(b: NotionBlock, number: number): string {
  const kids = (b.children ?? []).length > 0 ? blocksToMarkdown(b.children ?? []) : '';
  const nested = (s: string): string => (kids === '' ? s : `${s}\n${indent(kids, '  ')}`);
  switch (b.type) {
    case 'paragraph':
      return nested(textOf(b));
    case 'heading_1':
      return `# ${textOf(b)}`;
    case 'heading_2':
      return `## ${textOf(b)}`;
    case 'heading_3':
      return `### ${textOf(b)}`;
    case 'bulleted_list_item':
      return nested(`- ${textOf(b)}`);
    case 'numbered_list_item':
      return nested(`${number}. ${textOf(b)}`);
    case 'to_do': {
      const checked = (b.to_do as { checked?: boolean } | undefined)?.checked === true;
      return nested(`- [${checked ? 'x' : ' '}] ${textOf(b)}`);
    }
    case 'code': {
      const c = b.code as { rich_text?: NotionRichText[]; language?: string } | undefined;
      const lang = /^[a-z0-9+#-]{1,20}$/i.test(c?.language ?? '') && c?.language !== 'plain text' ? c!.language : '';
      return `\`\`\`${lang}\n${richTextPlain(c?.rich_text)}\n\`\`\``;
    }
    case 'quote':
    case 'callout': {
      const text = textOf(b);
      const all = kids === '' ? text : `${text}\n${kids}`;
      return all
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n');
    }
    case 'toggle':
      return nested(`- ${textOf(b)}`);
    case 'divider':
      return '---';
    case 'table':
      return tableMarkdown(b);
    default:
      return '';
  }
}

/** A list of sibling blocks → markdown. Pure. */
export function blocksToMarkdown(blocks: readonly NotionBlock[]): string {
  const parts: string[] = [];
  let n = 0;
  let prevType: string | undefined;
  for (const b of blocks) {
    n = b.type === 'numbered_list_item' ? (prevType === 'numbered_list_item' ? n + 1 : 1) : 0;
    const md = blockMarkdown(b, n);
    prevType = b.type;
    if (md.trim() === '') continue;
    const listy = /^(bulleted_list_item|numbered_list_item|to_do|toggle)$/.test(b.type ?? '');
    const last = parts[parts.length - 1];
    // Consecutive list items stay one list (single newline); everything else is its own paragraph.
    if (listy && last != null && last.startsWith('\u0000list')) parts[parts.length - 1] = `${last}\n${md}`;
    else parts.push(listy ? `\u0000list${md}` : md);
  }
  return parts
    .map((p) => p.replace(/^\u0000list/, ''))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Block types whose children are drawn (and therefore read). */
const FOLLOWED = new Set([
  'paragraph',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'table',
]);

interface ChildrenPage {
  results?: NotionBlock[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/**
 * Read a page's body as markdown. Bounded (calls, blocks, depth); never throws on a cut — the first
 * call's failure propagates (the reader decides), a later one ends the read with what it has.
 */
export async function fetchPageMarkdown(call: TrackerCall, pageId: string): Promise<string> {
  const budget = { calls: NOTION_BLOCK_CALLS_MAX, blocks: NOTION_BLOCKS_MAX, cut: false };
  const children = async (blockId: string, depth: number): Promise<NotionBlock[]> => {
    const out: NotionBlock[] = [];
    let cursor: string | null = null;
    for (;;) {
      if (budget.calls <= 0 || budget.blocks <= 0) {
        budget.cut = true;
        return out;
      }
      budget.calls -= 1;
      const q = new URLSearchParams({ page_size: '100' });
      if (cursor != null) q.set('start_cursor', cursor);
      const page: ChildrenPage = await notionRequest<ChildrenPage>(
        call,
        'GET',
        `/v1/blocks/${encodeURIComponent(blockId)}/children?${q.toString()}`,
      );
      for (const b of page.results ?? []) {
        if (budget.blocks <= 0) {
          budget.cut = true;
          break;
        }
        budget.blocks -= 1;
        out.push(b);
      }
      if (page.has_more !== true || page.next_cursor == null || budget.blocks <= 0) {
        if (page.has_more === true) budget.cut = true;
        break;
      }
      cursor = page.next_cursor;
    }
    if (depth < NOTION_BLOCK_DEPTH_MAX) {
      for (const b of out) {
        if (b.has_children !== true || !FOLLOWED.has(b.type ?? '') || b.id == null) continue;
        try {
          b.children = await children(b.id, depth + 1);
        } catch {
          budget.cut = true;
        }
      }
    }
    return out;
  };
  const top = await children(pageId, 1);
  const md = blocksToMarkdown(top);
  return budget.cut ? `${md}${md !== '' ? '\n\n' : ''}_(The rest of this Notion page was not read.)_` : md;
}
