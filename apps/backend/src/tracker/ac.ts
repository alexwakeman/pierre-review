// WHERE A MARKDOWN TRACKER KEEPS AN ISSUE'S ACCEPTANCE CRITERIA (pure; docs/TRACKERS.md § GitHub
// Issues, § Linear). Neither GitHub Issues nor Linear has a criteria field, so both readers look in
// four places, IN THIS ORDER, and the first that has something wins — ONE rule, shared, never forked:
//
//   1. SUB-ISSUES (GitHub sub-issues, Linear child issues) — the tracker's own breakdown of the
//      work. Each one is a criterion: `- [x] Title (#12)` / `- [x] Title (ENG-124)` when it is done,
//      `- [ ]` when not. The body is left whole as the description.
//   2. A TASK LIST in the body — every `- [ ] …` / `- [x] …` line outside a code block, EXCEPT a
//      group that is about the REPORTER rather than the work: an issue form's "Are you willing to
//      contribute?" / "I have searched existing issues" checkboxes (measured on ratatui/ratatui:
//      10 of 11 task lists read on receipt were exactly that). A group is the run of task lines
//      under one heading; it is dropped when its heading reads like a form question
//      (`FORM_HEADING_RE`) or when EVERY item is written in the first person.
//   3. An "ACCEPTANCE CRITERIA" SECTION — a heading (`## Acceptance criteria`) or a line that is
//      only that phrase in bold or with a colon, up to the next heading of the same or higher level.
//   4. Otherwise none: the whole body is the story (criteria '').
//
// When the criteria came from the BODY (2 or 3) they are cut out of the description, so the ticket
// review does not read them twice. ⚠ Code fences are skipped by both body rules — a checkbox inside
// a ```markdown example is not a criterion.

/** One sub-issue as a criterion: how it is cited (`#12`, `ENG-124`), its title, whether it is done. */
export interface AcChild {
  ref: string;
  title: string;
  done: boolean;
}

export type AcSource = 'sub_issues' | 'task_list' | 'heading';

export interface AcResult {
  description: string;
  criteria: { source: AcSource; name: string; text: string } | null;
}

/** The candidate id a stored row names its criteria source by — `<provider>:<source>`, never a Jira
 *  field id (the ac-field route refuses it, so there is nothing to "Change"). */
export const acSourceFieldId = (provider: 'github' | 'linear', source: AcSource): string => `${provider}:${source}`;

const AC_NAMES: Record<AcSource, string> = {
  sub_issues: 'Sub-issues',
  task_list: 'Task list',
  heading: 'Acceptance criteria section',
};

const TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+\S/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const AC_PHRASE = /^acceptance\s+criteria\b/i;
// A line that is only the phrase, emphasised or followed by a colon: "**Acceptance criteria**",
// "Acceptance Criteria:", "__Acceptance criteria:__".
const AC_LABEL_RE = /^\s{0,3}(?:\*\*|__)?\s*acceptance\s+criteria\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;

/** Which lines are inside a fenced code block (the fence lines included). */
function fencedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (open == null) {
      if (m) {
        open = m[1]![0]!.repeat(m[1]!.length);
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

const tidy = (s: string): string => s.replace(/\n{3,}/g, '\n\n').trim();

function subIssueList(subIssues: readonly AcChild[], total: number | null): string {
  const lines = subIssues.map(
    (s) => `- [${s.done ? 'x' : ' '}] ${s.title.replace(/\s+/g, ' ').trim()} (${s.ref})`,
  );
  // null = the tracker says there are more but not how many (Linear's connections carry no count).
  if (total == null) lines.push('- … and more sub-issues');
  else {
    const more = total - subIssues.length;
    if (more > 0) lines.push(`- … and ${more} more sub-issue${more === 1 ? '' : 's'}`);
  }
  return lines.join('\n');
}

// An issue form's meta questions — about the reporter, not the work.
const FORM_HEADING_RE =
  /\b(contribut\w*|willing|checklist|pre-?flight|before (submitting|you)|prerequisites?|code of conduct|terms|agreement|confirm\w*|search(ed)? (existing|for))\b/i;
const FIRST_PERSON_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+(?:\*\*|__)?(?:I|I'm|I’m|I've|I’ve|I'd|My|We|We've|We’ve)\b/;

function taskList(lines: readonly string[], fenced: readonly boolean[]): { text: string; rest: string } | null {
  // Group the task lines by the heading they sit under.
  const groups = new Map<number, { heading: string; idx: number[] }>();
  let section = -1;
  let heading = '';
  lines.forEach((line, i) => {
    if (fenced[i]) return;
    const h = ATX_RE.exec(line);
    if (h != null || AC_LABEL_RE.test(line) || /^\s{0,3}(\*\*|__)[^*_]+(\*\*|__):?\s*$/.test(line)) {
      section = i;
      heading = h != null ? h[2]! : line;
      return;
    }
    if (!TASK_RE.test(line)) return;
    const g = groups.get(section) ?? { heading, idx: [] };
    g.idx.push(i);
    groups.set(section, g);
  });
  const keep = new Set<number>();
  for (const g of groups.values()) {
    if (FORM_HEADING_RE.test(g.heading)) continue;
    if (g.idx.every((i) => FIRST_PERSON_RE.test(lines[i]!))) continue;
    for (const i of g.idx) keep.add(i);
  }
  const picked: string[] = [];
  const rest: string[] = [];
  lines.forEach((line, i) => {
    if (keep.has(i)) picked.push(line.replace(/\s+$/, ''));
    else rest.push(line);
  });
  if (picked.length === 0) return null;
  // Keep relative nesting, drop the common indent.
  const indent = Math.min(...picked.map((l) => /^\s*/.exec(l)![0].length));
  return { text: picked.map((l) => l.slice(indent)).join('\n'), rest: rest.join('\n') };
}

function headingSection(lines: readonly string[], fenced: readonly boolean[]): { text: string; rest: string } | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const line = lines[i]!;
    const atx = ATX_RE.exec(line);
    const level = atx != null && AC_PHRASE.test(atx[2]!.replace(/[*_]/g, '').trim()) ? atx[1]!.length : null;
    const label = level == null && AC_LABEL_RE.test(line);
    if (level == null && !label) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (fenced[j]) continue;
      const h = ATX_RE.exec(lines[j]!);
      // A heading of the same or higher level ends an ATX section; a bold label's section ends at
      // ANY heading (it has no level of its own).
      if (h != null && (label || h[1]!.length <= level!)) {
        end = j;
        break;
      }
    }
    const text = lines.slice(i + 1, end).join('\n').trim();
    if (text === '') continue;
    return { text, rest: [...lines.slice(0, i), ...lines.slice(end)].join('\n') };
  }
  return null;
}

/** The criteria of one issue and the description left once they are taken out of it. */
export function extractAcceptanceCriteria(
  body: string | null | undefined,
  subIssues: readonly AcChild[] = [],
  // How many sub-issues there are in all; null = more than listed, count unknown.
  subIssuesTotal: number | null = subIssues.length,
): AcResult {
  const text = (body ?? '').replace(/\r\n?/g, '\n');
  if (subIssues.length > 0) {
    return {
      description: tidy(text),
      criteria: { source: 'sub_issues', name: AC_NAMES.sub_issues, text: subIssueList(subIssues, subIssuesTotal) },
    };
  }
  const lines = text.split('\n');
  const fenced = fencedLines(lines);
  const tasks = taskList(lines, fenced);
  if (tasks != null) {
    return { description: tidy(tasks.rest), criteria: { source: 'task_list', name: AC_NAMES.task_list, text: tasks.text } };
  }
  const section = headingSection(lines, fenced);
  if (section != null) {
    return {
      description: tidy(section.rest),
      criteria: { source: 'heading', name: AC_NAMES.heading, text: section.text },
    };
  }
  return { description: tidy(text), criteria: null };
}
