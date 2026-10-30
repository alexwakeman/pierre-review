// ── DEPENDENCY AUTO-MERGE (CORE, free, both modes) ──────────────────────────────────────────────
//
// Two features on one wire file (docs/MERGE-CI-TRUNK.md § Dependency auto-merge):
//   • "Merge or arm all" on Pending → Dependencies — POST /api/dependencies/merge-all?workspace=;
//   • the per-workspace "Merge dependency updates automatically" setting —
//     GET / PUT /api/workspaces/:id/dependency-auto-merge (OFF by default).

import { PENDING_LIMITS } from './pending-rules.js';

/** The most PRs one "Merge or arm all" request may name — the most the Dependencies tab can
 *  LIST: `boardListCap` per list group (`listGroupOf`), over the tab's two kinds
 *  (`dependency_bump`, `security`) × the two author sides. The route's `maxItems` and the SPA's
 *  request both read it, so a full tab never meets a 400. */
export const DEPENDENCY_MERGE_ALL_MAX = PENDING_LIMITS.boardListCap * 2 * 2;

/** Why a PR in the bulk request was left alone. */
export type DependencyMergeSkipReason =
  | 'not_found' // not this account's, not open, not in the workspace, or not dependency automation
  | 'draft'
  | 'conflicts'
  | 'no_write_access'
  | 'already_armed'
  | 'already_queued';

/** The plain-English sentence for each skip reason — ONE spelling, read by the dialog and the toast. */
export const DEPENDENCY_MERGE_SKIP_LABEL: Record<DependencyMergeSkipReason, string> = {
  not_found: 'no longer an open dependency update here',
  draft: 'draft',
  conflicts: 'has conflicts',
  no_write_access: 'you can’t push to the repository',
  already_armed: 'already set to merge when ready',
  already_queued: 'already in the merge queue',
};

/** One PR's plan (dry run) or outcome (real run). */
export type DependencyMergeAction =
  | { action: 'merge' } // dry run: GitHub says it can land now
  | { action: 'arm' } // dry run: will be set to merge when ready
  | { action: 'merged' }
  | { action: 'armed' }
  | { action: 'skipped'; reason: DependencyMergeSkipReason }
  | { action: 'failed'; message: string };

export interface DependencyMergeItem {
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  outcome: DependencyMergeAction;
}

export interface DependencyMergeAllBody {
  /** The Dependencies tab's listed PR ids. Re-checked server-side, one by one. */
  prIds: number[];
  /** true = plan only: no GitHub call, nothing written. The confirm dialog reads this. */
  dryRun?: boolean;
}

export interface DependencyMergeAllResponse {
  workspaceId: number;
  dryRun: boolean;
  items: DependencyMergeItem[];
}

export interface WorkspaceDependencyAutoMerge {
  /** OFF unless switched on. */
  enabled: boolean;
}

export interface WorkspaceDependencyAutoMergeResponse {
  workspaceId: number;
  dependencyAutoMerge: WorkspaceDependencyAutoMerge;
}

// ── DEPENDENCY AUTOMATION (the Settings → Dependencies panel) ───────────────────────────────────
//
// docs/MERGE-CI-TRUNK.md § Dependency automation. Three per-workspace switches, every one OFF by
// default — merge (the setting above), APPROVE, and RESOLVE CONFLICTS (ask the bot to rebase, then
// an AI run through the in-app resolver) — and ONE policy that gates all three: how big an update
// may be, security fixes only, which ecosystems. Approval and conflict resolution act only on PRs
// opened by a bot the reader TRUSTS (`trustedBotIds`, a mark on the workspace's bot row).
//   GET / PUT /api/workspaces/:id/dependency-automation   the panel (DB only)
//   GET /api/dependencies/automation-log?workspace=        what automation did (DB only)

/** How big a version change is, by semver. Ordered: a policy of `minor` admits patch and minor. */
export type DependencyUpdateLevel = 'patch' | 'minor' | 'major';
export const DEPENDENCY_UPDATE_LEVELS: readonly DependencyUpdateLevel[] = ['patch', 'minor', 'major'];

/** The ecosystems a policy can name — a reader's words, folded from Dependabot's ids, Renovate's
 *  titles and the files a PR changes (merge/dependency-rules.ts). */
export type DependencyEcosystem =
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'ruby'
  | 'java'
  | 'dotnet'
  | 'php'
  | 'docker'
  | 'github_actions'
  | 'terraform';

export const DEPENDENCY_ECOSYSTEM_LABEL: Record<DependencyEcosystem, string> = {
  javascript: 'JavaScript (npm, Yarn, pnpm, Bun)',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  java: 'Java (Maven, Gradle)',
  dotnet: '.NET',
  php: 'PHP',
  docker: 'Docker',
  github_actions: 'GitHub Actions',
  terraform: 'Terraform',
};
export const DEPENDENCY_ECOSYSTEMS = Object.keys(DEPENDENCY_ECOSYSTEM_LABEL) as DependencyEcosystem[];

export interface DependencyAutomationPolicy {
  /** The largest update the automation acts on. Default `major` (every update). */
  maxLevel: DependencyUpdateLevel;
  /** Only security fixes. Default false. */
  securityOnly: boolean;
  /** Only these ecosystems; null = every ecosystem (the default). */
  ecosystems: DependencyEcosystem[] | null;
}

export const DEFAULT_DEPENDENCY_POLICY: DependencyAutomationPolicy = {
  maxLevel: 'major',
  securityOnly: false,
  ecosystems: null,
};

export interface DependencyAutomationSettings {
  /** Merge dependency updates once their required checks pass (`dependency_auto_merge`). */
  autoMerge: boolean;
  /** Approve them under the reader's account once CI is green. Trusted bots only. */
  autoApprove: boolean;
  /** Conflicts: ask the bot to rebase; if it can't, resolve them with AI. Trusted bots only. */
  autoResolveConflicts: boolean;
  policy: DependencyAutomationPolicy;
}

/** One dependency bot of the workspace (stored role `dependency`) and whether the reader trusts it. */
export interface DependencyBot {
  userId: number;
  login: string;
  /** The stored vendor kind (`dependabot`, `renovate`, …) or null. */
  kind: string | null;
  /** The name a person gave it in Bot settings, or null (the SPA shows the brand, else the login). */
  label: string | null;
  trusted: boolean;
  /** Can Limn ask it to rebase? Dependabot (a comment) and Renovate (its checkbox) can. */
  canRebase: boolean;
}

export interface WorkspaceDependencyAutomationResponse {
  workspaceId: number;
  settings: DependencyAutomationSettings;
  bots: DependencyBot[];
}

/** PUT body. Every field optional; only what is sent changes. */
export interface DependencyAutomationPatch {
  autoMerge?: boolean;
  autoApprove?: boolean;
  autoResolveConflicts?: boolean;
  maxLevel?: DependencyUpdateLevel;
  securityOnly?: boolean;
  ecosystems?: DependencyEcosystem[] | null;
  /** The full trusted set among the workspace's dependency bots; the rest become untrusted. */
  trustedBotIds?: number[];
}

/** What the automation did to one PR. */
export type DependencyAutomationActionKind = 'approve' | 'rebase_request' | 'ai_resolve';
export type DependencyAutomationActionState = 'running' | 'done' | 'failed';

export interface DependencyAutomationLogItem {
  id: number;
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  action: DependencyAutomationActionKind;
  state: DependencyAutomationActionState;
  /** The bot asked to rebase, the commit pushed, or why it failed — one plain sentence. */
  detail: string | null;
  /** ISO-8601. */
  at: string;
}

export interface DependencyAutomationLogResponse {
  workspaceId: number;
  items: DependencyAutomationLogItem[];
}
