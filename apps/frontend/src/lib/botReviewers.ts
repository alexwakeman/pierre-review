import type { WorkspaceReviewer } from '@pierre-review/shared';

// Pure shaping for the bot-reviewer listing of ONE WORKSPACE.
//
// ── ONE ROW PER ACTOR, AND THE WORKSPACE IS THE GRAIN ───────────────────────────────────────
// `DetectedReviewersResponse.reviewers` is a FLAT list of `WorkspaceReviewer`s — one per actor in
// the selected workspace — and each row carries, together, everything the UI used to have to join:
// the judgement (`automated` / `role`), the identity (`kind` / `label`), the price
// (`costMonthlyUsd`) and the evidence behind them (`footprint` + `repoFootprints`).
//
// That replaced a two-grain wire (`rows`, one per (repo, actor) + `reviewers`, one per actor) and
// with it the entire join this file existed to perform. A vendor running in six of the workspace's
// repos is now ONE row whose `repoFootprints` names all six; it is not six rows to group, and
// `groupRowsByRepo` / `identityIndex` / `actorSummaries` / `mixedRoleRowKeys` are gone rather than
// renamed — there is nothing left for them to reconcile.
//
// ── THE ONE RULE THAT SURVIVED THE COLLAPSE ─────────────────────────────────────────────────
// Money is still deduped by `userId` in `monthlyCostTotal`. Within one workspace that dedupe is a
// no-op — the server emits one row per actor — and it is kept deliberately as the cheap standing
// guard that this figure is never handed two workspaces' listings at once. Price is a PER-WORKSPACE
// fact now, so summing across workspaces is not a bigger total, it is a category error: six
// workspaces each listing a $120 CodeRabbit is either six subscriptions or one seen six ways, and
// nothing in this app may assert which.
//
// ── AND THE ONE THAT CHANGED SHAPE ──────────────────────────────────────────────────────────
// "Marked not a bot" is now `!automated && (isManualOverride || identitySource === 'manual')`. The
// second disjunct is not defensive padding: `isManualOverride` is `source === 'manual'`, and a
// RENAMED actor carries `identitySource === 'manual'` with `source === 'auto'`. Without it, an
// actor someone named and then marked "not a bot" would sit in NO bucket, invisible, with its
// identity pinned to manual and its "Reset name" control unreachable — the exact known gap this
// refactor claims to have closed.
//
// Pure and exported so each rule is a test rather than a comment (test/botReviewers.test.ts) —
// the established pattern here (see lib/annotationRun.ts, lib/prRef.ts, lib/botCost.ts).

// ── Buckets ─────────────────────────────────────────────────────────────────────────────────

/**
 * The three sub-lists the Settings surface renders, in render order.
 *
 * The split is per WORKSPACE by construction — `role` is one column on one row — so a login is a
 * review bot or a quality check here, never both. (Under the old per-repo grain it could legally
 * be one in `api` and the other in `infra`, which is why nothing compared the two lists. That
 * state is now unrepresentable.)
 */
export interface ReviewerBuckets {
  /** `automated && role === 'review'` — the reviewers every bot metric counts. */
  reviewBots: WorkspaceReviewer[];
  /** `automated && role === 'quality_check'` — coverage/lint/static analysis, excluded from ROI. */
  qualityChecks: WorkspaceReviewer[];
  /**
   * The rows a human deliberately pinned as NOT automated in this workspace.
   *
   * ⚠ THIS BUCKET EXISTS SO THE PIN STAYS VISIBLE. A manual row is one the classifier will never
   * re-derive, and "Not a bot" produces exactly that — so without this bucket the row disappears
   * from the only surface it can be edited from, leaving it pinned AND unreachable: the search box
   * could only offer to re-promote it (another manual write), never to hand it back to detection.
   *
   * ⚠ AUTO non-automated rows are still excluded, and must stay excluded. Every ordinary human
   * commenter has one (the row IS the bot object, so the classifier writes a low-confidence "not
   * automated" row for each), and listing them would bury the handful of deliberate ones under the
   * whole contributor roster. They are reached through `humanCandidates`, which is where a human
   * is a useful thing to look at.
   *
   * ⚠ THE `identitySource === 'manual'` DISJUNCT IS LOAD-BEARING. See the file header: a renamed
   * actor that is automated nowhere has `source === 'auto'`, so testing `isManualOverride` alone
   * files it under no bucket at all and strands its "Reset name" control.
   */
  markedNotBots: WorkspaceReviewer[];
}

/** Whether a reviewer appears in any of the three lists at all — the buckets' own predicate. */
function isListed(r: WorkspaceReviewer): boolean {
  return r.automated || r.isManualOverride || r.identitySource === 'manual';
}

/**
 * Split one workspace's listing into the three lists, preserving the server's order within each.
 *
 * ⚠ ITS PREDICATE AND `reviewerListEmptyKind`'S MUST AGREE. They are the same `isListed` test for
 * exactly that reason: if the empty state used a narrower rule it would paint "no automated
 * reviewers seen yet" over a screen that has a pinned row on it — and the thing it hid would be a
 * judgement the classifier honours forever, whose only reset control lives in the list being
 * hidden.
 */
export function bucketReviewers(reviewers: readonly WorkspaceReviewer[]): ReviewerBuckets {
  const out: ReviewerBuckets = { reviewBots: [], qualityChecks: [], markedNotBots: [] };
  for (const r of reviewers) {
    if (!r.automated) {
      // Only the DELIBERATE ones — a judgement pinned by hand, or an actor a human named.
      if (r.isManualOverride || r.identitySource === 'manual') out.markedNotBots.push(r);
      continue;
    }
    if (r.role === 'quality_check') out.qualityChecks.push(r);
    else out.reviewBots.push(r);
  }
  return out;
}

// ── The per-repo Bots tab's filter ──────────────────────────────────────────────────────────

/**
 * The workspace's reviewers that have actually touched `repoId`.
 *
 * ⚠ THIS IS A DISPLAY FILTER, NOT A SCOPE. The per-repo Bots tab fetches the WHOLE workspace
 * listing and narrows here, on purpose: every edit on that panel is workspace-wide — it is
 * literally the same row — so each card has to be able to show its full `repoFootprints[]`, i.e.
 * the real blast radius. Asking the server for `repoIds: [repoId]` would leave exactly one entry
 * in that array and reduce the disclosure to a line of copy asserting something the UI cannot
 * show. (It would also fragment the cache away from the workspace-wide entry every colour, vendor
 * tag and thread filter shares — see `detectedReviewersQueryKey`.)
 *
 * A reviewer with no footprint here is omitted rather than shown at zero: a judgement is a
 * workspace fact, and listing it under a repo it has never touched invites the reading that the
 * row is about that repo.
 */
export function reviewersWithFootprintIn(
  reviewers: readonly WorkspaceReviewer[],
  repoId: number,
): WorkspaceReviewer[] {
  return reviewers.filter((r) => r.repoFootprints.some((f) => f.repoId === repoId));
}

// ── Money ───────────────────────────────────────────────────────────────────────────────────

export interface MonthlyCostTotal {
  /** Sum over DISTINCT actors. Null when no automated reviewer here has a price at all. */
  totalUsd: number | null;
  /** How many distinct actors carry a price (0 included — 0 is a real price). */
  pricedActors: number;
  /** Distinct automated actors with no price recorded — the gap the caption should name. */
  unpricedActors: number;
}

/**
 * What the automated reviewers of ONE WORKSPACE cost per month, in total.
 *
 * ⚠ ONE WORKSPACE. Not one repo, not the account. The price on each row is what that bot costs in
 * this workspace; the same vendor's row in the next workspace may hold a different number, or
 * none, and the two must never be added together (§0 of the workspace contract: it would be
 * asserting six subscriptions where there may be one). Hand this function a single
 * `DetectedReviewersResponse.reviewers` array and nothing else.
 *
 * ⚠ IT SUMS THE SERVER'S `effectiveMonthlyUsd`, NEVER `costMonthlyUsd`. Under 'per_seat' the
 * stored number is a per-seat UNIT, and the server has already multiplied it by the workspace's
 * derived seat count on read — multiplying here too would double-charge, and summing the raw unit
 * would under-state. Exactly one place does that arithmetic, and it is not the client.
 * (`effectiveMonthlyUsd` is null exactly when `costMonthlyUsd` is, so the priced/unpriced split
 * is unchanged.)
 *
 * ⚠ THE DEDUPE BY `userId` IS KEPT THOUGH IT IS NOW TRIVIALLY SATISFIED. The server emits exactly
 * one row per actor per workspace, so it can never fire — which is precisely what makes it a cheap
 * standing invariant: the day someone concatenates two workspaces' listings to "show everything",
 * the total does not silently double.
 *
 * ⚠ 0 IS A PRICE, NOT AN ABSENCE. A bot recorded as free counts toward `pricedActors` and
 * contributes 0 to the total; it must not be counted as unpriced, or "3 of 5 bots have no price"
 * becomes a nag about a bot someone deliberately marked free.
 *
 * `totalUsd` is null (not 0) when nothing is priced, so the caller can say "no prices set" rather
 * than printing a confident $0.
 */
export function monthlyCostTotal(reviewers: readonly WorkspaceReviewer[]): MonthlyCostTotal {
  const seen = new Set<number>();
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  for (const r of reviewers) {
    if (!r.automated) continue;
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    if (r.effectiveMonthlyUsd == null) {
      unpriced += 1;
      continue;
    }
    priced += 1;
    total += r.effectiveMonthlyUsd;
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
 * Reviewers this workspace currently treats as human, matching a search string.
 *
 * ⚠ IT TAKES NO REPO LIST ANY MORE, AND THE GESTURE IT FEEDS TAKES NO REPO EITHER. "Mark as a bot"
 * is one workspace-wide write against the row that already exists for this actor, so there is no
 * repo to pick and no row to fabricate — the old per-repo button set (and the fabricated-bot-object
 * hazard it guarded against) went with the grain.
 *
 * A row a human pinned as "not a bot" IS still a candidate: search-by-name is how you find one you
 * cannot remember dismissing, and the two surfaces then offer the two different actions — promote
 * it again from here, or hand it back to detection from the marked-not-bots list.
 */
export function humanCandidates(
  reviewers: readonly WorkspaceReviewer[],
  query: string,
  limit: number,
): WorkspaceReviewer[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const out: WorkspaceReviewer[] = [];
  for (const r of reviewers) {
    // Automated already ⇒ not a candidate: it has a card in the lists above, where its judgement
    // is editable. Promoting it from the search box would be a second, competing control for one
    // fact.
    if (r.automated) continue;
    const hay = `${r.login} ${r.displayName ?? ''}`.toLowerCase();
    if (!hay.includes(q)) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// ── Empty state ─────────────────────────────────────────────────────────────────────────────

/**
 * An empty listing means two different things and looks like one. `repoIds` is what tells them
 * apart — which is exactly why the response carries the id LIST and not a count:
 *
 *   'no-repos'     — the workspace has no repos. The fix is to move some in; syncing cannot help.
 *   'no-reviewers' — repos in the workspace, but no automated reviewer has been seen in any of
 *                    them yet. The fix is to sync/wait.
 *
 * ⚠ A PINNED ROW COUNTS AS CONTENT, not as emptiness — hence the shared `isListed` predicate. A
 * workspace that marked its one detected bot "not a bot" would otherwise land on "no automated
 * reviewers seen yet" with the pin, and its reset control, hidden behind that sentence.
 */
export type ReviewerListEmptyKind = 'no-repos' | 'no-reviewers' | null;

export function reviewerListEmptyKind(
  reviewers: readonly WorkspaceReviewer[],
  repoIds: readonly number[],
): ReviewerListEmptyKind {
  if (repoIds.length === 0) return 'no-repos';
  return reviewers.some(isListed) ? null : 'no-reviewers';
}

/**
 * The sentence shown in place of the list.
 *
 * ⚠ NEITHER STRING MAY POINT AT THE SEARCH BOX, which is the trap this function exists to keep
 * shut. The "Add a review bot" search filters the SAME (empty) listing, so on any screen this copy
 * can appear it could only ever render a box that matches nobody. Copy, not markup, so the rule is
 * testable.
 *
 * The 'no-repos' string names the ONE place a repo's workspace can be changed, because under a
 * one-workspace-per-repo model there is nothing to add here — the repos exist, they are simply
 * somewhere else.
 */
export function emptyStateCopy(kind: 'no-repos' | 'no-reviewers', repoCount: number): string {
  if (kind === 'no-repos') {
    return 'No repos in this Workspace — move some in from Manage repos & workspaces, and their automated reviewers appear here.';
  }
  return `No automated reviewers seen yet in this Workspace’s ${repoCount} repo${repoCount === 1 ? '' : 's'} — they appear here once one has reviewed or commented on a PR we’ve synced.`;
}
