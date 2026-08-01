import { useMemo, useState } from 'react';
import type {
  AutomatedReviewerKind,
  RepoReviewer,
  ReviewerIdentity,
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
  actorSummaries,
  emptyStateCopy,
  groupRowsByRepo,
  humanCandidates,
  identityIndex,
  monthlyCostTotal,
  reviewerListEmptyKind,
  type ActorSummary,
  type RepoReviewerGroup,
} from '../../lib/botReviewers.js';
import {
  useDetectedReviewers,
  useRepoReviewerJudgement,
  useResetRepoReviewerJudgement,
  useResetReviewerIdentity,
  useReviewerCost,
  useReviewerIdentity,
} from '../../hooks/useBotTriage.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { SectionShell, inputCls } from './ui.js';

const ALL_KINDS = Object.keys(BOT_VENDOR_META) as AutomatedReviewerKind[];
const MAX_SEARCH_MATCHES = 8;

// The shared `inputCls` carries `w-full`, and Tailwind emits `.w-full` AFTER `.w-32`/`.w-auto`,
// so appending a width to it does nothing — the vendor picker and label box stretched edge to edge
// and the row read as a form, not a list. This is the same chrome with the width left off.
const FIELD_CLS =
  'rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-sky-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100';

// The bot-reviewer settings surface. CORE (free) — no capability gate.
//
// ── ONE OBJECT PER (REPO, ACTOR), AND NO DEDUPLICATION ──────────────────────────────────────
// The list below is grouped BY REPO and a vendor running in six repos appears six times, once per
// group. That is the intended display, not a bug to collapse: a bot is installed per repository,
// so "is `githubactions` a review bot?" only has an answer once a repo is named. A single-repo
// view is the same list with one group.
//
// ── TWO EDIT GRAINS, AND THE UI HAS TO MAKE THE DIFFERENCE UNMISSABLE ───────────────────────
// This screen is the only place both grains are editable, so it is the only place a user can
// mistake one for the other — and one direction of that mistake is the expensive one:
//
//   PER REPO   automated / role      → the buttons on each repo row. Local, obvious, reversible.
//   EVERYWHERE vendor kind / label / price → the "in every repo" section at the TOP.
//
// A user editing a repo row expects a local change and gets one. A user editing a vendor name or
// a price inside a repo group would expect a local change and get a global one — six rows renamed
// from a control that looked like it belonged to one. It reads as unrecoverable even though it is
// not, because there is no per-repo copy to "put back". So the account-wide controls do NOT live
// on the repo rows at all: they are lifted into their own section, with their own banner, and the
// repo rows show the vendor identity READ-ONLY as a coloured chip.
//
// ── WHY IDENTITY IS ACTOR-GRAIN IN THE FIRST PLACE ──────────────────────────────────────────
// A login is one vendor everywhere, so colour and vendor name key on the ACTOR. When they lived on
// the repo rows, clicking "Not a bot" in ONE repo nulled that row's kind, identity resolution
// picked it up, and CodeRabbit lost its brand colour and vendor name in the repos the user never
// touched — with no surface to undo it from.
//
// ── COST RENDERS ONCE PER ACTOR ─────────────────────────────────────────────────────────────
// You buy one subscription. Six CodeRabbit repo rows each showing $120 (and totalling $720) is the
// display bug the storage split cannot prevent, so the price is shown exactly once, in the
// account-wide section, and the total comes from `monthlyCostTotal`, which dedupes by userId.
//
// ── EVERY EDIT HAS A WAY BACK, AND THE TWO WAYS BACK ARE NOT INTERCHANGEABLE ─────────────────
// A manual write pins its row against re-derivation, so an edit with no reset is permanent —
// flipping the value back by hand re-stamps 'manual' and leaves it just as frozen. So each grain
// gets its own reset, and each is offered ONLY where it applies:
//
//   "Reset to auto"  on a repo row, only when `row.isManualOverride`   → ONE repo
//   "Reset to auto"  on an actor card, only when `identitySource === 'manual'` → EVERY repo
//
// Gating them on those flags is not tidiness: a reset control on an already-auto row does nothing,
// and a control that appears to do nothing is indistinguishable from a broken one. The blast
// radii differ by an order of magnitude, so they are labelled and placed differently — the
// per-repo one sits inline with the other per-repo buttons, the account-wide one inside the
// banded "in every repo" section — and the account-wide one states IN THE UI that the price is
// kept, because "reset" reads as "delete everything" otherwise.
export function DetectedReviewersTable({
  scope,
  repoIds,
}: { scope?: string; repoIds?: number[] | null } = {}): JSX.Element {
  const q = useDetectedReviewers(scope, repoIds);
  const { data: repos } = useRepos();
  // Account-wide colour resolver (its own unscoped listing — deliberately NOT this component's
  // possibly-narrowed data, or a bot would change colour when you narrow the scope).
  const botColor = useBotColors();

  const judgement = useRepoReviewerJudgement();
  const identity = useReviewerIdentity();
  const cost = useReviewerCost();
  const resetJudgement = useResetRepoReviewerJudgement();
  const resetIdentity = useResetReviewerIdentity();
  const busy =
    judgement.isPending ||
    identity.isPending ||
    cost.isPending ||
    resetJudgement.isPending ||
    resetIdentity.isPending;

  const [query, setQuery] = useState('');

  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const reviewers = useMemo(() => q.data?.reviewers ?? [], [q.data]);
  const listRepoIds = useMemo(() => q.data?.repoIds ?? [], [q.data]);

  const identityById = useMemo(() => identityIndex(reviewers), [reviewers]);
  const groups = useMemo(() => groupRowsByRepo(rows, listRepoIds), [rows, listRepoIds]);
  const actors = useMemo(
    () => actorSummaries(reviewers, rows, listRepoIds),
    [reviewers, rows, listRepoIds],
  );
  const costTotal = useMemo(() => monthlyCostTotal(reviewers, rows), [reviewers, rows]);
  const repoName = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of repos ?? []) m.set(r.id, r.fullName);
    return m;
  }, [repos]);

  const matches = useMemo(
    () => humanCandidates(reviewers, rows, query, MAX_SEARCH_MATCHES, listRepoIds),
    [reviewers, rows, query, listRepoIds],
  );

  const emptyKind = reviewerListEmptyKind(listRepoIds, rows);

  const anyError =
    judgement.error ?? identity.error ?? cost.error ?? resetJudgement.error ?? resetIdentity.error;

  return (
    <SectionShell
      title="Review bots"
      desc="Which reviewers we treat as automated — set per repo, because a bot is installed per repo. Who each bot is, and what it costs, is set once for the whole account."
    >
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
          <AccountWideSection
            actors={actors}
            costTotal={costTotal}
            botColor={botColor}
            busy={busy}
            onSaveIdentity={(userId, kind, label) =>
              identity.mutate({ userId, body: { kind, label: label.trim() === '' ? null : label } })
            }
            onSaveCost={(userId, monthlyUsd) =>
              cost.mutate({ userId, body: buildCostBody(monthlyUsd) })
            }
            onResetIdentity={(userId) => resetIdentity.mutate({ userId })}
          />

          <PerRepoSection
            groups={groups}
            repoName={repoName}
            identityById={identityById}
            botColor={botColor}
            busy={busy}
            onJudge={(userId, body) => judgement.mutate({ userId, body })}
            onResetJudgement={(userId, repoId) => resetJudgement.mutate({ userId, repoId })}
          />

          {/* Search-to-promote: find a reviewer we currently treat as human and mark them
              automated IN A NAMED REPO. The repo buttons are the whole point — a judgement with
              no repo has no row to land on, and offering only the repos where they actually have
              a footprint stops the UI fabricating bot objects for repos they have never touched. */}
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
                Type a reviewer&apos;s name, then pick the repo to mark them automated in. They join
                that repo&apos;s <span className="font-medium">Review bots</span> list; set the
                vendor and price once, above.
              </p>
            ) : matches.length === 0 ? (
              <p className="text-[10px] text-gray-400">
                No matching reviewers we currently treat as human.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
                {matches.map((m) => (
                  <li key={m.identity.userId} className="flex flex-col gap-1 px-2.5 py-1.5">
                    <div className="flex items-center gap-2">
                      {m.identity.avatarUrl != null && (
                        <img src={m.identity.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full" />
                      )}
                      <span className="truncate text-xs font-medium text-gray-800 dark:text-gray-100">
                        {m.identity.login}
                        {m.identity.displayName != null &&
                          m.identity.displayName !== m.identity.login && (
                            <span className="ml-1 font-normal text-gray-400">
                              {m.identity.displayName}
                            </span>
                          )}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pl-7">
                      <span className="text-[10px] text-gray-400">Treat as a review bot in</span>
                      {m.repoIds.map((rid) => (
                        <button
                          key={rid}
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            judgement.mutate({
                              userId: m.identity.userId,
                              // No `role`: absent takes the column's 'review' default. No
                              // kind/label either — naming the vendor is the other grain, and
                              // doing it from here would be an account-wide write behind a
                              // per-repo-looking button.
                              body: { repoId: rid, automated: true },
                            });
                            setQuery('');
                          }}
                          className="rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
                        >
                          {repoName.get(rid) ?? `repo #${rid}`}
                        </button>
                      ))}
                    </div>
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

// ── The account-wide half ───────────────────────────────────────────────────────────────────

type BotColorFn = (bot: { login?: string | null; kind: AutomatedReviewerKind }) => string;

/**
 * Vendor identity + price, ONE CARD PER ACTOR, above every repo group.
 *
 * ⚠ ITS PLACEMENT IS THE SAFETY MECHANISM. These fields are the same in every repo by definition,
 * so an editor for them sitting inside a repo group would look local and act global. Lifting them
 * out — with a banner that says so, and a per-card count of the repos affected — is what makes the
 * scope legible BEFORE the edit rather than surprising after it.
 */
function AccountWideSection({
  actors,
  costTotal,
  botColor,
  busy,
  onSaveIdentity,
  onSaveCost,
  onResetIdentity,
}: {
  actors: ActorSummary[];
  costTotal: ReturnType<typeof monthlyCostTotal>;
  botColor: BotColorFn;
  busy: boolean;
  onSaveIdentity: (userId: number, kind: AutomatedReviewerKind, label: string) => void;
  onSaveCost: (userId: number, monthlyUsd: number | null) => void;
  onResetIdentity: (userId: number) => void;
}): JSX.Element | null {
  if (actors.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
          These bots, in every repo
        </h4>
        <span className="text-[10px] text-gray-400">
          Vendor and price are properties of the bot, not of a repo — one subscription however many
          repos it runs in.
        </span>
      </div>
      {/* Not a subtle hint: this is the one section whose edits reach rows the user is not
          looking at, so it is banded and says so in plain words. */}
      <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        Changes here apply <span className="font-semibold">everywhere</span> — in every repo this
        bot runs in, including ones not shown below. To change what a bot is in{' '}
        <span className="font-semibold">one</span> repo, use the buttons on its row further down.
      </p>
      <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
        {actors.map((a) => (
          <ActorCard
            key={a.identity.userId}
            actor={a}
            botColor={botColor}
            busy={busy}
            onSaveIdentity={onSaveIdentity}
            onSaveCost={onSaveCost}
            onResetIdentity={onResetIdentity}
          />
        ))}
      </ul>
      <p className="text-[10px] text-gray-400">
        {costTotal.totalUsd == null ? (
          <>No monthly prices set yet — add one per bot above to get $/acted-on in the ROI table.</>
        ) : (
          <>
            <span className="font-medium tabular-nums text-gray-600 dark:text-gray-300">
              ${formatCostInput(costTotal.totalUsd)}/mo
            </span>{' '}
            across {costTotal.pricedActors} bot{costTotal.pricedActors === 1 ? '' : 's'}
            {costTotal.unpricedActors > 0 && (
              <> · {costTotal.unpricedActors} with no price set</>
            )}
            .{' '}
            {/* The dedupe is invisible unless it is stated: a reader counting rows below will get
                a bigger number, and "the total is wrong" is the support question this pre-empts. */}
            <span className="text-gray-400">
              Counted once per bot, not once per repo.
            </span>
          </>
        )}
      </p>
    </section>
  );
}

function ActorCard({
  actor,
  botColor,
  busy,
  onSaveIdentity,
  onSaveCost,
  onResetIdentity,
}: {
  actor: ActorSummary;
  botColor: BotColorFn;
  busy: boolean;
  onSaveIdentity: (userId: number, kind: AutomatedReviewerKind, label: string) => void;
  onSaveCost: (userId: number, monthlyUsd: number | null) => void;
  onResetIdentity: (userId: number) => void;
}): JSX.Element {
  const id = actor.identity;
  // A newly-promoted actor has no vendor named yet (`kind: null`). Default the picker to In-house
  // AI rather than leaving it blank — that is the honest guess for an unrecognised automation, and
  // nothing is written until Save.
  const serverKind: AutomatedReviewerKind = id.kind ?? 'in_house';
  const [kind, setKind] = useState<AutomatedReviewerKind>(serverKind);
  const [label, setLabel] = useState(id.label);
  // Re-seed from the server when it changes under us (a save, or a refetch). Adjusting state
  // during render off a "previous props" marker is React's own documented alternative to a sync
  // effect — it avoids the extra render pass where the fields still show the old values.
  // The separator is U+001F (unit separator), NOT a literal NUL. A NUL byte in a source file
  // makes the WHOLE FILE binary to file(1), and grep/ripgrep skip binary files by default — so
  // this component silently stopped matching any repo-wide search, which is how a reviewer
  // concluded its buttons were unwired. In a codebase navigated by grep, an ungreppable file is
  // a real hazard. U+001F is equally impossible in a vendor kind or a GitHub display name.
  const SEP = '\u001f';
  const [seed, setSeed] = useState(`${serverKind}${SEP}${id.label}`);
  const nextSeed = `${serverKind}${SEP}${id.label}`;
  if (seed !== nextSeed) {
    setSeed(nextSeed);
    setKind(serverKind);
    setLabel(id.label);
  }

  const color = botColor({ login: id.login, kind: serverKind });
  const identityDirty = kind !== serverKind || label !== id.label;
  const repoCount = actor.repoIds.length;

  return (
    <li className="flex flex-col gap-1.5 px-2.5 py-2">
      <div className="flex items-center gap-2">
        {id.avatarUrl != null && (
          <img src={id.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full" />
        )}
        <span className="truncate text-xs font-medium text-gray-800 dark:text-gray-100">
          {id.login}
          {id.displayName != null && id.displayName !== id.login && (
            <span className="ml-1 font-normal text-gray-400">{id.displayName}</span>
          )}
        </span>
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          style={{ color, backgroundColor: `${color}1a` }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
          {automatedReviewerMeta(serverKind).label}
        </span>
        {id.identitySource === 'manual' && (
          <span className="shrink-0 rounded bg-sky-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-600 dark:bg-sky-950 dark:text-sky-300">
            named by you
          </span>
        )}
        {/* The blast radius of the controls below, on the control itself. "6 repos" next to a
            rename is the difference between an informed edit and a surprise. */}
        <span className="ml-auto shrink-0 text-[10px] text-gray-400">
          {repoCount} repo{repoCount === 1 ? '' : 's'}
          {actor.reviewRepoCount > 0 && actor.qualityRepoCount > 0 && (
            <span title="Roled differently in different repos — that is allowed; the role is per repo.">
              {' '}
              · {actor.reviewRepoCount} review / {actor.qualityRepoCount} quality
            </span>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className={`${FIELD_CLS} w-auto py-0.5`}
          value={kind}
          onChange={(e) => setKind(e.target.value as AutomatedReviewerKind)}
          aria-label={`Vendor for ${id.login} (all repos)`}
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
          aria-label={`Display label for ${id.login} (all repos)`}
        />
        <button
          type="button"
          disabled={busy || !identityDirty}
          onClick={() => onSaveIdentity(id.userId, kind, label)}
          title={`Rename this bot in all ${repoCount} repo${repoCount === 1 ? '' : 's'}. It does not change whether it counts as a bot anywhere.`}
          className="rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
        >
          Save for all repos
        </button>
        {/* THE WAY BACK, and it is shown ONLY on a manually-named bot. On an auto identity there
            is nothing to reset, and a control that does nothing reads as a broken one. It is the
            only way back: re-typing the auto name by hand would just re-stamp "named by you".

            ⚠ ITS BLAST RADIUS IS THE WHOLE ACCOUNT — hence the repo count in the label, and hence
            its home in this banded section rather than on a repo row. The per-repo reset (one row,
            one repo) lives on the rows below and is worded to match. */}
        {id.identitySource === 'manual' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onResetIdentity(id.userId)}
            title={`Forget the vendor and label you set and let detection name this bot again, in all ${repoCount} repo${repoCount === 1 ? '' : 's'}. The monthly price is kept, and no repo's bot / not-a-bot verdict changes.`}
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Reset name to auto
          </button>
        )}
      </div>
      {/* Stated on screen, not only in a tooltip: "reset" reads as "delete everything", and the
          one thing a user is afraid of losing here is the number they typed into the box below. */}
      {id.identitySource === 'manual' && (
        <p className="text-[10px] text-gray-400">
          Reset hands the vendor and label back to detection in all {repoCount} repo
          {repoCount === 1 ? '' : 's'} —{' '}
          <span className="font-medium text-gray-500 dark:text-gray-300">the price is kept</span>,
          and no repo&apos;s bot / not-a-bot verdict changes.
        </p>
      )}

      <CostEditor
        // Remount on a userId change so a half-typed number can never survive onto another bot.
        key={id.userId}
        login={id.login}
        costMonthlyUsd={id.costMonthlyUsd}
        repoCount={repoCount}
        busy={busy}
        onApply={(v) => onSaveCost(id.userId, v)}
      />
    </li>
  );
}

// ── The per-repo half ───────────────────────────────────────────────────────────────────────

/**
 * One group per repo, in the server's order. A vendor in six repos appears in six groups — that
 * is the model, stated as a layout.
 *
 * Quality checks get their own sub-list rather than being hidden: a mis-role must be discoverable
 * ("why did SonarQube vanish?"), and the row stays re-rolable in place. The split is per repo, so
 * the same login can sit under Review bots here and Quality checks in the next group; nothing
 * compares the two.
 */
function PerRepoSection({
  groups,
  repoName,
  identityById,
  botColor,
  busy,
  onJudge,
  onResetJudgement,
}: {
  groups: RepoReviewerGroup[];
  repoName: Map<number, string>;
  identityById: Map<number, ReviewerIdentity>;
  botColor: BotColorFn;
  busy: boolean;
  onJudge: (userId: number, body: { repoId: number; automated?: boolean; role?: 'review' | 'quality_check' }) => void;
  onResetJudgement: (userId: number, repoId: number) => void;
}): JSX.Element {
  return (
    <section className="mt-4 space-y-2">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">Repo by repo</h4>
        <span className="text-[10px] text-gray-400">
          A bot is installed per repository, so this is where &ldquo;is it a bot here, and is it
          reviewing or quality-checking here&rdquo; is answered. The same vendor appears once per
          repo — that is intended.
        </span>
      </div>
      <p className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] text-gray-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-400">
        Changes below apply to <span className="font-semibold">that repo only</span>. The vendor
        name and price shown on each row are the bot&apos;s account-wide identity — edit them in the
        section above.
      </p>
      {groups.map((g) => (
        <div key={g.repoId} className="rounded border border-gray-200 dark:border-gray-700">
          <div className="flex flex-wrap items-baseline gap-1.5 border-b border-gray-200 px-2.5 py-1.5 dark:border-gray-700">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">
              {repoName.get(g.repoId) ?? `repo #${g.repoId}`}
            </span>
            <span className="text-[10px] text-gray-400">
              {g.reviewBots.length} review bot{g.reviewBots.length === 1 ? '' : 's'}
              {g.qualityChecks.length > 0 && ` · ${g.qualityChecks.length} quality check${g.qualityChecks.length === 1 ? '' : 's'}`}
            </span>
          </div>
          {g.reviewBots.length === 0 &&
          g.qualityChecks.length === 0 &&
          g.markedNotBots.length === 0 ? (
            <p className="px-2.5 py-2 text-[11px] text-gray-400">
              No automated reviewers detected here yet — they appear once one has reviewed or
              commented on a PR we&apos;ve synced.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {g.reviewBots.map((r) => (
                  <RepoReviewerRow
                    key={r.userId}
                    row={r}
                    identity={identityById.get(r.userId)}
                    botColor={botColor}
                    busy={busy}
                    onJudge={onJudge}
                    onResetJudgement={onResetJudgement}
                  />
                ))}
              </ul>
              {g.qualityChecks.length > 0 && (
                <div className="border-t border-gray-200 dark:border-gray-700">
                  <p className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-gray-400">
                    Quality checks — excluded from the review-bot metrics
                  </p>
                  <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {g.qualityChecks.map((r) => (
                      <RepoReviewerRow
                        key={r.userId}
                        row={r}
                        identity={identityById.get(r.userId)}
                        botColor={botColor}
                        busy={busy}
                        onJudge={onJudge}
                        onResetJudgement={onResetJudgement}
                      />
                    ))}
                  </ul>
                </div>
              )}
              {/* ⚠ THE ROWS SOMEONE DISMISSED, KEPT VISIBLE. "Not a bot here" writes a manual row
                  the classifier honours forever; before this sub-list existed the row simply left
                  the screen, so the pin was permanent AND unreachable — the search box could only
                  offer to re-promote it (another manual write), never to hand it back to detection.
                  Only DELIBERATE dismissals appear here (groupRowsByRepo filters on
                  isManualOverride); every ordinary human commenter also has a not-automated row
                  and listing those would bury these under the contributor roster. */}
              {g.markedNotBots.length > 0 && (
                <div className="border-t border-gray-200 dark:border-gray-700">
                  <p className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-gray-400">
                    Marked &ldquo;not a bot&rdquo; here by you — detection leaves these alone
                  </p>
                  <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {g.markedNotBots.map((r) => (
                      <RepoReviewerRow
                        key={r.userId}
                        row={r}
                        identity={identityById.get(r.userId)}
                        botColor={botColor}
                        busy={busy}
                        onJudge={onJudge}
                        onResetJudgement={onResetJudgement}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * One judgement row: this actor, in this repo.
 *
 * ⚠ THE VENDOR CHIP IS READ-ONLY HERE, ON PURPOSE. Its kind, label and colour come from the
 * ACTOR's identity (see the section above) — rendering an editor for them on a row inside a repo
 * group is exactly the footgun this layout exists to remove.
 */
function RepoReviewerRow({
  row,
  identity,
  botColor,
  busy,
  onJudge,
  onResetJudgement,
}: {
  row: RepoReviewer;
  identity: ReviewerIdentity | undefined;
  botColor: BotColorFn;
  busy: boolean;
  onJudge: (userId: number, body: { repoId: number; automated?: boolean; role?: 'review' | 'quality_check' }) => void;
  onResetJudgement: (userId: number, repoId: number) => void;
}): JSX.Element {
  const kind: AutomatedReviewerKind = identity?.kind ?? 'in_house';
  const color = botColor({ login: identity?.login, kind });
  const isQuality = row.role === 'quality_check';
  const f = row.footprint;
  return (
    <li className="flex flex-col gap-1 px-2.5 py-2">
      <div className="flex items-center gap-2">
        {identity?.avatarUrl != null && (
          <img src={identity.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full" />
        )}
        <span
          className="truncate text-xs font-medium text-gray-800 dark:text-gray-100"
          title={row.sampleReviewBody ?? undefined}
        >
          {identity?.login ?? `user #${row.userId}`}
        </span>
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          style={{ color, backgroundColor: `${color}1a` }}
          title="The bot's account-wide vendor identity — edit it in “These bots, in every repo”."
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
          {identity?.label ?? automatedReviewerMeta(kind).label}
        </span>
        {row.confidence !== 'high' && (
          <span className="shrink-0 text-[10px] text-amber-500" title={row.reasons.join(' · ')}>
            likely ({row.confidence})
          </span>
        )}
        {row.isManualOverride ? (
          <span className="shrink-0 rounded bg-sky-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-600 dark:bg-sky-950 dark:text-sky-300">
            manual
          </span>
        ) : (
          <span
            className="shrink-0 text-[9px] uppercase tracking-wide text-gray-300 dark:text-gray-600"
            title={row.reasons.join(' · ')}
          >
            {row.source.replace(/_/g, ' ')}
          </span>
        )}
        {/* The per-repo footprint. It is what makes a stale row legible without a flag: all-zero
            counts mean "a judgement recorded for a repo this reviewer no longer touches", which
            used to need a `dormantInScope` boolean back when a row had no repo to point at. */}
        <span
          className="ml-auto shrink-0 text-[10px] text-gray-400"
          title="Reviews / inline threads / PR comments in this repo over the last 90 days"
        >
          {f.reviews}r · {f.threads}t · {f.comments}c
          <span className="ml-1 text-gray-300 dark:text-gray-600">90d</span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {/* A row in the "marked not a bot" bucket needs the OPPOSITE control — the two below both
            assume `automated`, and offering "Not a bot here" on a row that already says so is a
            button that changes nothing but the timestamp. */}
        {row.automated ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onJudge(row.userId, {
                  repoId: row.repoId,
                  // `automated: true` is sent alongside the role so the row is stamped a human
                  // judgement in one write. It is already true on this branch, so it changes
                  // nothing but the provenance — which is the point of pressing a button.
                  automated: true,
                  role: isQuality ? 'review' : 'quality_check',
                })
              }
              title={
                isQuality
                  ? 'In this repo, treat it as a real AI code reviewer again — it re-enters the ROI, behaviour and dedup metrics here.'
                  : 'In this repo, treat it as static analysis / coverage / lint. Stays visible in the feed, but is excluded from the review-bot metrics here.'
              }
              className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {isQuality ? 'Treat as review bot here' : 'Mark as quality check here'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onJudge(row.userId, { repoId: row.repoId, automated: false })}
              title="In this repo, stop treating this reviewer as automated. Its other repos are unaffected, and it keeps its vendor name and price everywhere."
              className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Not a bot here
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => onJudge(row.userId, { repoId: row.repoId, automated: true })}
            title="In this repo, treat this reviewer as automated again. Its other repos are unaffected."
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Treat as a review bot here
          </button>
        )}
        {/* THE WAY BACK for this row, shown ONLY once a human has pinned it. The two buttons above
            both stamp the row `manual`, which is what stops the next detection pass silently
            reverting the edit — and also what makes it permanent without this. Note that pressing
            one of them AGAIN does not undo anything: the row stays pinned, just on the new value.

            ⚠ ONE REPO. The account-wide reset (vendor name, every repo) is in the section at the
            top; the label says "here" for the same reason the buttons above do. */}
        {row.isManualOverride && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onResetJudgement(row.userId, row.repoId)}
            title="Forget your judgement for this repo and let detection decide again here. Its other repos are unaffected, and its vendor name and price are untouched."
            className="rounded border border-dashed border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Reset to auto here
          </button>
        )}
      </div>
      {/* On screen rather than only on hover: the reset is the half of the model that is not
          guessable from the buttons, and the scope difference from the account-wide reset above is
          the thing a user must not get wrong. */}
      {row.isManualOverride && (
        <p className="text-[10px] text-gray-400">
          Set by you — detection will not change it here until you reset. Resetting affects{' '}
          <span className="font-medium text-gray-500 dark:text-gray-300">this repo only</span>, and
          keeps the bot&apos;s vendor name and price.
        </p>
      )}
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
 * One bot's monthly price.
 *
 * ⚠ ACCOUNT-WIDE, AND RENDERED EXACTLY ONCE. It lives on the actor card, never on a repo row: the
 * price is one subscription, so six repo rows each showing $120 would total $720 against an
 * invoice that says $120. The repo count is printed next to the control so the scope is visible
 * before the edit, not inferred after it.
 *
 * ⚠ 0 IS A PRICE ("we pay nothing"), EMPTY IS NO PRICE. `parseCostInput` keeps them apart —
 * `Number('')` is 0, which is exactly the trap.
 */
function CostEditor({
  login,
  costMonthlyUsd,
  repoCount,
  busy,
  onApply,
}: {
  login: string;
  costMonthlyUsd: number | null;
  repoCount: number;
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
        hint = `Sets this bot’s price across all ${repoCount} repo${repoCount === 1 ? '' : 's'} — it is one subscription.`;
        break;
      case 'clear':
        hint = 'Clears the price. $/acted-on stops showing for this bot.';
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
      <span className="text-[10px] uppercase tracking-wide text-gray-400">Cost</span>
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
        aria-label={`Monthly cost in US dollars for ${login}, all repos`}
      />
      <span className="text-[11px] text-gray-400">/mo</span>
      <span className="text-[9px] uppercase tracking-wide text-gray-400" title="One subscription, however many repos this bot runs in.">
        all repos
      </span>

      <button
        type="button"
        disabled={busy || !parsed.ok || outcome?.dirty !== true}
        onClick={() => {
          if (parsed.ok && outcome?.dirty === true) onApply(parsed.value);
        }}
        title={hint}
        className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        {outcome?.kind === 'clear' ? 'Clear' : 'Save cost'}
      </button>

      <span className={`text-[10px] ${parsed.ok ? 'text-gray-400' : 'text-red-500'}`}>{hint}</span>
    </div>
  );
}
