// THE LAYOUT OF A TICKET (pure; docs/TRACKERS.md § The ticket update). The plan's draft ticket update
// must keep the ticket's own layout: the same headings in the same order, the same list style, GIVEN /
// WHEN / THEN when the ticket uses it. ONE fold for the three places that ask:
//   - the planning agent is told the layout (sandbox/workspace/seed.ts `ticketMarkdown`);
//   - the host checks the draft at plan time (coding/story-build/plan-verify.ts → `layoutProblems`);
//   - the plan panel checks the reader's edit live (components/StoryBuild/TicketUpdatePanel.tsx).
// The check NEVER rejects anything: the reader decides. Every text here is markdown, as Limn stores it.
//
// The AC section rule (`findAcSection`) is the WRITE side: where an update puts criteria that live in
// the description. It knows the same bold label lines as the READ side (tracker/ac.ts `headingSection`,
// `AC_LABEL_RE`) and a few more names ("AC", "Criteria", "Definition of Done" — the last two only when
// no exact "Acceptance criteria" / "AC" section exists). The read side stays as it is: broadening it
// would move stored criteria.

/** Where a ticket keeps its acceptance criteria (what the update writes). */
export type TicketAcLocation =
  | { kind: 'field'; fieldId: string; fieldName: string | null }
  | { kind: 'description'; heading: string | null }
  | { kind: 'none' };

export type TicketListStyle = 'numbered' | 'bulleted' | 'checklist' | 'gherkin' | 'table' | 'paragraphs' | 'mixed' | 'empty';

/** The layout facts of one ticket text. */
export interface TicketLayout {
  /** ATX heading texts in order, trimmed, case kept. */
  headings: string[];
  /** The dominant list style of the text. */
  listStyle: TicketListStyle;
  /** GIVEN / WHEN / THEN lines. */
  gherkin: boolean;
  /** List items (or table rows, or gherkin scenarios) counted. */
  itemCount: number;
}

export const emptyTicketLayout = (): TicketLayout => ({ headings: [], listStyle: 'empty', gherkin: false, itemCount: 0 });

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const CHECK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s/;
const NUMBERED_RE = /^\s*\d+[.)]\s+\S/;
const BULLET_RE = /^\s*[-*+]\s+\S/;
const TABLE_RE = /^\s*\|/;
const TABLE_RULE_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const GHERKIN_RE = /^\s*(?:[-*+]|\d+[.)])?\s*\**(given|when|then|and)\b/i;
const GIVEN_RE = /^\s*(?:[-*+]|\d+[.)])?\s*\**given\b/i;

/** Which lines are inside a fenced code block (the fence lines included). */
function fencedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (open == null) {
      if (m) {
        open = m[1]!;
        out.push(true);
        continue;
      }
      out.push(false);
    } else {
      out.push(true);
      if (m && m[1]![0] === open[0] && m[1]!.length >= open.length) open = null;
    }
  }
  return out;
}

const splitLines = (s: string): string[] => s.replace(/\r\n?/g, '\n').split('\n');
const headingText = (raw: string): string => raw.replace(/[*_`]/g, '').trim();

/** The layout facts of one markdown text. */
export function ticketLayoutOf(markdown: string): TicketLayout {
  const lines = splitLines(markdown ?? '');
  const fenced = fencedLines(lines);
  const headings: string[] = [];
  let numbered = 0;
  let bulleted = 0;
  let checklist = 0;
  let table = 0;
  let paragraphs = 0;
  let gherkin = 0;
  let givens = 0;
  lines.forEach((line, i) => {
    if (fenced[i] || line.trim() === '') return;
    const h = ATX_RE.exec(line);
    if (h != null) {
      const t = headingText(h[2]!);
      if (t !== '') headings.push(t);
      return;
    }
    if (GHERKIN_RE.test(line)) gherkin += 1;
    if (GIVEN_RE.test(line)) givens += 1;
    if (TABLE_RE.test(line)) {
      if (!TABLE_RULE_RE.test(line)) table += 1;
    } else if (CHECK_RE.test(line)) checklist += 1;
    else if (NUMBERED_RE.test(line)) numbered += 1;
    else if (BULLET_RE.test(line)) bulleted += 1;
    else if (!/^\s/.test(line)) paragraphs += 1;
  });
  const isGherkin = gherkin >= 2 && givens >= 1;
  const counts: Array<[TicketListStyle, number]> = [
    ['checklist', checklist],
    ['numbered', numbered],
    ['bulleted', bulleted],
    ['table', table],
  ];
  const items = counts.reduce((n, [, c]) => n + c, 0);
  let listStyle: TicketListStyle;
  if (items === 0) {
    listStyle = isGherkin ? 'gherkin' : paragraphs > 0 ? 'paragraphs' : 'empty';
  } else {
    const [top, n] = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
    listStyle = n >= items * 0.8 ? top : 'mixed';
  }
  // A table's header row is not an item.
  const itemCount = isGherkin && items === 0 ? givens : listStyle === 'table' ? Math.max(0, table - 1) : items;
  return { headings, listStyle, gherkin: isGherkin, itemCount };
}

const STYLE_WORDS: Record<TicketListStyle, string> = {
  numbered: 'a numbered list',
  bulleted: 'bullets',
  checklist: 'a checklist',
  gherkin: 'GIVEN / WHEN / THEN lines',
  table: 'a table',
  paragraphs: 'paragraphs',
  mixed: 'a mixed layout',
  empty: 'nothing',
};

/** The layout in a few words, for the agent and the panel: "a numbered list, 5 items, GIVEN / WHEN / THEN". */
export function describeTicketLayout(l: TicketLayout): string {
  if (l.listStyle === 'empty') return 'empty';
  const parts = [STYLE_WORDS[l.listStyle]];
  if (l.listStyle !== 'paragraphs' && l.itemCount > 0) parts.push(`${l.itemCount} item${l.itemCount === 1 ? '' : 's'}`);
  if (l.gherkin && l.listStyle !== 'gherkin') parts.push('GIVEN / WHEN / THEN');
  return parts.join(', ');
}

const MAX_PROBLEMS = 6;

/** Problems, plain English, when `draft` does not keep `original`'s layout. [] = kept. */
export function compareTicketLayout(
  original: TicketLayout,
  draft: TicketLayout,
  what: 'description' | 'criteria',
): string[] {
  const out: string[] = [];
  const subject = what === 'description' ? 'The description' : 'The criteria';
  // Every original heading, still present, in the same relative order. New headings are fine.
  const norm = (h: string): string => h.toLowerCase().replace(/\s+/g, ' ').trim();
  const draftIdx = new Map<string, number>();
  draft.headings.forEach((h, i) => {
    if (!draftIdx.has(norm(h))) draftIdx.set(norm(h), i);
  });
  const kept: Array<{ h: string; at: number }> = [];
  for (const h of original.headings) {
    const at = draftIdx.get(norm(h));
    if (at == null) out.push(`${subject} drops the heading "${h}".`);
    else kept.push({ h, at });
  }
  for (let i = 1; i < kept.length; i += 1) {
    const prev = kept[i - 1]!;
    const cur = kept[i]!;
    if (cur.at < prev.at) out.push(`"${cur.h}" now comes before "${prev.h}".`);
  }
  // 'gherkin' as a style is covered by the GIVEN / WHEN / THEN rule below.
  const loose: TicketListStyle[] = ['empty', 'paragraphs', 'mixed', 'gherkin'];
  if (!loose.includes(original.listStyle) && draft.listStyle !== 'empty' && draft.listStyle !== original.listStyle) {
    const were = what === 'description' ? 'The description used' : 'The criteria were';
    out.push(`${were} ${STYLE_WORDS[original.listStyle]}; the draft uses ${STYLE_WORDS[draft.listStyle]}.`);
  }
  if (original.gherkin && !draft.gherkin && draft.listStyle !== 'empty') {
    out.push(`${subject} ${what === 'description' ? 'was' : 'were'} written as GIVEN / WHEN / THEN; the draft is not.`);
  }
  return out.slice(0, MAX_PROBLEMS);
}

/** A bold LABEL line ("**Acceptance Criteria:**", "**AC**:", "__Criteria__") — Jira's `*Label:*`, as stored. */
const BOLD_LABEL_RE = /^\s{0,3}(\*\*|__)\s*([^*_]+?)\s*(\*\*|__)\s*:?\s*$/;

/** Exact names first; the looser ones only when no exact one exists (a "Definition of Done" is often its own section). */
export const acSectionNameTier = (text: string): 0 | 1 | null => {
  const t = text.replace(/[*_`]/g, '').replace(/:\s*$/, '').trim();
  if (/^(acceptance\s+criteria|a\/?c'?s?)\b/i.test(t)) return 0;
  if (/^(criteria|definition\s+of\s+done)\b/i.test(t)) return 1;
  return null;
};

/**
 * The acceptance-criteria section inside a description: its heading text and the line range
 * [start, end) — `start` is the heading (or bold label) line. An ATX heading's section ends at the next
 * heading of the same or a higher level; a bold label's (Jira's `*Acceptance Criteria:*`, the read
 * side's tracker/ac.ts `AC_LABEL_RE`) at the next heading or bold label. An exact name ("Acceptance
 * criteria", "AC") wins over a looser one ("Criteria", "Definition of Done") wherever it sits; among
 * equals, the first. Fenced code is skipped. null = no such section.
 */
export function findAcSection(markdown: string): { heading: string; start: number; end: number } | null {
  const lines = splitLines(markdown ?? '');
  const fenced = fencedLines(lines);
  const found: Array<{ heading: string; start: number; end: number; tier: 0 | 1 }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const h = ATX_RE.exec(lines[i]!);
    const b = h == null ? BOLD_LABEL_RE.exec(lines[i]!) : null;
    if (h == null && b == null) continue;
    const text = headingText(h != null ? h[2]! : b![2]!).replace(/:\s*$/, '').trim();
    const tier = acSectionNameTier(text);
    if (tier == null) continue;
    const level = h != null ? h[1]!.length : null;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (fenced[j]) continue;
      const n = ATX_RE.exec(lines[j]!);
      if ((n != null && (level == null || n[1]!.length <= level)) || (level == null && BOLD_LABEL_RE.test(lines[j]!))) {
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

/** The body of the AC section of a description ('' when there is none). */
export function acSectionText(description: string): string {
  const s = findAcSection(description);
  if (s == null) return '';
  return splitLines(description).slice(s.start + 1, s.end).join('\n').trim();
}

/**
 * Replace the AC section of a description with `criteria`, keeping its heading line. No section ⇒
 * append one at the end under `## <heading>` (default "Acceptance criteria").
 */
export function spliceAcSection(description: string, criteria: string, heading: string | null): string {
  const body = criteria.replace(/\r\n?/g, '\n').trim();
  const lines = splitLines(description ?? '');
  const s = findAcSection(description ?? '');
  if (s != null) {
    const before = lines.slice(0, s.start + 1);
    const after = lines.slice(s.end);
    const out = [...before, '', body, ...(after.length > 0 ? ['', ...after] : [])];
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  const head = `## ${(heading ?? '').trim() || 'Acceptance criteria'}`;
  const base = (description ?? '').trim();
  return (base === '' ? `${head}\n\n${body}` : `${base}\n\n${head}\n\n${body}`).trim();
}

// THE TICKET UPDATE'S DIFF RULE — the plan panel's "Update ticket" (frontend TicketUpdatePanel) and the
// end-to-end build's host-side update (backend coding/story-build/end-to-end.ts) send the SAME body.
const sameText = (a: string, b: string): boolean => a.replace(/\r\n?/g, '\n').trim() === b.replace(/\r\n?/g, '\n').trim();

/** What the two boxes start with. */
export function ticketReviewSeed(
  draft: { description: string | null; acceptanceCriteria: string | null } | null,
  current: { description: string; acceptanceCriteria: string; acLocation: TicketAcLocation } | null,
): { description: string; criteria: string } {
  const description = draft?.description ?? current?.description ?? '';
  if (draft?.acceptanceCriteria != null) return { description, criteria: draft.acceptanceCriteria };
  if (current?.acLocation.kind === 'description' && findAcSection(description) != null) {
    return { description, criteria: acSectionText(description) };
  }
  return { description, criteria: current?.acceptanceCriteria ?? '' };
}

/**
 * The body "Update ticket" sends: ONLY what differs from the ticket's current text (null = leave it).
 * Criteria in the description: the criteria box is sent only when it differs from the criteria section
 * of the description being sent (the host splices it in), so an edit made in the description box is
 * never overwritten.
 */
export function ticketUpdateBody(
  edited: { description: string; criteria: string },
  current: { description: string; acceptanceCriteria: string; acLocation: TicketAcLocation },
): { description: string | null; acceptanceCriteria: string | null } {
  const description = sameText(edited.description, current.description) ? null : edited.description;
  let acceptanceCriteria: string | null = sameText(edited.criteria, current.acceptanceCriteria) ? null : edited.criteria;
  if (current.acLocation.kind === 'description' && findAcSection(edited.description) != null && sameText(edited.criteria, acSectionText(edited.description))) {
    acceptanceCriteria = null;
  }
  return { description, acceptanceCriteria };
}
