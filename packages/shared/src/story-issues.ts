import type { JiraStatusCategory } from './types.js';
import {
  STORY_REFERENCE_RELATIONS,
  type StoryCriterionLabel,
  type StoryDependencyKind,
  type StoryDependencyLabel,
  type StoryLevelLabels,
  type StorySpecGap,
  type StoryTicketReference,
} from './story-health.js';

// THE THREE STORY ISSUES — the ONE vocabulary for "what is wrong with this ticket" across Reports →
// This sprint (chips, bullets, checks, the code assessment) and
// the story report (its points carry an issue id). docs/CLAUDE-REVIEW.md § Story issues.
//
// Each issue is SPECIFIC: it carries the detail a reader needs to act — WHICH criterion and WHY, WHAT
// the story waits on, WHO owns it and in WHAT STATE, WHICH detail the spec leaves out.
//
//   unclear_done  no criteria (code), OR criteria the labeller could not check — each with a REASON.
//   blocked       work the story waits on, from TWO sources in order of trust:
//                   • TRACKER LINKS (code, objective): Jira "is blocked by" / "depends on" links,
//                     Linear "blocks" relations — stored on the ticket (`blocked_by_json`), with the
//                     linked issue's key, title and status. A link whose status category is `done` is
//                     RESOLVED: shown in the detail, never raised.
//                   • NAMED IN TEXT (the label): dependencies the ticket names without a link — what,
//                     owner, and a ticket key when one is named. A named key that is a STORED ticket
//                     gets its title + status from code (`knownTickets`); one that is done is resolved.
//                     RUBRIC 4: a named TICKET counts only when the label's `references` give it the
//                     relation `depends_on` — a ticket the story supersedes, builds on, leaves out of
//                     scope, is built alongside or merely mentions is never a blocker
//                     (`storyReferencesByKey`).
//                 Only REAL blockers are raised (`isRealStoryBlocker`): an unfinished ticket, or a
//                 decision nobody has made. Inputs (a design, data, a file) are not.
//   spec_gaps     up to three specific missing details from the label (a rule, an edge case, a design,
//                 data, a non-functional need). NOT a This sprint chip (2026-10-11: every labelled ticket
//                 got three, so a chip on every card said nothing) — the opened card lists the gaps as
//                 their own section. `foldStoryIssues` still returns it; This sprint filters chips by
//                 `chip` (`STORY_CHIP_ISSUE_IDS`).
//
// ⚠ "Too big" and "Scope not stated" were REMOVED (2026-10-11, user decision): the first flagged 69 of
// 73 real stories and splitting is not the reader's call; the second was too generic to act on. Their
// ids may still sit in OLD stored rows (story reports' `issue`, assessment bodies, sprint checks): every
// reader drops an id `isStoryIssueId` does not know — never renders it, never fails on it.
//
// ⚠ A LABEL HALF NEEDS A CURRENT LABEL — the caller hands in only the label whose text hash equals
// today's (`storyLabelInput`) at `STORY_RUBRIC_VERSION`, and a label that judged a different NUMBER of
// criteria than today's list is ignored (criterion n must point at the text it judged). With no usable
// label, only what code knows is raised: "no criteria" and linked blockers.
//
// ⚠ TWO QUESTIONS, TWO FOLDS — never one reused for the other:
//   • `foldStoryIssues` — THE TICKET NOW (This sprint): is it blocked TODAY? A finished dependency is
//     not a blocker.
//   • `storyIssueMeasure` — HOW THE STORY WAS WRITTEN (the story report's per-pick states): did it
//     depend on other work at all? Finished or not — or every old story would read "not blocked" once
//     its blockers closed.
// RATES over many stories (the story report's figures) use a THIRD rule,
// `storyIssueRateUnits`: unclear_done over CRITERIA, blocked over tracker LINKS only (code).
//
// ⚠ EVERY SENTENCE HERE IS TEMPLATED — the chip detail and the one-line bullet. The REASON / WHAT /
// OWNER / GAP strings inside them are the labeller's short phrases (validated, capped), shown as data.
// (The code assessment may REPLACE a bullet with its own sentence; that is labelled as Claude's.)

export type StoryIssueId = 'unclear_done' | 'blocked' | 'spec_gaps';

export interface StoryIssueMeta {
  id: StoryIssueId;
  /** Chip / heading text, plain English. */
  label: string;
  /** Display order (chips, bullets, series, Copy all). */
  order: number;
  /** The issue AVOIDED, for a strength ("What we do well"): naming the problem there reads as one. */
  avoided: string;
  /** The label for a RATE counted by `storyIssueRateUnits` (the story report's
   *  whole-window figures). It differs from `label` because the populations differ: unclear_done is a
   *  share of CRITERIA, blocked a share of stories with a tracker LINK (any status). */
  measureLabel: string;
  /** A chip on This sprint (counted in `flagCount`, the sort order). spec_gaps is not: its gaps show
   *  in the opened card as their own section (`SprintTicketRow.specGaps`). */
  chip: boolean;
}

/** In display order. */
export const STORY_ISSUES: readonly StoryIssueMeta[] = [
  { id: 'unclear_done', label: 'Unclear when done', order: 0, avoided: 'Clear when done', measureLabel: 'Criteria that can’t be checked', chip: true },
  { id: 'blocked', label: 'Blocked', order: 1, avoided: 'Nothing blocking', measureLabel: 'Stories with a linked blocker', chip: true },
  { id: 'spec_gaps', label: 'Spec gaps', order: 2, avoided: 'Spec complete', measureLabel: 'Spec gaps', chip: false },
];

export const STORY_ISSUE_IDS: readonly StoryIssueId[] = STORY_ISSUES.map((m) => m.id);

export const STORY_ISSUE_BY_ID: Readonly<Record<StoryIssueId, StoryIssueMeta>> = Object.fromEntries(
  STORY_ISSUES.map((m) => [m.id, m]),
) as Record<StoryIssueId, StoryIssueMeta>;

/** The issues that are chips on This sprint (`chip: true`), in display order. */
export const STORY_CHIP_ISSUE_IDS: readonly StoryIssueId[] = STORY_ISSUES.filter((m) => m.chip).map((m) => m.id);

/** THE tolerance gate: an old stored id ('too_big', 'waits_on_work', 'scope_unstated') is false. */
export function isStoryIssueId(v: unknown): v is StoryIssueId {
  return typeof v === 'string' && (STORY_ISSUE_IDS as readonly string[]).includes(v);
}

/** Bullets show at most this many items per issue, then "and N more". */
export const STORY_ISSUE_BULLET_ITEMS = 3;

/** "Unclear when done" shows at most this many flagged criteria (the FIRST, in criterion order, each
 *  with its reason), then "and N more" — on the card, in its bullet, Copy all and the comment default.
 *  The chip still says "N of M criteria". 2026-10-11, the BNG review: a list of every loose criterion
 *  was the longest thing on the card and the reader acted on the first one or two. */
export const STORY_UNCLEAR_CRITERIA_SHOWN = 2;

/** Spec gaps a label carries at most. */
export const STORY_SPEC_GAPS_MAX = 3;

// ── Tracker links (code, stored on `tracker_tickets` + `sprint_tickets` as `blocked_by_json`) ──────

/** A linked issue this ticket waits on, as the tracker states it (Jira issuelinks of a blocking type,
 *  Linear "blocks" relations pointing at this issue). Read in the SAME issue read as the ticket — no
 *  extra call. Stored for done blockers too (`category: 'done'`): those are RESOLVED, never raised. */
export interface TicketLinkBlocker {
  /** The linked issue's key (`BMD-568`, `ENG-12`). */
  key: string;
  /** Its summary / title, ≤ TICKET_LINK_TITLE_MAX chars; null when the tracker did not send one. */
  title: string | null;
  /** Its status name, as the tracker spells it; null when not sent. */
  status: string | null;
  category: JiraStatusCategory | null;
  /** The relation from THIS ticket's side, as the tracker phrases it ("is blocked by", "depends on",
   *  Linear: "blocked by"). Shown in the detail ⓘ only. */
  relation: string;
  /** Browse URL (https only) — render through `safeExternalUrl`. */
  url: string | null;
}

/** Links stored per ticket at most (the rest are cut; a ticket with more is rare). */
export const TICKET_LINK_BLOCKERS_MAX = 20;
export const TICKET_LINK_TITLE_MAX = 200;
export const TICKET_LINK_RELATION_MAX = 60;

/** Does a Jira link phrase (THIS ticket's side: `type.inward` when the link carries `inwardIssue`,
 *  `type.outward` when it carries `outwardIssue`) mean "this ticket waits on the other"? THE ONE
 *  predicate. "is blocked by", "depends on", "is dependent on", "requires", "waits on/for" → true;
 *  "blocks", "is depended on by", "is required by", "relates to" → false. */
export function isBlockingRelation(phrase: string): boolean {
  return /\b(blocked by|depends on|dependent on|requires|waits? (on|for))\b/i.test(phrase);
}

/** A stored `blocked_by_json` value → clean links (tolerant: anything malformed is dropped; a
 *  non-array is null = "not read"). */
export function parseTicketLinkBlockers(raw: unknown): TicketLinkBlocker[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TicketLinkBlocker[] = [];
  const cats: readonly string[] = ['new', 'indeterminate', 'done'];
  for (const x of raw) {
    if (x == null || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (typeof o.key !== 'string' || o.key.trim() === '') continue;
    out.push({
      key: o.key.trim(),
      title: typeof o.title === 'string' && o.title.trim() !== '' ? o.title.trim().slice(0, TICKET_LINK_TITLE_MAX) : null,
      status: typeof o.status === 'string' && o.status.trim() !== '' ? o.status.trim() : null,
      category: typeof o.category === 'string' && cats.includes(o.category) ? (o.category as JiraStatusCategory) : null,
      relation: typeof o.relation === 'string' ? o.relation.slice(0, TICKET_LINK_RELATION_MAX) : '',
      url: typeof o.url === 'string' && /^https:\/\//i.test(o.url) ? o.url : null,
    });
    if (out.length >= TICKET_LINK_BLOCKERS_MAX) break;
  }
  return out;
}

// ── The folded issue ─────────────────────────────────────────────────────────────────────────────

/** Why an issue was raised — data the templates read (and tests pin). */
export type StoryIssueReason =
  | 'no_criteria' // unclear_done: the ticket has no criteria
  | 'untestable' // unclear_done: criteria the labeller could not check
  | 'linked' // blocked: an open tracker link
  | 'named' // blocked: a dependency named in the text
  | 'gaps' // spec_gaps
  | 'claude'; // any issue: raised by a CURRENT "Check against code" run that code did not raise

/** One criterion "Unclear when done" points at. */
export interface StoryFlaggedCriterion {
  /** 1-based, = its position in `extractCriteria(...)`. */
  n: number;
  /** The labeller's short reason ("no expected result"); null when it gave none. */
  reason: string | null;
}

/** One thing the story waits on, from either source. */
export interface StoryBlocker {
  source: 'link' | 'text';
  /** 'ticket' for every link. */
  kind: StoryDependencyKind;
  /** The ticket key, when there is one (a link always; a text dependency when it names one). */
  ticketKey: string | null;
  /** What it is: the linked/known ticket's TITLE, else the labeller's `what`. ≤ 200 chars. */
  what: string;
  /** Who owns it, as the ticket names it (text only); null when not named. */
  owner: string | null;
  /** The ticket's status when known (a link, or a named key that is a stored ticket); null otherwise. */
  status: string | null;
  category: JiraStatusCategory | null;
  /** Link only: the tracker's phrase from this ticket's side. */
  relation: string | null;
  url: string | null;
  /** Finished (status category `done`): never raised by `foldStoryIssues`. */
  resolved: boolean;
  /** Text only (rubric 3): the label's verified passage naming it; ABSENT otherwise. */
  quote?: string | null;
}

export interface StoryIssue {
  id: StoryIssueId;
  /** The ticket's criteria count today. */
  total: number;
  /** In the order above; at least one. */
  reasons: StoryIssueReason[];
  /** unclear_done: the criteria behind it, ascending. [] for no_criteria / claude / other issues. */
  criteria: StoryFlaggedCriterion[];
  /** blocked: the REAL blockers only (`isRealStoryBlocker`), links before text — from
   *  `foldStoryIssues`. The story report's as-written view also lists finished tickets
   *  (`resolved: true`). [] otherwise. */
  blockers: StoryBlocker[];
  /** spec_gaps: the gaps, as labelled (≤ STORY_SPEC_GAPS_MAX). [] otherwise. */
  gaps: StorySpecGap[];
}

/** The stored label shape (`story_labels.criteria_json` + `story_json`) at the CURRENT rubric. */
export interface StoryIssueLabel {
  criteria: StoryCriterionLabel[];
  story: StoryLevelLabels;
}

/** A stored ticket a text dependency may name (same tracker site), for its title + status. */
export interface KnownTicket {
  title: string | null;
  status: string | null;
  category: JiraStatusCategory | null;
  url: string | null;
}

export interface StoryIssueInput {
  /** The ticket's numbered criteria (`extractCriteria`), in order. */
  criteria: readonly string[];
  /** The CURRENT label only; null when there is none (pending, off, or no criteria). */
  label: StoryIssueLabel | null;
  /** The ticket's stored tracker links (`blocked_by_json`); null/absent = not read (GitHub Issues, an
   *  old row). */
  links?: readonly TicketLinkBlocker[] | null;
  /** Stored tickets on the same site by KEY (upper-cased for Jira/Linear), for named keys. Absent = none. */
  knownTickets?: ReadonlyMap<string, KnownTicket> | null;
}

/** The label if it may be used: present, and judged exactly today's number of criteria. */
export function usableStoryLabel(input: StoryIssueInput): StoryIssueLabel | null {
  const l = input.label;
  if (l == null || input.criteria.length === 0) return null;
  return l.criteria.length === input.criteria.length ? l : null;
}

const keyOf = (k: string): string => k.trim().toUpperCase();

/** The label's references by UPPER-CASED key, one per ticket: when the text names a ticket in two
 *  roles, the higher-priority relation wins (`STORY_REFERENCE_RELATIONS` order — depends_on, then
 *  concurrent, …). Pure. */
export function storyReferencesByKey(
  refs: readonly StoryTicketReference[] | null | undefined,
): Map<string, StoryTicketReference> {
  const out = new Map<string, StoryTicketReference>();
  const rank = (r: StoryTicketReference): number => {
    const i = STORY_REFERENCE_RELATIONS.indexOf(r.relation);
    return i < 0 ? STORY_REFERENCE_RELATIONS.length : i;
  };
  for (const r of refs ?? []) {
    const k = keyOf(r.ticketKey);
    if (k === '') continue;
    const prev = out.get(k);
    if (prev == null || rank(r) < rank(prev)) out.set(k, r);
  }
  return out;
}

/** THE BLOCKER RULE — is this dependency something the story is really waiting on? Kept ONLY when it is
 *  (a) a TICKET (a tracker link, or a ticket key the text names) that is NOT done — an unknown status
 *  counts as not done and reads "status unknown" (`storyBlockerPhrase`); or (b) a text dependency of
 *  kind 'decision': a decision or approval nobody has made. DROPPED: tickets already done, and text
 *  items of any other kind (data, design, api, environment, other) with no ticket key — those are
 *  INPUTS the ticket points to, usually already provided (Figma nodes, spreadsheets, reference files).
 *  2026-10-11, the review of all 42 BNG sprint tickets: of 63 dependency items, 13 were done tickets,
 *  15 tickets of unknown status, 14 open tickets and 21 had no ticket, mostly inputs.
 *  Used by `foldStoryIssues` (This sprint: chips, bullets, Copy all, the comment default). Story
 *  health's linked-blocker rate (`storyIssueRateUnits`) is a different measure and does not use it. */
export function isRealStoryBlocker(b: StoryBlocker): boolean {
  return isStoryDependencyItem(b) && !b.resolved;
}

/** The KIND half of the blocker rule, status aside: a ticket (any status), or a decision. The story
 *  report's "as written" view (`storyIssueMeasure`, `storyIssuesAsWritten`) uses this, because it asks
 *  whether the story DEPENDED on other work — a ticket finished since still counts there. */
export function isStoryDependencyItem(b: StoryBlocker): boolean {
  return b.ticketKey != null || b.kind === 'decision';
}

/** Every dependency of one ticket, links first then text, deduped by ticket key (a link wins), in
 *  input order within each source. Pure; includes resolved ones. */
export function storyBlockers(input: StoryIssueInput): StoryBlocker[] {
  const out: StoryBlocker[] = [];
  const seen = new Set<string>();
  for (const l of input.links ?? []) {
    const k = keyOf(l.key);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      source: 'link',
      kind: 'ticket',
      ticketKey: l.key,
      what: l.title ?? l.key,
      owner: null,
      status: l.status,
      category: l.category,
      relation: l.relation || null,
      url: l.url,
      resolved: l.category === 'done',
    });
  }
  const label = usableStoryLabel(input);
  // RUBRIC 4: a label carrying `references` says what each named ticket IS to this story; only a
  // `depends_on` ticket may block. (A label without the field — an old fixture — keeps every named key.)
  const refs = label?.story.references != null ? storyReferencesByKey(label.story.references) : null;
  for (const d of label?.story.dependencies ?? []) {
    const k = d.ticketKey != null ? keyOf(d.ticketKey) : null;
    if (k != null && refs != null && refs.has(k) && refs.get(k)!.relation !== 'depends_on') continue;
    if (k != null && seen.has(k)) continue;
    if (k != null) seen.add(k);
    const known = k != null ? (input.knownTickets?.get(k) ?? null) : null;
    out.push({
      source: 'text',
      kind: d.kind,
      ticketKey: d.ticketKey,
      what: known?.title ?? d.what,
      owner: d.owner,
      status: known?.status ?? null,
      category: known?.category ?? null,
      relation: null,
      url: known?.url ?? null,
      resolved: known?.category === 'done',
      ...(d.quote != null ? { quote: d.quote } : {}),
    });
  }
  // A depends_on reference the dependencies did not list (the validator keeps the two in step; this is
  // the belt to its braces).
  for (const [k, r] of refs ?? []) {
    if (r.relation !== 'depends_on' || seen.has(k)) continue;
    seen.add(k);
    const known = input.knownTickets?.get(k) ?? null;
    out.push({
      source: 'text',
      kind: 'ticket',
      ticketKey: r.ticketKey,
      what: known?.title ?? r.ticketKey,
      owner: r.owner,
      status: known?.status ?? null,
      category: known?.category ?? null,
      relation: null,
      url: known?.url ?? null,
      resolved: known?.category === 'done',
      ...(r.quote != null ? { quote: r.quote } : {}),
    });
  }
  // Open first (links before text — stable), then resolved.
  return [...out.filter((b) => !b.resolved), ...out.filter((b) => b.resolved)];
}

/** Every issue present on one ticket NOW, in STORY_ISSUES order. Pure. */
export function foldStoryIssues(input: StoryIssueInput): StoryIssue[] {
  const total = input.criteria.length;
  const label = usableStoryLabel(input);
  const out: StoryIssue[] = [];
  const base = { total, criteria: [] as StoryFlaggedCriterion[], blockers: [] as StoryBlocker[], gaps: [] as StorySpecGap[] };

  // unclear_done
  if (total === 0) out.push({ ...base, id: 'unclear_done', reasons: ['no_criteria'] });
  else if (label != null) {
    const flagged = label.criteria
      .filter((c) => !c.testable && c.n >= 1 && c.n <= total)
      .map((c) => ({ n: c.n, reason: c.reason }))
      .sort((a, b) => a.n - b.n)
      .filter((c, i, a) => i === 0 || a[i - 1]!.n !== c.n);
    if (flagged.length > 0) out.push({ ...base, id: 'unclear_done', reasons: ['untestable'], criteria: flagged });
  }

  // blocked — the link half is code; the text half needs the label. REAL blockers only.
  {
    const blockers = storyBlockers(input).filter(isRealStoryBlocker);
    if (blockers.length > 0) {
      const reasons: StoryIssueReason[] = [];
      if (blockers.some((b) => b.source === 'link')) reasons.push('linked');
      if (blockers.some((b) => b.source === 'text')) reasons.push('named');
      out.push({ ...base, id: 'blocked', reasons, blockers });
    }
  }

  // spec_gaps
  if (label != null && label.story.gaps.length > 0) {
    out.push({ ...base, id: 'spec_gaps', reasons: ['gaps'], gaps: label.story.gaps.slice(0, STORY_SPEC_GAPS_MAX) });
  }
  return out;
}

/** Per issue NOW: true = present, false = known absent, null = cannot tell. Pure. `blocked` is true
 *  on an open link even with no label; false only with a usable label (the text half is known). */
export function storyIssueStates(input: StoryIssueInput): Record<StoryIssueId, boolean | null> {
  const present = new Set(foldStoryIssues(input).map((i) => i.id));
  const labelled = usableStoryLabel(input) != null;
  const state = (id: StoryIssueId): boolean | null => (present.has(id) ? true : labelled ? false : null);
  return { unclear_done: state('unclear_done'), blocked: state('blocked'), spec_gaps: state('spec_gaps') };
}

/** Per-story PRESENCE "as written" — the story report's per-pick states (`storyIssuesAsWritten`): did
 *  the story have the issue at all? ONE population, the stories with a usable label (null otherwise).
 *  ⚠ `blocked` here = the story DEPENDED on other work, FINISHED OR NOT: any ticket (linked or
 *  named), any named decision (`isStoryDependencyItem` — inputs such as a design or data are not). ⚠ This is NOT the rate rule — rates over many stories go through `storyIssueRateUnits`.
 *  Pure. */
export function storyIssueMeasure(input: StoryIssueInput): Record<StoryIssueId, boolean | null> {
  const label = usableStoryLabel(input);
  if (label == null) return { unclear_done: null, blocked: null, spec_gaps: null };
  return {
    unclear_done: label.criteria.some((c) => !c.testable),
    blocked: storyBlockers(input).some(isStoryDependencyItem),
    spec_gaps: label.story.gaps.length > 0,
  };
}

/** One story's contribution to a rate: `num` of `den` units (see `STORY_ISSUE_RATE_UNIT`). */
export interface StoryRateUnits {
  num: number;
  den: number;
}

/** What a rate counts, per issue: CRITERIA for "Unclear when done", STORIES for the rest. */
export const STORY_ISSUE_RATE_UNIT: Readonly<Record<StoryIssueId, 'criteria' | 'stories'>> = {
  unclear_done: 'criteria',
  blocked: 'stories',
  spec_gaps: 'stories',
};

/** THE RATE RULE for rates over many stories (the story report's
 *  whole-window rates). null = leave this story out of this issue's rate. Pure.
 *   • unclear_done — CRITERIA: of the story's criteria, how many the CURRENT usable label could not
 *     check. A story with no criteria or no usable label is out (no criteria is counted on its own, by
 *     code: `noCriteria` / `noCriteriaFound`). A rate over stories saturated: almost every story had one
 *     loose criterion.
 *   • blocked — STORIES, CODE ONLY: does the ticket carry ≥ 1 tracker link of a blocking type, any
 *     status? Out when its links were never read (`links` null/absent). A dependency named only in the
 *     text is NOT counted: two readings of the same ticket disagree on those.
 *   • spec_gaps — STORIES: the usable label found ≥ 1 gap (held from the story report, `STORY_ISSUE_RATES_HELD`). */
export function storyIssueRateUnits(input: StoryIssueInput): Record<StoryIssueId, StoryRateUnits | null> {
  const label = usableStoryLabel(input);
  let unclear: StoryRateUnits | null = null;
  if (label != null) {
    const total = input.criteria.length;
    const flagged = new Set(label.criteria.filter((c) => !c.testable && c.n >= 1 && c.n <= total).map((c) => c.n));
    unclear = { num: flagged.size, den: total };
  }
  return {
    unclear_done: unclear,
    blocked: input.links == null ? null : { num: input.links.length > 0 ? 1 : 0, den: 1 },
    spec_gaps: label == null ? null : { num: label.story.gaps.length > 0 ? 1 : 0, den: 1 },
  };
}

// ── Checks (per-workspace, Reports → This sprint) ────────────────────────────────────────────────

/** Which issues a workspace raises. OVERRIDES ONLY: `off` switches an issue off; `issueTypes` limits
 *  the WHOLE tab's issues to tickets of those types (case-insensitive; [] = every type). A ticket of
 *  another type is still listed, with no issues. A ticket with no issue type is always checked.
 *  ⚠ A STORED `off` may name a retired id — `parseSprintChecks` drops it. */
export interface StoryIssueChecks {
  off: StoryIssueId[];
  issueTypes: string[];
}

export const STORY_ISSUE_CHECKS_DEFAULT: StoryIssueChecks = { off: [], issueTypes: [] };
export const STORY_ISSUE_CHECK_TYPES_MAX = 40;
export const STORY_ISSUE_CHECK_TYPE_MAX_CHARS = 80;

/** Is a ticket of this type checked at all? THE ONE type predicate. */
export function storyIssueTypeChecked(checks: StoryIssueChecks, issueType: string | null): boolean {
  if (checks.issueTypes.length === 0 || issueType == null || issueType.trim() === '') return true;
  const t = issueType.trim().toLowerCase();
  return checks.issueTypes.some((x) => x.trim().toLowerCase() === t);
}

/** The issues this workspace raises on a ticket of this type. THE ONE filter (server and SPA). */
export function applyStoryIssueChecks<T extends { id: StoryIssueId }>(
  issues: readonly T[],
  checks: StoryIssueChecks,
  issueType: string | null,
): T[] {
  if (!storyIssueTypeChecked(checks, issueType)) return [];
  return issues.filter((i) => !checks.off.includes(i.id));
}

// ── Templates (never model text; the labeller's short phrases appear inside them as data) ─────────

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "a · b · c" then " and N more" past STORY_ISSUE_BULLET_ITEMS. */
export function joinCapped(items: readonly string[], cap: number = STORY_ISSUE_BULLET_ITEMS): string {
  const shown = items.slice(0, cap).join(' · ');
  return items.length > cap ? `${shown} and ${items.length - cap} more` : shown;
}

/** One blocker as a phrase: "BMD-568 cookie banner (To Do)" · "BMD-9 (status unknown)" · "Sign-off on
 *  the copy, product owner, no ticket". The first of a bullet is prefixed "Waits on " by `storyIssueBullet`. */
export function storyBlockerPhrase(b: StoryBlocker): string {
  const parts: string[] = [];
  if (b.ticketKey != null) {
    const what = b.what.trim() !== '' && keyOf(b.what) !== keyOf(b.ticketKey) ? ` ${b.what}` : '';
    // A ticket with no known status is still a blocker (`isRealStoryBlocker`) and says so.
    const status = b.status ?? (b.resolved ? null : 'status unknown');
    parts.push(`${b.ticketKey}${what}${status != null ? ` (${status})` : ''}`);
  } else parts.push(b.what);
  if (b.owner != null && b.owner.trim() !== '') parts.push(b.owner);
  if (b.ticketKey == null) parts.push('no ticket');
  return parts.join(', ');
}

/** "Criterion 3: no expected result" — one flagged criterion. */
export function storyCriterionPhrase(c: StoryFlaggedCriterion): string {
  return `Criterion ${c.n}: ${c.reason ?? 'can’t be checked'}`;
}

/** The chip's suffix after the label ("3 of 25 criteria", "no criteria", "2 open", "2 gaps"), or null. */
export function storyIssueDetail(issue: StoryIssue): string | null {
  if (issue.reasons.length === 1 && issue.reasons[0] === 'claude') return null;
  switch (issue.id) {
    case 'unclear_done':
      return issue.reasons.includes('no_criteria') ? 'no criteria' : `${issue.criteria.length} of ${issue.total} criteria`;
    case 'blocked': {
      const open = issue.blockers.filter(isRealStoryBlocker).length;
      return open > 0 ? `${open} open` : null;
    }
    case 'spec_gaps':
      return issue.gaps.length > 0 ? plural(issue.gaps.length, 'gap', 'gaps') : null;
  }
}

/** "Unclear when done · 3 of 25 criteria" — the whole chip text. */
export function storyIssueChipText(issue: StoryIssue): string {
  const d = storyIssueDetail(issue);
  return d == null ? STORY_ISSUE_BY_ID[issue.id].label : `${STORY_ISSUE_BY_ID[issue.id].label} · ${d}`;
}

/** The flagged criteria "Unclear when done" shows: the first STORY_UNCLEAR_CRITERIA_SHOWN, and how many
 *  more there are. THE ONE cap (card, bullet, Copy all, comment default). */
export function storyUnclearCriteriaShown(issue: StoryIssue): { shown: StoryFlaggedCriterion[]; more: number } {
  const shown = issue.criteria.slice(0, STORY_UNCLEAR_CRITERIA_SHOWN);
  return { shown, more: issue.criteria.length - shown.length };
}

/** THE ONE templated bullet per issue: the specific detail, capped (STORY_UNCLEAR_CRITERIA_SHOWN for
 *  criteria, STORY_ISSUE_BULLET_ITEMS otherwise). */
export function storyIssueBullet(issue: StoryIssue): string {
  switch (issue.id) {
    case 'unclear_done':
      if (issue.reasons.includes('no_criteria')) {
        return 'Add acceptance criteria: outcomes a tester could check, one per line.';
      }
      return joinCapped(issue.criteria.map(storyCriterionPhrase), STORY_UNCLEAR_CRITERIA_SHOWN);
    case 'blocked': {
      const open = issue.blockers.filter(isRealStoryBlocker).map(storyBlockerPhrase);
      return open.length === 0 ? '' : `Waits on ${joinCapped(open)}`;
    }
    case 'spec_gaps':
      return joinCapped(issue.gaps.map((g) => g.text));
  }
}

