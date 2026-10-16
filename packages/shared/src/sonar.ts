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
  // 'gate' = a FAILING QUALITY-GATE CONDITION SonarCloud can be acted on in code (coverage or
  // duplication on new code). Never stored in a snapshot's `issues`: derived on read from the stored
  // gate by `sonarGateItems`, so the counts ("50 of 132 issues") stay SonarCloud's own.
  kind: 'issue' | 'hotspot' | 'gate';
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

/** A file a failing coverage / duplication condition points at, with its count of new lines. */
export interface SonarGateFile {
  path: string;
  // Uncovered new lines (a coverage condition) or duplicated new lines (a duplication condition).
  lines: number;
}

export interface SonarGateCondition {
  metric: string;
  status: string; // OK | WARN | ERROR | NONE
  actual: string | null;
  threshold: string | null;
  comparator: string | null; // GT | LT
  // A failing coverage or duplication condition: the files with the most such new lines (≤ 10,
  // most first). Absent when not read (another metric, a passing condition, or a failed read).
  files?: SonarGateFile[];
}

/** One PR measure as SonarCloud gave it (coverage, duplication, size of the new code). */
export interface SonarMeasure {
  metric: string;
  value: string;
}

export interface SonarQualityGate {
  status: 'OK' | 'WARN' | 'ERROR' | 'NONE';
  conditions: SonarGateCondition[];
  // The PR's coverage / duplication / new-lines measures (`api/measures/component`). Absent on
  // rows stored before they were read, or when the read failed.
  measures?: SonarMeasure[];
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

// ---- quality-gate conditions, in words (the review tab, the prompt, the comment, AI Fix) ----

const METRIC_LABEL: Record<string, string> = {
  new_coverage: 'Coverage on new code',
  coverage: 'Coverage',
  new_line_coverage: 'Line coverage on new code',
  line_coverage: 'Line coverage',
  new_branch_coverage: 'Branch coverage on new code',
  branch_coverage: 'Branch coverage',
  new_uncovered_lines: 'Uncovered new lines',
  uncovered_lines: 'Uncovered lines',
  new_lines_to_cover: 'New lines to cover',
  new_duplicated_lines_density: 'Duplicated lines on new code',
  duplicated_lines_density: 'Duplicated lines',
  new_duplicated_lines: 'Duplicated new lines',
  duplicated_lines: 'Duplicated lines',
  new_lines: 'New lines',
  new_reliability_rating: 'Reliability rating on new code',
  new_security_rating: 'Security rating on new code',
  new_maintainability_rating: 'Maintainability rating on new code',
  new_security_review_rating: 'Security review rating on new code',
  new_security_hotspots_reviewed: 'Security hotspots reviewed',
  new_violations: 'Issues on new code',
  new_bugs: 'Bugs on new code',
  new_vulnerabilities: 'Vulnerabilities on new code',
  new_code_smells: 'Code smells on new code',
};

/** A metric key in words ("new_coverage" → "Coverage on new code"). */
export function sonarMetricLabel(metric: string): string {
  return METRIC_LABEL[metric] ?? metric.replace(/^new_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const isRating = (metric: string): boolean => /_rating$/.test(metric);
const isPercent = (metric: string): boolean => /(coverage|density|hotspots_reviewed)$/.test(metric);

/** A metric value as a reader expects it: "42.1%", rating "A"…"E", else as given. */
export function sonarMetricValue(metric: string, value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (isRating(metric)) return 'ABCDE'[Math.round(n) - 1] ?? value;
  if (isPercent(metric)) return `${Math.round(n * 10) / 10}%`;
  return String(n);
}

/** "Coverage on new code is 42.1%. The quality gate needs at least 80%." */
export function sonarConditionSentence(c: SonarGateCondition): string {
  const label = sonarMetricLabel(c.metric);
  const actual = c.actual != null ? sonarMetricValue(c.metric, c.actual) : null;
  const limit = c.threshold != null ? sonarMetricValue(c.metric, c.threshold) : null;
  const head = actual != null ? `${label} is ${actual}.` : `${label} fails.`;
  if (limit == null) return head;
  const need = isRating(c.metric)
    ? `${limit} or better`
    : c.comparator === 'LT'
      ? `at least ${limit}`
      : c.comparator === 'GT'
        ? `at most ${limit}`
        : limit;
  return `${head} The quality gate needs ${need}.`;
}

/** The conditions that did not pass. */
export function sonarFailingConditions(gate: SonarQualityGate | null | undefined): SonarGateCondition[] {
  return (gate?.conditions ?? []).filter((c) => c.status === 'ERROR' || c.status === 'WARN');
}

const coverageMetric = (m: string): boolean => /coverage|uncovered_lines|lines_to_cover/.test(m);
const duplicationMetric = (m: string): boolean => /duplicat/.test(m);

/** Is this a condition code can fix directly (coverage or duplication)? Ratings, issue counts and
 *  hotspot review follow from the issues and hotspots, which are items of their own. */
export function sonarConditionIsActionable(metric: string): boolean {
  return coverageMetric(metric) || duplicationMetric(metric);
}

/** The per-file metric a failing condition's files are ranked by (null: not a file-level fix). */
export function sonarConditionFileMetric(metric: string): string | null {
  const fresh = metric.startsWith('new_');
  if (coverageMetric(metric)) return fresh ? 'new_uncovered_lines' : 'uncovered_lines';
  if (duplicationMetric(metric)) return fresh ? 'new_duplicated_lines' : 'duplicated_lines';
  return null;
}

/**
 * Every FAILING coverage / duplication condition of a gate as an item — the same card, the same
 * AI Fix candidate (ref Q) and the same comment block as an issue. Pure; derived on read, never stored.
 */
export function sonarGateItems(gate: SonarQualityGate | null | undefined, url: string | null): SonarIssue[] {
  return sonarFailingConditions(gate)
    .filter((c) => sonarConditionIsActionable(c.metric))
    .map((c) => {
      const coverage = coverageMetric(c.metric);
      const files = c.files ?? [];
      const list =
        files.length > 0
          ? `\n\nFiles with the most ${coverage ? 'uncovered' : 'duplicated'} new lines:\n${files
              .map((f) => `- ${f.path}: ${f.lines} ${f.lines === 1 ? 'line' : 'lines'}`)
              .join('\n')}`
          : '';
      const howToFix = coverage
        ? `Write tests that run the new and changed lines SonarCloud reports as not covered, then let CI measure coverage again.${list}`
        : `Move the repeated new code into one shared function or module and call it from each place.${list}`;
      return {
        key: `gate:${c.metric}`,
        kind: 'gate' as const,
        rule: c.metric,
        ruleName: sonarMetricLabel(c.metric),
        severity: c.status === 'ERROR' ? ('critical' as const) : ('major' as const),
        type: 'QUALITY_GATE',
        message: sonarConditionSentence(c),
        path: null,
        line: null,
        endLine: null,
        effort: null,
        tags: [],
        securityCategory: null,
        whyIsThisAnIssue: null,
        howToFix,
        code: [],
        url: url ?? SONARCLOUD_HOST,
      };
    });
}
