import type {
  BotVendorAnalytics,
  RepoReviewer,
  ReviewerIdentity,
} from '@pierre-review/shared';

// Pure shaping for the bot-reviewer listing. Everything here exists because the wire serves TWO
// GRAINS that the UI has to join without ever confusing them:
//
//   `DetectedReviewersResponse.reviewers`  one per ACTOR      — identity + price (account-wide)
//   `DetectedReviewersResponse.rows`       one per (repo, actor) — the judgement (this repo only)
//
// ⚠ A BOT IS A PER-REPO OBJECT AND THERE IS NO DEDUPLICATION. A vendor running in six repos is SIX
// rows and is MEANT to render as six entries, grouped by repo. That was asked and answered
// explicitly: a team whose repos each run `githubactions` shows `githubactions` once per repo.
// Nothing in this file collapses rows by userId, and nothing added to it should.
//
// ⚠ THE ONE THING THAT *MUST* BE DEDUPED IS MONEY. The price lives on the actor, so joining it
// onto six repo rows and summing the column turns one $120 subscription into $720. That is what
// `monthlyCostTotal` is for, and it is the only function here that keys on userId alone.
//
// Pure and exported so each rule is a test rather than a comment (test/botReviewers.test.ts) —
// the established pattern here (see lib/annotationRun.ts, lib/prRef.ts, lib/botCost.ts).

// ── Grouping ────────────────────────────────────────────────────────────────────────────────

/**
 * One repo's slice of the listing: its own judgement rows, split by role.
 *
 * The role split is per repo BY CONSTRUCTION now — `role` is a `repo_reviewers` column — so the
 * same login can legitimately sit under "Review bots" in one group and "Quality checks" in the
 * next. That is a feature (a linter that also posts review comments in one repo), not a state to
 * reconcile, so the groups are computed independently and never compared.
 */
export interface RepoReviewerGroup {
  repoId: number;
  /** `automated && role === 'review'` — the reviewers every bot metric counts. */
  reviewBots: RepoReviewer[];
  /** `automated && role === 'quality_check'` — coverage/lint/static analysis, excluded from ROI. */
  qualityChecks: RepoReviewer[];
  /**
   * `!automated && isManualOverride` — the rows a human explicitly marked "not a bot HERE".
   *
   * ⚠ THIS BUCKET EXISTS SO THE PIN STAYS VISIBLE. A manual row is one the classifier will never
   * re-derive, and "Not a bot here" produces exactly that — so without this bucket the row
   * disappeared from the only surface it could be edited from, leaving it pinned AND unreachable:
   * the search box could only offer to re-promote it (another manual write), never to hand it back
   * to detection. That is the "no way back" failure this whole reset pass exists to close, in the
   * one case where it is invisible as well as permanent.
   *
   * ⚠ AUTO non-automated rows are still excluded, and must stay excluded. Every ordinary human
   * commenter has one (the row IS the bot object, so the classifier writes a low-confidence "not
   * automated" row for each), and listing them would bury the handful of deliberate ones under the
   * whole contributor roster. They are reached through `humanCandidates`, which is where a human
   * is a useful thing to look at.
   *
   * These rows DO also remain `humanCandidates` — search-by-name is how you find one when you
   * cannot remember which repo you dismissed it in — so the two surfaces offer the two different
   * actions: promote it again from search, or hand it back to detection from here.
   *
   * ⚠ THIS BUCKET IS ALSO THE ONLY WAY BACK for a manually-RENAMED actor that is automated in no
   * repo. `actorSummaries` skips an actor with no automated row, and the account-wide card it
   * builds is the only home of "Reset name to auto" — so renaming a bot and then marking it "not a
   * bot" in its last repo makes that card, and the identity reset with it, disappear while the
   * identity stays pinned to `manual`. Resetting or re-promoting the row from HERE brings the
   * actor (and its reset control) straight back, which is what keeps that a detour rather than the
   * permanent pin the reset routes exist to abolish. Do not "tidy" this bucket away.
   */
  markedNotBots: RepoReviewer[];
}

/**
 * Group the judgement rows by repo, in the order the server said to render them.
 *
 * ⚠ EVERY `repoId` GETS A GROUP, INCLUDING AN EMPTY ONE. A repo in scope with no detected
 * reviewer is a real, useful answer ("nothing automated has spoken here yet") and dropping it
 * would make that indistinguishable from the repo not being in scope at all.
 *
 * ⚠ A ROW WHOSE REPO IS NOT IN `repoIds` IS APPENDED, NEVER DROPPED. The server is the authority
 * on both lists and they should agree; if they ever don't, showing an unexpected group is a
 * visible bug, whereas silently swallowing rows is an invisible one — and this listing is the only
 * surface from which a stored judgement can be edited, so a hidden row is an unreachable setting.
 * Appended (not interleaved) so the server's stated order still governs the normal case.
 *
 * AUTO non-automated rows are deliberately absent from all three buckets: they are the "this is
 * an ordinary human" answers the classifier writes for every commenter, and they are reached
 * through `humanCandidates` instead, which is the only place they are useful. A MANUAL one is a
 * different thing entirely — a judgement someone recorded and the classifier now honours forever —
 * so it lands in `markedNotBots` and stays visible. See that field for what went wrong without it.
 */
export function groupRowsByRepo(
  rows: readonly RepoReviewer[],
  repoIds: readonly number[],
): RepoReviewerGroup[] {
  const groups = new Map<number, RepoReviewerGroup>();
  const order: number[] = [];
  const ensure = (repoId: number): RepoReviewerGroup => {
    let g = groups.get(repoId);
    if (g == null) {
      g = { repoId, reviewBots: [], qualityChecks: [], markedNotBots: [] };
      groups.set(repoId, g);
      order.push(repoId);
    }
    return g;
  };
  for (const id of repoIds) ensure(id);
  for (const r of rows) {
    if (!r.automated) {
      // Only the DELIBERATE ones. An auto "not a bot" row is every human in the account.
      if (r.isManualOverride) ensure(r.repoId).markedNotBots.push(r);
      continue;
    }
    const g = ensure(r.repoId);
    if (r.role === 'quality_check') g.qualityChecks.push(r);
    else g.reviewBots.push(r);
  }
  return order.map((id) => groups.get(id) as RepoReviewerGroup);
}

/** Identity lookup by actor. The join key between the two grains is always `userId`. */
export function identityIndex(
  reviewers: readonly ReviewerIdentity[],
): Map<number, ReviewerIdentity> {
  return new Map(reviewers.map((r) => [r.userId, r]));
}

// ── Actor summaries (the account-wide half of the screen) ───────────────────────────────────

/**
 * One actor, plus WHERE it is automated. Drives the identity + price section, which is rendered
 * ONCE per actor above the per-repo groups — because kind, label and price are the same in every
 * repo by definition, and putting an editor for them on each repo row is how a user comes to
 * believe they are renaming one copy.
 */
export interface ActorSummary {
  identity: ReviewerIdentity;
  /** Repos where this actor has an `automated` row, in the listing's repo order. */
  repoIds: number[];
  /** Of those, how many treat it as a review bot vs a quality check. Both can be non-zero. */
  reviewRepoCount: number;
  qualityRepoCount: number;
}

/**
 * Every actor that is automated in at least one in-scope repo, with the repos it is automated in.
 *
 * Ordered by descending repo footprint then login, so the bot that is everywhere sorts first —
 * that is the one whose price and vendor name matter most, and the one a user is most likely to
 * be looking for.
 *
 * An identity with no automated row anywhere is NOT here: it is either a human (reachable through
 * `humanCandidates`) or a stale identity row, and either way there is nothing account-wide to say
 * about it.
 */
export function actorSummaries(
  reviewers: readonly ReviewerIdentity[],
  rows: readonly RepoReviewer[],
  repoIds: readonly number[],
): ActorSummary[] {
  const rank = new Map(repoIds.map((id, i) => [id, i]));
  const byUser = new Map<number, { repoIds: number[]; review: number; quality: number }>();
  for (const r of rows) {
    if (!r.automated) continue;
    let e = byUser.get(r.userId);
    if (e == null) {
      e = { repoIds: [], review: 0, quality: 0 };
      byUser.set(r.userId, e);
    }
    e.repoIds.push(r.repoId);
    if (r.role === 'quality_check') e.quality += 1;
    else e.review += 1;
  }
  const out: ActorSummary[] = [];
  for (const identity of reviewers) {
    const e = byUser.get(identity.userId);
    if (e == null) continue;
    out.push({
      identity,
      // A repo absent from `repoIds` (see groupRowsByRepo's append rule) sorts last rather than
      // first, which `?? -1` would do.
      repoIds: [...e.repoIds].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity)),
      reviewRepoCount: e.review,
      qualityRepoCount: e.quality,
    });
  }
  out.sort(
    (a, b) =>
      b.repoIds.length - a.repoIds.length ||
      a.identity.login.localeCompare(b.identity.login),
  );
  return out;
}

// ── Money ───────────────────────────────────────────────────────────────────────────────────

export interface MonthlyCostTotal {
  /** Sum over DISTINCT actors. Null when no in-scope actor has a price at all. */
  totalUsd: number | null;
  /** How many distinct actors carry a price (0 included — 0 is a real price). */
  pricedActors: number;
  /** Distinct automated actors with no price recorded — the gap the caption should name. */
  unpricedActors: number;
}

/**
 * What the automated reviewers in scope cost per month, IN TOTAL.
 *
 * ⚠ THIS IS THE FUNCTION THE WHOLE FILE EXISTS FOR. The listing is one row per (repo, actor) and
 * the price hangs off the actor, so the obvious implementation — sum `costMonthlyUsd` across the
 * rendered rows — reports six CodeRabbit repos as $720 of spend when the invoice says $120. No
 * schema can prevent that (there is no per-repo price column to be wrong); only this dedupe can.
 *
 * ⚠ 0 IS A PRICE, NOT AN ABSENCE. An actor recorded as free counts toward `pricedActors` and
 * contributes 0 to the total; it must not be counted as unpriced, or "3 of 5 bots have no price"
 * becomes a nag about a bot someone deliberately marked free.
 *
 * `totalUsd` is null (not 0) when nothing is priced, so the caller can say "no prices set" rather
 * than printing a confident $0.
 */
export function monthlyCostTotal(
  reviewers: readonly ReviewerIdentity[],
  rows: readonly RepoReviewer[],
): MonthlyCostTotal {
  const automatedActors = new Set<number>();
  for (const r of rows) if (r.automated) automatedActors.add(r.userId);
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  for (const identity of reviewers) {
    if (!automatedActors.has(identity.userId)) continue;
    if (identity.costMonthlyUsd == null) {
      unpriced += 1;
      continue;
    }
    priced += 1;
    total += identity.costMonthlyUsd;
  }
  return {
    // Re-round to the cent: summing binary64 dollars accumulates representation error
    // ($0.10 + $0.20 = $0.30000000000000004), which would print as a nonsense total.
    totalUsd: priced === 0 ? null : Math.round(total * 100) / 100,
    pricedActors: priced,
    unpricedActors: unpriced,
  };
}

// ── Promoting a human ───────────────────────────────────────────────────────────────────────

/**
 * A human (or as-yet-unclassified actor) that could be marked automated, and the repos where
 * marking them would mean anything.
 *
 * ⚠ THE REPO LIST IS THE POINT. "Mark as a bot" is a per-repo judgement now, so a promote control
 * with no repo attached has no row to write. Offering the repos where the actor actually has a
 * footprint is what keeps the gesture honest — and stops the UI inventing rows for repos the
 * reviewer has never touched, which is a fabricated bot object, not a bot object.
 */
export interface HumanCandidate {
  identity: ReviewerIdentity;
  /** Repos where this actor has a (non-automated) row, in the listing's repo order. */
  repoIds: number[];
}

export function humanCandidates(
  reviewers: readonly ReviewerIdentity[],
  rows: readonly RepoReviewer[],
  query: string,
  limit: number,
  repoIds: readonly number[] = [],
): HumanCandidate[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const rank = new Map(repoIds.map((id, i) => [id, i]));
  const automatedActors = new Set<number>();
  const humanRepos = new Map<number, number[]>();
  for (const r of rows) {
    if (r.automated) {
      automatedActors.add(r.userId);
      continue;
    }
    const list = humanRepos.get(r.userId);
    if (list == null) humanRepos.set(r.userId, [r.repoId]);
    else list.push(r.repoId);
  }
  const out: HumanCandidate[] = [];
  for (const identity of reviewers) {
    // Automated ANYWHERE ⇒ not a candidate: it already has a row in the lists above, where its
    // per-repo judgement is editable. Promoting it again from the search box would be a second,
    // competing control for the same fact.
    if (automatedActors.has(identity.userId)) continue;
    const repos = humanRepos.get(identity.userId);
    if (repos == null || repos.length === 0) continue;
    const hay = `${identity.login} ${identity.displayName ?? ''}`.toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      identity,
      repoIds: [...repos].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity)),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Empty state ─────────────────────────────────────────────────────────────────────────────

/**
 * An empty listing means two different things and looks like one. `repoIds` is what tells them
 * apart — which is exactly why the response carries the id LIST and not a count:
 *
 *   'no-repos'     — nothing in scope. The fix is to add or show repos; no amount of syncing helps.
 *   'no-reviewers' — repos in scope, but no automated reviewer has been seen in any of them yet.
 *                    The fix is to sync/wait.
 *
 * ⚠ A MANUAL "not a bot" ROW COUNTS AS CONTENT, not as emptiness. It is not automated, so the
 * obvious `rows.some(r => r.automated)` renders the empty state over a screen that has something
 * on it — and worse, the thing it hides is a PIN the classifier honours forever, whose only reset
 * control lives in the list being hidden. An account that marked its one detected bot "not a bot
 * here" would land on "no automated reviewers seen yet" with no way back at all.
 */
export type ReviewerListEmptyKind = 'no-repos' | 'no-reviewers' | null;

export function reviewerListEmptyKind(
  repoIds: readonly number[],
  rows: readonly RepoReviewer[],
): ReviewerListEmptyKind {
  if (repoIds.length === 0) return 'no-repos';
  return rows.some((r) => r.automated || r.isManualOverride) ? null : 'no-reviewers';
}

/**
 * The sentence shown in place of the list.
 *
 * ⚠ NEITHER STRING MAY POINT AT THE SEARCH BOX, which is the trap this function exists to keep
 * shut. The "Add a review bot" search filters the SAME (empty) listing, so on any screen this copy
 * can appear it could only ever render a box that matches nobody. Copy, not markup, so the rule is
 * testable.
 */
export function emptyStateCopy(kind: 'no-repos' | 'no-reviewers', repoCount: number): string {
  if (kind === 'no-repos') {
    return 'No repos in scope. Add one — or widen the repo/team filter — and its automated reviewers appear here.';
  }
  return `No automated reviewers seen yet in ${repoCount} repo${repoCount === 1 ? '' : 's'} — they appear here once one has reviewed or commented on a PR we’ve synced.`;
}

// ── ROI: one actor, two roles ───────────────────────────────────────────────────────────────

/**
 * The analytics rows that appear in BOTH the ROI table and the excluded "quality checks" section.
 *
 * ⚠ THIS IS A LEGITIMATE STATE, NOT A SERVER BUG. `role` is a `repo_reviewers` column, so a login
 * can be a review bot in `api` and a quality gate in `infra`. Under a multi-repo scope the server
 * therefore has a reviewer whose role is not single-valued, and whichever way it splits the
 * aggregate, one of the two numbers is over a subset of that reviewer's work.
 *
 * The panel does NOT try to reconcile that — it cannot, from an aggregate — it LABELS it, keyed on
 * the analytics row `key` (`u<userId>` / 'pierre'), which is the identity both lists use. A quiet
 * marker on the affected rows says "this bot is roled differently in different repos, so this row
 * covers only part of its work", which is the honest statement and points at the per-repo Settings
 * list where the roles actually live.
 *
 * Matching on `key` and not `login` is deliberate: `login` is nullable on an analytics row and two
 * unresolved logins would both be null and falsely collide.
 */
export function mixedRoleRowKeys(
  vendors: readonly Pick<BotVendorAnalytics, 'key'>[],
  qualityChecks: readonly Pick<BotVendorAnalytics, 'key'>[],
): Set<string> {
  const inVendors = new Set(vendors.map((v) => v.key));
  const out = new Set<string>();
  for (const q of qualityChecks) if (inVendors.has(q.key)) out.add(q.key);
  return out;
}
