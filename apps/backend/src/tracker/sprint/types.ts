import type { SprintSource } from '@pierre-review/shared';
import type { FetchedTicket, TrackerCall } from '../types.js';

// THE SPRINT LIST SEAM (Reports → This sprint; docs/TRACKERS.md § The sprint list read). One lister
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
