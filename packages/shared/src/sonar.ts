// SONARCLOUD (CORE, free, both modes for the settings; docs/SONARCLOUD.md). A workspace may save a
// SonarCloud token + organization; Limn then reads a pull request's SonarCloud analysis (open issues,
// security hotspots, the quality gate, each rule's fix guidance and the flagged lines), stores ONE
// snapshot per (account, PR, head) and hands it to Claude Review, AI Fix and a PR comment.
//
// ⚠ THE HOST IS FIXED (`SONARCLOUD_HOST`) — nothing the customer types becomes a URL host.
// ⚠ THE TOKEN IS WRITE-ONLY: no response carries it (`hasToken` only), and the account export
// never does either.

export const SONARCLOUD_HOST = 'https://sonarcloud.io';

/** At most this many issues + hotspots are kept per snapshot, highest severity first. */
export const SONAR_ISSUE_CAP = 50;

// One severity scale for issues AND hotspots. An issue's severity is SonarCloud's own (its legacy
// `severity`, else the highest of its `impacts`); a hotspot's is its review priority mapped onto
// the same scale (HIGH → critical, MEDIUM → major, LOW → minor).
export type SonarSeverity = 'blocker' | 'critical' | 'major' | 'minor' | 'info';
export const SONAR_SEVERITY_ORDER: readonly SonarSeverity[] = ['blocker', 'critical', 'major', 'minor', 'info'];
export const SONAR_SEVERITY_LABEL: Record<SonarSeverity, string> = {
  blocker: 'Blocker',
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  info: 'Info',
};

/** One flagged source line (or a line of context around it), as plain text. */
export interface SonarCodeLine {
  line: number;
  code: string;
  // Inside the issue's own text range.
  flagged: boolean;
}

export interface SonarIssue {
  // SonarCloud's issue or hotspot key — stable across reads of the same analysis.
  key: string;
  kind: 'issue' | 'hotspot';
  // e.g. 'typescript:S1854'.
  rule: string;
  ruleName: string | null;
  severity: SonarSeverity;
  // BUG | VULNERABILITY | CODE_SMELL | SECURITY_HOTSPOT (null when SonarCloud gave none).
  type: string | null;
  message: string;
  // Repository-relative path (the component key minus the project prefix); null = project level.
  path: string | null;
  line: number | null;
  endLine: number | null;
  // SonarCloud's remediation estimate ("5min"), as given.
  effort: string | null;
  tags: string[];
  // Hotspots only: SonarCloud's security category ("sql-injection"); null otherwise.
  securityCategory: string | null;
  // From the rule's description (plain text, clipped). null when the rule gave none.
  whyIsThisAnIssue: string | null;
  howToFix: string | null;
  // The flagged lines with a little context; [] when SonarCloud would not serve the source.
  code: SonarCodeLine[];
  // The issue on sonarcloud.io.
  url: string;
}

export interface SonarGateCondition {
  metric: string;
  status: string; // OK | WARN | ERROR | NONE
  actual: string | null;
  threshold: string | null;
  comparator: string | null; // GT | LT
}

export interface SonarQualityGate {
  status: 'OK' | 'WARN' | 'ERROR' | 'NONE';
  conditions: SonarGateCondition[];
}

// What reading SonarCloud for one PR head came to. Everything but 'ok' is a NAMED, non-fatal state:
// a review never fails because SonarCloud did.
//   ok                read; `issues` may still be empty
//   not_configured    the workspace has no organization or no token
//   token_unreadable  a token is saved but this server cannot open it (key changed) — save it again
//   no_project        SonarCloud knows no project by the mapped key
//   not_analyzed      the project exists but has no analysis for this pull request (yet)
//   unauthorized      SonarCloud refused the token
//   error             anything else (timeout, 5xx…)
export type SonarSnapshotState =
  | 'ok'
  | 'not_configured'
  | 'token_unreadable'
  | 'no_project'
  | 'not_analyzed'
  | 'unauthorized'
  | 'error';

// The one PR-level comment carrying a snapshot's issues, once per (PR, head) (`sonar_snapshots.post`).
//   posting  claimed; the GitHub call is in flight — or was cut off, and is never retried
//   posted   on GitHub (`commentId`)
//   failed   GitHub refused; `error` says why. Never retried.
// An AUTO post that decides not to post (switched off, not your PR, nothing to post) writes NOTHING,
// so a person may still post by hand.
export interface SonarPostRecord {
  status: 'posting' | 'posted' | 'failed';
  at: string;
  trigger: 'manual' | 'auto';
  commentId: string | null;
  error: string | null;
  // How many issues the comment carried, and whether it had to leave some out to fit GitHub's limit.
  issueCount: number;
  truncated: boolean;
}

export interface SonarSnapshot {
  prId: number;
  headSha: string;
  state: SonarSnapshotState;
  // A plain sentence for every state but 'ok'.
  message: string | null;
  projectKey: string | null;
  qualityGate: SonarQualityGate | null;
  // Ranked (severity, then hotspots after issues of the same severity), capped at SONAR_ISSUE_CAP.
  issues: SonarIssue[];
  // What SonarCloud reports open on the PR — the denominator of "50 of 132".
  totalIssues: number;
  totalHotspots: number;
  fetchedAt: string;
  post: SonarPostRecord | null;
  // The PR's analysis on sonarcloud.io (null without a project key).
  dashboardUrl: string | null;
}

// `GET /api/prs/:id/sonar?head=<sha>` — a stored read; never calls SonarCloud.
export interface SonarPrResponse {
  prId: number;
  // The PR's workspace has an organization and a token saved.
  configured: boolean;
  // The snapshot at `head` (or the PR's synced head); null when none was taken.
  snapshot: SonarSnapshot | null;
}

// `POST /api/prs/:id/sonar/post` { headSha } — ONE PR comment, once per (PR, head).
export interface SonarPostResponse {
  snapshot: SonarSnapshot;
  // GitHub 201'd but the comment is not in Limn's copy yet. NEVER offer a retry on this.
  visible: boolean;
}

// ---- settings (Settings → Workspace → SonarCloud) ----

export interface WorkspaceSonarRepo {
  repoId: number;
  fullName: string;
  // The key in use: the saved override, else `defaultKey`.
  projectKey: string;
  // `<owner>_<repo>` — SonarCloud's default for a GitHub import.
  defaultKey: string;
  overridden: boolean;
}

// `GET /api/workspaces/:id/sonar`.
export interface WorkspaceSonarSettings {
  workspaceId: number;
  organization: string | null;
  hasToken: boolean;
  // A token is saved but cannot be opened on this server (save it again).
  tokenUnreadable: boolean;
  repos: WorkspaceSonarRepo[];
}

// `PUT /api/workspaces/:id/sonar` — a partial patch.
export interface WorkspaceSonarUpdate {
  // '' or null clears.
  organization?: string | null;
  // WRITE-ONLY. Never echoed.
  token?: string;
  clearToken?: boolean;
  // repoId → key; '' or null goes back to the default. Repos outside the workspace are refused.
  projectKeys?: Record<string, string | null>;
}

// `POST /api/workspaces/:id/sonar/check` — the Settings "Test connection" (SAVED token).
export interface SonarConnectionCheck {
  workspaceId: number;
  ok: boolean;
  message: string;
  // Per repo: does SonarCloud know the mapped project? null = not checked (cap or an error).
  projects: Array<{ repoId: number; projectKey: string; found: boolean | null }>;
}

/** SonarCloud's default project key for a GitHub-imported repository. */
export function defaultSonarProjectKey(owner: string, name: string): string {
  return `${owner}_${name}`;
}

// A project key / organization as SonarCloud allows them (letters, digits, '-', '_', '.', ':').
export const SONAR_KEY_PATTERN = '^[A-Za-z0-9_.:-]{1,400}$';
