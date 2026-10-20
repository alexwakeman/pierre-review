import type { JiraStatusCategory, TrackerProvider } from './types.js';

// REPORTS → THIS SPRINT — the shared constants and the pieces the SPRINT GRAPH (`sprint-graph.ts`)
// builds on: where the list came from, the read state and the status layout (status buckets)
// (docs/API.md § This sprint; docs/TRACKERS.md § The sprint list read). FREE core: no route 402s.
//
//   • THE POPULATION is the workspace tracker's CURRENT SPRINT, read by the tracker worker (the FIRST
//     tracker read that is not triggered by a received pull request — deliberately, and only for a
//     workspace whose This sprint tab was opened in the last `SPRINT_VIEW_TTL_DAYS`): Jira's open
//     sprints, Linear's active cycle, GitHub's nearest-due open milestone, else the status fallback
//     (To do + In progress tickets touched in the reporting window). The `source` says which.
//   • THE COLUMNS follow the workspace's STATUS LAYOUT (`SprintStatusLayout`): BUCKETS of statuses, each
//     meaning one of five stages — Not started, In progress, Code review, Product review, Complete.
//     AUTOMATIC (category, a code-review and a QA / sign-off name vocabulary, PR evidence; the tracker's
//     board / workflow order) unless the workspace sets its own (`SprintStatusSettings`).
//   • "Check against code" (a Sonnet run per ticket over default-branch checkouts) was REMOVED on
//     2026-10-18 with the sprint drawer; its tables (`sprint_ticket_repos`, `sprint_assessments`) are
//     dormant (docs/DATA-MODEL.md).
//   • NOTHING HERE WRITES TO A TRACKER. The write-back was removed (2026-10-12).
//
// ⚠ There is no team or person score anywhere on this surface.

// ── Constants (the ONE spelling the server and the page's copy both read) ────────────────────────

/** The worker re-reads a viewed workspace's sprint list at most this often. */
export const SPRINT_READ_INTERVAL_MS = 20 * 60_000;

/** A workspace whose This sprint tab has not been opened for this many days is not read at all. */
export const SPRINT_VIEW_TTL_DAYS = 7;

/** Tickets one sprint read stores at most; the rest are cut and the page says so (`truncated`). */
export const SPRINT_TICKETS_MAX = 150;

/** The fallback window when the workspace has no reporting window (days). */
export const SPRINT_FALLBACK_DAYS = 14;

/** Ticket text caps on the wire (characters). The stored text is never cut; the wire is. */
export const SPRINT_TEXT_MAX = {
  title: 300,
  description: 20_000,
  criteria: 20_000,
} as const;

// ── Where the list came from ─────────────────────────────────────────────────────────────────────

export type SprintFallbackReason =
  /** The tracker has no sprint concept we read (e.g. a Jira site with no sprint field). */
  | 'no_sprint_concept'
  /** It has one, but nothing is active right now. */
  | 'none_active';

/** Per workspace, what the stored list IS. Named on screen through `sprintSourceTitle`. */
export type SprintSource =
  | { kind: 'sprint'; provider: 'jira'; names: string[] }
  | { kind: 'cycle'; provider: 'linear'; names: string[] }
  | { kind: 'milestone'; provider: 'github'; name: string; dueOn: string | null; repos: string[] }
  | {
      kind: 'status_fallback';
      provider: TrackerProvider;
      reason: SprintFallbackReason;
      /** ISO-8601 — the "touched in" window. */
      from: string;
      to: string;
    };

/** The heading's name for a source ("Sprint 42", "Cycle 12 and Cycle 13", "Milestone v2.3"). */
export function sprintSourceTitle(s: SprintSource): string {
  const join = (names: string[]): string =>
    names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  switch (s.kind) {
    case 'sprint':
      return join(s.names) || 'Open sprint';
    case 'cycle':
      return join(s.names) || 'Active cycle';
    case 'milestone':
      return s.name;
    case 'status_fallback':
      return 'To do and in progress';
  }
}

/** The sprint read's state for this workspace. */
export interface SprintReadState {
  /** ISO-8601 of the last SUCCESSFUL read; null = never read yet (the page says "Reading…"). */
  readAt: string | null;
  /** ISO-8601 of the last attempt. */
  checkedAt: string | null;
  /** A plain-English sentence for the last attempt's failure, naming the provider; null = fine. */
  error: string | null;
  /** The read hit `SPRINT_TICKETS_MAX`. */
  truncated: boolean;
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

/** The coarse phase of a listed ticket — derived from its `stage` (in_progress = In progress, Code
 *  review or Product review). */
export type SprintPhase = 'not_started' | 'in_progress' | 'done';

export const SPRINT_PHASE_LABEL: Record<SprintPhase, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Complete',
};

// ── The status layout (buckets of statuses) ───────────────────────────────────────────────────────
//
// Statuses are per PROJECT and per TRACKER, so nothing here hard-codes a status name. The workspace
// groups its statuses into BUCKETS (1–SPRINT_BUCKETS_MAX, in reading order), each with a name and a
// MEANING — one of the five stages (Not started, In progress, Code review, Product review, Complete). The
// internal id of Code review stays `in_review` (stored settings and snapshots carry it). A ticket's `stage` is
// its bucket's meaning, so everything that reads a stage keeps working whatever the buckets are. Both
// the buckets and which status sits where are worked out automatically until the workspace sets them:
//
//   • THE ORDER — Jira: the board's column order (the sprint's `boardId` →
//     `/rest/agile/1.0/board/{id}/configuration`, status ids → names via `/rest/api/2/status`);
//     Linear: the team's workflow states (type, then `position`); GitHub Issues: Open, Closed. Stored
//     on `sprint_reads.status_order_json` by the sprint read. Unreadable → null, and the fallback is
//     the statuses on the tickets sorted by category (new → indeterminate → done), then name.
//   • THE AUTOMATIC STAGE — category `new` → Not started, `done` → Complete (so "Won't do" lands there).
//     An in-progress (or unknown-category) status is Product review when its NAME reads as QA / test /
//     sign-off / release (`SPRINT_PRODUCT_REVIEW_STATUS_RE`, checked first); else Code review when its
//     name reads as review (`SPRINT_REVIEW_STATUS_RE`), or when it sits at or after the PR-evidence
//     boundary: the FIRST in-progress status, in order, where at least SPRINT_DELIVERED_MIN_SHARE of the
//     tickets that have ≥ 1 pull request have ALL of them merged and none open, with at least
//     SPRINT_DELIVERED_MIN_TICKETS such tickets. Otherwise In progress.
//   • AUTOMATIC BUCKETS (`buckets: null`) — five, one per stage, id = the stage, named
//     SPRINT_STAGE_LABEL; every status sits in the bucket of its automatic stage.
//   • THE WORKSPACE'S BUCKETS (`SprintStatusSettings.buckets`) — meanings NON-DECREASING in order
//     (`sprintBucketsProblem`); each lists the statuses placed there, in order; a status sits in at
//     most one. ⚠ PLACEMENT BEATS CATEGORY. A status no bucket names (new on the board since) keeps
//     its automatic stage and joins the FIRST bucket with that meaning; with none, the bucket of the
//     nearest EARLIER meaning (else the nearest later one) — marked `auto` either way.
//   • THE COLUMNS (`SprintStatusLayout.columns`) — the x axis of every This Sprint view: the buckets in
//     order, nothing else (the derived "Merged, not signed off" column is GONE: it became the first-class
//     Product review bucket). THE MERGE RULE: while `mergedColumn` is on (the default) a ticket whose
//     bucket means Code review and that has ≥ 1 merged pull request and none open (closed unmerged ones
//     ignored) is drawn in the FIRST Product review bucket instead — `SprintGraphNode.column`, computed
//     once in the graph fold. Its `stage` and `bucketId` stay its status's.
//   • STORED BUCKETS SAVED BEFORE PRODUCT REVIEW (no `version`) are read with a Product review bucket
//     added after the last Code review bucket (else after the last In progress one, else before the
//     first Complete one), taking that Code review bucket's statuses whose names read as QA / sign-off
//     / release; a bucket named exactly "In review" reads as "Code review". Read-time only: the next Save
//     stores it (`SPRINT_STATUS_SETTINGS_VERSION`), after which a removed Product review stays removed.
//   • "Coding begins" = the first status of the first In progress bucket; "Coding ends" = the first
//     of the first Code review bucket, else of the first Product review one (`codingBegins` /
//     `codingEnds`) — derived, never stored.
//
// A status NAME is matched case-insensitively (trimmed).

/** Share of PR-bearing tickets in a status that must be fully merged for it to start Code review. */
export const SPRINT_DELIVERED_MIN_SHARE = 0.6;
/** Fully-merged tickets a status needs at least, for that share to count. */
export const SPRINT_DELIVERED_MIN_TICKETS = 2;
/** Statuses the buckets may list at most (over all of them); a status name's longest spelling. */
export const SPRINT_STATUS_ORDER_MAX = 60;
export const SPRINT_STATUS_NAME_MAX = 100;
/** Buckets a workspace may have; a bucket name's longest spelling; a bucket id's pattern. */
export const SPRINT_BUCKETS_MAX = 10;
export const SPRINT_BUCKET_NAME_MAX = 24;
export const SPRINT_BUCKET_ID_RE = /^[a-z0-9_-]{1,32}$/;
/** The retired derived column's id: still never a bucket id (an old link or stored value may name it). */
export const SPRINT_MERGED_COLUMN_ID = 'merged';

/** An in-progress status whose NAME matches this is automatically Product review — QA, test, sign-off
 *  and release ("Ready for QA", "In Test", "UAT", "Sign-off", "PO Review", "Staging", "Demo", "Awaiting
 *  Deployment", "Release"). Checked BEFORE `SPRINT_REVIEW_STATUS_RE`. */
export const SPRINT_PRODUCT_REVIEW_STATUS_RE =
  /\b(?:qa|tests?|testing|verif\w*|uat|accept\w*|sign.?off|po|product|staging|demo|deploy\w*|release\w*)\b/i;

/** An in-progress status whose NAME matches this (and not the Product review vocabulary) is
 *  automatically Code review ("Code Review", "In Review", "Ready for review"). */
export const SPRINT_REVIEW_STATUS_RE = /\b(?:review|ready for)\b/i;

/** The five stages, in page order — a bucket's MEANING. `in_review` is Code review (the id is kept:
 *  stored settings and snapshots carry it). */
export type SprintStage = 'not_started' | 'in_progress' | 'in_review' | 'product_review' | 'done';

export const SPRINT_STAGES: readonly SprintStage[] = ['not_started', 'in_progress', 'in_review', 'product_review', 'done'];

export const SPRINT_STAGE_LABEL: Record<SprintStage, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  in_review: 'Code review',
  product_review: 'Product review',
  done: 'Complete',
};

/** A stage's place in page order (meanings may never go backwards along the buckets). */
export const SPRINT_STAGE_RANK: Record<SprintStage, number> = { not_started: 0, in_progress: 1, in_review: 2, product_review: 3, done: 4 };

/** The coarse phase of a stage. */
export function sprintPhaseOfStage(stage: SprintStage): SprintPhase {
  return stage === 'not_started' ? 'not_started' : stage === 'done' ? 'done' : 'in_progress';
}

/** The automatic order as the sprint read stored it (`sprint_reads.status_order_json`). */
export interface SprintStatusAutoOrder {
  source: 'jira_board' | 'linear_states' | 'github';
  /** In board / workflow order. `id` is the tracker's status id when it has one. */
  statuses: Array<{ id: string | null; name: string; category: JiraStatusCategory | null }>;
  /** ISO-8601 of the read that produced it. */
  readAt: string;
}

/** One bucket of statuses, as the workspace set it. */
export interface SprintBucket {
  /** SPRINT_BUCKET_ID_RE, unique, never SPRINT_MERGED_COLUMN_ID. */
  id: string;
  /** 1–SPRINT_BUCKET_NAME_MAX characters. */
  name: string;
  meaning: SprintStage;
  /** The status names placed here, in order. */
  statuses: string[];
}

/** The workspace's override (`workspaces.sprint_statuses`). OVERRIDES ONLY: the default (automatic
 *  buckets, merge rule on) is stored as NULL. A stored value of the retired `{sections}` or
 *  `{order, deliveredFrom}` shape is read into five buckets named SPRINT_STAGE_LABEL. */
export interface SprintStatusSettings {
  /** null = automatic. */
  buckets: SprintBucket[] | null;
  /** Move a Code review ticket whose pull requests have all merged (none open) into the first Product
   *  review bucket. (The key keeps its old name: it once drew the "Merged, not signed off" column.) */
  mergedColumn: boolean;
}

/** Stamped on every stored value written since Product review became a bucket. A stored value WITHOUT
 *  it was saved before, and is read with a Product review bucket added (see the header). */
export const SPRINT_STATUS_SETTINGS_VERSION = 2;

export const SPRINT_STATUS_SETTINGS_DEFAULT: SprintStatusSettings = { buckets: null, mergedColumn: true };

/** The five automatic buckets (no statuses named). */
export function sprintAutomaticBuckets(): SprintBucket[] {
  return SPRINT_STAGES.map((s) => ({ id: s, name: SPRINT_STAGE_LABEL[s], meaning: s, statuses: [] }));
}

const STAGE_RANK = SPRINT_STAGE_RANK;

/** What is wrong with a set of buckets, in plain words; null when it may be saved. The server's
 *  validator (strict, on PUT) and the editor's (before Save) are this ONE function. */
export function sprintBucketsProblem(buckets: ReadonlyArray<SprintBucket>): string | null {
  if (buckets.length === 0) return 'Keep at least one bucket.';
  if (buckets.length > SPRINT_BUCKETS_MAX) return `Use at most ${SPRINT_BUCKETS_MAX} buckets.`;
  const ids = new Set<string>();
  const names = new Set<string>();
  const statuses = new Set<string>();
  let total = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    const b = buckets[i]!;
    if (typeof b.id !== 'string' || !SPRINT_BUCKET_ID_RE.test(b.id) || b.id === SPRINT_MERGED_COLUMN_ID || ids.has(b.id)) {
      return 'Each bucket needs its own id.';
    }
    ids.add(b.id);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name === '') return 'Give every bucket a name.';
    // eslint-disable-next-line no-control-regex
    if (name.length > SPRINT_BUCKET_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
      return `Keep bucket names to ${SPRINT_BUCKET_NAME_MAX} characters.`;
    }
    if (names.has(name.toLowerCase())) return `Two buckets are called “${name}”.`;
    names.add(name.toLowerCase());
    if (!SPRINT_STAGES.includes(b.meaning)) return `Choose what “${name}” means.`;
    const prev = buckets[i - 1];
    if (prev != null && STAGE_RANK[b.meaning] < STAGE_RANK[prev.meaning]) {
      return `“${name}” means ${SPRINT_STAGE_LABEL[b.meaning]}, so it cannot come after a bucket that means ${SPRINT_STAGE_LABEL[prev.meaning]}.`;
    }
    if (!Array.isArray(b.statuses)) return 'Each bucket needs a list of statuses.';
    for (const s of b.statuses) {
      const t = typeof s === 'string' ? s.trim() : '';
      // eslint-disable-next-line no-control-regex
      if (t === '' || t.length > SPRINT_STATUS_NAME_MAX || /[\u0000-\u001f\u007f]/.test(t)) return 'A status name is not valid.';
      if (statuses.has(t.toLowerCase())) return `“${t}” is in two buckets.`;
      statuses.add(t.toLowerCase());
      total += 1;
    }
  }
  if (total > SPRINT_STATUS_ORDER_MAX) return `Place at most ${SPRINT_STATUS_ORDER_MAX} statuses.`;
  return null;
}

/** One status in the resolved order. */
export interface SprintStatusLayoutEntry {
  name: string;
  category: JiraStatusCategory | null;
  /** Tickets in this status right now (Done ones included); 0 for a known status with none. */
  count: number;
  /** No bucket names it: it sits where the automatic rule put it ("not placed yet" in the editor). */
  auto: boolean;
  /** Its bucket's meaning — the stage tickets in this status are listed under. */
  stage: SprintStage;
  /** The bucket it sits in. */
  bucketId: string;
}

/** One resolved bucket: the workspace's (or an automatic one) with every status it holds. */
export interface SprintStatusLayoutBucket {
  id: string;
  name: string;
  meaning: SprintStage;
  /** In order (a slice of `order`). */
  statuses: SprintStatusLayoutEntry[];
}

/** One column of the x axis — one bucket. */
export interface SprintColumn {
  id: string;
  name: string;
  meaning: SprintStage;
}

/** Per in-progress status: the PR evidence behind the automatic Code review boundary. */
export interface SprintStatusEvidence {
  status: string;
  /** Tickets in this status with ≥ 1 pull request. */
  withPrs: number;
  /** …of which every pull request is merged and none is open. */
  allMerged: number;
}

export interface SprintStatusLayout {
  /** Every known status (automatic order ∪ statuses on the tickets ∪ the buckets' names), grouped by
   *  bucket in bucket order, in order within a bucket. */
  order: SprintStatusLayoutEntry[];
  /** The resolved buckets, in order (five automatic ones when none are set). */
  buckets: SprintStatusLayoutBucket[];
  /** The drawn x axis: the buckets, in order. */
  columns: SprintColumn[];
  /** Where the order came from: the override, the tracker, or the category fallback. */
  orderSource: 'override' | SprintStatusAutoOrder['source'] | 'fallback';
  /** The first status of In progress / of Code review, else of Product review (null when empty). */
  codingBegins: string | null;
  codingEnds: string | null;
  /** In order; in-progress (and unknown-category) statuses only. */
  evidence: SprintStatusEvidence[];
  /** The stored override (default when none), as read — a pre-Product-review value already carries
   *  its added Product review bucket. */
  settings: SprintStatusSettings;
}

/** PUT /api/sprint-stories/statuses — replace the workspace's override (FREE; the `read` tier; scope
 *  via `resolveWorkspaceScope`, an id that does not resolve to itself → 400 `bad_workspace`). Strict:
 *  `buckets` null or an array passing `sprintBucketsProblem`; `mergedColumn` a boolean → otherwise 400
 *  `bad_request` with the problem in `message`, and nothing is written. `{buckets: null, mergedColumn:
 *  true}` = "Reset to automatic" (stored as NULL). */
export interface SprintStatusesUpdate {
  workspaceId: number;
  settings: SprintStatusSettings;
}

export interface SprintStatusesResponse {
  workspaceId: number;
  settings: SprintStatusSettings;
  /** The layout recomputed with the new settings (same fold as the list GET). */
  statusLayout: SprintStatusLayout;
}

/** POST /api/sprint-stories/refresh {workspaceId} — read the sprint list now (bypasses the interval,
 *  not the backoff). 202 with the read state as it stands. */
export interface SprintRefreshResponse {
  workspaceId: number;
  read: SprintReadState;
  /** Ticket checks (the ticket review) this refresh started — local with AI on only; ABSENT in cloud
   *  and with AI off. `started` ≤ SPRINT_REFRESH_TICKET_CHECKS. `skipped` says why none could start
   *  ('no_credential': no Claude login or API key; 'credits': out of agentic credits); null otherwise
   *  (including "nothing needed a check"). */
  ticketChecks?: SprintRefreshTicketChecks;
}

export interface SprintRefreshTicketChecks {
  started: number;
  skipped: 'no_credential' | 'credits' | null;
}

