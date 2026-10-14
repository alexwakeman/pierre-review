import type { SprintSource, SprintStatusAutoOrder } from '@pierre-review/shared';
import type { FetchedTicket, TrackerCall } from '../types.js';

// THE SPRINT LIST SEAM (Activity → This Sprint; docs/TRACKERS.md § The sprint list read). One lister
// per provider (./jira.ts, ./linear.ts, ./github.ts) answers "which tickets are in this workspace's
// current sprint" — or, when the tracker has no sprint concept or none is active, the STATUS
// FALLBACK (To do + In progress tickets touched in the window) — and says which in `source`.
// ./read.ts stores the answer; nothing on a view ever calls a lister.

export interface SprintFetchedTicket extends FetchedTicket {
  /** Jira project key / Linear team key / GitHub owner/repo. */
  projectKey: string | null;
  epic: { key: string; title: string | null } | null;
  /** Jira components / Linear labels; null = not read. */
  components: string[] | null;
  /** The sprint / cycle / milestone the ticket was read under; null for the status fallback. */
  sprintName: string | null;
  issueUpdatedAt: Date | null;
}

export interface SprintListResult {
  source: SprintSource;
  /** ≤ SPRINT_TICKETS_MAX (the lister cuts). */
  tickets: SprintFetchedTicket[];
  truncated: boolean;
  /** The AUTOMATIC status order (docs/TRACKERS.md § The status order): undefined = not read this
   *  time (a failed order read — the stored one stands), null = not readable (no board), else the
   *  order to store on `sprint_reads.status_order_json`. */
  statusOrder?: SprintStatusAutoOrder | null;
  /** The failure CODE of an order read that failed (logged; never fails the list). */
  statusOrderError?: string;
  /** The current sprint's own dates as the tracker gave them (Jira sprint startDate/endDate, Linear
   *  cycle startsAt/endsAt, GitHub milestone dueOn as the end); stored on `sprint_reads`. Absent / null =
   *  none given (and always for the status fallback). */
  dates?: SprintListDates | null;
}

export interface SprintListDates {
  startsAt: Date | null;
  endsAt: Date | null;
}

/** A tracker date string → a Date, or null (missing, "<null>", unparseable). */
export function sprintDate(v: unknown): Date | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The dates of the sprint that holds the most read tickets (ties: the earliest start, then the first
 * seen) — several active sprints / cycles can feed one list, and the header shows one. Null when that
 * sprint carries no date at all. Pure.
 */
export function busiestSprintDates(sprints: ReadonlyArray<{ count: number; startsAt: Date | null; endsAt: Date | null }>): SprintListDates | null {
  let best: { count: number; startsAt: Date | null; endsAt: Date | null } | null = null;
  for (const s of sprints) {
    if (best == null || s.count > best.count) {
      best = s;
      continue;
    }
    const a = s.startsAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const b = best.startsAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (s.count === best.count && a < b) best = s;
  }
  if (best == null || (best.startsAt == null && best.endsAt == null)) return null;
  return { startsAt: best.startsAt, endsAt: best.endsAt };
}

export interface SprintListArgs {
  call: TrackerCall;
  /** Jira project keys / Linear team keys seen on the workspace (./project-keys.ts). */
  projectKeys: string[];
  /** GitHub: the workspace's repos as owner/name. */
  repos: string[];
  fallbackWindow: { fromMs: number; toMs: number };
  /** The workspace's acceptance-criteria field choice for an issue type (Jira). */
  acSettingFor(issueTypeId: string | null): string | null;
}

export type SprintLister = (a: SprintListArgs) => Promise<SprintListResult>;
