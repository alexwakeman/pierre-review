import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  SPRINT_BRIEF_MODEL,
  SPRINT_BRIEF_VERSION,
  type SprintBrief,
  parseTicketLinkBlockers,
  type SprintBriefCriterion,
  type SprintBriefLinkReason,
  type SprintBriefReference,
  type SprintBriefStoredReference,
  type StoryCriteriaSource,
  type TrackerProvider,
} from '@pierre-review/shared';
import { acceptanceSectionOf, extractCriteria } from './story-criteria.js';

// REPORTS → THIS SPRINT — THE BRIEF'S STORE HALF (docs/CLAUDE-REVIEW.md § Sprint briefs). ONE builder
// of what the brief pass is SENT (`sprintBriefInput`) and therefore of which stored brief is CURRENT:
// a brief counts only while its `text_hash` equals today's hash of today's text AND its
// `brief_version` is SPRINT_BRIEF_VERSION. The pass (review/sprint-briefs/, local + agentic) writes;
// the graph (db/sprint-graph.ts) and "Check against code" read.
//
//   • THE CRITERIA SENT are the ONE extractor's (`extractCriteria`) over the tracker's criteria field,
//     else the description's "Acceptance criteria" section — the same rule as the story labels. With
//     none, the brief DERIVES them from the description and is flagged `criteriaDerived` (decided HERE,
//     from the input, never by the model).
//   • The description and each criterion are clipped; the clip is inside the hash.
//   • THE TRACKER LINKS (`blocked_by_json`: key, title, the tracker's phrase) are sent too, so the brief
//     can say WHY each is there; they are inside the hash, so a link added, dropped or retitled
//     re-briefs the ticket.
//
// ⚠ PURE AT IMPORT: the DB client is reached LAZILY inside the readers (a pure test never opens it).

export const SPRINT_BRIEF_DESCRIPTION_MAX_CHARS = 4000;
export const SPRINT_BRIEF_CRITERION_MAX_CHARS = 500;
const COLOR_RE = /\{color[^}]*\}/g;

/** The ticket's criteria as written and where they came from. */
export function sprintCriteriaOf(
  t: { description: string; acceptanceCriteria: string },
  provider: TrackerProvider | string,
): { items: string[]; source: StoryCriteriaSource } {
  const jira = provider === 'jira';
  const field = extractCriteria(t.acceptanceCriteria, { jira });
  if (field.length > 0) return { items: field, source: 'acceptance_criteria' };
  const section = acceptanceSectionOf(t.description, { jira });
  const fromDescription = section == null ? [] : extractCriteria(section, { jira });
  if (fromDescription.length > 0) return { items: fromDescription, source: 'description_heading' };
  return { items: [], source: 'none' };
}

/** One tracker link as the brief is shown it. */
export interface SprintBriefLink {
  key: string;
  title: string | null;
  /** The tracker's phrase from this ticket's side ("is blocked by", "relates to"). */
  relation: string;
}

export interface SprintBriefInput {
  title: string;
  description: string;
  /** The criteria as written ([] → the brief derives them). */
  criteria: string[];
  /** = criteria.length === 0. */
  derived: boolean;
  /** The ticket's tracker links as stored (any relation), in stored order. */
  links: SprintBriefLink[];
  /** sha256 hex of exactly what is sent. */
  textHash: string;
}

const clip = (s: string, max: number): string => {
  if (s.length <= max) return s;
  let cut = max;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return s.slice(0, cut);
};

/** The brief's input for a stored ticket (sprint or ghost). Never null: a ticket with no text still
 *  gets a brief from its title. Pure. */
export function sprintBriefInput(
  // `blockedByJson` is REQUIRED (not optional) on purpose: a caller that forgot it would hash a
  // different input from the pass and every brief would read as stale there.
  ticket: { title: string | null; description: string | null; acceptanceCriteria: string | null; blockedByJson: unknown },
  provider: TrackerProvider | string,
): SprintBriefInput {
  const title = (ticket.title ?? '').trim();
  const rawDescription = (ticket.description ?? '').replace(COLOR_RE, '');
  const criteria = sprintCriteriaOf({ description: rawDescription, acceptanceCriteria: ticket.acceptanceCriteria ?? '' }, provider).items.map(
    (c) => clip(c, SPRINT_BRIEF_CRITERION_MAX_CHARS),
  );
  const description = clip(rawDescription, SPRINT_BRIEF_DESCRIPTION_MAX_CHARS);
  const links: SprintBriefLink[] = (parseTicketLinkBlockers(ticket.blockedByJson) ?? []).map((l) => ({
    key: l.key,
    title: l.title,
    relation: l.relation,
  }));
  const textHash = createHash('sha256')
    .update(JSON.stringify({ jira: provider === 'jira', title, description, criteria, links }))
    .digest('hex');
  return { title, description, criteria, derived: criteria.length === 0, links, textHash };
}

export type SprintBriefRow = {
  ident: string;
  textHash: string;
  briefVersion: number;
  summary: string;
  criteriaJson: unknown;
  criteriaDerived: boolean;
  referencesJson: unknown;
  createdAt: Date;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v);

/** A stored row → the wire brief (tolerant: malformed entries dropped). Pure. */
export function sprintBriefOf(r: SprintBriefRow): SprintBrief {
  const criteria: SprintBriefCriterion[] = [];
  for (const c of Array.isArray(r.criteriaJson) ? r.criteriaJson : []) {
    if (isObj(c) && typeof c.text === 'string' && c.text.trim() !== '') criteria.push({ n: criteria.length + 1, text: c.text });
  }
  const references: SprintBriefReference[] = [];
  const linkReasons: SprintBriefLinkReason[] = [];
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
  for (const x of Array.isArray(r.referencesJson) ? r.referencesJson : []) {
    if (!isObj(x) || typeof x.ticketKey !== 'string') continue;
    // A tracker link's reason shares the column, tagged `link: true` (SprintBriefStoredReference).
    if (x.link === true) {
      const why = text(x.why);
      if (why != null) linkReasons.push({ ticketKey: x.ticketKey, why });
      continue;
    }
    if (typeof x.relation !== 'string') continue;
    references.push({
      ticketKey: x.ticketKey,
      relation: x.relation as SprintBriefReference['relation'],
      quote: text(x.quote),
      why: text(x.why),
    });
  }
  return { summary: r.summary, criteria, criteriaDerived: r.criteriaDerived, references, linkReasons, createdAt: r.createdAt.toISOString() };
}

/** Is this stored brief current for today's input? Pure. */
export function isBriefCurrent(row: Pick<SprintBriefRow, 'textHash' | 'briefVersion'> | null | undefined, input: Pick<SprintBriefInput, 'textHash'>): boolean {
  return row != null && row.briefVersion === SPRINT_BRIEF_VERSION && row.textHash === input.textHash;
}

/** The stored brief rows (any currency) for these idents, this account + workspace only. */
export async function storedSprintBriefs(
  accountId: number,
  workspaceId: number,
  idents: readonly string[],
): Promise<Map<string, SprintBriefRow>> {
  const out = new Map<string, SprintBriefRow>();
  const list = [...new Set(idents)];
  if (list.length === 0) return out;
  const { db, schema } = await import('./client.js');
  const t = schema.sprintBriefs;
  for (let i = 0; i < list.length; i += 400) {
    const rows = await db
      .select({
        ident: t.ident,
        textHash: t.textHash,
        briefVersion: t.briefVersion,
        summary: t.summary,
        criteriaJson: t.criteriaJson,
        criteriaDerived: t.criteriaDerived,
        referencesJson: t.referencesJson,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), inArray(t.ident, list.slice(i, i + 400))))
      .execute();
    for (const r of rows) out.set(r.ident, r as SprintBriefRow);
  }
  return out;
}

/** The CURRENT briefs of these tickets (text hash + version match), by ident. */
export async function currentSprintBriefs(
  accountId: number,
  workspaceId: number,
  tickets: ReadonlyArray<{ ident: string; input: Pick<SprintBriefInput, 'textHash'> }>,
): Promise<Map<string, SprintBrief>> {
  const stored = await storedSprintBriefs(
    accountId,
    workspaceId,
    tickets.map((t) => t.ident),
  );
  const out = new Map<string, SprintBrief>();
  for (const t of tickets) {
    const row = stored.get(t.ident);
    if (isBriefCurrent(row, t.input)) out.set(t.ident, sprintBriefOf(row!));
  }
  return out;
}

export interface StoredSprintBrief {
  summary: string;
  criteria: SprintBriefCriterion[];
  criteriaDerived: boolean;
  references: SprintBriefReference[];
  /** Tracker-link reasons ([] / absent: none). */
  linkReasons?: SprintBriefLinkReason[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Upsert ONE brief (replaces the ticket's previous one). */
export async function storeSprintBrief(
  accountId: number,
  workspaceId: number,
  ident: string,
  textHash: string,
  b: StoredSprintBrief,
  now: Date = new Date(),
): Promise<void> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintBriefs;
  const values = {
    textHash,
    briefVersion: SPRINT_BRIEF_VERSION,
    summary: b.summary,
    criteriaJson: b.criteria,
    criteriaDerived: b.criteriaDerived,
    referencesJson: [
      ...b.references.map((r) => ({ ticketKey: r.ticketKey, relation: r.relation, quote: r.quote, why: r.why ?? null })),
      ...(b.linkReasons ?? []).map((l) => ({ ticketKey: l.ticketKey, why: l.why, link: true as const })),
    ] satisfies SprintBriefStoredReference[],
    model: SPRINT_BRIEF_MODEL,
    costUsd: b.costUsd,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    createdAt: now,
  };
  await db
    .insert(t)
    .values({ accountId, workspaceId, ident, ...values })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId, t.ident], set: values })
    .execute();
}
