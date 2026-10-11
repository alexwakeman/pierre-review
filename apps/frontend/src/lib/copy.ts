import {
  STORY_ISSUE_BY_ID,
  sprintBullets,
  sprintCurrentAssessmentBodyOf,
  type SprintBullet,
  type SprintChecks,
  type SprintTicketRow,
} from '@pierre-review/shared';
import { writeClipboard } from '../components/CopyButton.js';

// COPY AND PASTE FOR GENERATED TEXT — the ONE place (Reports → This sprint).
//
// Everything the This sprint tab generates (one issue's bullet, the proposed update, "Copy all" for a
// ticket) is copied through here, so a block pastes the same way wherever it came from.
//
//   • text/plain carries CLEAN MARKDOWN: a "## KEY — Title" header, `-` bullets, file paths in
//     backticks. It pastes as-is into a Jira / Linear / GitHub editor, a Slack message or a prompt.
//   • text/html carries the same content as minimal HTML (headings, lists, bold, code, links), so a
//     rich editor (Confluence, Google Docs, Slack's composer) keeps the structure rather than showing
//     the asterisks. Every character of the source is ESCAPED first — a ticket title is third-party
//     text, and `<script>` in one must paste as the seven characters, never as markup.
//   • No ClipboardItem (Firefox before 127, a non-secure context), or the rich write refused → the
//     markdown goes through `writeClipboard` (components/CopyButton.tsx), which has its own legacy
//     fallback. A copy never fails silently for want of HTML.
//
// The composers are PURE (test/copy.test.ts pins their shapes); only `copyRich` touches a browser API.

/** A block of copyable text with an optional heading (one section of a ticket). */
export interface CopyBlock {
  heading?: string;
  markdown: string;
}

/** "## KEY — Title" — the header every whole-ticket copy starts with. */
export function ticketHeader(key: string, title: string): string {
  const t = oneLine(title);
  return t === '' ? `## ${key}` : `## ${key} — ${t}`;
}

/** One issue's bullet as one Markdown line: "**Spec gaps**: No error copy for an expired link (`path` in `repo`)". */
export function sprintBulletMarkdown(b: SprintBullet): string {
  const ref = b.ref != null ? ` (\`${b.ref.path}\` in \`${b.ref.repo}\`)` : '';
  return `**${STORY_ISSUE_BY_ID[b.id].label}**: ${oneLine(b.text)}${ref}`;
}

/** Everything for a ticket: header, link, the CURRENT assessment's summary (when there is one) and one bullet
 *  per issue — the same bullets the card shows (`sprintBullets`, the workspace's checks applied). */
export function ticketCopyAllMarkdown(t: SprintTicketRow, checks: SprintChecks): string {
  const parts = [ticketHeader(t.key, t.title)];
  if (t.url != null && /^https?:\/\//i.test(t.url)) parts.push(t.url);
  const body = sprintCurrentAssessmentBodyOf(t);
  if (body != null && body.summary.trim() !== '') parts.push(oneLine(body.summary));
  const bullets = sprintBullets(t, checks);
  if (bullets.length > 0) parts.push(bullets.map((b) => `- ${sprintBulletMarkdown(b)}`).join('\n'));
  return parts.join('\n\n');
}

/** Joins blocks under their headings ("### heading"), skipping empty ones. */
export function blocksMarkdown(blocks: readonly CopyBlock[]): string {
  return blocks
    .filter((b) => b.markdown.trim() !== '')
    .map((b) => (b.heading != null ? `### ${oneLine(b.heading)}\n\n${b.markdown}` : b.markdown))
    .join('\n\n');
}

function oneLine(s: string): string {
  return s.replace(/\s*\r?\n\s*/g, ' ').trim();
}

// ── Markdown → clipboard HTML ────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline Markdown → HTML: `code`, **bold**, *italic*, [text](https URL). Escapes first. */
function inlineHtml(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part)
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => `<a href="${url}">${label}</a>`)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
    })
    .join('');
}

type ListKind = 'ul' | 'ol';

/** Minimal Markdown → HTML for the text/html half of a copy: headings, (nested) bullet and numbered
 *  lists, paragraphs, fenced code, bold / italic / code / links. Everything else is escaped text. Pure. */
export function markdownToClipboardHtml(md: string): string {
  const out: string[] = [];
  const stack: Array<{ kind: ListKind; indent: number }> = [];
  let para: string[] = [];
  let fence: string[] | null = null;

  const flushPara = (): void => {
    if (para.length > 0) out.push(`<p>${para.map(inlineHtml).join('<br>')}</p>`);
    para = [];
  };
  const closeListsTo = (depth: number): void => {
    while (stack.length > depth) {
      const top = stack.pop()!;
      out.push(`</li></${top.kind}>`);
    }
  };

  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    if (fence != null) {
      if (/^\s*```/.test(raw)) {
        out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else {
        fence.push(raw);
      }
      continue;
    }
    if (/^\s*```/.test(raw)) {
      flushPara();
      closeListsTo(0);
      fence = [];
      continue;
    }
    if (raw.trim() === '') {
      flushPara();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      flushPara();
      closeListsTo(0);
      const level = heading[1]!.length;
      out.push(`<h${level}>${inlineHtml(heading[2]!.trim())}</h${level}>`);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (item) {
      flushPara();
      const indent = item[1]!.replace(/\t/g, '    ').length;
      const kind: ListKind = /\d/.test(item[2]!) ? 'ol' : 'ul';
      // Close deeper lists than this item's indent.
      while (stack.length > 0 && stack[stack.length - 1]!.indent > indent) closeListsTo(stack.length - 1);
      const top = stack[stack.length - 1];
      if (top == null || indent > top.indent) {
        stack.push({ kind, indent });
        out.push(`<${kind}><li>`);
      } else if (top.kind !== kind) {
        closeListsTo(stack.length - 1);
        stack.push({ kind, indent });
        out.push(`<${kind}><li>`);
      } else {
        out.push('</li><li>');
      }
      out.push(inlineHtml(item[3]!.trim()));
      continue;
    }
    if (stack.length > 0) {
      // A continuation line inside a list item.
      out.push(`<br>${inlineHtml(raw.trim())}`);
      continue;
    }
    para.push(raw.trim());
  }
  if (fence != null) out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
  flushPara();
  closeListsTo(0);
  return out.join('');
}

/**
 * Copy Markdown to the clipboard as BOTH text/plain (the Markdown) and text/html (rendered), so it
 * pastes well into a rich editor and a plain one. Falls back to plain text when ClipboardItem or
 * `clipboard.write` is missing or refuses. Resolves true when something was copied.
 */
export async function copyRich(markdown: string): Promise<boolean> {
  if (markdown.trim() === '') return false;
  try {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (typeof ClipboardItem !== 'undefined' && clip != null && typeof clip.write === 'function') {
      const html = markdownToClipboardHtml(markdown);
      await clip.write([
        new ClipboardItem({
          'text/plain': new Blob([markdown], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return true;
    }
  } catch {
    // Refused (permissions, an unsupported type) — fall through to plain text.
  }
  return writeClipboard(markdown);
}
