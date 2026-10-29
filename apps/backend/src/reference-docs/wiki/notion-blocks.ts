// NOTION BLOCKS → MARKDOWN (docs/REFERENCE-DOCS.md § Wiki sources → Notion). PURE: the adapter
// (notion.ts) reads a page's block tree — every block's children attached as `children`, a synced block
// already pointing at its original's children — and, when figures are wanted, the image bytes; this
// module only writes text.
//
//   paragraph / heading_1-3            text with its annotations (bold, italic, strikethrough, code) and links
//   bulleted / numbered / to_do        lists, nested by indentation; to-dos as [x] / [ ]
//   toggle (+ toggleable headings)     its summary in bold (or the heading), then its contents
//   quote / callout                    a quote (a callout keeps its emoji)
//   code                               a fenced block, the language kept — `mermaid` / `plantuml` stay
//                                      fenced: the source IS the diagram
//   table                              a GitHub table, its first row as the header
//   divider / equation                 `---` / a fenced `math` block (the expression as text)
//   bookmark / embed / link_preview    a link
//   image                              its figure marker (figures.ts) or `[Image: caption or file name]`
//   file / pdf / video / audio         `[File: name]` (a Notion-hosted address expires; only an external one links)
//   column_list / column / synced_block  their contents, in order
//   child_page / child_database        NOTHING: they are the document's next chapters (listDescendants)
//   anything else                      skipped silently (its children, if any, still render)
//
// ⚠ Every string is a stranger's: text is escaped so it cannot become markdown syntax (a link, a
// heading, a figure marker), only http(s)/mailto targets become links, and nesting is bounded by the
// adapter's read (depth and block caps).

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [k: string]: unknown;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const SAFE_HREF = /^(?:https?:|mailto:)/i;

/** Text that must stay text: markdown's syntax characters escaped. */
export function escapeMarkdown(s: string): string {
  return s.replace(/([\\`*_[\]<>~|])/g, '\\$1').replace(/^(\s*)([#+-]|\d+[.)])(?=\s)/gm, '$1\\$2');
}

const wrap = (t: string, mark: string): string => {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : t;
};

const codeSpan = (t: string): string => {
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const ticks = '`'.repeat(longest + 1);
  return longest > 0 ? `${ticks} ${t} ${ticks}` : `${ticks}${t}${ticks}`;
};

/** A rich-text array → inline markdown. */
export function richText(v: unknown): string {
  let out = '';
  for (const item of arr(v)) {
    const o = obj(item);
    if (!o) continue;
    if (o.type === 'equation') {
      const expr = str(obj(o.equation)?.expression) || str(o.plain_text);
      if (expr) out += codeSpan(expr);
      continue;
    }
    const plain = str(o.plain_text) || str(obj(o.text)?.content);
    if (plain === '') continue;
    const ann = obj(o.annotations) ?? {};
    let t = ann.code === true ? codeSpan(plain) : escapeMarkdown(plain);
    if (ann.code !== true) {
      if (ann.bold === true) t = wrap(t, '**');
      if (ann.italic === true) t = wrap(t, '_');
      if (ann.strikethrough === true) t = wrap(t, '~~');
    }
    const href = str(obj(obj(o.text)?.link)?.url) || str(o.href);
    if (href && SAFE_HREF.test(href) && !/[\s()<>]/.test(href)) t = `[${t}](${href})`;
    out += t;
  }
  return out;
}

const plainOf = (v: unknown): string =>
  arr(v)
    .map((i) => str(obj(i)?.plain_text))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

const payload = (b: NotionBlock): Obj => obj(b[b.type]) ?? {};

/** A Notion-hosted file's address expires; only its name is kept. An external one may link. */
function fileOf(b: NotionBlock): { url: string; hosted: boolean; name: string; caption: string } {
  const p = payload(b);
  const hosted = str(p.type) === 'file';
  const url = hosted ? str(obj(p.file)?.url) : str(obj(p.external)?.url);
  const caption = plainOf(p.caption);
  let name = str(p.name);
  if (!name && url) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    } catch {
      name = '';
    }
  }
  return { url, hosted, name: name.replace(/\s+/g, ' ').trim().slice(0, 120), caption };
}

/** Words that may stand inside `[Image: …]`: no brackets, pipes or line breaks. */
const bracketSafe = (s: string): string => s.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

export interface NotionImageRef {
  blockId: string;
  url: string;
  fallback: string;
}

/** Every image of a block tree, in reading order (the adapter downloads them for figures). */
export function notionImageRefs(blocks: readonly NotionBlock[]): NotionImageRef[] {
  const out: NotionImageRef[] = [];
  const stack = [...blocks].reverse();
  while (stack.length > 0 && out.length < 200) {
    const b = stack.pop()!;
    if (b.type === 'image') {
      const f = fileOf(b);
      if (f.url && /^https:/i.test(f.url)) out.push({ blockId: b.id, url: f.url, fallback: `Image: ${bracketSafe(f.caption || f.name) || 'untitled'}` });
    }
    for (let k = (b.children ?? []).length - 1; k >= 0; k--) stack.push(b.children![k]!);
  }
  return out;
}

const indent = (text: string, pad: string): string =>
  text
    .split('\n')
    .map((l) => (l === '' ? '' : pad + l))
    .join('\n');

const quoteLines = (text: string): string =>
  text
    .split('\n')
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n');

const fence = (body: string, lang: string): string => {
  const longest = Math.max(0, ...(body.match(/`{3,}/g) ?? []).map((r) => r.length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${body.replace(/\n+$/, '')}\n${f}`;
};

const codeLanguage = (raw: string): string => {
  const l = raw.toLowerCase().trim();
  if (l === '' || l === 'plain text') return '';
  return l.replace(/\s+/g, '').replace(/[^a-z0-9+#-]/g, '').slice(0, 24);
};

interface Chunk {
  text: string;
  list: boolean;
}

function renderBlocks(blocks: readonly NotionBlock[], figures: ReadonlyMap<string, string>, depth: number): string {
  const chunks: Chunk[] = [];
  let n = 0;
  for (const b of blocks) {
    n = b.type === 'numbered_list_item' ? n + 1 : 0;
    const c = renderBlock(b, figures, depth, n);
    if (c && c.text.trim() !== '') chunks.push(c);
  }
  let out = '';
  chunks.forEach((c, i) => {
    if (i > 0) out += chunks[i - 1]!.list && c.list ? '\n' : '\n\n';
    out += c.text;
  });
  return out;
}

function renderBlock(b: NotionBlock, figures: ReadonlyMap<string, string>, depth: number, number: number): Chunk | null {
  if (depth > 40) return null;
  const p = payload(b);
  const kids = (): string => (b.children && b.children.length > 0 ? renderBlocks(b.children, figures, depth + 1) : '');
  const withKids = (head: string): string => {
    const k = kids();
    return head && k ? `${head}\n\n${k}` : head || k;
  };
  switch (b.type) {
    case 'paragraph':
      return { text: withKids(richText(p.rich_text)), list: false };
    case 'heading_1':
    case 'heading_2':
    case 'heading_3': {
      const level = Number(b.type.slice(-1));
      const t = richText(p.rich_text).replace(/\n+/g, ' ').trim();
      return { text: withKids(t ? `${'#'.repeat(level)} ${t}` : ''), list: false };
    }
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'to_do': {
      const mark = b.type === 'numbered_list_item' ? `${number}.` : '-';
      const box = b.type === 'to_do' ? (p.checked === true ? '[x] ' : '[ ] ') : '';
      const pad = ' '.repeat(mark.length + 1);
      const head = `${mark} ${box}${indent(richText(p.rich_text), pad).trimStart()}`;
      const k = kids();
      return { text: k ? `${head}\n${indent(k, pad)}` : head, list: true };
    }
    case 'toggle': {
      const t = richText(p.rich_text).replace(/\n+/g, ' ').trim();
      return { text: withKids(t ? `**${t}**` : ''), list: false };
    }
    case 'quote':
      return { text: quoteLines(withKids(richText(p.rich_text))), list: false };
    case 'callout': {
      const icon = obj(p.icon);
      const emoji = str(icon?.type) === 'emoji' ? str(icon?.emoji) : '';
      const t = richText(p.rich_text);
      return { text: quoteLines(withKids(emoji && t ? `${emoji} ${t}` : t)), list: false };
    }
    case 'code': {
      const body = arr(p.rich_text)
        .map((i) => str(obj(i)?.plain_text))
        .join('');
      const caption = plainOf(p.caption);
      const block = fence(body, codeLanguage(str(p.language)));
      return { text: caption ? `${block}\n\n_${escapeMarkdown(caption)}_` : block, list: false };
    }
    case 'equation': {
      const expr = str(p.expression);
      return expr ? { text: fence(expr, 'math'), list: false } : null;
    }
    case 'divider':
      return { text: '---', list: false };
    case 'table': {
      const rows = (b.children ?? []).filter((r) => r.type === 'table_row');
      if (rows.length === 0) return null;
      const width = Math.max(1, Number(p.table_width) || 0, ...rows.map((r) => arr(payload(r).cells).length));
      const cell = (c: unknown): string => richText(c).replace(/\n+/g, ' ').replace(/(^|[^\\])\|/g, '$1\\|').trim();
      const line = (r: NotionBlock): string => {
        const cells = arr(payload(r).cells).map(cell);
        while (cells.length < width) cells.push('');
        return `| ${cells.join(' | ')} |`;
      };
      const out = [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)];
      return { text: out.join('\n'), list: false };
    }
    case 'bookmark':
    case 'embed':
    case 'link_preview': {
      const url = str(p.url);
      if (!url || !SAFE_HREF.test(url) || /[\s()<>]/.test(url)) return null;
      const caption = plainOf(p.caption);
      return { text: `[${escapeMarkdown(caption || url)}](${url})`, list: false };
    }
    case 'image': {
      const marker = figures.get(b.id);
      if (marker) return { text: marker, list: false };
      const f = fileOf(b);
      const name = bracketSafe(f.caption || f.name);
      return name ? { text: `[Image: ${name}]`, list: false } : null;
    }
    case 'file':
    case 'pdf':
    case 'video':
    case 'audio': {
      const f = fileOf(b);
      const label = b.type === 'video' ? 'Video' : b.type === 'audio' ? 'Audio' : 'File';
      const name = bracketSafe(f.caption || f.name) || label.toLowerCase();
      if (!f.hosted && f.url && SAFE_HREF.test(f.url) && !/[\s()<>]/.test(f.url)) return { text: `[${label}: ${name}](${f.url})`, list: false };
      return { text: `[${label}: ${name}]`, list: false };
    }
    case 'child_page':
    case 'child_database':
    case 'link_to_page':
    case 'table_of_contents':
    case 'breadcrumb':
    case 'template':
    case 'unsupported':
      return null;
    case 'column_list':
    case 'column':
    case 'synced_block':
    default: {
      const k = kids();
      return k ? { text: k, list: false } : null;
    }
  }
}

/** A page's block tree → markdown. `figures` maps an image block's id to its figure marker. */
export function notionBlocksToMarkdown(blocks: readonly NotionBlock[], figures: ReadonlyMap<string, string> = new Map()): string {
  return renderBlocks(blocks, figures, 0).trim();
}
