import { useMemo, useState } from 'react';
import type {
  AutomatedReviewerKind,
  ReviewerRole,
  WorkspaceReviewer,
  WorkspaceReviewerPatchBody,
} from '@pierre-review/shared';
import { automatedReviewerMeta, BOT_VENDOR_META } from '../../lib/ui.js';
import {
  costEditOutcome,
  costStateOf,
  buildCostBody,
  formatCostInput,
  parseCostInput,
  type CostState,
} from '../../lib/botCost.js';
import {
  bucketReviewers,
  emptyStateCopy,
  humanCandidates,
  monthlyCostTotal,
  reviewerListEmptyKind,
  reviewersWithFootprintIn,
} from '../../lib/botReviewers.js';
import {
  useDetectedReviewers,
  useResetReviewerIdentity,
  useResetReviewerJudgement,
  useSetReviewerCost,
  useSetWorkspaceReviewer,
} from '../../hooks/useBotTriage.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { SectionShell, inputCls } from './ui.js';

const ALL_KINDS = Object.keys(BOT_VENDOR_META) as AutomatedReviewerKind[];
const MAX_SEARCH_MATCHES = 8;
// How many repo chips a card prints before collapsing to "+N more". The full list stays in the
// element's `title`, so the blast radius is never actually hidden — only wrapped.
const MAX_REPO_CHIPS = 8;

// The shared `inputCls` carries `w-full`, and Tailwind emits `.w-full` AFTER `.w-32`/`.w-auto`,
// so appending a width to it does nothing — the vendor picker and label box stretched edge to edge
// and the row read as a form, not a list. This is the same chrome with the width left off.
const FIELD_CLS =
  'rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-sky-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100';

/** Everything a card can write, minus the key the parent already holds. */
type ReviewerPatch = Omit<WorkspaceReviewerPatchBody, 'workspaceId'>;

type BotColorFn = (bot: { login?: string | null; kind: AutomatedReviewerKind }) => string;

// The bot-reviewer settings surface. CORE (free) — no capability gate.
//
// ── ONE CARD PER BOT, AND THE WORKSPACE IS THE ONLY SCOPE ───────────────────────────────────
// A bot is configured once per Workspace. `judgement` (is it automated, is it reviewing or
// quality-checking), `identity` (which vendor, what to call it) and `price` are all facts about the
// SAME key — (account, workspace, actor) — so they all live on one `workspace_reviewers` row and
// they are all edited on one card. A vendor running in six of the Workspace's repos is ONE card
// whose repo chips name all six.
//
// This replaced a two-section layout — an account-wide identity/price section above a per-repo
// judgement section — that existed only because those two facts sat at two different grains, in
// two tables, with two write routes. With one grain there is nothing to keep apart on screen:
// splitting the card would now be splitting a single row, which is how a user comes to believe
// there are two things to edit.
//
// ── WHAT DID *NOT* COLLAPSE: THE TWO PROVENANCE FLAGS ───────────────────────────────────────
// `source` owns automated/role/confidence/reasons; `identitySource` owns kind/label. They are
// stamped INDEPENDENTLY, and that independence is now the only thing doing the job the two tables
// used to do — there is no table boundary left to catch a write that pins one half because the
// user edited the other. Concretely: pressing "Not a bot" must not un-name the vendor, and saving
// a vendor name must not freeze the classification. So each half gets its OWN reset, offered only
// where its own flag is manual:
//
//   "Reset classification"  iff `isManualOverride`            → automated / role / confidence
//   "Reset name"            iff `identitySource === 'manual'` → kind / label, PRICE KEPT
//
// Gating them is not tidiness: a reset on an already-auto half does nothing, and a control that
// appears to do nothing is indistinguishable from a broken one. Each is the ONLY way back —
// flipping a value by hand re-stamps 'manual' and leaves it just as frozen, on the new value.
//
// ── PRICE IS PER WORKSPACE, AND THE LABEL SAYS SO ───────────────────────────────────────────
// "Price for this Workspace", never a bare "Price". Editing CodeRabbit's price here leaves every
// other Workspace untouched, and they may legitimately hold different numbers — nothing reconciles
// them and nothing is meant to. Within this Workspace there is exactly one row per bot, so the
// footer total is a plain sum; across Workspaces it is not a sum at all and no surface may add
// them up.
//
// ── THE REPO NARROWING IS A DISPLAY FILTER, NOT A SCOPE ─────────────────────────────────────
// `repoId` filters the cards CLIENT-SIDE (`reviewersWithFootprintIn`) over the full Workspace
// listing. It deliberately does NOT narrow the request: every control here writes the
// Workspace-wide row, so each card has to be able to show its whole repo footprint — the real
// blast radius — and a server-narrowed response would leave one chip behind a promise the UI
// cannot back up. It also keeps this screen on the same cache entry as the bot colour map.
export function DetectedReviewersTable({
  workspaceId,
  repoId,
}: {
  /** The Workspace whose bots are being configured. `null` while the store is still resolving. */
  workspaceId: number | null;
  /** Optional DISPLAY filter: show only bots with a footprint in this repo. Never a write scope. */
  repoId?: number;
}): JSX.Element {
  // No `repoIds`: the listing is always fetched Workspace-wide (see the header). That is also what
  // keeps this screen sharing one warm cache entry with `useBotColors`.
  const q = useDetectedReviewers(workspaceId);
  const { data: repos } = useRepos();
  // Colour resolver for THIS Workspace — identity is per Workspace now, so an unscoped resolver
  // would paint these bots from some other Workspace's vendor names.
  const botColor = useBotColors(workspaceId);

  const patch = useSetWorkspaceReviewer();
  const cost = useSetReviewerCost();
  const resetJudgement = useResetReviewerJudgement();
  const resetIdentity = useResetReviewerIdentity();
  const busy =
    patch.isPending || cost.isPending || resetJudgement.isPending || resetIdentity.isPending;

  const [query, setQuery] = useState('');

  const reviewers = useMemo(() => q.data?.reviewers ?? [], [q.data]);
  const listRepoIds = useMemo(() => q.data?.repoIds ?? [], [q.data]);

  // The cards on screen. Filtered for the per-repo tab; the numbers below are deliberately NOT.
  const shown = useMemo(
    () => (repoId == null ? reviewers : reviewersWithFootprintIn(reviewers, repoId)),
    [reviewers, repoId],
  );
  const buckets = useMemo(() => bucketReviewers(shown), [shown]);
  // ⚠ TOTALLED OVER THE WHOLE WORKSPACE, NOT OVER `shown`. The price is a Workspace fact; a total
  // over a repo-filtered subset would read as "this repo costs $X", which is a number this product
  // does not have and must not imply.
  const costTotal = useMemo(() => monthlyCostTotal(reviewers), [reviewers]);
  const repoName = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of repos ?? []) m.set(r.id, r.fullName);
    return m;
  }, [repos]);

  // Searched over the WHOLE Workspace: promoting is a Workspace-wide write, so restricting the
  // search to one repo's actors would hide people the gesture can legitimately reach.
  const matches = useMemo(
    () => humanCandidates(reviewers, query, MAX_SEARCH_MATCHES),
    [reviewers, query],
  );

  const emptyKind = reviewerListEmptyKind(reviewers, listRepoIds);
  const anyError =
    patch.error ?? cost.error ?? resetJudgement.error ?? resetIdentity.error;

  const title = 'Review bots';
  const desc =
    'Who counts as an automated reviewer in this Workspace, who each bot is, and what it costs here. Every setting below applies to the whole Workspace.';

  // `workspaceId` is null only while the store resolves its Default. The listing hook holds the
  // query idle in that state (skipToken), so `isLoading` is false and the empty-state branch would
  // otherwise claim "no repos in this Workspace" before anything had been asked. Handled here so
  // the rest of the component can treat the id as a number.
  if (workspaceId == null) {
    return (
      <SectionShell title={title} desc={desc}>
        <p className="py-3 text-center text-[11px] text-gray-400">Loading…</p>
      </SectionShell>
    );
  }

  const onPatch = (userId: number, body: ReviewerPatch): void => {
    patch.mutate({ userId, body: { workspaceId, ...body } });
  };

  return (
    <SectionShell title={title} desc={desc}>
      {q.isLoading ? (
        <p className="py-3 text-center text-[11px] text-gray-400">Loading…</p>
      ) : q.isError ? (
        <p className="py-3 text-center text-[11px] text-red-500">{(q.error as Error).message}</p>
      ) : emptyKind != null ? (
        <p className="py-3 text-center text-[11px] text-gray-400">
          {emptyStateCopy(emptyKind, listRepoIds.length)}
        </p>
      ) : (
        <>
          {/* ⚠ THE SCOPE SENTENCE, AND IT IS NOT THE ONE THIS BANNER USED TO CARRY. The old copy
              said edits apply "everywhere", which was true of an account-wide identity table and
              is now wrong in both directions: a change here reaches every repo in this Workspace
              (wider than the repo you may be looking at) and reaches no other Workspace at all. */}
          <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            Everything here applies to{' '}
            <span className="font-semibold">this Workspace</span> — all {listRepoIds.length} of its
            repo{listRepoIds.length === 1 ? '' : 's'}, including any not listed on a card. It does
            not reach your other Workspaces: the same bot can be classified, named and priced
            differently in each.
          </p>

          {/* ⚠ NO SECOND "this write is Workspace-wide" BANNER FOR THE `repoId` CASE. The banner
              above already says it, and the per-repo Bots tab (BotSettingsPanel) renders its own
              prominent note saying it again in the repo's own words — a third copy on one screen
              makes all three read as boilerplate. What this component owes the repo case instead is
              EVIDENCE, and it has it: every card lists the repos it is active in. */}
          {repoId != null && (
            <p className="text-[10px] text-gray-400">
              Filtered to the bots active in{' '}
              <span className="font-medium text-gray-500 dark:text-gray-300">
                {repoName.get(repoId) ?? `repo #${repoId}`}
              </span>
              . The repo chips on each card are the real reach of an edit.
            </p>
          )}

          <ReviewerList
            heading="Review bots"
            note="Counted in the ROI, behaviour and dedup metrics."
            reviewers={buckets.reviewBots}
            repoName={repoName}
            botColor={botColor}
            busy={busy}
            onPatch={onPatch}
            onCost={(userId, monthlyUsd) =>
              cost.mutate({ userId, body: buildCostBody(workspaceId, monthlyUsd) })
            }
            onResetJudgement={(userId) => resetJudgement.mutate({ userId, workspaceId })}
            onResetIdentity={(userId) => resetIdentity.mutate({ userId, workspaceId })}
          />

          {/* Quality checks get their own list rather than being hidden: a mis-role must be
              discoverable ("why did SonarQube vanish from the ROI table?") and re-rolable in
              place. */}
          <ReviewerList
            heading="Quality checks"
            note="Static analysis / coverage / lint — still visible in the feed, excluded from the review-bot metrics."
            reviewers={buckets.qualityChecks}
            repoName={repoName}
            botColor={botColor}
            busy={busy}
            onPatch={onPatch}
            onCost={(userId, monthlyUsd) =>
              cost.mutate({ userId, body: buildCostBody(workspaceId, monthlyUsd) })
            }
            onResetJudgement={(userId) => resetJudgement.mutate({ userId, workspaceId })}
            onResetIdentity={(userId) => resetIdentity.mutate({ userId, workspaceId })}
          />

          {/* ⚠ THE ONES SOMEONE DISMISSED OR NAMED, KEPT VISIBLE. A manual write pins its half of
              the row against re-derivation, so a row that left the screen would be pinned AND
              unreachable. Only DELIBERATE rows appear here (see `bucketReviewers`); every ordinary
              human commenter also has a not-automated row and listing those would bury these under
              the whole contributor roster. */}
          <ReviewerList
            heading="Marked “not a bot” by you"
            note="Detection leaves these alone until you reset them."
            reviewers={buckets.markedNotBots}
            repoName={repoName}
            botColor={botColor}
            busy={busy}
            onPatch={onPatch}
            onCost={(userId, monthlyUsd) =>
              cost.mutate({ userId, body: buildCostBody(workspaceId, monthlyUsd) })
            }
            onResetJudgement={(userId) => resetJudgement.mutate({ userId, workspaceId })}
            onResetIdentity={(userId) => resetIdentity.mutate({ userId, workspaceId })}
          />

          {repoId != null && shown.length === 0 && (
            <p className="py-3 text-center text-[11px] text-gray-400">
              No automated reviewer has touched this repo yet. This Workspace&apos;s other bots are
              still configured — clear the repo filter to see them.
            </p>
          )}

          <p className="text-[10px] text-gray-400">
            {costTotal.totalUsd == null ? (
              <>
                No monthly prices set yet — add one per bot above to get $/acted-on in the ROI
                table.
              </>
            ) : (
              <>
                <span className="font-medium tabular-nums text-gray-600 dark:text-gray-300">
                  ${formatCostInput(costTotal.totalUsd)}/mo
                </span>{' '}
                across {costTotal.pricedActors} bot{costTotal.pricedActors === 1 ? '' : 's'} in this
                Workspace
                {costTotal.unpricedActors > 0 && (
                  <> · {costTotal.unpricedActors} with no price set</>
                )}
                .{' '}
                {/* Stated, not implied: prices in other Workspaces are separate figures, and
                    adding them up would assert a number of subscriptions nobody told us. */}
                <span className="text-gray-400">
                  Prices are per Workspace and are never added across Workspaces.
                </span>
              </>
            )}
          </p>

          {/* Search-to-promote: find a reviewer this Workspace currently treats as human and mark
              them automated. One button now — the judgement is Workspace-wide, so there is no repo
              to pick and no row to fabricate. */}
          <div className="mt-3 space-y-1.5 border-t border-gray-200 pt-3 dark:border-gray-800">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-gray-600 dark:text-gray-300">Add a review bot</span>
              <input
                className={inputCls}
                value={query}
                placeholder="Search reviewers by name or login…"
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search reviewers to mark as a review bot"
              />
            </label>
            {query.trim() === '' ? (
              <p className="text-[10px] text-gray-400">
                Type a reviewer&apos;s name to treat them as an automated reviewer in this
                Workspace. They join the <span className="font-medium">Review bots</span> list
                above, where you set the vendor and the price.
              </p>
            ) : matches.length === 0 ? (
              <p className="text-[10px] text-gray-400">
                No matching reviewers this Workspace currently treats as human.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
                {matches.map((m) => (
                  <li key={m.userId} className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
                    {m.avatarUrl != null && (
                      <img src={m.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full" />
                    )}
                    <span className="truncate text-xs font-medium text-gray-800 dark:text-gray-100">
                      {m.login}
                      {m.displayName != null && m.displayName !== m.login && (
                        <span className="ml-1 font-normal text-gray-400">{m.displayName}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        // No `role`: absent takes the column's 'review' default. No kind/label
                        // either — naming the vendor stamps the OTHER provenance flag, and doing
                        // it from here would freeze the identity on the strength of a promote.
                        onPatch(m.userId, { automated: true });
                        setQuery('');
                      }}
                      className="ml-auto rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
                    >
                      Treat as a review bot in this Workspace
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {anyError != null && <p className="text-[11px] text-red-500">{anyError.message}</p>}
    </SectionShell>
  );
}

// ── One bucket ──────────────────────────────────────────────────────────────────────────────

function ReviewerList({
  heading,
  note,
  reviewers,
  repoName,
  botColor,
  busy,
  onPatch,
  onCost,
  onResetJudgement,
  onResetIdentity,
}: {
  heading: string;
  note: string;
  reviewers: WorkspaceReviewer[];
  repoName: Map<number, string>;
  botColor: BotColorFn;
  busy: boolean;
  onPatch: (userId: number, body: ReviewerPatch) => void;
  onCost: (userId: number, monthlyUsd: number | null) => void;
  onResetJudgement: (userId: number) => void;
  onResetIdentity: (userId: number) => void;
}): JSX.Element | null {
  if (reviewers.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
          {heading} ({reviewers.length})
        </h4>
        <span className="text-[10px] text-gray-400">{note}</span>
      </div>
      <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
        {reviewers.map((r) => (
          <ReviewerCard
            key={r.userId}
            reviewer={r}
            repoName={repoName}
            botColor={botColor}
            busy={busy}
            onPatch={onPatch}
            onCost={onCost}
            onResetJudgement={onResetJudgement}
            onResetIdentity={onResetIdentity}
          />
        ))}
      </ul>
    </section>
  );
}

// ── One bot ─────────────────────────────────────────────────────────────────────────────────

/**
 * ONE card, one `workspace_reviewers` row: judgement, identity, price and the evidence behind
 * them.
 *
 * ⚠ THE VENDOR PICKER IS EDITABLE HERE. It used to be a read-only chip on the per-repo rows, and
 * that was correct while identity lived in a different table at a different grain — an editor on a
 * repo-shaped row would have looked local and acted account-wide. Identity is per Workspace now,
 * exactly like the judgement beside it, so there is no grain left to confuse and no reason to send
 * the user somewhere else to type a name.
 */
function ReviewerCard({
  reviewer,
  repoName,
  botColor,
  busy,
  onPatch,
  onCost,
  onResetJudgement,
  onResetIdentity,
}: {
  reviewer: WorkspaceReviewer;
  repoName: Map<number, string>;
  botColor: BotColorFn;
  busy: boolean;
  onPatch: (userId: number, body: ReviewerPatch) => void;
  onCost: (userId: number, monthlyUsd: number | null) => void;
  onResetJudgement: (userId: number) => void;
  onResetIdentity: (userId: number) => void;
}): JSX.Element {
  const r = reviewer;
  // A newly-promoted bot has no vendor named yet (`kind: null`). Default the picker to In-house AI
  // rather than leaving it blank — the honest guess for an unrecognised automation — and nothing is
  // written until Save.
  const serverKind: AutomatedReviewerKind = r.kind ?? 'in_house';
  const [kind, setKind] = useState<AutomatedReviewerKind>(serverKind);
  const [label, setLabel] = useState(r.label);
  // Re-seed from the server when it changes under us (a save, or a refetch). Adjusting state
  // during render off a "previous props" marker is React's own documented alternative to a sync
  // effect — it avoids the extra render pass where the fields still show the old values.
  // The separator is U+001F (unit separator), NOT a literal NUL. A NUL byte in a source file
  // makes the WHOLE FILE binary to file(1), and grep/ripgrep skip binary files by default — so
  // this component silently stopped matching any repo-wide search, which is how a reviewer
  // concluded its buttons were unwired. In a codebase navigated by grep, an ungreppable file is
  // a real hazard. U+001F is equally impossible in a vendor kind or a GitHub display name.
  const SEP = '\u001f';
  const [seed, setSeed] = useState(`${serverKind}${SEP}${r.label}`);
  const nextSeed = `${serverKind}${SEP}${r.label}`;
  if (seed !== nextSeed) {
    setSeed(nextSeed);
    setKind(serverKind);
    setLabel(r.label);
  }

  const color = botColor({ login: r.login, kind: serverKind });
  const identityDirty = kind !== serverKind || label !== r.label;
  const isQuality = r.role === 'quality_check';
  const f = r.footprint;
  const footprints = r.repoFootprints;
  const shownRepos = footprints.slice(0, MAX_REPO_CHIPS);
  const hiddenRepos = footprints.length - shownRepos.length;
  const allRepoNames = footprints
    .map((e) => repoName.get(e.repoId) ?? `repo #${e.repoId}`)
    .join(', ');

  return (
    <li className="flex flex-col gap-1.5 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {r.avatarUrl != null && (
          <img src={r.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full" />
        )}
        <span
          className="truncate text-xs font-medium text-gray-800 dark:text-gray-100"
          title={r.sampleReviewBody ?? undefined}
        >
          {r.login}
          {r.displayName != null && r.displayName !== r.login && (
            <span className="ml-1 font-normal text-gray-400">{r.displayName}</span>
          )}
        </span>
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          style={{ color, backgroundColor: `${color}1a` }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
          {automatedReviewerMeta(serverKind).label}
        </span>
        {r.identitySource === 'manual' && (
          <span className="shrink-0 rounded bg-sky-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-600 dark:bg-sky-950 dark:text-sky-300">
            named by you
          </span>
        )}
        {r.isManualOverride ? (
          <span className="shrink-0 rounded bg-sky-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-600 dark:bg-sky-950 dark:text-sky-300">
            set by you
          </span>
        ) : (
          <span
            className="shrink-0 text-[9px] uppercase tracking-wide text-gray-300 dark:text-gray-600"
            title={r.reasons.join(' · ')}
          >
            {r.source.replace(/_/g, ' ')}
          </span>
        )}
        {r.automated && r.confidence !== 'high' && !r.isManualOverride && (
          <span className="shrink-0 text-[10px] text-amber-500" title={r.reasons.join(' · ')}>
            likely ({r.confidence})
          </span>
        )}
        {/* The Workspace-wide footprint. It is what makes a stale card legible without a flag:
            all-zero counts mean "a judgement recorded for a Workspace this reviewer no longer
            touches", which used to need a `dormantInScope` boolean. */}
        <span
          className="ml-auto shrink-0 text-[10px] text-gray-400"
          title="Reviews / inline threads / PR comments across this Workspace over the last 90 days"
        >
          {f.reviews}r · {f.threads}t · {f.comments}c
          <span className="ml-1 text-gray-300 dark:text-gray-600">90d</span>
        </span>
      </div>

      {/* THE BLAST RADIUS, SPELLED OUT AS DATA. Every control on this card writes one row that
          judges, names and prices this bot in all of these repos at once. */}
      {footprints.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" title={allRepoNames}>
          <span className="text-[9px] uppercase tracking-wide text-gray-400">Active in</span>
          {shownRepos.map((e) => (
            <span
              key={e.repoId}
              className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              title={`${e.reviews}r · ${e.threads}t · ${e.comments}c here over the last 90 days`}
            >
              {repoName.get(e.repoId) ?? `repo #${e.repoId}`}
            </span>
          ))}
          {hiddenRepos > 0 && (
            <span className="text-[10px] text-gray-400">+{hiddenRepos} more</span>
          )}
        </div>
      )}

      {/* ── IDENTITY (provenance: identitySource) ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className={`${FIELD_CLS} w-auto py-0.5`}
          value={kind}
          onChange={(e) => setKind(e.target.value as AutomatedReviewerKind)}
          aria-label={`Vendor for ${r.login} in this Workspace`}
        >
          {ALL_KINDS.map((k) => (
            <option key={k} value={k}>
              {automatedReviewerMeta(k).label}
            </option>
          ))}
        </select>
        <input
          className={`${FIELD_CLS} w-40 py-0.5`}
          value={label}
          placeholder="Label"
          onChange={(e) => setLabel(e.target.value)}
          aria-label={`Display label for ${r.login} in this Workspace`}
        />
        <button
          type="button"
          disabled={busy || !identityDirty}
          onClick={() =>
            // Identity ONLY. Sending `automated`/`role` here would stamp `source: 'manual'` and
            // freeze the classification because someone corrected a vendor name — the exact
            // coupling the two provenance flags exist to prevent.
            onPatch(r.userId, { kind, label: label.trim() === '' ? null : label })
          }
          title="Name this bot for this Workspace. It does not change whether it counts as a bot, and it does not reach your other Workspaces."
          className="rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
        >
          Save name
        </button>
        {/* THE WAY BACK for the identity half, shown ONLY on a manually-named bot. On an auto
            identity there is nothing to reset, and a control that does nothing reads as a broken
            one. It is the only way back: re-typing the auto name by hand just re-stamps
            "named by you". */}
        {r.identitySource === 'manual' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onResetIdentity(r.userId)}
            title="Forget the vendor and label you set and let detection name this bot again in this Workspace. The monthly price is kept, and the bot / not-a-bot verdict is unchanged."
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Reset name
          </button>
        )}
      </div>
      {/* Stated on screen, not only in a tooltip: "reset" reads as "delete everything", and the
          one thing a user is afraid of losing here is the number they typed into the box below. */}
      {r.identitySource === 'manual' && (
        <p className="text-[10px] text-gray-400">
          Reset hands the vendor and label back to detection for this Workspace —{' '}
          <span className="font-medium text-gray-500 dark:text-gray-300">the price is kept</span>,
          and the bot / not-a-bot verdict does not change.
        </p>
      )}

      {/* ── JUDGEMENT (provenance: source) ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {r.automated ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onPatch(r.userId, {
                  // `automated: true` rides along with the role so the row is stamped a human
                  // judgement in one write. It is already true on this branch, so it changes
                  // nothing but the provenance — which is the point of pressing a button.
                  automated: true,
                  role: (isQuality ? 'review' : 'quality_check') satisfies ReviewerRole,
                })
              }
              title={
                isQuality
                  ? 'Treat it as a real AI code reviewer in this Workspace — it re-enters the ROI, behaviour and dedup metrics.'
                  : 'Treat it as static analysis / coverage / lint in this Workspace. Stays visible in the feed, but is excluded from the review-bot metrics.'
              }
              className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {isQuality ? 'Treat as a review bot' : 'Mark as a quality check'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPatch(r.userId, { automated: false })}
              title="Stop treating this reviewer as automated in this Workspace — every repo in it. Its vendor name and price are kept, and your other Workspaces are unaffected."
              className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Not a bot in this Workspace
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => onPatch(r.userId, { automated: true })}
            title="Treat this reviewer as automated again in this Workspace — every repo in it. Your other Workspaces are unaffected."
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Treat as a review bot
          </button>
        )}
        {/* THE WAY BACK for the judgement half, shown ONLY once a human has pinned it. Both buttons
            above stamp `source: 'manual'`, which is what stops the next detection pass silently
            reverting the edit — and also what makes it permanent without this. Pressing one of them
            AGAIN undoes nothing: the row stays pinned, just on the new value. */}
        {r.isManualOverride && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onResetJudgement(r.userId)}
            title="Forget your bot / not-a-bot and review / quality-check judgement for this Workspace and let detection decide again. The vendor name and the price are untouched."
            className="rounded border border-dashed border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Reset classification
          </button>
        )}
      </div>
      {/* On screen rather than only on hover: the reset is the half of the model that is not
          guessable from the buttons. */}
      {r.isManualOverride && (
        <p className="text-[10px] text-gray-400">
          Set by you — detection will not change it in this Workspace until you reset. Resetting
          keeps the bot&apos;s{' '}
          <span className="font-medium text-gray-500 dark:text-gray-300">name and price</span>.
        </p>
      )}

      {/* ── PRICE (no provenance; one writer) ── */}
      <CostEditor
        // Remount on a userId change so a half-typed number can never survive onto another bot.
        key={r.userId}
        login={r.login}
        costMonthlyUsd={r.costMonthlyUsd}
        busy={busy}
        onApply={(v) => onCost(r.userId, v)}
      />
    </li>
  );
}

// ── The price ───────────────────────────────────────────────────────────────────────────────

// Per-state input chrome. The two states must be distinguishable at a glance, because emptying the
// box means something different in each: on a priced bot it CLEARS, on an unpriced one it does
// nothing.
const COST_INPUT_CLS: Record<CostState, string> = {
  set: 'border-violet-400 text-gray-800 dark:border-violet-600 dark:text-gray-100',
  none: 'border-gray-300 text-gray-800 dark:border-gray-700 dark:text-gray-100',
};

/**
 * One bot's monthly price IN THIS WORKSPACE.
 *
 * ⚠ THE LABEL IS "PRICE FOR THIS WORKSPACE", NOT "PRICE". The old control sat in an account-wide
 * section and was captioned "all repos"; the price is now a plain column on the same per-Workspace
 * row as everything else on the card, so an unqualified "Price" would read as a global setting and
 * invite exactly the cross-Workspace totalling this product forbids. Editing it here leaves every
 * other Workspace alone, and they may legitimately hold a different number, or none.
 *
 * ⚠ 0 IS A PRICE ("we pay nothing"), EMPTY IS NO PRICE. `parseCostInput` keeps them apart —
 * `Number('')` is 0, which is exactly the trap.
 */
function CostEditor({
  login,
  costMonthlyUsd,
  busy,
  onApply,
}: {
  login: string;
  costMonthlyUsd: number | null;
  busy: boolean;
  onApply: (value: number | null) => void;
}): JSX.Element {
  const state = costStateOf({ costMonthlyUsd });
  const serverText = formatCostInput(costMonthlyUsd);
  const [text, setText] = useState(serverText);
  const [seededFrom, setSeededFrom] = useState(serverText);
  if (seededFrom !== serverText) {
    setSeededFrom(serverText);
    setText(serverText);
  }

  const parsed = parseCostInput(text);
  const outcome = parsed.ok ? costEditOutcome(costMonthlyUsd, parsed.value) : null;

  // What the button would do / why it can't. The one no-op outcome is exactly the case where a
  // user who clicked and saw nothing needs the explanation on screen, not on hover.
  let hint: string;
  if (!parsed.ok) hint = parsed.error;
  else if (outcome == null) hint = '';
  else
    switch (outcome.kind) {
      case 'set':
        hint = 'Sets this bot’s price for this Workspace. Other Workspaces are unaffected.';
        break;
      case 'clear':
        hint = 'Clears the price for this Workspace. $/acted-on stops showing for this bot.';
        break;
      case 'unchanged':
        hint = 'Unchanged.';
        break;
      case 'no-cost':
        hint = 'No price set. Type a number to add one (0 means “free”).';
        break;
    }

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="text-[10px] uppercase tracking-wide text-gray-400">
        Price for this Workspace
      </span>
      <span className="text-[11px] text-gray-400">$</span>
      <input
        type="text"
        inputMode="decimal"
        // Not `type="number"`: a number input in several browsers reports '' for a partially-typed
        // or invalid value, which would be indistinguishable from the CLEAR gesture. Parsing the
        // raw text keeps the two states honest.
        className={`w-20 rounded border bg-white px-1.5 py-0.5 text-[11px] tabular-nums outline-none focus:border-sky-400 dark:bg-gray-800 ${COST_INPUT_CLS[state]}`}
        value={text}
        placeholder="—"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && parsed.ok && outcome?.dirty === true && !busy) {
            onApply(parsed.value);
          }
        }}
        aria-label={`Monthly cost in US dollars for ${login} in this Workspace`}
      />
      <span className="text-[11px] text-gray-400">/mo</span>

      <button
        type="button"
        disabled={busy || !parsed.ok || outcome?.dirty !== true}
        onClick={() => {
          if (parsed.ok && outcome?.dirty === true) onApply(parsed.value);
        }}
        title={hint}
        className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        {outcome?.kind === 'clear' ? 'Clear' : 'Save price'}
      </button>

      <span className={`text-[10px] ${parsed.ok ? 'text-gray-400' : 'text-red-500'}`}>{hint}</span>
    </div>
  );
}
