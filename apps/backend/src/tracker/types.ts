import type {
  IssueMatchScope,
  JiraAcCandidate,
  JiraStatusCategory,
  TrackerProvider,
} from '@pierre-review/shared';
import type { JiraFetchPolicy, JiraTransport } from './jira/fetch.js';

// ── THE TRACKER SEAM ────────────────────────────────────────────────────────────────────────────
//
// ONE tracker per workspace (`workspace_trackers`), ONE adapter per provider (./registry.ts). Every
// provider-specific fact lives behind this interface; everything else — the stored tickets, the
// pull-based worker, the PR-detail chips, the Open PRs ticket row and stacks, the ticket review's
// membership and story, the credential at rest — is written ONCE over it. docs/TRACKERS.md is the
// contract; this file is the shape.
//
// The five concerns an adapter answers:
//
//   IDENTITY    `siteRoot` — the provider's CANONICAL site root for a workspace's base URL (Jira:
//               shared `jiraApiRoot`, the ONE fold — a second copy splits one ticket into two
//               idents). The ident is `<provider>:<root>#<key>` (shared `ticketIdent`), and
//               `isKey` is the provider's key shape.
//   LINKING     `detect` — which tickets a pull request names (title / head branch, the workspace's
//               allowlist + match scope). `browseUrl` — the link a chip opens.
//   FETCH       `reader` — read ONE ticket when a PR is RECEIVED (title, description markdown,
//               acceptance-criteria candidates, status + category, assignee, issue type). An
//               adapter without one would be link-only: no worker pass, no story, chips only.
//   PEERS       not per-adapter. Every PR on a ticket is the stored rows sharing (provider, root,
//               key) — one SQL shape for every provider (./peers.ts).
//   CREDENTIAL  `reader.credential` — what the workspace must have saved: 'token' (a sealed,
//               write-only per-workspace token, ./secret.ts) or 'none' (a provider that reads with
//               something core already holds — the GitHub Issues adapter uses the account's
//               GitHub token, through `TrackerCall.github`).
//
// A sixth, OPTIONAL member, `linker`, is for a provider whose LINKS are not in the PR's title or
// branch but must be READ from somewhere (GitHub Issues: the issues a PR closes; Linear: the issues
// its GitHub integration attached the PR to). The worker runs it before detection, for that
// provider's PRs only, and stores what it read on the PR; `detect` then reads the stored links like
// any other PR column. A provider without one costs nothing. `linker.required` says whether the
// links are the WHOLE answer (GitHub: never read = unknown) or an ADDITION to key detection (Linear:
// never read = detection alone).
//
// ⚠ VIEWS NEVER CALL A READER. Only the worker (./worker.ts) does, plus a person pressing Refresh.

export interface TrackerConfig {
  provider: TrackerProvider;
  baseUrl: string;
  projectKeys: string[];
  matchScope: IssueMatchScope;
}

// 'link' = a link the provider itself states (GitHub: the PR closes the issue).
// 'manual' = a person pasted the ticket on the PR (the Story check's paste box): the stored row IS
// the link, so detection keeps it (docs/TRACKERS.md § Adding a ticket by hand).
export type DetectedFrom = 'title' | 'branch' | 'link' | 'manual';

/** What detection may read off a pull request. `closingIssues` is the GitHub linker's stored read,
 *  `linearLinks` the Linear linker's (read against the Linear workspace `linearLinksRoot`):
 *  undefined = not loaded by this caller, null = never read, [] = none. */
export interface DetectInput {
  title: string | null;
  headRefName: string | null;
  closingIssues?: string[] | null;
  linearLinks?: string[] | null;
  linearLinksRoot?: string | null;
  /** Keys a person linked by hand (stored rows with `detected_from = 'manual'` on the workspace's
   *  current provider + site — `manualKeysOf`). Appended after detection; undefined = none loaded. */
  manualKeys?: readonly string[] | null;
}

export interface DetectedTicket {
  key: string;
  from: DetectedFrom;
  order: number;
}

export interface FetchedTicketAssignee {
  name: string;
  // The provider's id for the person (Jira Cloud accountId / Server key); null when none.
  accountId: string | null;
  // https only; null otherwise.
  avatarUrl: string | null;
}

/** One ticket as a reader returns it — provider-neutral; the worker stores exactly this. */
export interface FetchedTicket {
  key: string;
  title: string;
  // MARKDOWN.
  description: string;
  issueType: { id: string; name: string } | null;
  status: { name: string; category: JiraStatusCategory | null } | null;
  assignee: FetchedTicketAssignee | null;
  // Where the acceptance criteria might live (Jira custom text fields). [] when the provider keeps
  // them in the description; the criteria are then derived as '' and the description carries them.
  candidates: JiraAcCandidate[];
  omittedCandidates: number;
  /** The ticket's own link as the tracker gave it (Linear's issue URL), https only; absent = build
   *  it from the workspace's base URL (`browseUrl`). */
  url?: string | null;
}

/** A GitHub GraphQL answer: the data (partial data included) and any errors GitHub reported. */
export interface GithubGqlResult<T = unknown> {
  data: T | null;
  errors?: unknown;
}

/**
 * The account's GitHub access, for a provider that reads with it (GitHub Issues). Built from
 * `TrackerContext.github` per ACCOUNT — the token is resolved per call through `getAccessToken`,
 * never cached here (CLAUDE.md: no module-level token cache).
 */
export interface GithubCallAccess {
  accountId: number;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<GithubGqlResult<T>>;
}

/** Everything one call to a reader needs. `credentials.email` is Jira-only (Basic vs Bearer). */
export interface TrackerCall {
  provider: TrackerProvider;
  apiRoot: string;
  credentials: { email: string | null; token: string };
  policy: JiraFetchPolicy;
  transport?: JiraTransport;
  /** Present for a provider that reads with the account's GitHub token. */
  github?: GithubCallAccess;
}

export interface TrackerReader {
  credential: 'token' | 'none';
  /** Read one ticket. Throws `JiraFetchError` (any provider: the codes are transport-generic). */
  fetchTicket(call: TrackerCall, key: string): Promise<FetchedTicket>;
  /** A plain-English sentence for a failure, naming the provider. Never anything it sent back. */
  errorMessage(err: unknown): string;
}

export interface TrackerAdapter {
  provider: TrackerProvider;
  /** The product's own name, for "Jira ticket" copy. */
  label: string;
  /** A provider whose site is fixed (GitHub Issues: github.com) — no base URL is asked for, and the
   *  workspace's stored one is ignored. */
  fixedBaseUrl?: string;
  siteRoot(baseUrl: string | null | undefined): string | null;
  isKey(key: string): boolean;
  /** The canonical spelling of a key a REQUEST carries (Jira: upper case), or null if malformed. */
  normalizeKey(raw: string): string | null;
  browseUrl(baseUrl: string, key: string): string;
  detect(cfg: TrackerConfig, pr: DetectInput): DetectedTicket[];
  reader?: TrackerReader;
  linker?: TrackerLinker;
}

/** A PR the linker may read links for. */
export interface LinkerPr {
  id: number;
  githubNodeId: string;
  state: string;
  updatedAt: Date | null;
  closingIssuesCheckedAt: Date | null;
  /** `https://github.com/<owner>/<repo>/pull/<n>` — what Linear's attachments are keyed on. */
  prUrl?: string | null;
  linearLinksRoot?: string | null;
  linearLinksCheckedAt?: Date | null;
}

/**
 * READ a provider's links for some PRs and store them on the PR. Bounded, budget-pre-empted, never
 * throws. `call` is the PR's WORKSPACE's call (Linear: its key and workspace root; GitHub ignores
 * it). `stop` reports a failure that says nothing about any one PR (a refused key, a rate limit),
 * so the worker can back the workspace off.
 */
export interface TrackerLinker {
  /** true: the stored links are the WHOLE answer (never read = tickets unknown). false: they add
   *  to key detection (never read = detection alone). */
  required: boolean;
  refresh(
    ctx: import('./context.js').TrackerContext,
    accountId: number,
    prs: readonly LinkerPr[],
    opts: { now: number; call: TrackerCall },
  ): Promise<{ read: number; skipped: number; stop?: { code: string; status: number | null } }>;
  /** A PR whose links are due a read (never read, edited since, or stale while open). */
  isDue(pr: LinkerPr, now: number, call: TrackerCall): boolean;
}
