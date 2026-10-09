import { useMemo, useState } from 'react';
import type {
  AutomatedReviewerKind,
  CostModel,
  ReviewerRole,
  WorkspaceReviewer,
  WorkspaceReviewerPatchBody,
} from '@pierre-review/shared';
import {
  REVIEWER_ROLES,
  REVIEWER_ROLE_LABEL,
  roleForVendorKind,
  vendorKindsForRole,
} from '@pierre-review/shared';
import { automatedReviewerMeta, safeExternalUrl, vendorInk } from '../../lib/ui.js';
import { monogramFor, monogramInk } from '../../lib/botAvatar.js';
import { InfoButton } from '../InfoModal.js';
import {
  costEditOutcome,
  costStateOf,
  buildCostBody,
  formatCostInput,
  parseCostInput,
  perSeatMonthlyUsd,
  type CostState,
} from '../../lib/botCost.js';
import {
  bucketReviewers,
  emptyStateCopy,
  humanCandidates,
  monthlyCostTotal,
  reviewerListEmptyKind,
} from '../../lib/botReviewers.js';
import {
  useDetectedReviewers,
  useResetReviewerIdentity,
  useResetReviewerJudgement,
  useSetReviewerCost,
  useSetWorkspaceReviewer,
} from '../../hooks/useBotTriage.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { SectionShell, inputCls } from './ui.js';

const MAX_SEARCH_MATCHES = 8;
// How many repo chips a card prints before collapsing to "+N more". The full list stays in the
// element's `title`, so the blast radius is never actually hidden — only wrapped.
const MAX_REPO_CHIPS = 8;

// The shared `inputCls` carries `w-full`, and Tailwind emits `.w-full` AFTER `.w-32`/`.w-auto`,
// so appending a width to it does nothing — the vendor picker and label box stretched edge to edge
// and the row read as a form, not a list. This is the same chrome with the width left off.
const FIELD_CLS =
  'rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-sky-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100';
// The label in front of each control row on a card ("Counts as", "Role", "Vendor").
const CONTROL_LABEL_CLS = 'w-16 shrink-0 text-[11px] font-medium text-gray-500 dark:text-gray-400';
const segmentCls = (active: boolean): string =>
  `px-2 py-0.5 text-[11px] font-medium disabled:opacity-40 ${
    active
      ? 'bg-sky-600 text-white'
      : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
  }`;

// What each role MEANS, in terms of the consequence the user is choosing. Every string names the
// lane the actor lands in on the period report, because that consequence is otherwise two screens
// away and is the reason most people open this picker at all.
//
// ⚠ ONLY `review` KEEPS THE ACTOR IN THE BOT-ROI / behaviour / dedup / benchmark metrics. The
// other five all remove it, differing in how the period report ATTRIBUTES its work — which is a
// real distinction (a merged agent PR is delivered work, a merged Dependabot bump is overhead)
// and not five ways of saying "ignore this".
const ROLE_HELP: Record<ReviewerRole, string> = {
  review:
    'An AI code reviewer. The only role counted in the review-bot figures: ROI, behaviour, duplicates and the benchmark.',
  quality_check:
    'Static analysis, coverage, scanners, CI. Posts pass/fail verdicts rather than findings. Shown in the feed, left out of the review-bot figures.',
  dependency:
    'Version bumps (Dependabot, Renovate). Opens PRs and never reviews; its merges are reported as overhead, not team throughput.',
  code_agent:
    'Writes code that is not a version bump: coding agents, autofix, generated-content sync. Its merged PRs are reported as work no person typed.',
  release:
    'Merge queues, release trains, changelogs, backports. Moves code without writing or judging it; its approvals do not count as review.',
  housekeeping:
    'CLA/DCO checks, triage, labels, stale-closers, size and preview reports. Left out of every review figure.',
};

/** Everything a card can write, minus the key the parent already holds. */
type ReviewerPatch = Omit<WorkspaceReviewerPatchBody, 'workspaceId'>;

type BotColorFn = (bot: { login?: string | null; kind: AutomatedReviewerKind }) => string;

// The bot classification surface — Feed → Bot classification. FREE on every tier, both modes, and
// the screen carries no capability gate: classifying a reviewer, naming its vendor and setting its
// role all work on a plugin-less `npx` install. The one paid thing on it is the PRICE (`botDepth`)
// — the editor on each card and the workspace total — and without the capability those are simply
// ABSENT (no badge, no nudge). See the note at `showCost` for how that is enforced.
//
// ── ONE CARD PER BOT, IN A GRID ─────────────────────────────────────────────────────────────
// Each entry is a distinct bordered card (1 column on a phone, 2–3 wide): a header with the bot's
// own GitHub avatar (for an App bot, the vendor's logo; a monogram tile on the vendor colour when
// there is none or it fails to load), its name and login, and its role and vendor as labelled
// chips; the controls sit beneath. The vendor colour is a thin LEFT ACCENT — a non-text use, so the
// raw hex is fine there; as text it always goes through `vendorInk`. A row judged a person is drawn
// muted, so the grid separates bots from people at a glance.
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
// ── THE LISTING IS ALWAYS WORKSPACE-WIDE ────────────────────────────────────────────────────
// Every control here writes the Workspace-wide row, so each card shows its whole repo footprint —
// the real blast radius. It also keeps this screen on the same cache entry as the bot colour map.
export function DetectedReviewersTable({
  workspaceId,
}: {
  /** The Workspace whose bots are being configured. `null` while the store is still resolving. */
  workspaceId: number | null;
}): JSX.Element {
  // No `repoIds`: the listing is always fetched Workspace-wide (see the header). That is also what
  // keeps this screen sharing one warm cache entry with `useBotColors`.
  const q = useDetectedReviewers(workspaceId);
  const { data: repos } = useRepos();
  // Colour resolver for THIS Workspace — identity is per Workspace now, so an unscoped resolver
  // would paint these bots from some other Workspace's vendor names.
  const botColor = useBotColors(workspaceId);

  // ── THE COST SURFACES ARE PAID (`botDepth`), THE REST OF THIS SCREEN IS FREE ──────────────
  // Classification / identity / role editing is ungated (an `npx` user must be able to classify a
  // reviewer — the Feed's bot hiding reads it). Only the price editor and the workspace cost total
  // read `showCost`, and without it they are ABSENT: no ProBadge, no upsell line.
  //
  // ⚠ THE SERVER ENFORCES BOTH HALVES NOW, ON ALL FOUR ROUTES THAT ECHO A REVIEWER ROW. `PUT
  // …/cost` has always 402'd; as of the ROI gate the LISTING this screen reads strips
  // `costMonthlyUsd` / `costModel` / `effectiveMonthlyUsd` for an unentitled account — and so do
  // the PATCH and both resets, which this screen also calls and which would otherwise be a
  // perfectly good read path for the same numbers (`stripCost`, api/routes/bot-triage.ts). So
  // `showCost` is a rendering decision over data that is genuinely absent, not a client-side
  // curtain over a price that arrived anyway.
  const { botDepth: showCost } = useProCapabilities();

  const patch = useSetWorkspaceReviewer();
  const cost = useSetReviewerCost();
  const resetJudgement = useResetReviewerJudgement();
  const resetIdentity = useResetReviewerIdentity();
  const busy =
    patch.isPending || cost.isPending || resetJudgement.isPending || resetIdentity.isPending;

  const [query, setQuery] = useState('');

  const reviewers = useMemo(() => q.data?.reviewers ?? [], [q.data]);
  const listRepoIds = useMemo(() => q.data?.repoIds ?? [], [q.data]);
  // ONE derived number per workspace (distinct human PR authors, trailing 30 days) — the per-seat
  // preview multiplies by it; every SAVED figure comes back server-multiplied.
  const workspaceSeatCount = q.data?.workspaceSeatCount ?? 0;

  const buckets = useMemo(() => bucketReviewers(reviewers), [reviewers]);
  // The price is a Workspace fact, so the total is over the whole Workspace's rows.
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

  const title = 'Bot classification';
  // The cost clause only when the cost surfaces actually render (`botDepth`).
  const desc = showCost
    ? 'Who counts as a bot in this Workspace, what kind of bot it is, and what it costs here.'
    : 'Who counts as a bot in this Workspace and what kind of bot it is.';
  // The six roles, reachable by touch and keyboard. The role picker's `title` carries the same
  // text, but a hover tooltip is not an explanation anyone on a phone can read.
  const info = (
    <InfoButton title="Bot classification">
      <p>Bots are detected automatically. Bots are hidden on the Feed and Timeline by default.</p>
      <p>Each bot has one role in this Workspace. The role decides which figures count it:</p>
      <ul className="list-disc space-y-1 pl-5">
        {REVIEWER_ROLES.map((k) => (
          <li key={k}>
            <strong>{REVIEWER_ROLE_LABEL[k]}:</strong> {ROLE_HELP[k]}
          </li>
        ))}
      </ul>
      <p>
        A change here reaches every repo in this Workspace. The repo chips on each card show where
        that bot is active.
      </p>
      {showCost && (
        <p>
          Prices are set per Workspace and are never added up across Workspaces: the same bot can
          have a different price in each.
        </p>
      )}
    </InfoButton>
  );

  // `workspaceId` is null only while the store resolves its Default. The listing hook holds the
  // query idle in that state (skipToken), so `isLoading` is false and the empty-state branch would
  // otherwise claim "no repos in this Workspace" before anything had been asked. Handled here so
  // the rest of the component can treat the id as a number.
  if (workspaceId == null) {
    return (
      <SectionShell title={title} desc={desc} info={info}>
        <p className="py-3 text-center text-[11px] text-gray-400">Loading…</p>
      </SectionShell>
    );
  }

  const onPatch = (userId: number, body: ReviewerPatch): void => {
    patch.mutate({ userId, body: { workspaceId, ...body } });
  };

  return (
    <SectionShell title={title} desc={desc} info={info}>
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
          <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            Everything here applies to{' '}
            <span className="font-semibold">this Workspace</span>: all {listRepoIds.length} of its
            repo{listRepoIds.length === 1 ? '' : 's'}, and none of your other Workspaces.
          </p>

          <ReviewerList
            heading="Review bots"
            note="Counted in the review-bot figures."
            reviewers={buckets.reviewBots}
            workspaceSeatCount={workspaceSeatCount}
            showCost={showCost}
            repoName={repoName}
            botColor={botColor}
            busy={busy}
            onPatch={onPatch}
            onCost={(userId, monthlyUsd, costModel) =>
              cost.mutate({ userId, body: buildCostBody(workspaceId, monthlyUsd, costModel) })
            }
            onResetJudgement={(userId) => resetJudgement.mutate({ userId, workspaceId })}
            onResetIdentity={(userId) => resetIdentity.mutate({ userId, workspaceId })}
          />

          {/* Non-reviewer automation gets its own list rather than being hidden: a mis-role must
              be discoverable ("why did SonarQube vanish from the ROI table?") and re-rolable in
              place. Each row states its own role, so the heading no longer claims they are all
              quality checks — the list also holds dependency bots, code agents, release
              automation and housekeeping. */}
          <ReviewerList
            heading="Other automation"
            note="Shown in the feed, left out of the review-bot figures."
            reviewers={buckets.qualityChecks}
            workspaceSeatCount={workspaceSeatCount}
            showCost={showCost}
            repoName={repoName}
            botColor={botColor}
            busy={busy}
            onPatch={onPatch}
            onCost={(userId, monthlyUsd, costModel) =>
              cost.mutate({ userId, body: buildCostBody(workspaceId, monthlyUsd, costModel) })
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
            workspaceSeatCount={workspaceSeatCount}
            showCost={showCost}
            repoName={repoName}
            botColor={botColor}
            busy={busy}
            onPatch={onPatch}
            onCost={(userId, monthlyUsd, costModel) =>
              cost.mutate({ userId, body: buildCostBody(workspaceId, monthlyUsd, costModel) })
            }
            onResetJudgement={(userId) => resetJudgement.mutate({ userId, workspaceId })}
            onResetIdentity={(userId) => resetIdentity.mutate({ userId, workspaceId })}
          />

          {/* The workspace cost total — a cost surface (`botDepth`). Without the capability it is
              simply absent: no badge, no upsell line. */}
          {showCost && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {costTotal.totalUsd == null ? (
              <>
                No monthly prices set yet. Add one per bot above to see $ per used thread in the
                ROI table.
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
                .
                {/* "Never added across Workspaces" lives in the section's info popover; the amber
                    banner above already says this screen is this Workspace only. */}
              </>
            )}
          </p>
          )}

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
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Type a reviewer&apos;s name to treat them as an automated reviewer in this
                Workspace. They join the <span className="font-medium">Review bots</span> list
                above, where you set the vendor{showCost ? ' and the price' : ''}.
              </p>
            ) : matches.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                No matching reviewers this Workspace currently treats as human.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
                {matches.map((m) => (
                  <li key={m.userId} className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
                    {safeExternalUrl(m.avatarUrl) !== undefined && (
                      <img
                        src={safeExternalUrl(m.avatarUrl)!}
                        alt=""
                        loading="lazy"
                        className="h-5 w-5 shrink-0 rounded-full"
                      />
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
  workspaceSeatCount,
  showCost,
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
  workspaceSeatCount: number;
  /** Paid `botDepth`: false hides every price control (absence, never an error). */
  showCost: boolean;
  repoName: Map<number, string>;
  botColor: BotColorFn;
  busy: boolean;
  onPatch: (userId: number, body: ReviewerPatch) => void;
  onCost: (userId: number, monthlyUsd: number | null, costModel: CostModel) => void;
  onResetJudgement: (userId: number) => void;
  onResetIdentity: (userId: number) => void;
}): JSX.Element | null {
  if (reviewers.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
          {heading} ({reviewers.length})
        </h4>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">{note}</span>
      </div>
      {/* A responsive GRID of distinct cards: one column at phone width, two from `md`, three on a
          wide screen. `items-start` keeps a short card from stretching to its row-mate's height. */}
      <ul className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {reviewers.map((r) => (
          <ReviewerCard
            key={r.userId}
            reviewer={r}
            workspaceSeatCount={workspaceSeatCount}
            showCost={showCost}
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
  workspaceSeatCount,
  showCost,
  repoName,
  botColor,
  busy,
  onPatch,
  onCost,
  onResetJudgement,
  onResetIdentity,
}: {
  reviewer: WorkspaceReviewer;
  workspaceSeatCount: number;
  /** Paid `botDepth`: false hides the price editor (absence, never an error). */
  showCost: boolean;
  repoName: Map<number, string>;
  botColor: BotColorFn;
  busy: boolean;
  onPatch: (userId: number, body: ReviewerPatch) => void;
  onCost: (userId: number, monthlyUsd: number | null, costModel: CostModel) => void;
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
  const [role, setRole] = useState<ReviewerRole>(r.role);
  // The render-phase re-seed, extended to the role. Same rule as the vendor and label above: when
  // the SERVER's value changes under us (a save landing, a refetch, another tab) the local draft
  // is replaced — otherwise an applied role would keep showing the old draft and the "Apply role"
  // button would stay lit forever.
  const [seed, setSeed] = useState(`${serverKind}${SEP}${r.label}${SEP}${r.role}`);
  const nextSeed = `${serverKind}${SEP}${r.label}${SEP}${r.role}`;
  if (seed !== nextSeed) {
    setSeed(nextSeed);
    setKind(serverKind);
    setLabel(r.label);
    setRole(r.role);
  }

  const color = botColor({ login: r.login, kind: serverKind });
  const identityDirty = kind !== serverKind || label !== r.label;
  const f = r.footprint;
  const footprints = r.repoFootprints;
  const shownRepos = footprints.slice(0, MAX_REPO_CHIPS);
  const hiddenRepos = footprints.length - shownRepos.length;
  const allRepoNames = footprints
    .map((e) => repoName.get(e.repoId) ?? `repo #${e.repoId}`)
    .join(', ');

  // A row judged a PERSON is drawn muted (grey accent, grey ground, a "Person" chip), so the grid
  // separates bots from people at a glance. The text keeps its normal contrast — muted is the
  // ground and the accent, never an opacity over the words.
  const isPerson = !r.automated;
  const vendorLabel = automatedReviewerMeta(serverKind).label;
  // The card's title: the human-set label / vendor brand (`r.label`), with the login beneath it.
  const title = r.label.trim() !== '' ? r.label : r.login;

  return (
    <li
      className={`relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-lg border py-3 pl-4 pr-3 ${
        isPerson
          ? 'border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40'
          : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'
      }`}
      data-testid="bot-classification-card"
    >
      {/* The vendor colour as a thin LEFT ACCENT — a non-text use of the raw brand hex. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1"
        style={{ backgroundColor: isPerson ? 'rgb(156 163 175)' : color }}
      />

      {/* ── HEADER: logo · name + login · role and vendor chips ── */}
      <div className="flex min-w-0 items-start gap-2.5">
        <BotAvatar avatarUrl={r.avatarUrl} name={title} color={color} muted={isPerson} />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100"
            title={r.sampleReviewBody ?? undefined}
          >
            {title}
          </div>
          <div className="truncate text-xs text-gray-500 dark:text-gray-400">
            @{r.login}
            {r.displayName != null && r.displayName !== r.login && r.displayName !== title && (
              <span className="ml-1">· {r.displayName}</span>
            )}
          </div>
        </div>
        {/* The Workspace-wide footprint. All-zero counts mean "a judgement recorded for a
            Workspace this reviewer no longer touches". */}
        <span
          className="shrink-0 text-[11px] tabular-nums text-gray-500 dark:text-gray-400"
          title="Reviews / inline threads / PR comments across this Workspace over the last 90 days"
        >
          {f.reviews}r · {f.threads}t · {f.comments}c · 90d
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {isPerson ? (
          <span className="inline-flex items-center rounded-full border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:border-gray-700 dark:text-gray-300">
            Person
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 dark:border-gray-700 dark:text-gray-300">
            <span className="text-gray-500 dark:text-gray-400">Role</span>
            <span className="font-medium">{REVIEWER_ROLE_LABEL[r.role]}</span>
          </span>
        )}
        <span
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ ...vendorInk(color), backgroundColor: `${color}1a` }}
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
          {vendorLabel}
        </span>
        {r.identitySource === 'manual' && (
          <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-950 dark:text-sky-300">
            Named by you
          </span>
        )}
        {r.isManualOverride ? (
          <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-950 dark:text-sky-300">
            Set by you
          </span>
        ) : (
          <span
            className="text-[11px] text-gray-500 dark:text-gray-400"
            title={r.reasons.join(' · ')}
          >
            Detected: {r.source.replace(/_/g, ' ')}
          </span>
        )}
        {r.automated && r.confidence !== 'high' && !r.isManualOverride && (
          <span className="text-[11px] text-amber-700 dark:text-amber-300" title={r.reasons.join(' · ')}>
            likely ({r.confidence})
          </span>
        )}
      </div>

      {/* THE BLAST RADIUS, SPELLED OUT AS DATA. Every control on this card writes one row that
          judges, names and prices this bot in all of these repos at once. */}
      {footprints.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" title={allRepoNames}>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">Active in</span>
          {shownRepos.map((e) => (
            <span
              key={e.repoId}
              className="max-w-full truncate rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              title={`${e.reviews}r · ${e.threads}t · ${e.comments}c here over the last 90 days`}
            >
              {repoName.get(e.repoId) ?? `repo #${e.repoId}`}
            </span>
          ))}
          {hiddenRepos > 0 && (
            <span className="text-[11px] text-gray-500 dark:text-gray-400">+{hiddenRepos} more</span>
          )}
        </div>
      )}

      {/* ── CONTROLS, beneath the header ── */}
      <div className="space-y-2 border-t border-gray-200 pt-2.5 dark:border-gray-800">
        {/* ── JUDGEMENT (provenance: source) ── */}
        {/* Bot or person: a segmented pair, so the stored state is always one of the two words on
            screen. Pressing the side already held writes nothing. Both writes stamp
            `source: 'manual'`; "Reset classification" is the way back. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={CONTROL_LABEL_CLS}>Counts as</span>
          <span
            role="group"
            aria-label={`Is ${r.login} a bot in this Workspace?`}
            className="inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700"
          >
            <button
              type="button"
              disabled={busy}
              aria-pressed={r.automated}
              onClick={() => {
                if (!r.automated) onPatch(r.userId, { automated: true });
              }}
              title="Treat this account as a bot in this Workspace — every repo in it. Your other Workspaces are unaffected."
              className={segmentCls(r.automated)}
            >
              Bot
            </button>
            <button
              type="button"
              disabled={busy}
              aria-pressed={!r.automated}
              onClick={() => {
                if (r.automated) onPatch(r.userId, { automated: false });
              }}
              title={`Treat this account as a person in this Workspace — every repo in it. Its vendor name${showCost ? ' and price are' : ' is'} kept, and your other Workspaces are unaffected.`}
              className={segmentCls(!r.automated)}
            >
              Person
            </button>
          </span>
          {/* THE WAY BACK for the judgement half, shown ONLY once a human has pinned it. Pressing
              Bot/Person again undoes nothing: the row stays pinned, just on the new value. */}
          {r.isManualOverride && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onResetJudgement(r.userId)}
              title={`Forget your bot / person and role judgement for this Workspace and let detection decide again. The vendor name${showCost ? ' and the price are' : ' is'} untouched.`}
              className="rounded border border-dashed border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Reset classification
            </button>
          )}
        </div>
        {r.automated && (
          <div className="flex flex-wrap items-center gap-2">
            {/* ⚠ A SELECT OVER ALL SIX ROLES, never a two-way toggle (a toggle silently re-roled the
                four newer roles to `quality_check`). Its `title` names the consequence. */}
            <label className="flex items-center gap-2">
              <span className={CONTROL_LABEL_CLS}>Role</span>
              <select
                disabled={busy}
                value={role}
                onChange={(e) => setRole(e.target.value as ReviewerRole)}
                title={ROLE_HELP[role]}
                className={`${FIELD_CLS} py-0.5 disabled:opacity-40`}
              >
                {REVIEWER_ROLES.map((k) => (
                  <option key={k} value={k}>
                    {REVIEWER_ROLE_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            {/* ⚠ THE ROLE WRITE IS BEHIND AN EXPLICIT BUTTON. Writing on the select's `change`
                event made a persistent, provenance-stamping write out of a scroll wheel or a
                browser form restore — a live row once went `review` → `housekeeping` with nobody
                choosing it. The identity half works the same way ("Save name"). */}
            {role !== r.role && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onPatch(r.userId, {
                    // `automated: true` rides along so the row is stamped a human judgement in
                    // one write; it is already true here, so only the provenance changes.
                    automated: true,
                    role,
                  })
                }
                title={ROLE_HELP[role]}
                className="rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
              >
                Apply role
              </button>
            )}
          </div>
        )}
        {/* On screen rather than only on hover: the reset is the half of the model that is not
            guessable from the buttons. */}
        {r.isManualOverride && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            Set by you — detection will not change it in this Workspace until you reset. Resetting
            keeps the bot&apos;s{' '}
            <span className="font-medium text-gray-600 dark:text-gray-300">
              {showCost ? 'name and price' : 'name'}
            </span>
            .
          </p>
        )}

        {/* ── IDENTITY (provenance: identitySource) ── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={CONTROL_LABEL_CLS}>Vendor</span>
          {/* ⚠ SCOPED TO THE ROLE ABOVE, and the whole ~70-brand list is deliberately NOT offered.
              A user who has just said "this is a quality check" is looking for SonarQube, not
              scrolling past CodeRabbit, Dependabot and a CLA bot to reach it — and an ungrouped
              list is also how a quality gate ends up tagged with a review vendor's brand.

              ⚠ `kind` IS PASSED AS `current` FOR A CORRECTNESS REASON, not a cosmetic one. A
              `<select>` whose `value` is absent from its options renders the FIRST option instead,
              so the card would display a vendor the row does not hold — and "Save name" would then
              write that wrong vendor. Role and identity are independently owned halves, so a row
              legitimately carries a vendor from another family (someone marks CodeRabbit a quality
              check without renaming it), and the stored value has to stay selectable. */}
          <select
            className={`${FIELD_CLS} w-auto py-0.5`}
            value={kind}
            onChange={(e) => setKind(e.target.value as AutomatedReviewerKind)}
            aria-label={`Vendor for ${r.login} in this Workspace`}
          >
            {vendorKindsForRole(role, kind).map((k) => (
              <option key={k} value={k}>
                {automatedReviewerMeta(k).label}
                {/* Name the mismatch rather than hiding it — see `current` above. */}
                {roleForVendorKind(k) != null && roleForVendorKind(k) !== role
                  ? ` (${REVIEWER_ROLE_LABEL[roleForVendorKind(k)!].toLowerCase()})`
                  : ''}
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
              title={`Forget the vendor and label you set and let detection name this bot again in this Workspace.${showCost ? ' The monthly price is kept, and the' : ' The'} bot / not-a-bot verdict is unchanged.`}
              className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Reset name
            </button>
          )}
        </div>
        {/* Stated on screen, not only in a tooltip: "reset" reads as "delete everything", and the
            one thing a user is afraid of losing here is the number they typed into the box below. */}
        {r.identitySource === 'manual' && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            Reset hands the vendor and label back to detection for this Workspace
            {showCost && (
              <>
                {' '}—{' '}
                <span className="font-medium text-gray-600 dark:text-gray-300">the price is kept</span>
              </>
            )}
            . Bot or person does not change.
          </p>
        )}

        {/* ── PRICE (no provenance; one writer) ── Paid (`botDepth`): with the capability off the
            editor is simply absent — no badge, no nudge. */}
        {showCost && (
        <CostEditor
          // Remount on a userId change so a half-typed number (or a flipped pricing mode) can never
          // survive onto another bot.
          key={r.userId}
          login={r.login}
          costMonthlyUsd={r.costMonthlyUsd}
          costModel={r.costModel}
          workspaceSeatCount={workspaceSeatCount}
          busy={busy}
          onApply={(v, m) => onCost(r.userId, v, m)}
        />
        )}
      </div>
    </li>
  );
}

// ── The logo ────────────────────────────────────────────────────────────────────────────────

/**
 * The card's logo: the account's own GitHub avatar (for a GitHub App bot that IS the vendor's
 * logo), else — no avatar, an unsafe URL, or a load error — a monogram tile on the vendor colour.
 *
 * The URL goes through `safeExternalUrl` (a data-derived URL never reaches `src` raw); the SPA's CSP
 * `img-src … https:` already admits avatars.githubusercontent.com in both modes. The monogram's
 * text colour is picked by contrast against the tile (`monogramInk`), never the brand hex itself.
 */
function BotAvatar({
  avatarUrl,
  name,
  color,
  muted,
}: {
  avatarUrl: string | null;
  name: string;
  color: string;
  muted: boolean;
}): JSX.Element {
  const src = safeExternalUrl(avatarUrl);
  // Keyed on the URL so a refetch that brings a NEW avatar retries the image.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src != null && failedSrc !== src) {
    return (
      <img
        src={src}
        alt=""
        width={36}
        height={36}
        loading="lazy"
        onError={() => setFailedSrc(src)}
        className={`h-9 w-9 shrink-0 rounded-md border border-gray-200 bg-white object-cover dark:border-gray-700 ${
          muted ? 'grayscale' : ''
        }`}
      />
    );
  }
  const bg = muted ? '#6b7280' : color;
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-md text-xs font-semibold"
      style={{ backgroundColor: bg, color: monogramInk(bg) }}
    >
      {monogramFor(name)}
    </span>
  );
}

// ── The price ───────────────────────────────────────────────────────────────────────────────

// Per-state input chrome. The two states must be distinguishable at a glance, because emptying the
// box means something different in each: on a priced bot it CLEARS, on an unpriced one it does
// nothing.
const COST_INPUT_CLS: Record<CostState, string> = {
  set: 'border-ai-signal/60 text-gray-800 dark:text-gray-100',
  none: 'border-gray-300 text-gray-800 dark:border-gray-700 dark:text-gray-100',
};

/**
 * One bot's monthly price IN THIS WORKSPACE — a number plus its reading rule (flat / per seat).
 *
 * ⚠ THE LABEL IS "PRICE FOR THIS WORKSPACE", NOT "PRICE". The old control sat in an account-wide
 * section and was captioned "all repos"; the price is now a plain column on the same per-Workspace
 * row as everything else on the card, so an unqualified "Price" would read as a global setting and
 * invite exactly the cross-Workspace totalling this product forbids. Editing it here leaves every
 * other Workspace alone, and they may legitimately hold a different number, or none.
 *
 * ⚠ 0 IS A PRICE ("we pay nothing"), EMPTY IS NO PRICE. `parseCostInput` keeps them apart —
 * `Number('')` is 0, which is exactly the trap.
 *
 * ⚠ THE MODE IS PART OF WHAT SAVE SAVES. Under "per seat" the typed number is a per-seat unit and
 * the displayed monthly is unit × the Workspace's derived seat count — SERVER-computed on read;
 * the "× N seats ≈ $X/mo" line below is a preview of the same arithmetic, never a second source
 * of truth. A mode flip with an unchanged number is a REAL save (`costEditOutcome` compares
 * both), and the mode state lives inside this component so the remount key on `userId` keeps a
 * flipped toggle from ever leaking onto another bot's card.
 */
function CostEditor({
  login,
  costMonthlyUsd,
  costModel,
  workspaceSeatCount,
  busy,
  onApply,
}: {
  login: string;
  costMonthlyUsd: number | null;
  costModel: CostModel;
  workspaceSeatCount: number;
  busy: boolean;
  onApply: (value: number | null, model: CostModel) => void;
}): JSX.Element {
  const state = costStateOf({ costMonthlyUsd });
  const serverText = formatCostInput(costMonthlyUsd);
  const [text, setText] = useState(serverText);
  const [mode, setMode] = useState<CostModel>(costModel);
  // Re-seed BOTH fields when the server row changes under us (a save, a refetch): the mode is as
  // much "the stored value" as the number is, and a stale one would silently re-save the old
  // metering. Same U+001F separator rationale as the identity seed above (greppability).
  const SEP = '\u001f';
  const serverSeed = `${serverText}${SEP}${costModel}`;
  const [seededFrom, setSeededFrom] = useState(serverSeed);
  if (seededFrom !== serverSeed) {
    setSeededFrom(serverSeed);
    setText(serverText);
    setMode(costModel);
  }

  const parsed = parseCostInput(text);
  const outcome = parsed.ok ? costEditOutcome(costMonthlyUsd, parsed.value, costModel, mode) : null;

  // What the button would do / why it can't. The one no-op outcome is exactly the case where a
  // user who clicked and saw nothing needs the explanation on screen, not on hover.
  let hint: string;
  if (!parsed.ok) hint = parsed.error;
  else if (outcome == null) hint = '';
  else
    switch (outcome.kind) {
      case 'set':
        hint =
          mode === 'per_seat'
            ? 'Sets a per-seat price for this Workspace — the monthly figure is the price × this Workspace’s seats. Other Workspaces are unaffected.'
            : 'Sets this bot’s price for this Workspace. Other Workspaces are unaffected.';
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

  const modeBtnCls = (active: boolean): string =>
    `px-1.5 py-0.5 text-[11px] font-medium ${
      active
        ? 'bg-sky-600 text-white'
        : 'bg-white text-gray-500 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'
    }`;

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
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
            onApply(parsed.value, mode);
          }
        }}
        aria-label={`Monthly cost in US dollars for ${login} in this Workspace`}
      />
      <span className="text-[11px] text-gray-400">{mode === 'per_seat' ? '/seat/mo' : '/mo'}</span>

      {/* Flat vs per-seat. A segmented pair rather than a checkbox so the stored state is always
          one of the two words on screen. */}
      <span
        role="group"
        aria-label={`Pricing model for ${login} in this Workspace`}
        className="inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700"
      >
        <button type="button" disabled={busy} onClick={() => setMode('flat')} className={modeBtnCls(mode === 'flat')}>
          flat
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setMode('per_seat')}
          className={modeBtnCls(mode === 'per_seat')}
          title="Meter this bot per seat — a seat is a distinct human who opened a PR in this Workspace’s repos over the last 30 days."
        >
          per seat
        </button>
      </span>

      {/* Read-only preview of the server's read-time arithmetic — never a second source of truth
          for a saved figure. */}
      {mode === 'per_seat' && parsed.ok && parsed.value != null && (
        <span
          className="text-[11px] tabular-nums text-gray-400"
          title="Seats are the distinct humans who opened a PR in this Workspace’s repos over the last 30 days. The monthly figure is derived at read time and moves with the team."
        >
          × {workspaceSeatCount} seat{workspaceSeatCount === 1 ? '' : 's'} ≈ $
          {formatCostInput(perSeatMonthlyUsd(parsed.value, workspaceSeatCount))}/mo
        </span>
      )}

      <button
        type="button"
        disabled={busy || !parsed.ok || outcome?.dirty !== true}
        onClick={() => {
          if (parsed.ok && outcome?.dirty === true) onApply(parsed.value, mode);
        }}
        title={hint}
        className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        {outcome?.kind === 'clear' ? 'Clear' : 'Save price'}
      </button>

      <span className={`text-[11px] ${parsed.ok ? 'text-gray-400' : 'text-red-500'}`}>{hint}</span>
    </div>
  );
}
