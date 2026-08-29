// ── WHERE IT'S STUCK: the court ledger (CORE, deterministic, NO MODEL) ───────────────────────
//
// Every hour a pull request is open, somebody is holding the ball. Charge each interval to its
// holder and the hours account for themselves — no stage boundaries to argue about, and no
// assumption that a pull request moves through a pipeline exactly once (real ones oscillate
// author -> reviewer -> author).
//
// ⚠ WHAT THIS REPLACED, AND WHY. `db/flow-findings.ts` emitted findings at a PATH-BUCKET grain and
// produced rows like "src/** is a bottleneck". A directory is four proxies from anything an EM can
// change, and on a conventional single-package repo `src/**` IS the repository — so the row stated
// a fact about the repo with a directory's authority. Two of its four kinds are deleted outright
// (`single_reviewer_path`, `round_trips`); `size_latency` is deleted as a finding because 845,316
// pull requests say size does not predict time-to-merge (r_s = 0.26, the field's strongest
// negative result); `approval_parked` survives, absorbed here as the LANDING court, where it
// finally has a denominator.
//
// ⚠ A BOT ACTION NEVER MOVES THE BALL. One predicate, and it is the entire moat: a tool keying on
// `user.type === 'Bot'` cannot separate "this pull request was reviewed" from "a person looked at
// this". Human-ness comes from `resolveActorLanes`' UNION, never `users.isBot` alone — the second
// row of a duplicated identity (`dependabot` vs `dependabot[bot]`) carries `is_bot = 0` and would
// otherwise be counted as a human reviewer.
//
// ⚠ EVERY SENTENCE IN THIS FILE IS TEMPLATED. No model, no plugin, no AI import. An EM makes
// staffing decisions off this screen, so a generated sentence would launder an unverified figure
// into it. Same discipline `packages/pro/test/llm-isolation.test.ts` pins for the bot advisor.
//
// ── THE STATE MACHINE, and the three decisions inside it ─────────────────────────────────────
//
// Start at REVIEWER from `openedAt` (a fresh pull request is waiting to be looked at). Then per
// human action, charge the elapsed interval to the current court and move the ball:
//
//   reviewer acts (review, or a comment by anyone who is not the author)  -> AUTHOR
//   author acts   (a commit, or a comment by the author)                  -> LANDING if already
//                                                                            approved, else REVIEWER
//   an APPROVING review                                                   -> LANDING
//
//   1. A reviewer comment AFTER approval moves the ball back to the AUTHOR, not to the reviewer.
//      Somebody said something and the author owes a reply; that is the author's court by the
//      definition above, and it stays true after an approval.
//   2. An author push AFTER approval stays in LANDING. Whether it invalidates the approval depends
//      on a branch-protection setting we do not sync, so the conservative reading is "approved,
//      with new code, waiting to land" — and it does not silently inflate the author court.
//   3. ⚠ A pull request no human ever acted on is EXCLUDED, not scored. Its ledger would be 100%
//      REVIEWER by construction and would swamp every share on the screen. On real data that is
//      46% of merges, so this is not an edge case — they are reported separately, as governance.
//
// ── WINDOW PURITY ────────────────────────────────────────────────────────────────────────────
// The window is on `mergedAt`, TWO-SIDED and half-open `[from, to)`, matching db/period-metrics.ts:
// a cycle-time figure belongs to the period the work COMPLETED in, or a long-running pull request
// would move between windows as it aged.
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import type {
  CourtEvidencePr,
  CourtShare,
  FlowCoverage,
  FlowRefusal,
  FlowResponse,
  PrCourt,
  RepoCourtProfile,
  UnreviewedRepoStat,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { resolveActorLanes, type ActorLanes } from './actor-lanes.js';
import type { BotScope } from './queries.js';

const { commits, prComments, pullRequests, repos, reviewComments, reviews, users } = schema;

// ── Window ───────────────────────────────────────────────────────────────────────────────────
export const FLOW_DEFAULT_WINDOW_DAYS = 30;
// Clamped, not merely defaulted: below a week the medians rest on a handful of pull requests, and
// above 90 days the RETROACTIVE COVERAGE BIAS rule bites — a workspace that onboarded repos across
// the span shows a "trend" that is entirely onboarding.
export const FLOW_MIN_WINDOW_DAYS = 7;
export const FLOW_MAX_WINDOW_DAYS = 90;

// ── Scan caps ────────────────────────────────────────────────────────────────────────────────
// Every scan is bounded and hitting any of them sets `coverage.truncated`. A silent truncation
// reads as "we covered everything", which is a stronger claim than any figure here can support.
const FLOW_PR_CAP = 5_000;
const FLOW_ACTION_CAP = 200_000;
/** `inArray` bind parameters per statement — far inside SQLite's 32,766 and Postgres' 65,535. */
const ID_CHUNK = 900;

// ── Floors and thresholds ────────────────────────────────────────────────────────────────────
/** Merged, human-touched pull requests a repo needs before its profile is a number rather than an
 *  anecdote. */
const FLOW_MIN_REPO_PRS = 12;
/** A court must hold at least this share before it is worth naming as the thing to fix. */
const FLOW_DOMINANT_SHARE = 0.5;
/**
 * ⚠ AND THE REPO MUST ACTUALLY BE SLOW. This is the single most important constant in the file.
 * A real repository in the development corpus is 73% author-court with a p75 lead time of
 * EIGHTEEN MINUTES; reporting its share alone would invent a crisis in a healthy repo — the exact
 * failure that made the path-bucket findings worthless. Lopsided AND slow, or say nothing.
 */
const FLOW_SLOW_P75_HOURS = 8;
/** Openable pull requests offered per claim. */
const FLOW_EVIDENCE_CAP = 5;
/** Repos listed. A board nobody can read is not a worklist. */
const FLOW_REPO_CAP = 12;
/** Below this share of a repo's merges, an unreviewed-merge rate is not worth a line. */
const FLOW_UNREVIEWED_MIN_SHARE = 0.2;
const FLOW_UNREVIEWED_MIN_COUNT = 10;

const HOUR_MS = 3_600_000;

// ── Small pure helpers ───────────────────────────────────────────────────────────────────────
function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Nearest-rank percentile over an unsorted array. Returns 0 for an empty one — every caller
 *  guards on the sample floor before it reads the result. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i] ?? 0;
}

export function median(xs: number[]): number {
  return percentile(xs, 0.5);
}

/** One decimal at most, never a bare `.0` — "4.0h" implies a precision this file cannot support. */
function oneDp(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}

/**
 * A duration in prose. ⚠ Used ONLY for the templated sentences; the wire carries raw hours and the
 * SPA formats them, so a figure never appears on screen in two spellings.
 */
export function fmtHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`;
  if (h < 10) return `${oneDp(h)} hours`;
  if (h < 48) return `${Math.round(h)} hours`;
  return `${oneDp(h / 24)} days`;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// ── The court walk ───────────────────────────────────────────────────────────────────────────

/** A human action on a pull request, reduced to the only two things the ledger needs. */
export interface CourtAction {
  atMs: number;
  /** Who acted, in ball terms — not who they are. */
  by: 'reviewer' | 'author';
  /** An approving review. Moves the ball to LANDING and latches. */
  approves: boolean;
}

export interface CourtHours {
  reviewer: number;
  author: number;
  landing: number;
}

/**
 * THE LEDGER, as a pure function so it can be tested without a database.
 *
 * `actions` need not be sorted; anything outside `[openedMs, mergedMs]` is ignored rather than
 * clamped, because an action stamped outside the pull request's own life is a data error and
 * silently stretching an interval to cover it would put invented hours on the screen.
 */
export function walkCourts(
  openedMs: number,
  mergedMs: number,
  actions: CourtAction[],
): CourtHours {
  const hours: CourtHours = { reviewer: 0, author: 0, landing: 0 };
  if (!(mergedMs > openedMs)) return hours;

  const inLife = actions
    .filter((a) => a.atMs >= openedMs && a.atMs <= mergedMs)
    .sort((a, b) => a.atMs - b.atMs);

  let court: PrCourt = 'reviewer';
  let approved = false;
  let last = openedMs;

  const charge = (untilMs: number): void => {
    const h = (untilMs - last) / HOUR_MS;
    if (h > 0) hours[court] += h;
    last = untilMs;
  };

  for (const a of inLife) {
    charge(a.atMs);
    if (a.approves) {
      approved = true;
      court = 'landing';
    } else if (a.by === 'reviewer') {
      // Decision 1: somebody said something, so the author owes a reply — even after an approval.
      court = 'author';
    } else {
      // Decision 2: an author push after approval stays in LANDING. Whether it invalidates the
      // approval is a branch-protection setting we do not sync.
      court = approved ? 'landing' : 'reviewer';
    }
  }
  charge(mergedMs);
  return hours;
}

// ── The templated narrative ──────────────────────────────────────────────────────────────────
//
// ⚠ ONE SENTENCE PER COURT, AND EACH NAMES A DIFFERENT ACTION. That is the whole point of the
// split: "your PRs are slow" is not a finding, "nothing is blocked on the author or on CI, so this
// is a routing problem" is. Every figure interpolated below is code-derived.
//
// The actions are the ones with published effect sizes behind them, which is why they are worth
// hard-coding rather than leaving to the reader:
//   reviewer -> a reminder on an overdue pull request, and naming an individual rather than a team
//   author   -> nothing an EM can push on directly; the honest advice is about round-trip cost
//   landing  -> automatic merge, which this product already ships
const COURT_WAIT: Record<PrCourt, string> = {
  reviewer: 'waiting for somebody to look at it',
  author: 'waiting for its author to answer review',
  landing: 'approved and waiting to merge',
};

/**
 * The REPO row's own sentence: figures specific to this repository and NOTHING ELSE.
 *
 * ⚠ No advice here — see `RepoCourtProfile.narrative`. Six repos in one court produced six
 * identical recommendations on the first cut, which is exactly the restatement problem that made
 * the path-bucket findings worthless.
 */
function narrate(
  court: PrCourt,
  share: number,
  prs: number,
  p75LeadHours: number,
  medianLeadHours: number,
): string {
  return (
    `${pct(share)} of open time is spent ${COURT_WAIT[court]}. ` +
    `Across ${prs} merged pull ${plural(prs, 'request', 'requests')}, half cleared in ` +
    `${fmtHours(medianLeadHours)} and the slowest quarter took ${fmtHours(p75LeadHours)} or more.`
  );
}

/** The advice, once per court. See `CourtDirective` in shared for why it lives at this grain. */
function directiveFor(court: PrCourt, repos: number): string {
  const where = `${repos} ${plural(repos, 'repository', 'repositories')} here ${plural(repos, 'is', 'are')}`;
  switch (court) {
    case 'reviewer':
      return (
        `${where} spending most of a pull request's life waiting for a person to look — not on ` +
        `the author, and not on checks. That makes it a routing problem rather than a capacity ` +
        `one: request a named reviewer instead of a team, and chase the pull requests already ` +
        `past the marks below. Both are cheap, and both are the interventions with the largest ` +
        `measured effect on how long a pull request stays open.`
      );
    case 'author':
      return (
        `${where} spending most of a pull request's life waiting for its author to answer ` +
        `review. Reviewers are keeping up — the cost is in the round trip. Fewer, clearer review ` +
        `passes will do more here than asking anyone to go faster, and nothing on this screen is ` +
        `an argument about how quickly an individual replies.`
      );
    case 'landing':
      return (
        `${where} spending most of a pull request's life approved and waiting to merge. The ` +
        `review is already done, so this is the merge step and not a people problem. Arming ` +
        `"merge when ready" lands these without anyone watching them.`
      );
  }
}

function headlineFor(courts: CourtShare[], medianLead: number, p75Lead: number, prs: number): string {
  const by = new Map(courts.map((c) => [c.court, c.share]));
  const top = [...courts].sort((a, b) => b.share - a.share)[0];
  const lead =
    `Half of pull requests cleared in ${fmtHours(medianLead)}; the slowest quarter took ` +
    `${fmtHours(p75Lead)} or more.`;
  return (
    `Across ${prs} merged pull requests a person actually worked on, time split ` +
    `${pct(by.get('reviewer') ?? 0)} waiting for a reviewer, ` +
    `${pct(by.get('author') ?? 0)} waiting for the author, and ` +
    `${pct(by.get('landing') ?? 0)} approved and waiting to land. ` +
    `${lead}${top && top.share >= FLOW_DOMINANT_SHARE ? '' : ' No single court dominates here.'}`
  );
}

function sharesOf(h: CourtHours): CourtShare[] {
  const total = h.reviewer + h.author + h.landing;
  const s = (v: number): number => (total > 0 ? v / total : 0);
  return [
    { court: 'reviewer', hours: h.reviewer, share: s(h.reviewer) },
    { court: 'author', hours: h.author, share: s(h.author) },
    { court: 'landing', hours: h.landing, share: s(h.landing) },
  ];
}

// ── The query ────────────────────────────────────────────────────────────────────────────────

interface PrRow {
  id: number;
  repoId: number;
  number: number;
  title: string;
  authorId: number | null;
  openedMs: number;
  mergedMs: number;
}

export async function getFlowCourts(
  accountId: number,
  scope: BotScope,
  windowDaysRaw: number,
): Promise<FlowResponse> {
  const windowDays = Math.min(
    FLOW_MAX_WINDOW_DAYS,
    Math.max(FLOW_MIN_WINDOW_DAYS, Math.round(windowDaysRaw)),
  );
  const toMs = Date.now();
  const to = new Date(toMs);
  const from = new Date(toMs - windowDays * 24 * HOUR_MS);

  const refusals: FlowRefusal[] = [];
  const refuse = (
    kind: FlowRefusal['kind'],
    reason: string,
    basis: FlowRefusal['basis'] = 'insufficient_data',
  ): void => {
    refusals.push({ kind, reason, basis });
  };

  const empty = (coverage: FlowCoverage): FlowResponse => ({
    workspaceId: scope.workspaceId,
    windowDays,
    measuredPrs: 0,
    courts: sharesOf({ reviewer: 0, author: 0, landing: 0 }),
    medianLeadHours: 0,
    p75LeadHours: 0,
    headline: null,
    repos: [],
    directives: [],
    unreviewed: [],
    refusals,
    coverage,
  });

  // `[]` is a real answer ("this workspace is empty"), never a widening to the whole account.
  if (scope.repoIds.length === 0) {
    for (const k of ['courts', 'unreviewed'] as const) {
      refuse(k, 'This workspace has no repositories yet.');
    }
    return empty({
      reposInWorkspace: 0,
      reposWithData: 0,
      prsScanned: 0,
      truncated: false,
      excludedNoHumanTouch: 0,
      excludedBotAuthored: 0,
    });
  }

  const caps = { truncated: false };
  const noteCap = (rows: number, cap: number): void => {
    if (rows >= cap) caps.truncated = true;
  };

  const repoRows = await db
    .select({ id: repos.id, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), inArray(repos.id, scope.repoIds)))
    .execute();
  const repoName = new Map(repoRows.map((r) => [r.id, `${r.owner}/${r.name}`]));

  // Merged in-window. TWO-SIDED, half-open — the window-purity rule.
  const prRows = await db
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      title: pullRequests.title,
      authorId: pullRequests.authorId,
      openedAt: pullRequests.openedAt,
      mergedAt: pullRequests.mergedAt,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, scope.repoIds),
        eq(pullRequests.state, 'merged'),
        gte(pullRequests.mergedAt, from),
        lt(pullRequests.mergedAt, to),
      ),
    )
    .limit(FLOW_PR_CAP)
    .execute();
  noteCap(prRows.length, FLOW_PR_CAP);

  const prs: PrRow[] = [];
  for (const r of prRows) {
    if (r.openedAt == null || r.mergedAt == null) continue;
    const openedMs = r.openedAt.getTime();
    const mergedMs = r.mergedAt.getTime();
    if (!(mergedMs > openedMs)) continue;
    prs.push({
      id: r.id,
      repoId: r.repoId,
      number: r.number,
      title: r.title,
      authorId: r.authorId,
      openedMs,
      mergedMs,
    });
  }

  if (prs.length === 0) {
    for (const k of ['courts', 'unreviewed'] as const) {
      refuse(k, `No pull request merged in the last ${windowDays} days.`);
    }
    return empty({
      reposInWorkspace: scope.repoIds.length,
      reposWithData: 0,
      prsScanned: 0,
      truncated: caps.truncated,
      excludedNoHumanTouch: 0,
      excludedBotAuthored: 0,
    });
  }

  const byId = new Map(prs.map((p) => [p.id, p]));
  const prIds = prs.map((p) => p.id);
  const lanes: ActorLanes = await resolveActorLanes(accountId, scope);
  // ⚠ The lane resolver's UNION, never `users.isBot` alone — see the header.
  const isHuman = (userId: number | null): boolean =>
    userId != null && lanes.laneOf(userId) === 'human';

  const actions = new Map<number, CourtAction[]>();
  const push = (prId: number, a: CourtAction): void => {
    const list = actions.get(prId);
    if (list) list.push(a);
    else actions.set(prId, [a]);
  };

  for (const ids of chunk(prIds, ID_CHUNK)) {
    // Reviews. `state` carries the approval latch.
    const rvRows = await db
      .select({ prId: reviews.prId, authorId: reviews.authorId, at: reviews.submittedAt, state: reviews.state })
      .from(reviews)
      .where(inArray(reviews.prId, ids))
      .limit(FLOW_ACTION_CAP)
      .execute();
    noteCap(rvRows.length, FLOW_ACTION_CAP);
    for (const r of rvRows) {
      if (r.at == null || !isHuman(r.authorId)) continue;
      if (r.state === 'pending') continue;
      const pr = byId.get(r.prId);
      if (pr == null) continue;
      // A review by the pull request's OWN author is a self-comment, not somebody reviewing it.
      const self = r.authorId != null && r.authorId === pr.authorId;
      push(r.prId, {
        atMs: r.at.getTime(),
        by: self ? 'author' : 'reviewer',
        approves: !self && r.state === 'approved',
      });
    }

    // Inline review comments.
    const rcRows = await db
      .select({ prId: reviewComments.prId, authorId: reviewComments.authorId, at: reviewComments.createdAt })
      .from(reviewComments)
      .where(inArray(reviewComments.prId, ids))
      .limit(FLOW_ACTION_CAP)
      .execute();
    noteCap(rcRows.length, FLOW_ACTION_CAP);
    for (const r of rcRows) {
      if (r.at == null || !isHuman(r.authorId)) continue;
      const pr = byId.get(r.prId);
      if (pr == null) continue;
      push(r.prId, {
        atMs: r.at.getTime(),
        by: r.authorId === pr.authorId ? 'author' : 'reviewer',
        approves: false,
      });
    }

    // Conversation comments.
    const pcRows = await db
      .select({ prId: prComments.prId, authorId: prComments.authorId, at: prComments.createdAt })
      .from(prComments)
      .where(inArray(prComments.prId, ids))
      .limit(FLOW_ACTION_CAP)
      .execute();
    noteCap(pcRows.length, FLOW_ACTION_CAP);
    for (const r of pcRows) {
      if (r.at == null || !isHuman(r.authorId)) continue;
      const pr = byId.get(r.prId);
      if (pr == null) continue;
      push(r.prId, {
        atMs: r.at.getTime(),
        by: r.authorId === pr.authorId ? 'author' : 'reviewer',
        approves: false,
      });
    }

    // Pushes. A commit is ALWAYS an author action whoever authored it — the ball moves because new
    // code arrived on the branch, not because of whose name is on it.
    const cmRows = await db
      .select({ prId: commits.prId, at: commits.committedAt })
      .from(commits)
      .where(inArray(commits.prId, ids))
      .limit(FLOW_ACTION_CAP)
      .execute();
    noteCap(cmRows.length, FLOW_ACTION_CAP);
    for (const r of cmRows) {
      if (r.at == null) continue;
      push(r.prId, { atMs: r.at.getTime(), by: 'author', approves: false });
    }
  }

  // Author bot-ness. Read BY ID — `users` is one of the two GLOBAL tables and is never handed to a
  // tenant as a listing. ⚠ This is not decoration on the evidence rows: it GATES the population.
  const authorIds = [...new Set(prs.map((p) => p.authorId).filter((id): id is number => id != null))];
  const botAuthors = new Set<number>();
  for (const ids of chunk(authorIds, ID_CHUNK)) {
    const uRows = await db
      .select({ id: users.id, isBot: users.isBot })
      .from(users)
      .where(inArray(users.id, ids))
      .execute();
    for (const u of uRows) if (u.isBot || !isHuman(u.id)) botAuthors.add(u.id);
  }

  // ── Attribute ──────────────────────────────────────────────────────────────────────────────
  interface Measured {
    pr: PrRow;
    hours: CourtHours;
    leadHours: number;
  }
  const measured: Measured[] = [];
  const unreviewedByRepo = new Map<number, PrRow[]>();
  let excludedNoHumanTouch = 0;

  let excludedBotAuthored = 0;
  for (const pr of prs) {
    // ⚠ AUTOMATION'S OWN PULL REQUESTS ARE NOT THIS SCREEN'S SUBJECT. See
    // `FlowCoverage.excludedBotAuthored` — blending them moved every share and produced evidence
    // rows citing dependency bumps as things people were waiting on.
    if (pr.authorId != null && botAuthors.has(pr.authorId)) {
      excludedBotAuthored += 1;
      continue;
    }
    const acts = actions.get(pr.id) ?? [];
    const humanReviewed = acts.some((a) => a.by === 'reviewer');
    if (!humanReviewed) {
      // Decision 3: excluded from the split, reported as governance.
      excludedNoHumanTouch += 1;
      const list = unreviewedByRepo.get(pr.repoId);
      if (list) list.push(pr);
      else unreviewedByRepo.set(pr.repoId, [pr]);
      continue;
    }
    measured.push({
      pr,
      hours: walkCourts(pr.openedMs, pr.mergedMs, acts),
      leadHours: (pr.mergedMs - pr.openedMs) / HOUR_MS,
    });
  }

  // ⚠ The unreviewed-merge DENOMINATOR is the same human-authored population the shares are over.
  // Counting bot merges into it would report "30% of merges went in unreviewed" against a total
  // that includes work no human was ever meant to review.
  const mergedByRepo = new Map<number, number>();
  for (const pr of prs) {
    if (pr.authorId != null && botAuthors.has(pr.authorId)) continue;
    mergedByRepo.set(pr.repoId, (mergedByRepo.get(pr.repoId) ?? 0) + 1);
  }

  const coverage: FlowCoverage = {
    reposInWorkspace: scope.repoIds.length,
    reposWithData: new Set(prs.map((p) => p.repoId)).size,
    prsScanned: prs.length,
    truncated: caps.truncated,
    excludedNoHumanTouch,
    excludedBotAuthored,
  };

  if (measured.length === 0) {
    refuse(
      'courts',
      `No pull request merged in the last ${windowDays} days had a human review or comment on it, so there is no waiting time to attribute.`,
    );
  }

  // ── Workspace-wide ─────────────────────────────────────────────────────────────────────────
  const wsHours: CourtHours = { reviewer: 0, author: 0, landing: 0 };
  for (const m of measured) {
    wsHours.reviewer += m.hours.reviewer;
    wsHours.author += m.hours.author;
    wsHours.landing += m.hours.landing;
  }
  const wsCourts = sharesOf(wsHours);
  const wsLeads = measured.map((m) => m.leadHours);
  const wsMedian = median(wsLeads);
  const wsP75 = percentile(wsLeads, 0.75);

  // ── Per repo ───────────────────────────────────────────────────────────────────────────────
  const byRepo = new Map<number, Measured[]>();
  for (const m of measured) {
    const list = byRepo.get(m.pr.repoId);
    if (list) list.push(m);
    else byRepo.set(m.pr.repoId, [m]);
  }

  const ghUrl = (repoId: number, number: number): string =>
    `https://github.com/${repoName.get(repoId) ?? ''}/pull/${number}`;

  const evidenceOf = (rows: Measured[], court: PrCourt): CourtEvidencePr[] =>
    [...rows]
      .sort((a, b) => b.hours[court] - a.hours[court] || a.pr.id - b.pr.id)
      .slice(0, FLOW_EVIDENCE_CAP)
      .map((m) => ({
        prId: m.pr.id,
        repoFullName: repoName.get(m.pr.repoId) ?? '',
        prNumber: m.pr.number,
        prTitle: m.pr.title,
        githubUrl: ghUrl(m.pr.repoId, m.pr.number),
        hoursInCourt: m.hours[court],
        leadHours: m.leadHours,
        authorIsBot: m.pr.authorId != null && botAuthors.has(m.pr.authorId),
      }));

  let clearedFloor = 0;
  const profiles: RepoCourtProfile[] = [];
  for (const [repoId, rows] of byRepo) {
    if (rows.length < FLOW_MIN_REPO_PRS) continue;
    clearedFloor += 1;
    const h: CourtHours = { reviewer: 0, author: 0, landing: 0 };
    for (const m of rows) {
      h.reviewer += m.hours.reviewer;
      h.author += m.hours.author;
      h.landing += m.hours.landing;
    }
    const courts = sharesOf(h);
    const leads = rows.map((m) => m.leadHours);
    const p75 = percentile(leads, 0.75);
    const top = [...courts].sort((a, b) => b.share - a.share)[0];

    // ⚠ LOPSIDED **AND** SLOW. See FLOW_SLOW_P75_HOURS — a share alone invents a crisis in a repo
    // whose pull requests clear in eighteen minutes.
    const dominant: PrCourt | null =
      top != null && top.share >= FLOW_DOMINANT_SHARE && p75 >= FLOW_SLOW_P75_HOURS
        ? top.court
        : null;

    profiles.push({
      repoId,
      repoFullName: repoName.get(repoId) ?? '',
      prs: rows.length,
      courts,
      medianLeadHours: median(leads),
      p75LeadHours: p75,
      dominant,
      narrative:
        dominant == null ? null : narrate(dominant, top?.share ?? 0, rows.length, p75, median(leads)),
      evidence: dominant == null ? [] : evidenceOf(rows, dominant),
    });
  }

  // Worst first: a named court outranks a quiet repo, then by how slow the tail is.
  profiles.sort(
    (a, b) =>
      Number(b.dominant != null) - Number(a.dominant != null) ||
      b.p75LeadHours - a.p75LeadHours ||
      a.repoFullName.localeCompare(b.repoFullName),
  );
  const shownRepos = profiles.slice(0, FLOW_REPO_CAP);

  // One directive per court that actually has a repository under it, in a fixed order so the
  // screen does not reshuffle between polls.
  const COURT_ORDER: PrCourt[] = ['reviewer', 'author', 'landing'];
  const directives = COURT_ORDER.map((court) => ({
    court,
    repos: shownRepos.filter((r) => r.dominant === court).length,
  }))
    .filter((d) => d.repos > 0)
    .map((d) => ({ ...d, directive: directiveFor(d.court, d.repos) }));

  if (measured.length > 0 && clearedFloor === 0) {
    refuse(
      'courts',
      `No repository reached ${FLOW_MIN_REPO_PRS} merged pull requests with a human review in the last ${windowDays} days.`,
    );
  } else if (shownRepos.length > 0 && shownRepos.every((p) => p.dominant == null)) {
    refuse(
      'courts',
      `Measured ${clearedFloor} ${plural(clearedFloor, 'repository', 'repositories')} in the last ${windowDays} days; none was both lopsided towards one court and slow enough to act on.`,
      'measured_clean',
    );
  }

  // ── Merged without a human review ──────────────────────────────────────────────────────────
  const unreviewed: UnreviewedRepoStat[] = [];
  for (const [repoId, rows] of unreviewedByRepo) {
    const merged = mergedByRepo.get(repoId) ?? 0;
    if (merged === 0) continue;
    const share = rows.length / merged;
    if (rows.length < FLOW_UNREVIEWED_MIN_COUNT || share < FLOW_UNREVIEWED_MIN_SHARE) continue;
    unreviewed.push({
      repoId,
      repoFullName: repoName.get(repoId) ?? '',
      merged,
      withoutHumanReview: rows.length,
      share,
      evidence: [...rows]
        .sort((a, b) => b.mergedMs - a.mergedMs || a.id - b.id)
        .slice(0, FLOW_EVIDENCE_CAP)
        .map((pr) => ({
          prId: pr.id,
          repoFullName: repoName.get(pr.repoId) ?? '',
          prNumber: pr.number,
          prTitle: pr.title,
          githubUrl: ghUrl(pr.repoId, pr.number),
          hoursInCourt: 0,
          leadHours: (pr.mergedMs - pr.openedMs) / HOUR_MS,
          authorIsBot: pr.authorId != null && botAuthors.has(pr.authorId),
        })),
    });
  }
  unreviewed.sort((a, b) => b.share - a.share || a.repoFullName.localeCompare(b.repoFullName));

  if (unreviewed.length === 0) {
    refuse(
      'unreviewed',
      excludedNoHumanTouch === 0
        ? `Every pull request merged in the last ${windowDays} days had a human review or comment on it.`
        : `No repository merged enough pull requests without a human review to be worth naming (the floor is ${FLOW_UNREVIEWED_MIN_COUNT} and ${pct(FLOW_UNREVIEWED_MIN_SHARE)} of its merges).`,
      'measured_clean',
    );
  }

  return {
    workspaceId: scope.workspaceId,
    windowDays,
    measuredPrs: measured.length,
    courts: wsCourts,
    medianLeadHours: wsMedian,
    p75LeadHours: wsP75,
    headline:
      measured.length === 0 ? null : headlineFor(wsCourts, wsMedian, wsP75, measured.length),
    repos: shownRepos,
    directives,
    unreviewed,
    refusals,
    coverage,
  };
}

/** Exposed for the unit test — the floors a fixture has to clear or miss. */
export const __flowTesting = {
  FLOW_MIN_REPO_PRS,
  FLOW_DOMINANT_SHARE,
  FLOW_SLOW_P75_HOURS,
  FLOW_EVIDENCE_CAP,
  FLOW_UNREVIEWED_MIN_COUNT,
  FLOW_UNREVIEWED_MIN_SHARE,
  walkCourts,
  percentile,
  median,
  fmtHours,
  narrate,
};
