import {
  SPRINT_DELIVERED_MIN_SHARE,
  SPRINT_DELIVERED_MIN_TICKETS,
  SPRINT_MERGED_COLUMN_ID,
  SPRINT_MERGED_COLUMN_LABEL,
  SPRINT_REVIEW_STATUS_RE,
  SPRINT_STATUS_SETTINGS_DEFAULT,
  sprintAutomaticBuckets,
  type JiraStatusCategory,
  type SprintBucket,
  type SprintColumn,
  type SprintStage,
  type SprintStatusAutoOrder,
  type SprintStatusEvidence,
  type SprintStatusLayout,
  type SprintStatusLayoutBucket,
  type SprintStatusLayoutEntry,
  type SprintStatusSettings,
  type TrackerProvider,
} from '@pierre-review/shared';
import { and, eq } from 'drizzle-orm';
import { parseSprintStatusSettings } from './sprint-status-settings.js';

// ⚠ The DB half imports db/client LAZILY: the pure fold above it is imported by tests (and the SPA's
// shapes mirror it) and must not open a database at import.
const dbMods = async () => {
  const [client, settings] = await Promise.all([import('./client.js'), import('./sprint-status-settings.js')]);
  return { db: client.db, schema: client.schema, getSprintStatusSettingsRaw: settings.getSprintStatusSettingsRaw };
};

// ACTIVITY → THIS SPRINT — THE STATUS LAYOUT (shared sprint-stories.ts § The status layout;
// docs/TRACKERS.md § This Sprint statuses; docs/API.md § This sprint). Which BUCKET each status sits in
// (and so which of the four stages — the bucket's meaning), in what order, and the drawn COLUMNS. The
// PURE half is here (sprint-status-layout.test.ts); the DB half — the stored override
// (db/sprint-status-settings.ts) and the PR evidence (`loadSprintStatusEvidence`) — feeds it.
//
//   AUTOMATIC ORDER: the tracker's board / workflow order, else the category fallback (new →
//   indeterminate → done, then name); a status on the tickets the tracker did not list is placed by
//   category among the known ones.
//   AUTOMATIC STAGE: new → Not started, done → Complete; an in-progress (or unknown) status → In review
//   when its name reads as review / QA (`SPRINT_REVIEW_STATUS_RE`) or it sits at / after the PR
//   evidence boundary (`inferReviewFrom`), else In progress.
//   AUTOMATIC BUCKETS: four, one per stage (shared `sprintAutomaticBuckets`).
//   OVERRIDE: the reader's buckets, in their order. ⚠ PLACEMENT BEATS CATEGORY. A status no bucket
//   names keeps its automatic stage and joins the FIRST bucket meaning it, else the bucket of the
//   NEAREST meaning (the earlier on a tie), right after its nearest automatic predecessor there (else
//   first) — `auto: true`. A status a bucket names that nobody has seen is kept (count 0) so the
//   settings list can show it.

const norm = (s: string): string => s.trim().toLowerCase();
const CAT_RANK: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };
const catRank = (c: JiraStatusCategory | null): number => (c == null ? 1 : (CAT_RANK[c] ?? 1));

export interface StatusTicketInput {
  statusName: string | null;
  statusCategory: string | null;
}

export interface StatusLayoutInput {
  autoOrder: SprintStatusAutoOrder | null;
  settings: SprintStatusSettings;
  /** Every ticket of the current sprint (status name + category). */
  tickets: readonly StatusTicketInput[];
  /** Per status NAME (any case): PR evidence, from `loadSprintStatusEvidence`. */
  evidence: ReadonlyMap<string, { withPrs: number; allMerged: number }>;
}

const asCategory = (c: string | null | undefined): JiraStatusCategory | null =>
  c === 'new' || c === 'indeterminate' || c === 'done' ? c : null;

/** The automatic order alone: the tracker's, then any status on the tickets it did not list, by
 *  category then name. Pure. */
export function automaticStatusOrder(
  autoOrder: SprintStatusAutoOrder | null,
  tickets: readonly StatusTicketInput[],
): Array<{ name: string; category: JiraStatusCategory | null }> {
  const out: Array<{ name: string; category: JiraStatusCategory | null }> = [];
  const seen = new Set<string>();
  for (const s of autoOrder?.statuses ?? []) {
    const k = norm(s.name);
    if (k === '' || seen.has(k)) continue;
    seen.add(k);
    out.push({ name: s.name.trim(), category: s.category });
  }
  const extra = new Map<string, { name: string; category: JiraStatusCategory | null }>();
  for (const t of tickets) {
    const name = t.statusName?.trim() ?? '';
    const k = norm(name);
    if (k === '' || seen.has(k) || extra.has(k)) continue;
    extra.set(k, { name, category: asCategory(t.statusCategory) });
  }
  const tail = [...extra.values()].sort(
    (a, b) => catRank(a.category) - catRank(b.category) || a.name.localeCompare(b.name),
  );
  // A status the tracker's order missed is placed by category among the known ones: after the last
  // known status of the same (or a lower) category.
  for (const s of tail) {
    let at = out.length;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (catRank(out[i]!.category) <= catRank(s.category)) {
        at = i + 1;
        break;
      }
      at = i;
    }
    out.splice(at, 0, s);
  }
  return out;
}

/** The first in-progress (or unknown-category) status, in order, whose PR-bearing tickets are mostly
 *  fully merged: it and every in-progress status after it are automatically In review. Pure. */
export function inferReviewFrom(
  order: ReadonlyArray<{ name: string; category: JiraStatusCategory | null }>,
  evidence: ReadonlyMap<string, { withPrs: number; allMerged: number }>,
): string | null {
  const ev = new Map([...evidence].map(([k, v]) => [norm(k), v]));
  for (const s of order) {
    if (s.category === 'new' || s.category === 'done') continue;
    const e = ev.get(norm(s.name));
    if (e == null || e.withPrs === 0) continue;
    if (e.allMerged >= SPRINT_DELIVERED_MIN_TICKETS && e.allMerged / e.withPrs >= SPRINT_DELIVERED_MIN_SHARE) return s.name;
  }
  return null;
}

/** Does this status name read as review / QA / test / release? Pure. */
export function isReviewStatusName(name: string): boolean {
  return SPRINT_REVIEW_STATUS_RE.test(name);
}

/** The automatic stage of every status in the automatic order. Pure. */
export function automaticStages(
  auto: ReadonlyArray<{ name: string; category: JiraStatusCategory | null }>,
  evidence: ReadonlyMap<string, { withPrs: number; allMerged: number }>,
): SprintStage[] {
  const from = inferReviewFrom(auto, evidence);
  const fromAt = from == null ? -1 : auto.findIndex((s) => norm(s.name) === norm(from));
  return auto.map((s, i) => {
    if (s.category === 'new') return 'not_started';
    if (s.category === 'done') return 'done';
    if (isReviewStatusName(s.name) || (fromAt >= 0 && i >= fromAt)) return 'in_review';
    return 'in_progress';
  });
}

type Placed = { name: string; category: JiraStatusCategory | null; auto: boolean; stage: SprintStage; bucketId: string };

const STAGE_RANK: Record<SprintStage, number> = { not_started: 0, in_progress: 1, in_review: 2, done: 3 };

/** The bucket a status of this automatic stage joins when no bucket names it: the FIRST bucket with
 *  that meaning, else the bucket of the NEAREST meaning (the earlier one on a tie — never claim more
 *  progress than the status shows), the first bucket of that meaning. Pure. */
export function bucketForStage<B extends Pick<SprintBucket, 'id' | 'meaning'>>(buckets: readonly B[], stage: SprintStage): B | null {
  const exact = buckets.find((b) => b.meaning === stage);
  if (exact != null) return exact;
  let best: B | null = null;
  let bestD = Infinity;
  for (const b of buckets) {
    const d = Math.abs(STAGE_RANK[b.meaning] - STAGE_RANK[stage]);
    const below = STAGE_RANK[b.meaning] < STAGE_RANK[stage];
    if (best == null || d < bestD) {
      best = b;
      bestD = d;
    } else if (d === bestD) {
      const bestBelow = STAGE_RANK[best.meaning] < STAGE_RANK[stage];
      // A tie: prefer the earlier meaning; within one meaning, keep the first bucket.
      if (below && !bestBelow) best = b;
    }
  }
  return best;
}

/** Place every status in a bucket: the buckets' named statuses first (in their order), then each
 *  unnamed automatic status in `bucketForStage`'s bucket. Grouped in bucket order. Pure. `buckets:
 *  null` = the four automatic buckets, every status in its automatic stage's, in automatic order. */
export function applyBuckets(
  auto: ReadonlyArray<{ name: string; category: JiraStatusCategory | null; stage: SprintStage }>,
  buckets: readonly SprintBucket[] | null,
): Placed[] {
  const set = buckets != null && buckets.length > 0;
  const list = set ? buckets : sprintAutomaticBuckets();
  const byBucket = new Map<string, Placed[]>(list.map((b) => [b.id, []]));
  const placed = new Set<string>();
  const autoByKey = new Map(auto.map((s) => [norm(s.name), s]));
  if (set) {
    for (const b of list) {
      for (const n of b.statuses) {
        const k = norm(n);
        if (k === '' || placed.has(k)) continue;
        const known = autoByKey.get(k);
        byBucket.get(b.id)!.push({ name: known?.name ?? n.trim(), category: known?.category ?? null, auto: false, stage: b.meaning, bucketId: b.id });
        placed.add(k);
      }
    }
  }
  for (let i = 0; i < auto.length; i += 1) {
    const s = auto[i]!;
    const k = norm(s.name);
    if (placed.has(k)) continue;
    const b = bucketForStage(list, s.stage)!;
    const into = byBucket.get(b.id)!;
    // After the nearest automatic predecessor already placed in the SAME bucket; else first. With no
    // override, keep the automatic order exactly (append).
    let at = 0;
    if (!set) at = into.length;
    else {
      for (let j = i - 1; j >= 0; j -= 1) {
        const idx = into.findIndex((o) => norm(o.name) === norm(auto[j]!.name));
        if (idx >= 0) {
          at = idx + 1;
          break;
        }
      }
    }
    into.splice(at, 0, { name: s.name, category: s.category, auto: true, stage: b.meaning, bucketId: b.id });
    placed.add(k);
  }
  return list.flatMap((b) => byBucket.get(b.id)!);
}

/** The drawn x axis: the buckets in order, with the derived merged column (when on) after the last In
 *  review bucket, else after the last In progress bucket. With neither, no merged column: no ticket
 *  could ever sit in it (`sprintColumnOf` needs an In progress or In review stage). Pure. */
export function sprintColumnsOf(buckets: ReadonlyArray<Pick<SprintBucket, 'id' | 'name' | 'meaning'>>, mergedColumn: boolean): SprintColumn[] {
  const cols: SprintColumn[] = buckets.map((b) => ({ id: b.id, name: b.name, meaning: b.meaning, derived: false }));
  if (!mergedColumn) return cols;
  const merged: SprintColumn = { id: SPRINT_MERGED_COLUMN_ID, name: SPRINT_MERGED_COLUMN_LABEL, meaning: 'in_review', derived: true };
  const lastOf = (m: SprintStage): number => cols.map((c) => c.meaning).lastIndexOf(m);
  const review = lastOf('in_review');
  const progress = lastOf('in_progress');
  if (review < 0 && progress < 0) return cols;
  cols.splice(review >= 0 ? review + 1 : progress + 1, 0, merged);
  return cols;
}

/** The column a ticket is drawn in: its bucket, or the merged column when that column is on, its stage
 *  is In progress or In review, and it has ≥ 1 merged pull request and none open (closed unmerged ones
 *  ignored). Pure; THE ONE column rule (the graph fold calls it). */
export function sprintColumnOf(
  place: { stage: SprintStage; bucketId: string } | null,
  prs: ReadonlyArray<{ state: string }>,
  mergedColumn: boolean,
): string | null {
  if (place == null) return null;
  if (!mergedColumn || (place.stage !== 'in_progress' && place.stage !== 'in_review')) return place.bucketId;
  const open = prs.some((p) => p.state === 'open');
  const merged = prs.some((p) => p.state === 'merged');
  return merged && !open ? SPRINT_MERGED_COLUMN_ID : place.bucketId;
}

/** The category fallback for a status the layout does not know: done → Complete, new or none → Not
 *  started, else In review by name, else In progress. */
function fallbackStage(status: { name: string; category: string | null } | null): SprintStage {
  const cat = asCategory(status?.category ?? null);
  if (cat === 'done') return 'done';
  if (cat === 'new' || status == null) return 'not_started';
  return isReviewStatusName(status.name) ? 'in_review' : 'in_progress';
}

/** Where a ticket in this status sits: its bucket and that bucket's meaning. Pure; THE ONE placement
 *  rule: the layout's placement; a status the layout does not know falls back to its category's stage,
 *  in `bucketForStage`'s bucket (with no buckets at all: the stage's automatic bucket id). */
export function sprintPlacementOf(
  layout: Pick<SprintStatusLayout, 'order'> & Partial<Pick<SprintStatusLayout, 'buckets'>>,
  status: { name: string; category: string | null } | null,
): { stage: SprintStage; bucketId: string } {
  if (status != null) {
    const hit = layout.order.find((o) => norm(o.name) === norm(status.name));
    if (hit != null) return { stage: hit.stage, bucketId: hit.bucketId };
  }
  const stage = fallbackStage(status);
  const b = bucketForStage(layout.buckets ?? [], stage);
  return b == null ? { stage, bucketId: stage } : { stage: b.meaning, bucketId: b.id };
}

/** The stage a ticket in this status is listed under (its bucket's meaning). Pure. */
export function sprintStageOf(
  layout: Pick<SprintStatusLayout, 'order'> & Partial<Pick<SprintStatusLayout, 'buckets'>>,
  status: { name: string; category: string | null } | null,
): SprintStage {
  return sprintPlacementOf(layout, status).stage;
}

/** A status's index in the layout (the sort key within a bucket); unknown → after all. */
export function sprintStatusSectionIndex(layout: Pick<SprintStatusLayout, 'order'>, statusName: string | null): number {
  if (statusName == null) return layout.order.length;
  const i = layout.order.findIndex((o) => norm(o.name) === norm(statusName));
  return i < 0 ? layout.order.length : i;
}

/** THE layout fold. Pure. */
export function resolveSprintStatusLayout(input: StatusLayoutInput): SprintStatusLayout {
  const settings = input.settings ?? SPRINT_STATUS_SETTINGS_DEFAULT;
  const autoOrder = automaticStatusOrder(input.autoOrder, input.tickets);
  const stages = automaticStages(autoOrder, input.evidence);
  const bucketList = settings.buckets != null && settings.buckets.length > 0 ? settings.buckets : sprintAutomaticBuckets();
  const merged = applyBuckets(
    autoOrder.map((s, i) => ({ ...s, stage: stages[i]! })),
    settings.buckets,
  );
  const counts = new Map<string, number>();
  for (const t of input.tickets) {
    const k = norm(t.statusName ?? '');
    if (k !== '') counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const order: SprintStatusLayoutEntry[] = merged.map((s) => ({
    name: s.name,
    category: s.category,
    count: counts.get(norm(s.name)) ?? 0,
    auto: s.auto,
    stage: s.stage,
    bucketId: s.bucketId,
  }));
  const buckets: SprintStatusLayoutBucket[] = bucketList.map((b) => ({
    id: b.id,
    name: b.name,
    meaning: b.meaning,
    statuses: order.filter((o) => o.bucketId === b.id),
  }));
  const ev = new Map([...input.evidence].map(([k, v]) => [norm(k), v]));
  const evidence: SprintStatusEvidence[] = autoOrder
    .filter((s) => s.category !== 'new' && s.category !== 'done')
    .map((s) => ({ status: s.name, withPrs: ev.get(norm(s.name))?.withPrs ?? 0, allMerged: ev.get(norm(s.name))?.allMerged ?? 0 }));
  return {
    order,
    buckets,
    columns: sprintColumnsOf(bucketList, settings.mergedColumn),
    orderSource: settings.buckets != null ? 'override' : (input.autoOrder?.source ?? 'fallback'),
    codingBegins: order.find((o) => o.stage === 'in_progress')?.name ?? null,
    codingEnds: order.find((o) => o.stage === 'in_review')?.name ?? null,
    evidence,
    settings,
  };
}

/** Parse a STORED override against the statuses this layout knows (a retired `{order, deliveredFrom}`
 *  value needs each status's category). Pure. */
export function storedSettingsFor(
  raw: unknown,
  autoOrder: SprintStatusAutoOrder | null,
  tickets: readonly StatusTicketInput[],
): SprintStatusSettings {
  const cats = new Map(automaticStatusOrder(autoOrder, tickets).map((s) => [norm(s.name), s.category]));
  return parseSprintStatusSettings(raw, false, (n) => cats.get(norm(n)) ?? null) ?? { ...SPRINT_STATUS_SETTINGS_DEFAULT };
}

// ── The DB half (signatures are the contract db/sprint-graph.ts and the statuses route call) ─────────────────────────

export interface SprintStatusLayoutArgs {
  provider: TrackerProvider;
  apiRoot: string;
  /** Every in_sprint ticket on the current site (listed AND done). */
  tickets: ReadonlyArray<StatusTicketInput & { issueKey: string }>;
  /** `sprint_reads.status_order_json`. */
  autoOrder: SprintStatusAutoOrder | null;
}

/** One stored ticket↔PR pair, as the evidence query reads it. */
export interface EvidencePairRow {
  issueKey: string;
  statusName: string | null;
  fetchedAt: Date | null;
  rowId: number;
  prId: number;
  prState: string;
  /** The PR's merge time (null / absent = not merged, or not known). */
  mergedAt?: Date | null;
}

/** A sprint row's status. `fetchedAt` ABSENT = a ticket in the current sprint (the list read keeps it
 *  fresh: trusted outright); present = a row no longer in the sprint, which competes on freshness with
 *  the stored ticket rows. */
export interface EvidenceSprintTicket {
  issueKey: string;
  statusName: string | null;
  fetchedAt?: Date | null;
}

/** THE evidence fold. Pure. Per ticket (key, case-insensitive): its status is the in-sprint ticket's
 *  where there is one (fresh), else the freshest of its stored rows and any out-of-sprint sprint row;
 *  ⚠ that status counts ONLY when it was read at or after the ticket's last PR merge — the worker stops
 *  re-reading a ticket once its PRs merge, so a status read before the merge ("In Code Review") is
 *  stale for ever and would drag the split towards earlier statuses. Its PRs are the distinct PRs on
 *  its rows, CLOSED-UNMERGED ignored entirely. Per status (as first spelled): `withPrs` = tickets with
 *  ≥ 1 open or merged PR, `allMerged` = of those, ≥ 1 merged and 0 open. */
export function foldSprintStatusEvidence(
  pairs: readonly EvidencePairRow[],
  sprintTickets: readonly EvidenceSprintTicket[],
): Map<string, { withPrs: number; allMerged: number }> {
  const trusted = new Map<string, string | null>();
  const sprintCandidate = new Map<string, { status: string; at: number }>();
  for (const t of sprintTickets) {
    const k = t.issueKey.toUpperCase();
    if (t.fetchedAt === undefined) {
      trusted.set(k, t.statusName);
      continue;
    }
    if (t.statusName == null) continue;
    const at = t.fetchedAt?.getTime() ?? -Infinity;
    const prev = sprintCandidate.get(k);
    if (prev == null || at > prev.at) sprintCandidate.set(k, { status: t.statusName, at });
  }
  const tickets = new Map<
    string,
    { status: string | null; freshAt: number; freshId: number; open: Set<number>; merged: Set<number>; lastMergeAt: number }
  >();
  for (const p of pairs) {
    const k = p.issueKey.toUpperCase();
    let t = tickets.get(k);
    if (t == null) {
      t = { status: null, freshAt: -Infinity, freshId: -Infinity, open: new Set(), merged: new Set(), lastMergeAt: -Infinity };
      tickets.set(k, t);
    }
    const at = p.fetchedAt?.getTime() ?? -Infinity;
    if (p.statusName != null && (at > t.freshAt || (at === t.freshAt && p.rowId > t.freshId))) {
      t.status = p.statusName;
      t.freshAt = at;
      t.freshId = p.rowId;
    }
    if (p.prState === 'open') t.open.add(p.prId);
    else if (p.prState === 'merged') {
      t.merged.add(p.prId);
      const m = p.mergedAt?.getTime();
      if (m != null && m > t.lastMergeAt) t.lastMergeAt = m;
    }
  }
  const out = new Map<string, { withPrs: number; allMerged: number }>();
  const spelling = new Map<string, string>();
  for (const [k, t] of tickets) {
    if (t.open.size + t.merged.size === 0) continue;
    let status: string | null;
    if (trusted.has(k)) status = trusted.get(k) ?? null;
    else {
      let readAt = t.freshAt;
      status = t.status;
      const sc = sprintCandidate.get(k);
      if (sc != null && (status == null || sc.at > readAt)) {
        status = sc.status;
        readAt = sc.at;
      }
      if (readAt < t.lastMergeAt) continue; // read before its last merge: not known to be current
    }
    const name0 = status?.trim() ?? '';
    if (name0 === '') continue;
    const nk = norm(name0);
    const name = spelling.get(nk) ?? name0;
    spelling.set(nk, name);
    const e = out.get(name) ?? { withPrs: 0, allMerged: 0 };
    e.withPrs += 1;
    if (t.merged.size > 0 && t.open.size === 0) e.allMerged += 1;
    out.set(name, e);
  }
  return out;
}

/** Per status name: tickets with ≥ 1 PR, and of those how many have every PR merged and none open.
 *  Membership = `tracker_tickets` (state 'ok') on this site, this workspace, ⨝ `pull_requests`;
 *  status = the sprint ticket's (fresh) where the ticket is in `args.tickets`, else the freshest of the
 *  stored rows and this workspace's out-of-sprint sprint rows — and only when read after the last
 *  merge (`foldSprintStatusEvidence`). Account-predicated on every table. */
export async function loadSprintStatusEvidence(
  accountId: number,
  workspaceId: number,
  args: SprintStatusLayoutArgs,
): Promise<Map<string, { withPrs: number; allMerged: number }>> {
  const { db, schema } = await dbMods();
  const tt = schema.trackerTickets;
  const pr = schema.pullRequests;
  const rows = (await db
    .select({
      issueKey: tt.issueKey,
      statusName: tt.statusName,
      fetchedAt: tt.fetchedAt,
      rowId: tt.id,
      prId: pr.id,
      prState: pr.state,
      mergedAt: pr.mergedAt,
    })
    .from(tt)
    .innerJoin(pr, and(eq(pr.id, tt.prId), eq(pr.accountId, accountId)))
    .where(
      and(
        eq(tt.accountId, accountId),
        eq(tt.workspaceId, workspaceId),
        eq(tt.provider, args.provider),
        eq(tt.apiRoot, args.apiRoot),
        eq(tt.state, 'ok'),
      ),
    )
    .execute()) as EvidencePairRow[];
  const st = schema.sprintTickets;
  const outOfSprint = (await db
    .select({ issueKey: st.issueKey, statusName: st.statusName, fetchedAt: st.fetchedAt })
    .from(st)
    .where(
      and(
        eq(st.accountId, accountId),
        eq(st.workspaceId, workspaceId),
        eq(st.provider, args.provider),
        eq(st.apiRoot, args.apiRoot),
        eq(st.inSprint, false),
      ),
    )
    .execute()) as Array<{ issueKey: string; statusName: string | null; fetchedAt: Date | null }>;
  // In-sprint tickets carry no `fetchedAt` (trusted); out-of-sprint rows compete on freshness.
  const inSprint = new Set(args.tickets.map((t) => t.issueKey.toUpperCase()));
  const sprintRows: EvidenceSprintTicket[] = [
    ...args.tickets.map((t) => ({ issueKey: t.issueKey, statusName: t.statusName })),
    ...outOfSprint.filter((r) => !inSprint.has(r.issueKey.toUpperCase())),
  ];
  return foldSprintStatusEvidence(rows, sprintRows);
}

/** The workspace's layout: the stored override (db/sprint-status-settings.ts) + the evidence + the
 *  pure fold. */
export async function getSprintStatusLayout(
  accountId: number,
  workspaceId: number,
  args: SprintStatusLayoutArgs,
): Promise<SprintStatusLayout> {
  const { getSprintStatusSettingsRaw } = await dbMods();
  const [evidence, raw] = await Promise.all([
    loadSprintStatusEvidence(accountId, workspaceId, args),
    getSprintStatusSettingsRaw(accountId, workspaceId),
  ]);
  const settings = storedSettingsFor(raw, args.autoOrder, args.tickets);
  return resolveSprintStatusLayout({ autoOrder: args.autoOrder, settings, tickets: args.tickets, evidence });
}

/** The layout for a workspace from what is stored: its `sprint_reads` row (site + automatic order)
 *  and its in-sprint tickets on that site (listed AND done). null when the sprint was never read
 *  (no site to name statuses on). The settings route answers with it; any caller may reuse it. */
export async function sprintLayoutFor(accountId: number, workspaceId: number): Promise<SprintStatusLayout | null> {
  const { db, schema } = await dbMods();
  const sr = schema.sprintReads;
  const read = (
    await db
      .select({ provider: sr.provider, apiRoot: sr.apiRoot, statusOrderJson: sr.statusOrderJson })
      .from(sr)
      .where(and(eq(sr.accountId, accountId), eq(sr.workspaceId, workspaceId)))
      .limit(1)
      .execute()
  )[0] as { provider: string | null; apiRoot: string | null; statusOrderJson: SprintStatusAutoOrder | null } | undefined;
  if (read?.provider == null || read.apiRoot == null) return null;
  const st = schema.sprintTickets;
  const tickets = (await db
    .select({ issueKey: st.issueKey, statusName: st.statusName, statusCategory: st.statusCategory })
    .from(st)
    .where(
      and(
        eq(st.accountId, accountId),
        eq(st.workspaceId, workspaceId),
        eq(st.inSprint, true),
        eq(st.provider, read.provider),
        eq(st.apiRoot, read.apiRoot),
      ),
    )
    .execute()) as Array<{ issueKey: string; statusName: string | null; statusCategory: string | null }>;
  return getSprintStatusLayout(accountId, workspaceId, {
    provider: read.provider as TrackerProvider,
    apiRoot: read.apiRoot,
    tickets,
    autoOrder: read.statusOrderJson ?? null,
  });
}
