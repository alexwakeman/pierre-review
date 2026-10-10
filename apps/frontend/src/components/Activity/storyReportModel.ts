import {
  reportingWindowShortTitle,
  STORY_ISSUE_BY_ID,
  type StoryReportPoint,
  type ReportingWindowInfo,
  type StoryReportBody,
  type StoryReportCandidate,
  type StoryReportPopulation,
  type StoryReportRange,
  type StoryReportRecord,
  type StoryReportWindowChoice,
} from '@pierre-review/shared';
import { safeExternalUrl } from '../../lib/ui.js';
import { formatWorkingTime } from './storiesModel.js';

// Reports → Stories → the story report: the pure folds behind the card. No renderer, no fetch —
// test/storyReportModel.test.ts.
//
// ⚠ A TICKET KEY IS A LINK ONLY WHEN IT IS A PICKED CANDIDATE. The model's text may name any ticket
// it read about (a dependency, a parent epic); only the picks carry a URL we vouch for, and every URL
// goes through `safeExternalUrl`.
// ⚠ THE FIGURES ARE CODE'S, THE TEXT IS THE MODEL'S. `storyReportFigures` reads the stored
// `population` only; nothing here derives a number from the model's prose.

// ── Window ────────────────────────────────────────────────────────────────────────────────────

/** The picker / heading name of a window choice: "This sprint" / "Last 14 days" / "Last 60 days". */
export function storyReportWindowLabel(
  choice: StoryReportWindowChoice,
  reporting: Pick<ReportingWindowInfo, 'mode' | 'days'> | null | undefined,
): string {
  if (choice === 'reporting') return reporting != null ? reportingWindowShortTitle(reporting) : 'Reporting window';
  return `Last ${choice} days`;
}

const DAY_FMT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

/** "1 Aug – 9 Oct": the span, last day inclusive (`to` is exclusive). */
export function storyReportRangeDates(range: Pick<StoryReportRange, 'from' | 'to'>): string {
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return '';
  const lastMs = Math.max(from.getTime(), to.getTime() - 1);
  const a = from.toLocaleDateString('en-GB', DAY_FMT);
  const b = new Date(lastMs).toLocaleDateString('en-GB', DAY_FMT);
  return a === b ? a : `${a} – ${b}`;
}

/** "9 Oct" — a run's date. */
export function storyReportDate(iso: string | null | undefined): string {
  if (iso == null) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', DAY_FMT);
}

// ── Ticket keys ───────────────────────────────────────────────────────────────────────────────

export type CandidateIndex = ReadonlyMap<string, StoryReportCandidate>;

export function indexCandidates(picked: readonly StoryReportCandidate[]): Map<string, StoryReportCandidate> {
  return new Map(picked.map((c) => [c.key, c]));
}

/** The safe browse URL of a candidate key, or null (unknown key, or no safe URL). */
export function ticketHref(key: string, index: CandidateIndex): string | null {
  return safeExternalUrl(index.get(key)?.url ?? null) ?? null;
}

export type TextSegment = { kind: 'text'; text: string } | { kind: 'ticket'; key: string; href: string | null };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split text into plain runs and ticket keys. ONLY candidate keys are matched, and only as a whole
 * token: `BMD-12` does not match inside `BMD-123` or `XBMD-12`, nor at the head of `BMD-12-fix`.
 */
export function linkifyTicketKeys(text: string, index: CandidateIndex): TextSegment[] {
  if (text === '') return [];
  const keys = [...index.keys()].filter((k) => k !== '').sort((a, b) => b.length - a.length);
  if (keys.length === 0) return [{ kind: 'text', text }];
  const re = new RegExp(
    `(?<![A-Za-z0-9_/#.-])(?:${keys.map(escapeRe).join('|')})(?![A-Za-z0-9_]|[-/#.][A-Za-z0-9])`,
    'g',
  );
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    out.push({ kind: 'ticket', key: m[0], href: ticketHref(m[0], index) });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

// ── Figures (code) ────────────────────────────────────────────────────────────────────────────

export interface StoryReportFigure {
  key: string;
  label: string;
  value: string;
}

function ofN(n: number, total: number): string {
  return total > 0 ? `${n} of ${total}` : String(n);
}

/** The figures row: whole-window counts from the stored population. */
export function storyReportFigures(p: StoryReportPopulation): StoryReportFigure[] {
  const out: StoryReportFigure[] = [
    { key: 'stories', label: 'Stories', value: String(p.storiesInWindow) },
    { key: 'criteria', label: 'With written criteria', value: ofN(p.withWrittenCriteria, p.storiesInWindow) },
    { key: 'checked', label: 'Checked by a ticket review', value: ofN(p.checkedByTicketReview, p.storiesInWindow) },
  ];
  if (p.checkedByTicketReview > 0) {
    out.push(
      { key: 'met', label: 'Fully met', value: ofN(p.checkedAndFullyMet, p.checkedByTicketReview) },
      { key: 'gaps', label: 'With gaps', value: ofN(p.checkedWithGaps, p.checkedByTicketReview) },
    );
  }
  out.push({
    key: 'median',
    label: 'Median working time',
    value: p.medianWorkingHours == null ? 'not measured' : formatWorkingTime(p.medianWorkingHours, p.workingDayHours),
  });
  // The four story issues, counted by code over the whole window (absent on reports written before
  // them; an issue nothing could be told about is left out, never "0 of 0").
  // Over the stories Claude has read in their current form (`of`), never mixed with no-criteria stories.
  for (const r of p.issueRates ?? []) {
    if (r.of > 0) out.push({ key: `issue:${r.id}`, label: STORY_ISSUE_BY_ID[r.id].label, value: `${r.stories} of ${r.of} read` });
  }
  return out;
}

/** The story issue a point is about, as its label; null when the point names none (or an old row). */
export function pointIssueLabel(p: Pick<StoryReportPoint, 'issue'>): string | null {
  return p.issue != null && STORY_ISSUE_BY_ID[p.issue] != null ? STORY_ISSUE_BY_ID[p.issue].label : null;
}

// ── Sections ──────────────────────────────────────────────────────────────────────────────────

export type StoryReportSectionKey = 'doingWell' | 'fallingShort' | 'spotlights' | 'themes' | 'actions';

export const STORY_REPORT_SECTION_TITLE: Record<StoryReportSectionKey, string> = {
  doingWell: 'What we do well',
  fallingShort: 'Where stories fall short',
  spotlights: 'Spotlights',
  themes: 'Emerging themes',
  actions: 'Next sprint actions',
};

const SECTION_ORDER: readonly StoryReportSectionKey[] = ['doingWell', 'fallingShort', 'spotlights', 'themes', 'actions'];

/** The sections that have something in them, in reading order. An empty one is not a heading. */
export function storyReportSections(body: StoryReportBody): StoryReportSectionKey[] {
  return SECTION_ORDER.filter((k) => body[k].length > 0);
}

// ── Markdown export ───────────────────────────────────────────────────────────────────────────

// ⚠ MODEL TEXT IS ESCAPED; ONLY THE CODE'S LINKS ARE MARKDOWN. A pasted document renders whatever
// markdown the model wrote — a detail starting "# " becomes a heading, `[x](url)` a link nobody
// vetted, a bare https:// an autolink. So every model run is backslash-escaped, and the only live
// markup is what this file writes: the structure and `[KEY](safeUrl)` on picked candidates.

/** Backslash-escape inline markdown in a run of model text (and break GFM autolinks). */
function escapeInline(s: string): string {
  return s
    .replace(/[\\`*_[\]<>|~!]/g, '\\$&')
    .replace(/:\/\//g, '\\://')
    .replace(/\b(www)\./gi, '$1\\.');
}

/** Escape a block marker a line could start with: `#`, `>`, `-`/`+`/`*` + space, `1.`/`1)` + space. */
function escapeLeading(s: string): string {
  return s.replace(/^(\s*)(#|>|[-+=](?=\s|$)|\d+(?=[.)](?:\s|$)))/, (_m, sp: string, mk: string) =>
    /^\d/.test(mk) ? `${sp}${mk}\\` : `${sp}\\${mk}`,
  );
}

/** Escape model text that is not linkified (titles, themes, actions, the headline). */
function escapeModelText(s: string): string {
  return escapeLeading(escapeInline(s));
}

/** A code-vouched URL made safe inside `(…)`. */
function linkTarget(href: string): string {
  return href.replace(/[()\s]/g, (c) => encodeURIComponent(c));
}

/** Text with candidate keys as markdown links (other keys stay plain); every model run escaped. */
export function markdownWithLinks(text: string, index: CandidateIndex): string {
  const out = linkifyTicketKeys(text, index)
    .map((s) =>
      s.kind === 'text'
        ? escapeInline(s.text)
        : s.href != null
          ? `[${escapeInline(s.key)}](${linkTarget(s.href)})`
          : escapeInline(s.key),
    )
    .join('');
  return escapeLeading(out);
}

function ticketList(keys: readonly string[], index: CandidateIndex): string {
  return keys.map((k) => markdownWithLinks(k, index)).join(', ');
}

/** One line, so a paragraph of model text cannot break the markdown structure around it. */
function oneLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, ' ').trim();
}

/**
 * The report as a clean markdown document for a manager to paste: headline, window, summary, the
 * code's figures (labelled as such), then the sections. "Left out" is a working note and stays on
 * screen only.
 */
export function storyReportMarkdown(record: StoryReportRecord): string {
  const body = record.report;
  if (body == null) return '';
  const index = indexCandidates(record.picked);
  const md = (s: string): string => markdownWithLinks(oneLine(s), index);
  const lines: string[] = [];
  lines.push(`# ${escapeModelText(oneLine(body.headline))}`, '');
  const label = storyReportWindowLabel(record.window, record.range.reporting);
  const dates = storyReportRangeDates(record.range);
  lines.push(`${label}${dates !== '' ? ` (${dates})` : ''}`, '');
  lines.push(md(body.summary), '');

  lines.push('## Figures', '');
  for (const f of storyReportFigures(record.population)) lines.push(`- ${f.label}: ${f.value}`);
  lines.push(
    '',
    `_Figures are counted over every story in the window. The text was written by Claude from ${record.picked.length} picked stories._`,
    '',
  );

  for (const key of storyReportSections(body)) {
    lines.push(`## ${STORY_REPORT_SECTION_TITLE[key]}`, '');
    if (key === 'doingWell' || key === 'fallingShort') {
      for (const p of body[key]) {
        const issue = pointIssueLabel(p);
        lines.push(
          `### ${escapeModelText(oneLine(p.title))}${issue != null ? ` · ${issue}` : ''}`,
          '',
          md(p.detail),
          '',
          `Tickets: ${ticketList(p.tickets, index)}`,
          '',
        );
      }
    } else if (key === 'spotlights') {
      for (const s of body.spotlights) {
        const tone = s.tone === 'positive' ? 'Good example' : 'Weak example';
        lines.push(`- **${ticketList([s.ticket], index)}** (${tone}): ${md(s.headline).replace(/[.!?:]+$/, '')}. ${md(s.detail)}`);
      }
      lines.push('');
    } else if (key === 'themes') {
      for (const t of body.themes) {
        const tickets = t.tickets.length > 0 ? ` (${ticketList(t.tickets, index)})` : '';
        lines.push(`- **${escapeModelText(oneLine(t.theme))}**: ${md(t.detail)}${tickets}`);
      }
      lines.push('');
    } else {
      body.actions.forEach((a, i) => {
        const tickets = a.tickets.length > 0 ? ` (${ticketList(a.tickets, index)})` : '';
        lines.push(`${i + 1}. **${escapeModelText(oneLine(a.action))}**: ${md(a.why)}${tickets}`);
      });
      lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
