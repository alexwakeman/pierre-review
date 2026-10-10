// MARKDOWN → JIRA, for the sprint write-back (./run.ts). The reader confirms MARKDOWN in the dialog
// (the same text the Copy buttons put on the clipboard); Jira Cloud's v3 API takes Atlassian Document
// Format and Jira Server / Data Center's v2 API takes wiki markup, so both conversions live here.
// Pure, no I/O. What it understands: paragraphs, headings, bullet / ordered lists (nested by
// indent), bold, italic, inline code, fenced code blocks, links (https only — anything else stays
// as its visible text) and hard breaks (consecutive lines of one paragraph). Anything else is text.

type Mark = { type: 'strong' } | { type: 'em' } | { type: 'code' } | { type: 'link'; attrs: { href: string } };
interface TextNode {
  type: 'text';
  text: string;
  marks?: Mark[];
}
type InlineNode = TextNode | { type: 'hardBreak' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BlockNode = Record<string, any>;

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: unknown[];
}

const httpsOnly = (href: string): string | null => {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
};

// One pass over inline markdown. Order matters: code first (its content is literal), then links,
// then bold before italic.
const INLINE_RE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s](?:[^*\n]*?[^*\s])?)\*|(?<![A-Za-z0-9_])_([^_\s](?:[^_\n]*?[^_\s])?)_(?![A-Za-z0-9_])/g;

function inline(src: string, marks: Mark[] = []): TextNode[] {
  const out: TextNode[] = [];
  const push = (text: string, m: Mark[]): void => {
    if (text === '') return;
    out.push(m.length > 0 ? { type: 'text', text, marks: m } : { type: 'text', text });
  };
  let last = 0;
  for (const match of src.matchAll(new RegExp(INLINE_RE.source, 'g'))) {
    const at = match.index ?? 0;
    push(src.slice(last, at), marks);
    const [whole, code, linkText, linkHref, bold1, bold2, em1, em2] = match;
    if (code != null) {
      // ADF forbids `code` beside other marks except link; keep only a link if one applies.
      push(code, [...marks.filter((m) => m.type === 'link'), { type: 'code' }]);
    } else if (linkText != null && linkHref != null) {
      const href = httpsOnly(linkHref);
      if (href != null) out.push(...inline(linkText, [...marks, { type: 'link', attrs: { href } }]));
      else out.push(...inline(linkText, marks));
    } else if (bold1 != null || bold2 != null) {
      out.push(...inline((bold1 ?? bold2)!, [...marks, { type: 'strong' }]));
    } else if (em1 != null || em2 != null) {
      out.push(...inline((em1 ?? em2)!, [...marks, { type: 'em' }]));
    } else {
      push(whole, marks);
    }
    last = at + whole.length;
  }
  push(src.slice(last), marks);
  return out;
}

function paragraph(lines: readonly string[]): BlockNode {
  const content: InlineNode[] = [];
  lines.forEach((l, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    content.push(...inline(l.trim()));
  });
  return { type: 'paragraph', content };
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)\s*([A-Za-z0-9_+.-]*)\s*$/;

interface ListLine {
  indent: number;
  ordered: boolean;
  text: string;
}

// A run of list lines → nested list nodes. A deeper indent opens a child list inside the previous
// item; a shallower one closes back to its level.
function buildList(items: readonly ListLine[], start: number, indent: number): { node: BlockNode; next: number } {
  const ordered = items[start]!.ordered;
  const listItems: BlockNode[] = [];
  let i = start;
  while (i < items.length) {
    const it = items[i]!;
    if (it.indent < indent) break;
    if (it.indent > indent) {
      const child = buildList(items, i, it.indent);
      const parent = listItems[listItems.length - 1];
      if (parent != null) parent.content.push(child.node);
      else listItems.push({ type: 'listItem', content: [child.node] });
      i = child.next;
      continue;
    }
    if (it.ordered !== ordered) break;
    listItems.push({ type: 'listItem', content: [paragraph([it.text])] });
    i += 1;
  }
  return { node: { type: ordered ? 'orderedList' : 'bulletList', content: listItems }, next: i };
}

const indentOf = (ws: string): number => ws.replace(/\t/g, '    ').length;

/** Markdown → Atlassian Document Format. Pure. */
export function markdownToAdf(md: string): AdfDoc {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const content: BlockNode[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) content.push(paragraph(para));
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE_RE.exec(line);
    if (fence != null) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i += 1; // the closing fence (or the end)
      const text = body.join('\n');
      content.push({
        type: 'codeBlock',
        ...(fence[2] ? { attrs: { language: fence[2] } } : {}),
        content: text !== '' ? [{ type: 'text', text }] : [],
      });
      continue;
    }
    if (line.trim() === '') {
      flush();
      i += 1;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading != null) {
      flush();
      content.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: inline(heading[2]!) });
      i += 1;
      continue;
    }
    if (LIST_RE.test(line)) {
      flush();
      const items: ListLine[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]!);
        if (m == null) break;
        items.push({ indent: indentOf(m[1]!), ordered: /\d/.test(m[2]!), text: m[3]! });
        i += 1;
      }
      const base = Math.min(...items.map((x) => x.indent));
      const norm = items.map((x) => ({ ...x, indent: Math.max(x.indent, base) }));
      let j = 0;
      while (j < norm.length) {
        const r = buildList(norm, j, norm[j]!.indent);
        content.push(r.node);
        j = r.next;
      }
      continue;
    }
    para.push(line);
    i += 1;
  }
  flush();
  return { type: 'doc', version: 1, content };
}

// ── wiki markup (Jira Server / Data Center, v2 API) ─────────────────────────────────────────────

function wikiInline(src: string): string {
  return src.replace(new RegExp(INLINE_RE.source, 'g'), (whole, code, linkText, linkHref, b1, b2, e1, e2) => {
    if (code != null) return `{{${code}}}`;
    if (linkText != null && linkHref != null) {
      const href = httpsOnly(linkHref);
      return href != null ? `[${wikiInline(linkText)}|${href}]` : wikiInline(linkText);
    }
    if (b1 != null || b2 != null) return `*${wikiInline(b1 ?? b2)}*`;
    if (e1 != null || e2 != null) return `_${wikiInline(e1 ?? e2)}_`;
    return whole;
  });
}

/** Markdown → Jira wiki markup (Server / Data Center). Pure. */
export function markdownToJiraWiki(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const stack: Array<{ indent: number; ch: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE_RE.exec(line);
    if (fence != null) {
      stack.length = 0;
      out.push(fence[2] ? `{code:${fence[2]}}` : '{code}');
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i]!)) out.push(lines[i++]!);
      out.push('{code}');
      i += 1;
      continue;
    }
    const list = LIST_RE.exec(line);
    if (list != null) {
      const indent = indentOf(list[1]!);
      const ch = /\d/.test(list[2]!) ? '#' : '*';
      while (stack.length > 0 && stack[stack.length - 1]!.indent > indent) stack.pop();
      const top = stack[stack.length - 1];
      if (top == null || top.indent < indent) stack.push({ indent, ch });
      else stack[stack.length - 1] = { indent, ch };
      out.push(`${stack.map((s) => s.ch).join('')} ${wikiInline(list[3]!)}`);
      i += 1;
      continue;
    }
    stack.length = 0;
    const heading = HEADING_RE.exec(line);
    out.push(heading != null ? `h${heading[1]!.length}. ${wikiInline(heading[2]!)}` : wikiInline(line));
    i += 1;
  }
  return out.join('\n');
}
