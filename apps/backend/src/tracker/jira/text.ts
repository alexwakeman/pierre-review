// Turning a Jira field value into the plain text Claude Review's ticket panel holds.
//
// REST API v2 returns `description` (and text-area custom fields) as a WIKI-MARKUP STRING on both
// Jira Cloud and Server / Data Center, and that string is kept verbatim — Claude reads wiki markup
// fine and rewriting it would be a lossy guess. Some fields (and some Cloud instances) answer in
// ATLASSIAN DOCUMENT FORMAT instead — `{type:'doc', content:[…]}` — which is flattened here to
// readable text: paragraphs, "- " list items (numbered for ordered lists), headings, hard breaks,
// code blocks, tables as " | "-joined rows. Checklist-style custom fields arrive as ARRAYS and
// select fields as `{value}` objects; both are read too.
//
// ⚠ NEVER TRUNCATED. The SPA's `checkClaudeReviewTicket` flags anything over the caps with its own
// message; cutting here would hide that the ticket is long. The only change is NORMALISATION:
// CRLF → LF, and the C0 control characters the shared validator refuses (everything but tab,
// newline and carriage return, plus DEL) removed — Jira text can carry them and pg jsonb cannot.

import { acSectionNameTier } from '@pierre-review/shared';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function normaliseJiraText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface AdfNode {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  attrs?: Record<string, unknown> | null;
}

const isNode = (v: unknown): v is AdfNode => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isAdfDoc(v: unknown): boolean {
  return isNode(v) && v.type === 'doc' && Array.isArray(v.content);
}

function children(n: AdfNode): AdfNode[] {
  return Array.isArray(n.content) ? n.content.filter(isNode) : [];
}

const attr = (n: AdfNode, k: string): string => {
  const v = n.attrs?.[k];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
};

// Inline content → one string (hard breaks become newlines).
function inline(nodes: AdfNode[]): string {
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out += typeof n.text === 'string' ? n.text : '';
        break;
      case 'hardBreak':
        out += '\n';
        break;
      case 'mention':
        out += attr(n, 'text') || '@someone';
        break;
      case 'emoji':
        out += attr(n, 'text') || attr(n, 'shortName');
        break;
      case 'status':
        out += attr(n, 'text');
        break;
      case 'inlineCard':
      case 'blockCard':
        out += attr(n, 'url');
        break;
      case 'date': {
        const ts = Number(attr(n, 'timestamp'));
        out += Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : '';
        break;
      }
      default:
        // An unknown inline node with its own content (a future mark wrapper) still yields text.
        out += inline(children(n));
    }
  }
  return out;
}

const indentLines = (s: string, pad: string): string =>
  s
    .split('\n')
    .map((l, i) => (i === 0 || l === '' ? l : pad + l))
    .join('\n');

// Block content → one entry per block (a list is ONE entry, its items on consecutive lines).
function blocks(nodes: AdfNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
      case 'heading': {
        const t = inline(children(n));
        if (t.trim() !== '') out.push(t);
        break;
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        const start = Number(attr(n, 'order')) || 1;
        const items = children(n).map((item, i) => {
          const done = item.type === 'taskItem' && attr(item, 'state') === 'DONE';
          const marker =
            n.type === 'orderedList'
              ? `${start + i}. `
              : n.type === 'taskList'
                ? done
                  ? '- [x] '
                  : '- [ ] '
                : '- ';
          // A task item holds INLINE content directly; a list item holds blocks (which may be a
          // nested list — its lines are indented under this item's text by the marker's width).
          const body =
            item.type === 'taskItem' ? inline(children(item)) : blocks(children(item)).join('\n');
          // An item with NO text of its own whose first block is a list (Jira's editor makes one when
          // a list is indented under an empty bullet) would print "- - a" — a bullet holding a bullet.
          // Its list stands in for it instead, at this level.
          const first = item.type === 'taskItem' ? undefined : children(item)[0];
          if (first != null && (first.type === 'bulletList' || first.type === 'orderedList') && body.trim() !== '') return body;
          return marker + indentLines(body, ' '.repeat(marker.length));
        });
        // ONE entry for the whole list, so its items stay on consecutive lines.
        if (items.length > 0) out.push(items.join('\n'));
        break;
      }
      case 'codeBlock':
        out.push(inline(children(n)));
        break;
      case 'blockquote':
      case 'panel':
      case 'expand':
      case 'nestedExpand':
      case 'layoutSection':
      case 'layoutColumn':
        if (n.type === 'expand' || n.type === 'nestedExpand') {
          const title = attr(n, 'title');
          if (title !== '') out.push(title);
        }
        out.push(...blocks(children(n)));
        break;
      case 'table':
        for (const row of children(n)) {
          const cells = children(row).map((cell) => blocks(children(cell)).join(' ').trim());
          if (cells.some((c) => c !== '')) out.push(cells.join(' | '));
        }
        break;
      case 'rule':
        out.push('---');
        break;
      case 'mediaSingle':
      case 'mediaGroup':
      case 'media':
        break;
      default: {
        // Unknown block: keep whatever text it carries rather than dropping a criterion.
        const t = inline(children(n));
        if (t.trim() !== '') out.push(t);
      }
    }
  }
  return out;
}

export function adfToText(doc: unknown): string {
  if (!isNode(doc)) return '';
  // Blocks are separated by a blank line, except consecutive list lines (already one per line).
  return normaliseJiraText(blocks(children(doc)).join('\n\n'));
}

// Any Jira field value → plain text. null / undefined / an empty value → ''.
export function fieldValueToText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return normaliseJiraText(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const items = v.map((x) => fieldValueToText(x)).filter((t) => t !== '');
    return items.map((t) => `- ${indentLines(t, '  ')}`).join('\n');
  }
  if (isAdfDoc(v)) return adfToText(v);
  if (isNode(v)) {
    // Select / checklist item shapes: {value}, {name}, {text}, {summary}.
    const o = v as Record<string, unknown>;
    for (const k of ['value', 'name', 'text', 'summary']) {
      const inner = o[k];
      if (inner != null && typeof inner !== 'object') return fieldValueToText(inner);
      if (inner != null && isAdfDoc(inner)) return adfToText(inner);
    }
  }
  return '';
}

// ---- Jira wiki markup → markdown ----
//
// The ticket DESCRIPTION is shown read-only, rendered as markdown, in the Claude Review panel (and
// Claude reads markdown at least as well as wiki markup). REST v2 answers in wiki markup, so the
// common constructs are rewritten: headings (`h2.`), bullet and numbered lists (`*`, `#`, nested),
// `{code}` / `{noformat}` blocks, `{quote}` / `bq.`, `*bold*`, `{{monospace}}`, `[text|url]` links
// and `||header||` tables. Anything else is left as written — a lossless miss beats a wrong guess.
// Text inside a code block is never touched.

// `!name.png|width=326,alt="…"!` / `!name.png!` → a short plain marker. Run BEFORE a table row
// is split, because the attribute list's `|` would otherwise split the cell.
const IMAGE_RE = /!([^\s!|][^!|\n]*?\.[A-Za-z0-9]{2,5})(?:\|[^!\n]*)?!/g;
const imagesToText = (s: string): string => s.replace(IMAGE_RE, '(image: $1)');

// {color:#0747a6}…{color} — colour only, so the tags go and the text stays.
const stripColour = (s: string): string => s.replace(/\{color(?::[^}\n]*)?\}/g, '');

// Links → markdown, which carries no `|`. Also run before a table row is split.
const linksToMd = (s: string): string =>
  s
    // [text|url|smart-link] (a Jira link card) → [text](url)
    .replace(/\[([^|\]\n]+)\|((?:https?):[^\]\s|]+)\|[^\]\n|]*\]/g, '[$1]($2)')
    // [text|url] → [text](url); [url] → <url>
    .replace(/\[([^|\]\n]+)\|((?:https?|mailto):[^\]\s]+)\]/g, '[$1]($2)')
    .replace(/\[((?:https?):\/\/[^\]\s|]+)\](?!\()/g, '<$1>');

const inlineWikiToMd = (line: string): string =>
  linksToMd(imagesToText(stripColour(line)))
    // {{mono}} → `mono`
    .replace(/\{\{([^}\n]+?)\}\}/g, '`$1`')
    // *bold* → **bold** (word-bounded, so "2 * 3 * 4" is left alone)
    .replace(/(^|[\s(>])\*(\S(?:[^*\n]*?\S)?)\*(?=$|[\s).,:;!?<])/g, '$1**$2**');

// One cell's text: its lines (a cell may span several) joined with <br>, a list line as "• item".
function cellToMd(cell: string): string {
  return cell
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => {
      const m = l.match(/^[*#-]+\s+(.*)$/);
      return m ? `• ${inlineWikiToMd(m[1]!)}` : inlineWikiToMd(l);
    })
    .join('<br>');
}

// A whole table row — possibly several source lines — to one markdown row. Images, colour and links
// are rewritten FIRST, so no `|` inside a cell survives to the split.
function tableRow(text: string, header: boolean): string {
  const sep = header ? '||' : '|';
  const t = linksToMd(imagesToText(stripColour(text))).trim();
  const cells = t
    .slice(sep.length, t.endsWith(sep) ? -sep.length : undefined)
    .split(sep)
    .map(cellToMd);
  return `| ${cells.join(' | ')} |`;
}

// A row is finished when its text ends with the cell separator.
const rowClosed = (text: string): boolean => /\|\s*$/.test(text) && text.trim().length > 1;
// The longest a row may run over several lines before it is closed anyway (never dropped).
const MAX_ROW_LINES = 200;

export function jiraWikiToMarkdown(wiki: string): string {
  const out: string[] = [];
  let fence: string | null = null; // the closing tag while inside {code}/{noformat}
  let quote = false;
  const lines = wiki.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (fence) {
      const end = raw.indexOf(fence);
      if (end >= 0) {
        if (end > 0) out.push(raw.slice(0, end));
        out.push('```');
        fence = null;
      } else {
        out.push(raw);
      }
      continue;
    }
    const code = raw.match(/^\s*\{(code|noformat)(?::([^}]*))?\}(.*)$/);
    if (code) {
      const lang = code[1] === 'code' ? (code[2] ?? '').split('|')[0]!.replace(/^language=/, '').trim() : '';
      out.push('```' + (/^[A-Za-z0-9+#-]{1,20}$/.test(lang) ? lang : ''));
      const tag = `{${code[1]}}`;
      const rest = code[3] ?? '';
      const end = rest.indexOf(tag);
      if (end >= 0) {
        if (end > 0) out.push(rest.slice(0, end));
        out.push('```');
      } else {
        if (rest.trim() !== '') out.push(rest);
        fence = tag;
      }
      continue;
    }
    if (/^\s*\{quote\}\s*$/.test(raw)) {
      quote = !quote;
      continue;
    }
    let line = raw;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*h([1-6])\.\s+(.*)$/))) {
      line = `${'#'.repeat(Number(m[1]))} ${inlineWikiToMd(m[2]!)}`;
    } else if ((m = line.match(/^\s*bq\.\s+(.*)$/))) {
      line = `> ${inlineWikiToMd(m[1]!)}`;
    } else if ((m = line.match(/^\s*([*#-]+)\s+(.*)$/)) && !/^-{4,}$/.test(m[1]!)) {
      const marks = m[1]!;
      const depth = marks.length - 1;
      const bullet = marks.endsWith('#') ? '1.' : '-';
      line = `${'   '.repeat(depth)}${bullet} ${inlineWikiToMd(m[2]!)}`;
    } else if (/^\s*----\s*$/.test(line)) {
      line = '---';
    } else if (/^\s*\|/.test(line)) {
      // A row runs on until it ends with a separator: a Jira cell may span several lines. It stops
      // early at the next row, a blank line or the end, so no text is ever dropped.
      let text = line;
      let taken = 0;
      while (!rowClosed(text) && i + 1 < lines.length && taken < MAX_ROW_LINES) {
        const next = lines[i + 1]!;
        if (next.trim() === '' || /^\s*\|/.test(next)) break;
        text += `\n${next}`;
        i += 1;
        taken += 1;
      }
      if (/^\s*\|\|/.test(text)) {
        const row = tableRow(text, true);
        const n = row.split(' | ').length;
        out.push(quote ? `> ${row}` : row);
        line = `|${' --- |'.repeat(n)}`;
      } else {
        line = tableRow(text, false);
      }
    } else {
      line = inlineWikiToMd(line);
    }
    out.push(quote && line !== '' ? `> ${line}` : quote ? '>' : line);
  }
  if (fence) out.push('```');
  return out.join('\n');
}

// ── MARKDOWN → JIRA WIKI MARKUP (the ticket update, ../ticket-update.ts) ────────────────────────────
//
// The reverse of `jiraWikiToMarkdown` for what Limn shows a ticket's description as: the reader (or
// the agent's draft) writes the description in markdown, and Jira's REST v2 stores wiki markup.
// Covered: headings, bullet and numbered lists (nested by indent), block quotes, rules, fenced code,
// tables, bold, italic, strike, inline code, links and images. Anything else passes through as text,
// which wiki markup shows as typed. Inline code and fences are copied verbatim (no markup inside).

/** Inline markdown → wiki: code spans kept verbatim; bold before italic (placeholders keep them apart). */
function inlineMdToWiki(line: string): string {
  const codes: string[] = [];
  let s = line.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, '!$1!')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '[$1|$2]')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '\u0001$2\u0001')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1_$2_')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '-$1-')
    .replace(/\u0001/g, '*');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `{{${codes[Number(i)] ?? ''}}}`);
}

const MD_TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function mdTableCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => inlineMdToWiki(c.trim()));
}

export function markdownToJiraWiki(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  // The open list levels: each one's indent and kind, outermost first.
  const levels: Array<{ indent: number; kind: '*' | '#' }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const fence = /^\s*```\s*([A-Za-z0-9+#-]{0,20})\s*$/.exec(raw);
    if (fence) {
      levels.length = 0;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j]!)) body.push(lines[j++]!);
      const lang = fence[1] ?? '';
      out.push(lang !== '' ? `{code:${lang}}` : '{noformat}', ...body, lang !== '' ? '{code}' : '{noformat}');
      i = j;
      continue;
    }
    // A table: a header row followed by its separator row.
    if (/^\s*\|/.test(raw) && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1]!)) {
      levels.length = 0;
      out.push(`|| ${mdTableCells(raw).join(' || ')} ||`);
      i += 1;
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1]!)) {
        i += 1;
        out.push(`| ${mdTableCells(lines[i]!).join(' | ')} |`);
      }
      continue;
    }
    const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(raw);
    if (item && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      const indent = item[1]!.replace(/\t/g, '    ').length;
      const kind = /^\d/.test(item[2]!) ? '#' : '*';
      while (levels.length > 0 && levels[levels.length - 1]!.indent > indent) levels.pop();
      const top = levels[levels.length - 1];
      if (top == null || top.indent < indent) levels.push({ indent, kind });
      else top.kind = kind;
      out.push(`${levels.map((l) => l.kind).join('')} ${inlineMdToWiki(item[3]!)}`);
      continue;
    }
    if (raw.trim() === '' || !/^\s/.test(raw)) levels.length = 0;
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) out.push(`h${m[1]!.length}. ${inlineMdToWiki(m[2]!)}`);
    else if ((m = raw.match(/^\s{0,3}>\s?(.*)$/))) out.push(m[1]!.trim() === '' ? '' : `bq. ${inlineMdToWiki(m[1]!)}`);
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) out.push('----');
    else out.push(inlineMdToWiki(raw));
  }
  return out.join('\n');
}

// ── THE AC SECTION INSIDE A RAW WIKI DESCRIPTION (a criteria-only ticket update) ──────────────────────
//
// Limn's stored description is LOSSY markdown (`jiraWikiToMarkdown` drops colours, panels and images),
// so a criteria-only update never rebuilds the description from it: it replaces ONLY the criteria block
// of the LIVE wiki text and keeps every other byte. The section rule mirrors shared `findAcSection`:
// an `hN.` heading (ends at the next heading of the same or a higher level) or a bold label line
// (`*Acceptance Criteria:*`, ends at the next heading or bold label); exact names win over loose ones;
// `{code}` / `{noformat}` blocks are skipped. No section ⇒ appended under `h2. <heading>`.
const WIKI_HEADING_RE = /^\s*h([1-6])\.\s+(.*?)\s*$/;
const WIKI_LABEL_RE = /^\s*\*([^*\n]+?)\*\s*:?\s*$/;
const WIKI_BLOCK_RE = /^\s*\{(code|noformat)(?::[^}]*)?\}/;

function wikiBlockLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    if (open == null) {
      const m = WIKI_BLOCK_RE.exec(line);
      // A one-line block (`{code}x{code}`) opens and closes on the same line.
      if (m && !new RegExp(`\\{${m[1]}\\}\\s*$`).test(line.slice(m[0].length))) open = m[1]!;
      out.push(m != null);
    } else {
      out.push(true);
      if (new RegExp(`\\{${open}\\}`).test(line)) open = null;
    }
  }
  return out;
}

/** The criteria block of a wiki description: [start, end) lines, `start` the heading / label line. */
export function findWikiAcSection(wiki: string): { heading: string; start: number; end: number } | null {
  const lines = wiki.replace(/\r\n?/g, '\n').split('\n');
  const blocks = wikiBlockLines(lines);
  const found: Array<{ heading: string; start: number; end: number; tier: 0 | 1 }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (blocks[i]) continue;
    const h = WIKI_HEADING_RE.exec(lines[i]!);
    const b = h == null ? WIKI_LABEL_RE.exec(lines[i]!) : null;
    if (h == null && b == null) continue;
    const text = (h != null ? h[2]! : b![1]!).replace(/[*_{}]/g, '').replace(/:\s*$/, '').trim();
    const tier = acSectionNameTier(text);
    if (tier == null) continue;
    const level = h != null ? Number(h[1]) : null;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (blocks[j]) continue;
      const n = WIKI_HEADING_RE.exec(lines[j]!);
      if ((n != null && (level == null || Number(n[1]) <= level)) || (level == null && WIKI_LABEL_RE.test(lines[j]!))) {
        end = j;
        break;
      }
    }
    found.push({ heading: text, start: i, end, tier });
    if (tier === 0) break;
  }
  const pick = found.find((f) => f.tier === 0) ?? found[0];
  return pick == null ? null : { heading: pick.heading, start: pick.start, end: pick.end };
}

/** Replace ONLY the criteria block of a raw wiki description with `criteriaWiki` (every other byte kept). */
export function spliceWikiAcSection(wiki: string, criteriaWiki: string, heading: string | null): string {
  const text = wiki.replace(/\r\n?/g, '\n');
  const body = criteriaWiki.replace(/\r\n?/g, '\n').trim();
  const s = findWikiAcSection(text);
  const lines = text.split('\n');
  if (s != null) {
    const before = lines.slice(0, s.start + 1);
    const after = lines.slice(s.end);
    // A blank line before the next section only when the original had one there.
    const gap = after.length > 0 && (lines[s.end - 1] ?? '').trim() === '' ? [''] : [];
    return [...before, body, ...gap, ...after].join('\n');
  }
  const head = `h2. ${(heading ?? '').trim() || 'Acceptance criteria'}`;
  const base = text.replace(/\s+$/, '');
  return base === '' ? `${head}\n${body}` : `${base}\n\n${head}\n${body}`;
}

// ── UNTRUSTED DRAFT TEXT → WIKI (the plan's draft ticket update) ────────────────────────────────────
//
// `markdownToJiraWiki` passes Jira wiki markup through as typed, so a draft the planning agent wrote
// (it reads untrusted ticket, repository and PR text) could carry a live user mention (`[~accountid:…]`,
// `[~name]`, which notifies on save) or a macro (`{html}`, `{panel}`, `{color}`, `{include}`). The draft
// path ESCAPES each one the stored ticket text does not already hold (a backslash: wiki shows it as
// typed), so a round trip of the reader's own ticket stays lossless. The reader still sees and edits it.
const WIKI_RISKY_RE = /\[~[^\]\n]{1,200}\]|\{(?:html|panel|color|include|iframe)(?::[^}\n]{0,200})?\}/gi;

/** Escape the wiki mentions and macros `draft` has that `original` does not. `changed` = something was escaped. */
export function neutraliseNewWikiMarkup(draft: string, original: string): { text: string; changed: boolean } {
  const known = new Set((original.match(WIKI_RISKY_RE) ?? []).map((m) => m.toLowerCase()));
  let changed = false;
  const text = draft.replace(WIKI_RISKY_RE, (m) => {
    if (known.has(m.toLowerCase())) return m;
    changed = true;
    return `\\${m}`;
  });
  return { text, changed };
}

/**
 * Markdown → ONE line of plain text, for a single-line Jira text field (`…:textfield`): list markers,
 * headings, quotes, emphasis, inline code and link syntax dropped (a link keeps its text), every run
 * of whitespace collapsed to one space. The caller enforces the field's 255-character limit.
 */
export function plainOneLine(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*(?:`{3,}|~{3,}).*$/, '')
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .replace(/\s*\|\s*/g, ' | '),
    )
    .join(' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The most a single-line Jira text field holds. */
export const JIRA_TEXTFIELD_MAX = 255;

/**
 * How Limn may write a field, from its editmeta `schema` (REST v2): a multi-line text field — the
 * `…:textarea` custom type, or a system string field with no custom type — takes WIKI markup (v2 takes
 * wiki strings for rich-text fields on Cloud and Server alike, so Limn never writes ADF); a one-line
 * `…:textfield` takes PLAIN text; anything else (a select, a checklist app's type) is null: refused.
 */
export function criteriaFieldFormat(schema: unknown): 'wiki' | 'plain' | null {
  if (typeof schema !== 'object' || schema == null) return null;
  const s = schema as { type?: unknown; custom?: unknown };
  if (s.type !== 'string') return null;
  if (s.custom == null) return 'wiki';
  if (typeof s.custom !== 'string') return null;
  if (s.custom.endsWith(':textarea')) return 'wiki';
  if (s.custom.endsWith(':textfield')) return 'plain';
  return null;
}
