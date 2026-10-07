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
