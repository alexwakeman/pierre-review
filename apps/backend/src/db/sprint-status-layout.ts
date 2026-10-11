import {
  SPRINT_DELIVERED_MIN_SHARE,
  SPRINT_DELIVERED_MIN_TICKETS,
  SPRINT_STATUS_SETTINGS_DEFAULT,
  type JiraStatusCategory,
  type SprintStage,
  type SprintStatusAutoOrder,
  type SprintStatusEvidence,
  type SprintStatusLayout,
  type SprintStatusLayoutEntry,
  type SprintStatusSettings,
  type TrackerProvider,
} from '@pierre-review/shared';
import { and, eq } from 'drizzle-orm';

// ⚠ The DB half imports db/client LAZILY: the pure fold above it is imported by tests (and the SPA's
// shapes mirror it) and must not open a database at import.
const dbMods = async () => {
  const [client, settings] = await Promise.all([import('./client.js'), import('./sprint-status-settings.js')]);
  return { db: client.db, schema: client.schema, getSprintStatusSettings: settings.getSprintStatusSettings };
};

// REPORTS → THIS SPRINT — THE STATUS LAYOUT (shared sprint-stories.ts § The status layout; docs/API.md
// § This sprint). Which sections the page shows, in what order, and which status "code delivered"
// starts at. The PURE half is here (sprint-status-layout.test.ts); the DB half — the stored override
// (db/sprint-status-settings.ts) and the PR evidence (`loadSprintStatusEvidence`) — feeds it.
//
//   ORDER: override names first-class; every other known status keeps its AUTOMATIC position (the
//   tracker's board / workflow order), else the category fallback (new → indeterminate → done, then
//   name). A status the override names that nobody has seen is kept (count 0) so the settings list
//   can show it.
//   DELIVERED FROM: the override when it names a status in the order (case-insensitive), else the
//   automatic inference (`inferDeliveredFrom`).
//   STAGE: category beats position — new → not_started, done → done; the rest split at deliveredFrom.

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
  /** The LISTED + done tickets of the current sprint (status name + category). */
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

/** Merge an override onto the automatic order: the override's names in its order; a status it does
 *  not name is inserted right after its automatic predecessor's position (or first); then a stable
 *  sort by category (new → in progress / unknown → done). Pure. */
export function applyOrderOverride(
  auto: ReadonlyArray<{ name: string; category: JiraStatusCategory | null }>,
  override: readonly string[] | null,
): Array<{ name: string; category: JiraStatusCategory | null; auto: boolean }> {
  if (override == null || override.length === 0) return auto.map((s) => ({ ...s, auto: true }));
  const byKey = new Map(auto.map((s) => [norm(s.name), s]));
  const out: Array<{ name: string; category: JiraStatusCategory | null; auto: boolean }> = [];
  const placed = new Set<string>();
  for (const n of override) {
    const k = norm(n);
    if (k === '' || placed.has(k)) continue;
    placed.add(k);
    const known = byKey.get(k);
    out.push({ name: known?.name ?? n.trim(), category: known?.category ?? null, auto: false });
  }
  for (let i = 0; i < auto.length; i += 1) {
    const s = auto[i]!;
    const k = norm(s.name);
    if (placed.has(k)) continue;
    // After the nearest automatic predecessor that is already placed.
    let at = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const pk = norm(auto[j]!.name);
      const idx = out.findIndex((o) => norm(o.name) === pk);
      if (idx >= 0) {
        at = idx + 1;
        break;
      }
    }
    out.splice(at, 0, { ...s, auto: true });
    placed.add(k);
  }
  // Category beats position here too (it does for the stage): a stable sort keeps the reader's order
  // within a category, so a done status inserted after a moved predecessor never sits mid-list.
  return out.map((s, i) => ({ s, i })).sort((a, b) => catRank(a.s.category) - catRank(b.s.category) || a.i - b.i).map((x) => x.s);
}

/** The first in-progress status, in order, whose PR-bearing tickets are mostly fully merged. Pure. */
export function inferDeliveredFrom(
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

/** The stage a ticket in this status is listed under. Pure; THE ONE stage rule. */
export function sprintStageOf(
  layout: Pick<SprintStatusLayout, 'order' | 'deliveredFrom'>,
  status: { name: string; category: string | null } | null,
): SprintStage {
  const cat = asCategory(status?.category ?? null);
  if (cat === 'done') return 'done';
  if (cat === 'new' || status == null) return 'not_started';
  if (layout.deliveredFrom == null) return 'writing';
  const at = layout.order.findIndex((o) => norm(o.name) === norm(status.name));
  const from = layout.order.findIndex((o) => norm(o.name) === norm(layout.deliveredFrom as string));
  if (at < 0 || from < 0) return 'writing';
  return at >= from ? 'delivered' : 'writing';
}

/** A status's section index in the layout (the sort key within a stage); unknown → after all. */
export function sprintStatusSectionIndex(layout: Pick<SprintStatusLayout, 'order'>, statusName: string | null): number {
  if (statusName == null) return layout.order.length;
  const i = layout.order.findIndex((o) => norm(o.name) === norm(statusName));
  return i < 0 ? layout.order.length : i;
}

/** THE layout fold. Pure. */
export function resolveSprintStatusLayout(input: StatusLayoutInput): SprintStatusLayout {
  const settings = input.settings ?? SPRINT_STATUS_SETTINGS_DEFAULT;
  const auto = automaticStatusOrder(input.autoOrder, input.tickets);
  const merged = applyOrderOverride(auto, settings.order);
  const counts = new Map<string, number>();
  for (const t of input.tickets) {
    if (asCategory(t.statusCategory) === 'done') continue;
    const k = norm(t.statusName ?? '');
    if (k !== '') counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // Over the order the page USES (the reader's, when they saved one), so the split never lands after
  // an earlier status, on screen, that passes the same test.
  const deliveredFromAuto = inferDeliveredFrom(merged, input.evidence);
  const overridden =
    settings.deliveredFrom != null && merged.some((s) => norm(s.name) === norm(settings.deliveredFrom as string))
      ? (merged.find((s) => norm(s.name) === norm(settings.deliveredFrom as string))?.name ?? null)
      : null;
  const deliveredFrom = overridden ?? deliveredFromAuto;
  const partial = { order: merged.map((s) => ({ name: s.name, category: s.category })), deliveredFrom };
  const order: SprintStatusLayoutEntry[] = merged.map((s) => ({
    name: s.name,
    category: s.category,
    count: counts.get(norm(s.name)) ?? 0,
    auto: s.auto,
    stage: sprintStageOf(partial as Pick<SprintStatusLayout, 'order' | 'deliveredFrom'>, s),
  }));
  const ev = new Map([...input.evidence].map(([k, v]) => [norm(k), v]));
  const evidence: SprintStatusEvidence[] = merged
    .filter((s) => s.category !== 'new' && s.category !== 'done')
    .map((s) => ({ status: s.name, withPrs: ev.get(norm(s.name))?.withPrs ?? 0, allMerged: ev.get(norm(s.name))?.allMerged ?? 0 }));
  return {
    order,
    orderSource:
      settings.order != null && settings.order.length > 0 ? 'override' : (input.autoOrder?.source ?? 'fallback'),
    deliveredFrom,
    deliveredFromAuto,
    evidence,
    settings,
  };
}

// ── The DB half (signatures are the contract db/sprint-stories.ts calls) ─────────────────────────

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
  const { getSprintStatusSettings } = await dbMods();
  const [evidence, settings] = await Promise.all([
    loadSprintStatusEvidence(accountId, workspaceId, args),
    getSprintStatusSettings(accountId, workspaceId),
  ]);
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
