import {
  isStoryIssueId,
  STORY_REPORT_ITEMS_MAX,
  STORY_REPORT_LEAN,
  STORY_REPORT_MAX_CANDIDATES,
  STORY_REPORT_TEXT_MAX,
  STORY_REPORT_TICKETS_PER_ACTION_MAX,
  STORY_REPORT_TICKETS_PER_ITEM_MAX,
  STORY_REPORT_TICKETS_PER_POINT_MAX,
  type StoryReportAction,
  type StoryReportBody,
  type StoryReportDropped,
  type StoryReportLeftOut,
  type StoryReportPoint,
  type StoryReportSpotlight,
  type StoryReportTheme,
} from '@pierre-review/shared';

// SERVER-SIDE VALIDATION of what the story report's agent submitted (`submit_report`). Pure.
//
//   • Every string is trimmed and cut to `STORY_REPORT_TEXT_MAX` (ending "…") — never refused (the tool
//     schema's `.max` is what makes the model rewrite; this cut is the backstop). A point's detail is
//     ONE sentence (`pointDetail`).
//   • Ticket keys must be PICKED CANDIDATES' keys: an unknown key is removed from a list (counted),
//     lists are deduped and capped (ONE example per point, two per action, eight per old theme — the
//     first known keys win); an item left with no ticket is dropped; a spotlight or leftOut on
//     an unknown key is dropped. The model may drop a weak example, never add a story.
//   • `tone` must be 'positive' | 'negative' (anything else drops the spotlight).
//   • A point's `issue` is kept only when it is one of the three story issues (`isStoryIssueId` — a
//     retired id such as 'too_big' is dropped); otherwise the FIELD is dropped, never the point.
//   • Each report section is capped at `STORY_REPORT_ITEMS_MAX`. `leftOut` is NOT a section — it is
//     the list of picked candidates the agent chose not to cover, so it is capped at
//     `STORY_REPORT_MAX_CANDIDATES` (and deduped by ticket); cutting it at 6 would hide stories the
//     report skipped and count them as model over-production.
//   • A report with no headline or summary after this is INVALID — the run fails ('invalid_report').

export type ValidatedReport =
  | { ok: true; report: StoryReportBody; dropped: StoryReportDropped }
  | { ok: false; dropped: StoryReportDropped };

function text(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v != null && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function validateStoryReport(raw: unknown, candidateKeys: ReadonlySet<string>): ValidatedReport {
  const dropped: StoryReportDropped = { unknownTickets: 0, items: 0, overCap: 0 };
  // Keys compared exactly after trimming; the model echoes keys it read from list_candidates.
  const known = (k: unknown): string | null => {
    const key = typeof k === 'string' ? k.trim() : '';
    return key !== '' && candidateKeys.has(key) ? key : null;
  };
  const ticketList = (v: unknown, max: number = STORY_REPORT_TICKETS_PER_ITEM_MAX): string[] => {
    const out: string[] = [];
    for (const k of arr(v)) {
      const key = known(k);
      if (key == null) {
        dropped.unknownTickets += 1;
        continue;
      }
      if (!out.includes(key)) out.push(key);
    }
    return out.slice(0, max);
  };
  const cap = <T>(items: T[], max: number = STORY_REPORT_ITEMS_MAX): T[] => {
    if (items.length > max) dropped.overCap += items.length - max;
    return items.slice(0, max);
  };
  // An item needs its text AND at least one known ticket; otherwise it is dropped (counted).
  const keep = <T>(item: T | null): item is T => {
    if (item == null) dropped.items += 1;
    return item != null;
  };

  const o = obj(raw);
  const point = (v: unknown): StoryReportPoint | null => {
    const p = obj(v);
    const title = text(p.title, STORY_REPORT_TEXT_MAX.title);
    const tickets = ticketList(p.tickets, STORY_REPORT_TICKETS_PER_POINT_MAX);
    if (title === '' || tickets.length === 0) return null;
    const out: StoryReportPoint = { title, detail: text(p.detail, STORY_REPORT_TEXT_MAX.pointDetail), tickets };
    if (isStoryIssueId(p.issue)) out.issue = p.issue;
    return out;
  };
  const spotlight = (v: unknown): StoryReportSpotlight | null => {
    const p = obj(v);
    const ticket = known(p.ticket);
    if (ticket == null && typeof p.ticket === 'string') dropped.unknownTickets += 1;
    const tone = p.tone === 'positive' || p.tone === 'negative' ? p.tone : null;
    const headline = text(p.headline, STORY_REPORT_TEXT_MAX.title);
    return ticket == null || tone == null || headline === ''
      ? null
      : { ticket, tone, headline, detail: text(p.detail, STORY_REPORT_TEXT_MAX.detail) };
  };
  const theme = (v: unknown): StoryReportTheme | null => {
    const p = obj(v);
    const t = text(p.theme, STORY_REPORT_TEXT_MAX.title);
    const tickets = ticketList(p.tickets);
    return t === '' || tickets.length === 0 ? null : { theme: t, detail: text(p.detail, STORY_REPORT_TEXT_MAX.detail), tickets };
  };
  const action = (v: unknown): StoryReportAction | null => {
    const p = obj(v);
    const a = text(p.action, STORY_REPORT_TEXT_MAX.action);
    const tickets = ticketList(p.tickets, STORY_REPORT_TICKETS_PER_ACTION_MAX);
    return a === '' || tickets.length === 0 ? null : { action: a, why: text(p.why, STORY_REPORT_TEXT_MAX.detail), tickets };
  };
  const leftOut = (v: unknown): StoryReportLeftOut | null => {
    const p = obj(v);
    const ticket = known(p.ticket);
    if (ticket == null && typeof p.ticket === 'string') dropped.unknownTickets += 1;
    return ticket == null ? null : { ticket, reason: text(p.reason, STORY_REPORT_TEXT_MAX.reason) };
  };

  const report: StoryReportBody = {
    headline: text(o.headline, STORY_REPORT_TEXT_MAX.headline),
    summary: text(o.summary, STORY_REPORT_TEXT_MAX.summary),
    doingWell: cap(arr(o.doingWell).map(point).filter(keep), STORY_REPORT_LEAN.doingWell),
    // One shortfall per story issue (the first wins); a point with no issue still counts toward the cap.
    fallingShort: cap(
      arr(o.fallingShort)
        .map(point)
        .filter(keep)
        .filter((p, i, all) => p.issue == null || all.findIndex((x) => x.issue === p.issue) === i),
      STORY_REPORT_LEAN.fallingShort,
    ),
    // The lean report writes no spotlights or themes; anything sent is dropped, uncounted.
    spotlights: [],
    themes: [],
    actions: cap(arr(o.actions).map(action).filter(keep), STORY_REPORT_LEAN.actions),
    leftOut: cap(
      arr(o.leftOut)
        .map(leftOut)
        .filter(keep)
        .filter((l, i, all) => all.findIndex((x) => x.ticket === l.ticket) === i),
      STORY_REPORT_MAX_CANDIDATES,
    ),
  };
  if (report.headline === '' || report.summary === '') return { ok: false, dropped };
  return { ok: true, report, dropped };
}
