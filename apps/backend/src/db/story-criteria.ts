import type { StoryCriteriaSource } from '@pierre-review/shared';

// HOW MANY ACCEPTANCE CRITERIA A STORY HAS — pure, deterministic, unit-tested (story-criteria.test.ts).
// Reports → Stories plots it against size (db/stories.ts). The count's SOURCE is always labelled on
// the wire, because the three sources are not the same measurement:
//
//   1. 'review'               the latest succeeded ticket review's `criteria.length` (db/stories.ts
//                             decides this one; it is not text-derived and lives there).
//   2. 'acceptance_criteria'  the tracker's criteria field (`tracker_tickets.acceptance_criteria`;
//                             for GitHub Issues / Linear tracker/ac.ts already lifted sub-issues, a
//                             task list or an "Acceptance criteria" section into it).
//   3. 'description_heading'  bullets under an "Acceptance criteria" heading in the DESCRIPTION
//                             (the Jira habit of writing them into the body).
//   4. 'none'                 nothing to count → `count: null`, never 0.
//
// THE COUNTING RULE (one function, both text sources):
//   • Jira `{color…}` markup is stripped first; blank lines and heading / label lines are skipped.
//   • When the text has BULLETS (`-`, `*`, `+`, `•`, `1.`, `1)`, a task box, Jira `*`/`#` runs), the
//     count is the bullets at the SHALLOWEST depth present — a sub-bullet is detail of its parent,
//     not a criterion of its own.
//   • Otherwise every remaining line is one criterion, EXCEPT that a line starting "When / Then /
//     And / But" continues the scenario above it (Given-When-Then is one criterion, not four).
// ⚠ A Jira line starting `# ` is a numbered-list item, a Markdown one is a heading — the provider
// decides, so this takes it.

const COLOR_RE = /\{color[^}]*\}/g;
const JIRA_HEADING_RE = /^h[1-6]\.\s/i;
const MD_HEADING_RE = /^#{1,6}\s/;
const AC_PHRASE_RE = /acceptance\s+criteria/i;
// "Acceptance criteria", "**Acceptance criteria:**", "*AC*:" — a line that only labels what follows.
const LABEL_ONLY_RE = /^(?:\*\*|__|\*|_)?\s*(?:acceptance\s+criteria|a\/?cs?)\s*:?\s*(?:\*\*|__|\*|_)?\s*:?$/i;
// A line that is ONLY emphasised text (optionally with a colon) — reads as a sub-heading.
const BOLD_LINE_RE = /^(?:\*\*[^*]+\*\*|\*[^*\s][^*]*\*|__[^_]+__)\s*:?$/;
// A colon label that names ANOTHER section, so it still ends the criteria even with a list under it.
const OTHER_SECTION_RE =
  /^(?:notes?|references?|links?|resources|out of scope|not in scope|dependencies|assumptions|risks?|questions?|context|background|designs?|technical notes?|tech notes?|definition of done|dod)\b/i;
const CONTINUATION_RE = /^(?:when|then|and|but)\b/i;

interface Bullet {
  depth: number;
}

function bulletOf(raw: string, jira: boolean): Bullet | null {
  const indent = (/^\s*/.exec(raw)?.[0] ?? '').replace(/\t/g, '    ').length;
  const line = raw.trim();
  if (jira) {
    const run = /^([*#]+)\s+\S/.exec(line);
    if (run) return { depth: indent * 10 + run[1]!.length };
  } else if (/^\*\s+\S/.test(line)) {
    return { depth: indent * 10 + 1 };
  }
  if (/^(?:[-+•]|\d+[.)])\s+\S/.test(line)) return { depth: indent * 10 + 1 };
  return null;
}

function isHeading(line: string, jira: boolean): boolean {
  return jira ? JIRA_HEADING_RE.test(line) : MD_HEADING_RE.test(line);
}

// The marker a criterion's text is written without: a bullet (or Jira `*`/`#` run, or a number),
// then an optional task box.
const MARKER_RE = /^\s*(?:[*#]+|[-+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;

function keptLines(text: string | null | undefined, jira: boolean): string[] {
  return (text ?? '')
    .replace(COLOR_RE, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .filter((l) => {
      const t = l.trim();
      return !isHeading(t, jira) && !LABEL_ONLY_RE.test(t) && !/^(`{3,}|~{3,}|\{(?:code|noformat)[^}]*\})/.test(t);
    });
}

/**
 * The criteria in one block of text, by the rule in the header — ONE string per criterion, in order.
 * A top-depth bullet starts a criterion (its marker stripped); a deeper bullet or a plain line after
 * it is folded into it. Without bullets, every line starts one except a When / Then / And / But line,
 * which is folded into the one above. Text before the first criterion (a preamble above the bullets)
 * is not a criterion and is dropped. `[]` when there is nothing to count.
 *
 * ⚠ `countCriteriaLines(t, o) === extractCriteria(t, o).length` ALWAYS — the count is defined as
 * this list's length, so the number on Reports → Stories and the criteria Story health labels can
 * never disagree.
 */
export function extractCriteria(text: string | null | undefined, opts: { jira: boolean }): string[] {
  const kept = keptLines(text, opts.jira);
  const bullets = kept.map((l) => bulletOf(l, opts.jira));
  const depths = bullets.filter((b): b is Bullet => b != null).map((b) => b.depth);
  const out: string[] = [];
  const fold = (line: string): void => {
    if (out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${line}`.trim();
  };
  if (depths.length > 0) {
    const top = Math.min(...depths);
    kept.forEach((l, i) => {
      const b = bullets[i];
      const body = b != null ? l.replace(MARKER_RE, '').trim() : l.trim();
      if (b != null && b.depth === top) out.push(body);
      else fold(body);
    });
    return out;
  }
  for (const l of kept) {
    const t = l.trim();
    if (out.length === 0 || !CONTINUATION_RE.test(t)) out.push(t);
    else fold(t);
  }
  return out;
}

/** Criteria in one block of text by the rule in the header; 0 when there is nothing to count. */
export function countCriteriaLines(text: string | null | undefined, opts: { jira: boolean }): number {
  return extractCriteria(text, opts).length;
}

/** The section of a DESCRIPTION under an "Acceptance criteria" heading (or label line), up to the
 *  next heading; null when there is no such heading. */
export function acceptanceSectionOf(description: string | null | undefined, opts: { jira: boolean }): string | null {
  const lines = (description ?? '').replace(COLOR_RE, '').split(/\r?\n/);
  const isSectionHead = (t: string): boolean =>
    isHeading(t, opts.jira) ||
    BOLD_LINE_RE.test(t) ||
    (/:$/.test(t) && t.length <= 60 && bulletOf(t, opts.jira) == null) ||
    // A bare "References" / "Notes" line with no colon still starts another section.
    (OTHER_SECTION_RE.test(t) && /^[\p{L} ]{1,40}$/u.test(t));
  const start = lines.findIndex((l) => {
    const t = l.trim();
    if (!AC_PHRASE_RE.test(t)) return false;
    return isHeading(t, opts.jira) || LABEL_ONLY_RE.test(t) || BOLD_LINE_RE.test(t);
  });
  if (start < 0) return null;
  // A plain "For option 1:" line followed by a list is a SUB-LABEL inside the section, not the next
  // section: it is carried onto each of its own list items ("For option 1: …"), so two options'
  // criteria stay told apart. Treating it as a section end read BMD-1042's six criteria as none.
  const nextBullet = (from: number): Bullet | null => {
    for (let j = from; j < lines.length; j += 1) {
      if (lines[j]!.trim() !== '') return bulletOf(lines[j]!, opts.jira);
    }
    return null;
  };
  const out: string[] = [];
  let label: { text: string; depth: number } | null = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const t = lines[i]!.trim();
    if (t !== '' && isSectionHead(t)) {
      const first = /:$/.test(t) && !isHeading(t, opts.jira) && !BOLD_LINE_RE.test(t) && !OTHER_SECTION_RE.test(t)
        ? nextBullet(i + 1)
        : null;
      if (first == null) break;
      label = { text: t.replace(/:$/, '').trim(), depth: first.depth };
      continue;
    }
    const b = label != null && t !== '' ? bulletOf(lines[i]!, opts.jira) : null;
    if (label != null && b != null && b.depth === label.depth) {
      const marker = MARKER_RE.exec(lines[i]!)?.[0] ?? '';
      out.push(`${marker}${label.text}: ${lines[i]!.slice(marker.length).trim()}`);
    } else {
      out.push(lines[i]!);
    }
  }
  return out.join('\n');
}

/** The text-derived criteria count of a stored ticket: its criteria field, else bullets under an
 *  "Acceptance criteria" heading in its description, else none. (The review's count, when there is a
 *  review, is decided by the caller and wins over both.) */
export function textCriteriaCount(
  ticket: { acceptanceCriteria: string | null | undefined; description: string | null | undefined },
  provider: string,
): { count: number | null; source: StoryCriteriaSource } {
  const jira = provider === 'jira';
  const fromField = countCriteriaLines(ticket.acceptanceCriteria, { jira });
  if (fromField > 0) return { count: fromField, source: 'acceptance_criteria' };
  const section = acceptanceSectionOf(ticket.description, { jira });
  const fromSection = section == null ? 0 : countCriteriaLines(section, { jira });
  if (fromSection > 0) return { count: fromSection, source: 'description_heading' };
  return { count: null, source: 'none' };
}
