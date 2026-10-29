import { htmlToMarkdown } from '../convert.js';

// CONFLUENCE STORAGE FORMAT → MARKDOWN (docs/REFERENCE-DOCS.md § Wiki sources → Converting a page).
//
// A page body arrives as Confluence "storage format": XHTML plus Confluence's own `ac:` / `ri:`
// elements (macros, links to other pages, images, task lists, layouts). This module rewrites it into
// PLAIN HTML (`storageToHtml`, pure) and hands that to the library's ONE turndown pipeline
// (`htmlToMarkdown` — tables, links and images behave exactly as for an uploaded web page).
//
//   code / noformat            → a fenced code block (the language kept)
//   info / note / tip / warning / panel / success / error (+ the new editor's panels)
//                              → a quote headed by its kind ("Note:") and its title
//   expand                     → its title in bold, then its body
//   mermaid / plantuml with text → a fenced block of the diagram's SOURCE
//   draw.io / Gliffy / Lucidchart, or a diagram with no text source
//                              → `[Diagram: name]` (DIAGRAM_HOOK: a later image-description pass
//                                replaces this placeholder; the name is all the body holds)
//   status / jira              → their words ("[In progress]", "[Jira: ENG-12]")
//   toc / children / anchor / attachments and other navigation macros → dropped
//   an unknown macro           → its rich-text body if it has one, else nothing
//   ac:link                    → its text (or the target page's title); no address (it is the wiki's)
//   ac:image                   → `[Image: alt or file name]`
//   ac:task-list               → a list with [x] / [ ] marks
//
// ⚠ THE BODY IS A STRANGER'S TEXT, up to megabytes: the tokenizer is ONE forward pass (indexOf and a
// quote-aware walk to each tag's end), the element stack is capped (STACK_CAP) so a page of unclosed
// tags cannot make close-tag matching quadratic, and rendering recurses at most that deep.

const STACK_CAP = 256;

interface El {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = El | { text: string; raw: boolean };

const isEl = (n: Node): n is El => (n as El).name !== undefined;

/** Escape text for HTML (CDATA content, attribute values we write). */
export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Decode the few entities an attribute value carries (titles, file names). */
function decodeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Bounded by the tag's own text; the pattern has no nested quantifiers.
  for (const m of src.matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]!.toLowerCase()] = decodeAttr(m[2] ?? m[3] ?? '');
  }
  return out;
}

/** The index just past a tag's closing `>`, honouring quotes. -1 when the tag never closes. */
function tagEnd(s: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  return -1;
}

/** Storage XHTML → a tree. One forward pass. */
export function parseStorage(src: string): El {
  const root: El = { name: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  const top = (): El => stack[stack.length - 1]!;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      top().children.push({ text: src.slice(i), raw: true });
      break;
    }
    if (lt > i) top().children.push({ text: src.slice(i, lt), raw: true });
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const body = end < 0 ? src.slice(lt + 9) : src.slice(lt + 9, end);
      top().children.push({ text: body, raw: false });
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const end = tagEnd(src, lt + 1);
    if (end < 0) {
      top().children.push({ text: escapeHtml(src.slice(lt)), raw: true });
      break;
    }
    const inner = src.slice(lt + 1, end - 1);
    i = end;
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim().toLowerCase();
      // Pop to the nearest open element of that name (the stack is capped, so this is bounded).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9:_-]*)([\s\S]*)$/.exec(inner);
    if (!m) {
      top().children.push({ text: escapeHtml(`<${inner}>`), raw: true });
      continue;
    }
    const name = m[1]!.toLowerCase();
    let rest = m[2]!;
    const selfClosing = /\/\s*$/.test(rest);
    if (selfClosing) rest = rest.replace(/\/\s*$/, '');
    const el: El = { name, attrs: parseAttrs(rest), children: [] };
    top().children.push(el);
    if (!selfClosing && !VOID.has(name) && stack.length < STACK_CAP) stack.push(el);
  }
  return root;
}

const VOID = new Set(['br', 'hr', 'img', 'col', 'wbr', 'input', 'meta', 'link', 'source', 'area', 'base', 'embed', 'param', 'track']);

// Plain HTML elements kept as elements (everything else without a colon renders as its children).
const KEEP = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'colgroup', 'col', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike', 'sub', 'sup', 'code', 'pre', 'blockquote', 'a', 'div',
  'span', 'dl', 'dt', 'dd', 'caption', 'kbd', 'small', 'mark', 'abbr', 'cite', 'q',
]);

const PANEL_LABEL: Record<string, string> = {
  info: 'Info',
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
  success: 'Success',
  error: 'Error',
  panel: '',
};

const DROP_MACROS = new Set([
  'toc', 'toc-zone', 'children', 'pagetree', 'pagetreesearch', 'anchor', 'attachments', 'recently-updated', 'contributors',
  'contributors-summary', 'livesearch', 'create-from-template', 'content-by-label', 'blog-posts', 'page-index', 'space-details',
  'profile', 'gallery', 'viewfile', 'view-file', 'multimedia', 'widget', 'roadmap', 'change-history', 'excerpt-include', 'include',
]);

const DIAGRAM_MACROS = new Set(['drawio', 'drawio-sketch', 'inc-drawio', 'gliffy', 'lucidchart', 'lucidchart-macro', 'mermaid', 'mermaid-cloud', 'mermaid-macro', 'plantuml', 'plantumlcloud']);
const TEXT_DIAGRAMS: Record<string, string> = { mermaid: 'mermaid', 'mermaid-cloud': 'mermaid', 'mermaid-macro': 'mermaid', plantuml: 'plantuml', plantumlcloud: 'plantuml' };

const child = (el: El, name: string): El | null => (el.children.find((c) => isEl(c) && c.name === name) as El | undefined) ?? null;

function param(el: El, key: string): string | null {
  for (const c of el.children) {
    if (isEl(c) && c.name === 'ac:parameter' && (c.attrs['ac:name'] ?? '').toLowerCase() === key.toLowerCase()) {
      const v = plainText(c).trim();
      return v === '' ? null : v;
    }
  }
  return null;
}

/** The text inside a node, entities left as written (raw) or decoded (CDATA). */
function plainText(n: Node): string {
  if (!isEl(n)) return n.raw ? decodeAttr(n.text.replace(/&nbsp;/g, ' ')) : n.text;
  return n.children.map(plainText).join('');
}

const kids = (el: El, depth: number): string => el.children.map((c) => render(c, depth + 1)).join('');

/** A diagram's placeholder. DIAGRAM_HOOK: an image-description pass may replace these later. */
export function diagramPlaceholder(name: string | null): string {
  const n = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `<p>${literal(`[Diagram: ${n || 'untitled'}]`)}</p>`;
}

// LITERALS: words the server writes in brackets ("[Diagram: x]", "[Jira: PAY-12]", "[x]") must reach
// the markdown as written — turndown would escape the brackets. They travel through turndown as a
// private-use sentinel and are put back after (`storageToMarkdown`); `storageToHtml` puts them back
// as escaped text. Synchronous per call, so one module-level list is safe.
let literals: string[] = [];
const literal = (s: string): string => {
  literals.push(s);
  return `${literals.length - 1}`;
};
const SENTINEL = /(\d+)/g;

// FIGURES (docs/REFERENCE-DOCS.md § Figures). The adapter reads the page's images and diagram files
// BEFORE rendering (confluence.ts) and hands back the text for each, keyed as `figureRefs` names them:
// an image's figure marker, a diagram's outline (or its preview's marker). Rendering stays pure and
// synchronous: it only looks the key up. Without a replacement the placeholder stays.
let replacements: ReadonlyMap<string, string> = new Map();

export interface StorageFigureRef {
  key: string;
  kind: 'attachment' | 'url' | 'drawio' | 'gliffy';
  /** The attachment's file name (an image), the address (an external image) or the diagram's name. */
  name: string;
  /** What the image keeps when it is not described. */
  fallback: string;
}

const DRAWIO = new Set(['drawio', 'drawio-sketch', 'inc-drawio']);

function diagramName(el: El, macro: string): string {
  return param(el, 'diagramDisplayName') ?? param(el, 'diagramName') ?? param(el, 'name') ?? param(el, 'title') ?? param(el, 'filename') ?? macro;
}

/** The images and readable diagrams of a page, in order, once each (bounded by the stack-capped tree). */
export function storageFigureRefs(storage: string): StorageFigureRef[] {
  const out: StorageFigureRef[] = [];
  const seen = new Set<string>();
  const push = (r: StorageFigureRef): void => {
    if (seen.has(r.key) || out.length >= 200) return;
    seen.add(r.key);
    out.push(r);
  };
  const stack: Node[] = [parseStorage(storage)];
  let visited = 0;
  while (stack.length > 0 && visited < 200_000) {
    visited += 1;
    const n = stack.pop()!;
    if (!isEl(n)) continue;
    if (n.name === 'ac:image') {
      const att = child(n, 'ri:attachment');
      const url = child(n, 'ri:url');
      const alt = n.attrs['ac:alt'] ?? n.attrs['ac:title'] ?? '';
      const file = att?.attrs['ri:filename'] ?? '';
      // An attachment of ANOTHER page (ri:page inside ri:attachment) is not this page's: left as its name.
      if (att && file && !child(att, 'ri:page')) push({ key: `att:${file}`, kind: 'attachment', name: file, fallback: `Image: ${alt || file}` });
      else if (url?.attrs['ri:value']) push({ key: `url:${url.attrs['ri:value']}`, kind: 'url', name: url.attrs['ri:value'], fallback: `Image: ${alt || url.attrs['ri:value']}` });
      continue;
    }
    if (n.name === 'ac:structured-macro' || n.name === 'ac:macro') {
      const macro = (n.attrs['ac:name'] ?? '').toLowerCase();
      if (DRAWIO.has(macro) || macro === 'gliffy') {
        const name = diagramName(n, macro);
        const file = param(n, 'diagramName') ?? param(n, 'name') ?? name;
        push({ key: `diagram:${macro}:${name}`, kind: macro === 'gliffy' ? 'gliffy' : 'drawio', name: file, fallback: `Diagram: ${name}` });
      }
    }
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]!);
  }
  return out;
}

function renderMacro(el: El, depth: number): string {
  const macro = (el.attrs['ac:name'] ?? '').toLowerCase();
  const body = child(el, 'ac:rich-text-body');
  const plain = child(el, 'ac:plain-text-body');
  if (macro === 'code' || macro === 'noformat' || macro === 'code-block') {
    const lang = (param(el, 'language') ?? '').toLowerCase().replace(/[^a-z0-9+#-]/g, '');
    const text = plain ? plainText(plain) : body ? plainText(body) : '';
    const title = param(el, 'title');
    return `${title ? `<p><strong>${escapeHtml(title)}</strong></p>` : ''}<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(text)}</code></pre>`;
  }
  if (macro in PANEL_LABEL) {
    const title = param(el, 'title');
    const label = PANEL_LABEL[macro] || '';
    const head = [label ? `${label}:` : '', title ?? ''].filter(Boolean).join(' ');
    return `<blockquote>${head ? `<p><strong>${escapeHtml(head)}</strong></p>` : ''}${body ? kids(body, depth) : ''}</blockquote>`;
  }
  if (macro === 'expand' || macro === 'ui-expand') {
    const title = param(el, 'title') ?? 'Details';
    return `<p><strong>${escapeHtml(title)}</strong></p>${body ? kids(body, depth) : ''}`;
  }
  if (DIAGRAM_MACROS.has(macro)) {
    const source = plain ? plainText(plain).trim() : '';
    const lang = TEXT_DIAGRAMS[macro];
    if (lang && source !== '') return `<pre><code class="language-${lang}">${escapeHtml(source)}</code></pre>`;
    const name = diagramName(el, macro);
    const replaced = replacements.get(`diagram:${macro}:${name}`);
    if (replaced) return `<p>${literal(replaced)}</p>`;
    return diagramPlaceholder(name);
  }
  if (macro === 'status') {
    const t = param(el, 'title') ?? param(el, 'colour') ?? '';
    return t ? literal(`[${t.slice(0, 60)}]`) : '';
  }
  if (macro === 'jira' || macro === 'jiraissues') {
    const key = param(el, 'key');
    return key ? literal(`[Jira: ${key.slice(0, 40)}]`) : '';
  }
  if (DROP_MACROS.has(macro)) return '';
  if (body) return kids(body, depth);
  if (plain) {
    const text = plainText(plain).trim();
    return text ? `<pre><code>${escapeHtml(text)}</code></pre>` : '';
  }
  return '';
}

function renderAdf(el: El, depth: number): string {
  // The new editor's extensions: `<ac:adf-extension><ac:adf-node type="panel">…<ac:adf-content>…`
  // with an `<ac:adf-fallback>` beside it for older readers. The node wins; its content is rendered.
  const node = child(el, 'ac:adf-node');
  if (node) {
    const type = (node.attrs['type'] ?? '').toLowerCase();
    const content = child(node, 'ac:adf-content');
    if (type === 'panel') {
      let kind = '';
      for (const c of node.children) {
        if (isEl(c) && c.name === 'ac:adf-attribute' && c.attrs['key'] === 'panel-type') kind = plainText(c).trim().toLowerCase();
      }
      const label = PANEL_LABEL[kind] ?? '';
      return `<blockquote>${label ? `<p><strong>${label}:</strong></p>` : ''}${content ? kids(content, depth) : ''}</blockquote>`;
    }
    if (content) return kids(content, depth);
  }
  const fallback = child(el, 'ac:adf-fallback');
  return fallback ? kids(fallback, depth) : '';
}

function linkText(el: El): string {
  const plainBody = child(el, 'ac:plain-text-link-body');
  if (plainBody) return escapeHtml(plainText(plainBody).trim());
  const body = child(el, 'ac:link-body');
  if (body) return kids(body, 0);
  for (const c of el.children) {
    if (!isEl(c)) continue;
    if (c.name === 'ri:page' || c.name === 'ri:blog-post') return escapeHtml(c.attrs['ri:content-title'] ?? '');
    if (c.name === 'ri:attachment') return escapeHtml(c.attrs['ri:filename'] ?? '');
    if (c.name === 'ri:user') return '@user';
    if (c.name === 'ri:space') return escapeHtml(c.attrs['ri:space-key'] ?? '');
  }
  return escapeHtml(el.attrs['ac:anchor'] ?? '');
}

function render(n: Node, depth: number): string {
  if (!isEl(n)) return n.raw ? n.text : escapeHtml(n.text);
  if (depth > STACK_CAP) return '';
  const name = n.name;
  switch (name) {
    case '#root':
      return kids(n, depth);
    case 'ac:structured-macro':
    case 'ac:macro':
      return renderMacro(n, depth);
    case 'ac:adf-extension':
      return renderAdf(n, depth);
    case 'ac:link':
      return linkText(n);
    case 'ac:image': {
      const att = child(n, 'ri:attachment');
      const url = child(n, 'ri:url');
      const replaced = att?.attrs['ri:filename'] && !child(att, 'ri:page')
        ? replacements.get(`att:${att.attrs['ri:filename']}`)
        : url?.attrs['ri:value']
          ? replacements.get(`url:${url.attrs['ri:value']}`)
          : undefined;
      if (replaced) return literal(replaced);
      const alt = n.attrs['ac:alt'] ?? n.attrs['ac:title'] ?? att?.attrs['ri:filename'] ?? url?.attrs['ri:value'] ?? '';
      return alt ? `<img alt="${escapeHtml(alt)}">` : '';
    }
    case 'ac:emoticon': {
      const fb = n.attrs['ac:emoji-fallback'] ?? '';
      return fb && !/^:/.test(fb) ? escapeHtml(fb) : '';
    }
    case 'ac:task-list':
      return `<ul>${kids(n, depth)}</ul>`;
    case 'ac:task': {
      const status = child(n, 'ac:task-status');
      const done = status ? plainText(status).trim() === 'complete' : false;
      const body = child(n, 'ac:task-body');
      return `<li>${literal(done ? '[x]' : '[ ]')} ${body ? unwrapParagraphs(kids(body, depth)) : ''}</li>`;
    }
    case 'ac:task-status':
    case 'ac:task-id':
    case 'ac:task-uuid':
    case 'ac:parameter':
    case 'ac:placeholder':
    case 'ac:adf-attribute':
      return '';
    case 'time': {
      const dt = n.attrs['datetime'] ?? '';
      return dt ? escapeHtml(dt) : kids(n, depth);
    }
    case 'a': {
      const href = n.attrs['href'] ?? '';
      return /^(?:https?:|mailto:)/i.test(href) ? `<a href="${escapeHtml(href)}">${kids(n, depth)}</a>` : kids(n, depth);
    }
    case 'img': {
      const alt = n.attrs['alt'] ?? '';
      return alt ? `<img alt="${escapeHtml(alt)}">` : '';
    }
    case 'th':
    case 'td': {
      const span = ['colspan', 'rowspan']
        .filter((k) => /^\d{1,3}$/.test(n.attrs[k] ?? ''))
        .map((k) => ` ${k}="${n.attrs[k]}"`)
        .join('');
      return `<${name}${span}>${unwrapParagraphs(kids(n, depth))}</${name}>`;
    }
    case 'li':
      return `<li>${unwrapParagraphs(kids(n, depth))}</li>`;
    case 'code':
    case 'pre': {
      const cls = /^language-[a-z0-9+#-]{1,24}$/i.test(n.attrs['class'] ?? '') ? ` class="${n.attrs['class']}"` : '';
      return `<${name}${cls}>${kids(n, depth)}</${name}>`;
    }
    case 'script':
    case 'style':
    case 'noscript':
    case 'iframe':
    case 'object':
    case 'embed':
    case 'template':
    case 'svg':
    case 'canvas':
    case 'form':
    case 'button':
      return '';
    default:
      if (KEEP.has(name)) return VOID.has(name) ? `<${name}>` : `<${name}>${kids(n, depth)}</${name}>`;
      // ac:layout, ac:layout-section, ac:layout-cell, ac:rich-text-body … and unknown HTML: their children.
      return kids(n, depth);
  }
}

/**
 * Confluence wraps a table cell's or a list item's text in <p>: turndown would then break the cell
 * (or space the list) across lines. The paragraphs WE rendered become plain runs, joined by a space.
 */
function unwrapParagraphs(html: string): string {
  return html.replace(/<\/p>\s*<p>/g, ' ').replace(/^\s*<p>/, '').replace(/<\/p>\s*$/, '').replace(/<\/?p>/g, ' ');
}

function renderWithLiterals(storage: string, figures?: ReadonlyMap<string, string>): { html: string; lits: string[] } {
  literals = [];
  replacements = figures ?? new Map();
  try {
    const html = render(parseStorage(storage), 0);
    return { html, lits: literals };
  } finally {
    literals = [];
    replacements = new Map();
  }
}

/** Storage XHTML → plain HTML (pure). */
export function storageToHtml(storage: string): string {
  const { html, lits } = renderWithLiterals(storage);
  return html.replace(SENTINEL, (_m, i: string) => escapeHtml(lits[Number(i)] ?? ''));
}

/** Storage XHTML → markdown, through the library's turndown pipeline. */
export async function storageToMarkdown(storage: string, figures?: ReadonlyMap<string, string>): Promise<string> {
  const { html, lits } = renderWithLiterals(storage, figures);
  if (html.trim() === '') return '';
  const md = await htmlToMarkdown(`<article>${html}</article>`);
  return md.replace(SENTINEL, (_m, i: string) => lits[Number(i)] ?? '');
}
