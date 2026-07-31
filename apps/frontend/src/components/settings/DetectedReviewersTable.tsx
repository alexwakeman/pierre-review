import { useMemo, useState } from 'react';
import type { AutomatedReviewerKind, DetectedReviewer, ReviewerRole } from '@pierre-review/shared';
import { NO_TEAM_KEY } from '@pierre-review/shared';
import { automatedReviewerMeta, BOT_VENDOR_META } from '../../lib/ui.js';
import {
  buildCostOnlyBody,
  costEditOutcome,
  costStateOf,
  emptyStateCopy,
  emptyStateFor,
  formatCostInput,
  parseCostInput,
  resetOverrideOffer,
  DEFAULT_SOURCE_LABEL,
  type CostState,
} from '../../lib/botCost.js';
import {
  useDeleteReviewerOverride,
  useDetectedReviewers,
  useReviewerOverride,
} from '../../hooks/useBotTriage.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { SectionShell, inputCls } from './ui.js';

const ALL_KINDS = Object.keys(BOT_VENDOR_META) as AutomatedReviewerKind[];
const MAX_SEARCH_MATCHES = 8;

// The account's automated reviewers, plus a search box to promote any human reviewer to a bot.
// CORE — the two-way override (mark automated / not-a-bot), the vendor kind/label, the
// ReviewerRole and the per-team monthly COST all PATCH /api/bot-reviewers.
//
// `teamId` is the TEAM whose answers are being edited (NO_TEAM_KEY = "No team (default)", which
// is BOTH the No-team scope and the inheritance root every other team falls back to). A row the
// server reports as `inherited` came from the default rather than an explicit row for this team;
// editing it CREATES a team override, and "Reset to default" (only offered on a real override)
// removes it again.
//
// ⚠ TWO INHERITANCE AXES, resolved differently, shown separately on every row:
//   • the CLASSIFICATION (`inherited`) is ROW-level — an explicit team row wins WHOLESALE;
//   • the COST (`costInherited`) is FIELD-level — a team row created to hold a role opinion still
//     uses the default's price until someone types one here.
// A row can legitimately be `inherited: false, costInherited: true`, so the two badges are
// rendered independently rather than being folded into one "inherited" chip.
//
// Two lists, because a quality check is not a reviewer: **Review bots** (AI code reviewers — the
// ones every metric counts) and **Quality checks** (static analysis / coverage / lint — still
// automated, still visible in the feed, but excluded from ROI, behaviour, dedup and the
// benchmark). The role is a SEPARATE control from the vendor kind: they are orthogonal axes, so
// DeepSource can be marked a quality check without losing its brand identity or colour.
//
// Only automated reviewers are listed by default (an account can have dozens of human
// maintainers — the full list is unusable); the search below finds a person by login/name and
// marks them a bot, after which they move into the list where kind/label/role/cost are editable.
export function DetectedReviewersTable({
  teamId = NO_TEAM_KEY,
}: { teamId?: number } = {}): JSX.Element {
  // SCOPED: this tab asks for the reviewers seen in THIS team's own repos (at team 0, the repos
  // in no team), which is what makes `scopedRepoCount` a number and lets the empty state say
  // whether the team has no repos or the repos have no bots. The flag is opt-in and lives in the
  // query key — the account-wide consumers (bot colours, feed tags, thread filter) must keep
  // getting the unnarrowed roster.
  const q = useDetectedReviewers(teamId, true, { scoped: true });
  const botColor = useBotColors();
  const override = useReviewerOverride();
  const resetOverride = useDeleteReviewerOverride();
  const [drafts, setDrafts] = useState<
    Record<number, { kind: AutomatedReviewerKind; label: string }>
  >({});
  const [query, setQuery] = useState('');

  const rowDraft = (r: DetectedReviewer): { kind: AutomatedReviewerKind; label: string } =>
    drafts[r.userId] ?? { kind: r.classification.kind ?? 'in_house', label: r.classification.label };
  const patchDraft = (
    r: DetectedReviewer,
    patch: Partial<{ kind: AutomatedReviewerKind; label: string }>,
  ): void => setDrafts((prev) => ({ ...prev, [r.userId]: { ...rowDraft(r), ...patch } }));

  const busy = override.isPending || resetOverride.isPending;
  const reviewers = q.data?.reviewers ?? [];
  const scopedRepoCount = q.data?.scopedRepoCount ?? null;
  const automated = reviewers.filter((r) => r.classification.automated === true);
  const humans = reviewers.filter((r) => r.classification.automated !== true);
  // Rows that exist ONLY as a stored classification for this team — no footprint in its repos.
  // They are pulled out of the two main lists (they'd read as active bots) but NOT dropped: they
  // still govern the moment a repo moves back into the team, so hiding one produces exactly the
  // "set somewhere I can't find" support question this flag exists to pre-empt.
  const dormantHere = automated.filter((r) => r.dormantInScope);
  const live = automated.filter((r) => !r.dormantInScope);
  // The role split. `role` is meaningless on a human (callers must gate on `automated` first),
  // which is why it is only read inside the automated subset.
  const reviewBots = live.filter((r) => r.classification.role !== 'quality_check');
  const qualityChecks = live.filter((r) => r.classification.role === 'quality_check');

  // Only surface the (potentially huge) human list once the user types — that's the whole point.
  const trimmedQuery = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (trimmedQuery === '') return [];
    return humans
      .filter((h) => `${h.login} ${h.displayName ?? ''}`.toLowerCase().includes(trimmedQuery))
      .slice(0, MAX_SEARCH_MATCHES);
  }, [humans, trimmedQuery]);

  // Every write carries the team key — omit it and the edit silently lands on the account
  // default instead of the team being viewed.
  const applyRole = (r: DetectedReviewer, role: ReviewerRole): void => {
    const d = rowDraft(r);
    override.mutate({
      userId: r.userId,
      // NO `costMonthlyUsd`: absent means "leave the stored cost alone", so re-roling a bot can
      // never wipe the price someone typed next to it.
      body: { automated: true, kind: d.kind, label: d.label, role, teamId },
    });
  };

  // Promote a human to an automated reviewer with a sensible default kind; on success the
  // detected-reviewers query refetches and the row re-appears in the bot list, where the exact
  // vendor kind + label + role + cost are editable inline.
  const promote = (r: DetectedReviewer): void => {
    override.mutate({ userId: r.userId, body: { automated: true, kind: 'in_house', teamId } });
    setQuery('');
  };

  const renderRow = (r: DetectedReviewer): JSX.Element => {
    const c = r.classification;
    const d = rowDraft(r);
    const meta = automatedReviewerMeta(c.kind ?? 'in_house');
    // Per-bot colour (brand-aware hybrid) so multiple in-house bots read distinctly,
    // matching their colour in the Bots ROI console + feed.
    const color = botColor({ login: r.login, kind: c.kind ?? 'in_house' });
    const isQuality = c.role === 'quality_check';
    // Whether "Reset to default" is offered here, and whether pressing it would take a price with
    // it (it deletes the whole row, cost column included). See `resetOverrideOffer`.
    const reset = resetOverrideOffer(r, teamId);
    return (
      <li key={r.userId} className={`flex flex-col gap-1.5 px-2.5 py-2 ${r.dormantInScope ? 'opacity-60' : ''}`}>
        <div className="flex items-center gap-2">
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
          <span className="ml-auto shrink-0 text-[10px] text-gray-400">
            {r.threadsLast90d} threads · 90d
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            style={{ color, backgroundColor: `${color}1a` }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
            {meta.label}
          </span>
          {c.confidence !== 'high' && (
            <span className="text-[10px] text-amber-500" title={c.reasons.join(' · ')}>
              likely ({c.confidence})
            </span>
          )}
          {r.isManualOverride ? (
            <span className="rounded bg-sky-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-600 dark:bg-sky-950 dark:text-sky-300">
              manual
            </span>
          ) : (
            <span
              className="text-[9px] uppercase tracking-wide text-gray-300 dark:text-gray-600"
              title={c.reasons.join(' · ')}
            >
              {c.source.replace(/_/g, ' ')}
            </span>
          )}
          {/* Where this CLASSIFICATION came from (row-level). Only meaningful once a TEAM (not the
              default) is being viewed — at NO_TEAM_KEY every row IS the default, so the badge
              would be noise. It NAMES its source rather than just saying "inherited": since this
              tab now lists only the team's own repos, the No-team row that governs it can be
              invisible from here, and "where was that set?" has to be answerable on the row. */}
          {teamId !== NO_TEAM_KEY &&
            (r.inherited ? (
              <span
                className="rounded border border-dashed border-gray-300 px-1 py-0.5 text-[9px] uppercase tracking-wide text-gray-400 dark:border-gray-600"
                title={`This classification comes from the “${DEFAULT_SOURCE_LABEL}” row, not from this team. Editing it here creates an override for this team only.`}
              >
                inherited · {DEFAULT_SOURCE_LABEL}
              </span>
            ) : (
              <span className="rounded bg-violet-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-violet-600 dark:bg-violet-950 dark:text-violet-300">
                team override
              </span>
            ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <select
            className={`${inputCls} w-auto py-0.5`}
            value={d.kind}
            onChange={(e) => patchDraft(r, { kind: e.target.value as AutomatedReviewerKind })}
            aria-label="Reviewer kind"
          >
            {ALL_KINDS.map((k) => (
              <option key={k} value={k}>
                {automatedReviewerMeta(k).label}
              </option>
            ))}
          </select>
          <input
            className={`${inputCls} w-28 py-0.5`}
            value={d.label}
            placeholder="Label"
            onChange={(e) => patchDraft(r, { label: e.target.value })}
            aria-label="Reviewer label"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              override.mutate({
                userId: r.userId,
                // NO `role` — absent means "leave the stored role alone", so editing the kind or
                // label of a quality check can never silently promote it back to a review bot.
                // NO `costMonthlyUsd` either, for the mirror reason: absent leaves the price be.
                body: { automated: true, kind: d.kind, label: d.label, teamId },
              })
            }
            className="rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
          >
            Apply
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => applyRole(r, isQuality ? 'review' : 'quality_check')}
            title={
              isQuality
                ? 'Treat this as a real AI code reviewer again — it re-enters the ROI, behaviour and dedup metrics.'
                : 'Static analysis / coverage / lint. Stays visible in the feed, but is excluded from the review-bot metrics.'
            }
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {isQuality ? 'Treat as review bot' : 'Mark as quality check'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              override.mutate({ userId: r.userId, body: { automated: false, kind: null, teamId } })
            }
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Not a bot
          </button>
          {/* Only on a REAL team CLASSIFICATION override, i.e. a MANUAL row stored at this team.
              Two guards, for two different reasons:
                • `!r.inherited` — on an inherited row this would delete nothing, and a silent
                  no-op is indistinguishable from a reset that worked;
                • `r.isManualOverride` — a team row created by a COST-ONLY patch is not a
                  classification opinion at all (it copies the default's verbatim; see
                  `buildCostOnlyBody`). Offering "Reset to default" there is offering a control
                  whose ONLY effect is deleting the price — named nowhere in its label. That row's
                  reset is the cost box's own Clear, which drops the row server-side.
              ⚠ It DOES take this team's own price with it (cost lives on the row being deleted),
              so the label and the confirm below have to say so — the earlier comment here claimed
              the opposite and the button destroyed a typed price silently. */}
          {reset.show && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                // Confirm ONLY when a price would actually be destroyed: on a row that inherits
                // its cost (or has none) the reset is purely a classification change and a dialog
                // would be noise.
                if (
                  reset.dropsCostUsd != null &&
                  !window.confirm(
                    `Reset ${r.login} to the “${DEFAULT_SOURCE_LABEL}” answer?\n\nThis team’s $${formatCostInput(reset.dropsCostUsd)}/mo price is stored on the same row and will go with it — the row falls back to the default’s price.`,
                  )
                )
                  return;
                resetOverride.mutate({ userId: r.userId, teamId });
              }}
              title={
                reset.dropsCostUsd != null
                  ? `Remove this team's override so it inherits the “${DEFAULT_SOURCE_LABEL}” classification again — including this team's own $${formatCostInput(reset.dropsCostUsd)}/mo price, which is stored on the same row.`
                  : `Remove this team's override so it inherits the “${DEFAULT_SOURCE_LABEL}” classification again.`
              }
              className="rounded border border-violet-300 px-2 py-0.5 text-[11px] font-medium text-violet-600 hover:bg-violet-50 disabled:opacity-40 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950"
            >
              {reset.dropsCostUsd != null ? 'Reset to default (incl. price)' : 'Reset to default'}
            </button>
          )}
        </div>

        <CostEditor
          key={`${teamId}:${r.userId}`}
          reviewer={r}
          teamId={teamId}
          busy={busy}
          onApply={(value) =>
            override.mutate({ userId: r.userId, body: buildCostOnlyBody(teamId, value) })
          }
        />
      </li>
    );
  };

  const listCls =
    'divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700';

  // The empty list means three different things and looks like one — `scopedRepoCount` is the
  // only thing that separates them, and null means it wasn't scoped at all (so no count may be
  // quoted). See `emptyStateFor`.
  //
  // ⚠ NONE OF THIS COPY MAY POINT AT THE SEARCH BOX. The search-to-promote block lives inside the
  // non-empty branch below, and hoisting it would not help: it filters the SAME `reviewers` array,
  // so on an empty list it would render a box that can never match anybody. An empty list has
  // exactly one honest instruction — wait for a sync (or, for a team with no repos, assign some).
  //
  // 'no-repos' cannot occur at NO_TEAM_KEY: the server degrades a 0-repo root scope to the
  // unscoped roster (it is the inheritance root and must stay editable), so the count comes back
  // null → 'unscoped'. That is why this branch may safely say "this team".
  const emptyBody = emptyStateCopy(emptyStateFor(scopedRepoCount), scopedRepoCount);

  return (
    <SectionShell
      title="Review bots"
      // No "search below" here either: this description renders above the EMPTY state too, where
      // the search block is not on screen. The block carries its own explanation where it lives.
      desc="Reviewers we treat as an AI/automated reviewer, and what each costs this team. Override any row — a manual choice sticks."
    >
      {q.isLoading ? (
        <p className="py-3 text-center text-[11px] text-gray-400">Loading…</p>
      ) : q.isError ? (
        <p className="py-3 text-center text-[11px] text-red-500">{(q.error as Error).message}</p>
      ) : reviewers.length === 0 ? (
        <p className="py-3 text-center text-[11px] text-gray-400">{emptyBody}</p>
      ) : (
        <>
          {/* State the scope on the NON-empty path too: these rows are the reviewers seen in this
              team's repos, not the account's whole roster, and a user comparing two tabs needs to
              know why a bot is missing from one. Omitted entirely when the count is null. */}
          {scopedRepoCount != null && (
            <p className="text-[10px] text-gray-400">
              Reviewers seen in this {teamId === NO_TEAM_KEY ? 'scope' : 'team'}&apos;s{' '}
              <span className="tabular-nums">{scopedRepoCount}</span> repo
              {scopedRepoCount === 1 ? '' : 's'}.
            </p>
          )}

          {reviewBots.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-gray-400">
              No review bots yet — search below to mark one.
            </p>
          ) : (
            <ul className={listCls}>{reviewBots.map(renderRow)}</ul>
          )}

          {/* Quality checks get their OWN section rather than being hidden: a mis-role must be
              discoverable ("why did SonarQube vanish?") and the reviewer stays reclassifiable. */}
          {qualityChecks.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-1.5">
                <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                  Quality checks
                </h4>
                <span className="text-[10px] text-gray-400">
                  Static analysis, coverage and lint. Still automated and still shown in the feed —
                  but excluded from the review-bot metrics (ROI, behaviour, dedup, benchmark), so
                  their volume can&apos;t make your reviewers look noisy.
                </span>
              </div>
              <ul className={listCls}>{qualityChecks.map(renderRow)}</ul>
            </div>
          )}

          {/* Set here, invisible here. A stored row for a reviewer with no footprint in this
              scope's repos is NOT dead — classification and cost resolve by TEAM KEY, never by
              repo, so it governs again the instant a repo moves back in. Collapsed and dimmed so
              it doesn't pad the live lists, but present so the setting is findable. */}
          {dormantHere.length > 0 && (
            <details className="mt-3 rounded border border-gray-200 dark:border-gray-700">
              <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                Set here but not active ({dormantHere.length})
              </summary>
              <div className="border-t border-gray-200 dark:border-gray-700">
                <p className="px-2.5 py-1.5 text-[10px] text-gray-400">
                  These reviewers have a stored setting for this{' '}
                  {teamId === NO_TEAM_KEY ? 'scope' : 'team'} but no activity in its repos. The
                  setting still applies — it takes effect again as soon as one of their repos is in
                  scope.
                </p>
                <ul className={listCls}>{dormantHere.map(renderRow)}</ul>
              </div>
            </details>
          )}

          {/* Search-to-promote: find a human reviewer by login/name and mark them a review bot.
              We never render the full human list — only matches once a query is typed. */}
          <div className="mt-1 space-y-1.5">
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
            {trimmedQuery === '' ? (
              <p className="text-[10px] text-gray-400">
                Type a reviewer&apos;s name to mark them as a bot. They default to In-house AI — set
                the exact vendor above once added (or pick{' '}
                <span className="font-medium">Vendor</span> for a proprietary tool that isn&apos;t
                your own), and use <span className="font-medium">Mark as quality check</span> for a
                linter or coverage tool.
              </p>
            ) : matches.length === 0 ? (
              <p className="text-[10px] text-gray-400">No matching reviewers.</p>
            ) : (
              <ul className={listCls}>
                {matches.map((r) => (
                  <li key={r.userId} className="flex items-center gap-2 px-2.5 py-1.5">
                    {r.avatarUrl != null && (
                      <img src={r.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full" />
                    )}
                    <span className="truncate text-xs font-medium text-gray-800 dark:text-gray-100">
                      {r.login}
                      {r.displayName != null && r.displayName !== r.login && (
                        <span className="ml-1 font-normal text-gray-400">{r.displayName}</span>
                      )}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-gray-400">
                      {r.threadsLast90d} · 90d
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => promote(r)}
                      className="shrink-0 rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
                    >
                      Treat as review bot
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {override.isError && (
        <p className="text-[11px] text-red-500">{(override.error as Error).message}</p>
      )}
      {resetOverride.isError && (
        <p className="text-[11px] text-red-500">{(resetOverride.error as Error).message}</p>
      )}
    </SectionShell>
  );
}

// ── Inline per-team cost ────────────────────────────────────────────────────────────────────

// Per-state input chrome. The three states MUST be distinguishable at a glance, because the same
// gesture (emptying the box) means something different in each:
//   inherited → dashed + muted italic: the number shown is real and applies, but it lives
//               elsewhere, so it reads as a quotation rather than a local value;
//   set       → solid violet, matching the "team override" classification badge above it;
//   none      → plain, empty, with a "—" placeholder so an empty box never reads as "$0".
const COST_INPUT_CLS: Record<CostState, string> = {
  // Muted, but NOT to the point of unreadable in dark mode: the number in this box is a real
  // price that applies to this team, so it has to stay legible — the italic + dashed border are
  // what carry "it lives elsewhere", not a near-invisible text colour.
  inherited:
    'border-dashed border-gray-300 italic text-gray-500 dark:border-gray-600 dark:text-gray-400',
  set: 'border-violet-400 text-gray-800 dark:border-violet-600 dark:text-gray-100',
  none: 'border-gray-300 text-gray-800 dark:border-gray-700 dark:text-gray-100',
};

/**
 * The monthly cost box on one reviewer row, for the team being viewed.
 *
 * ⚠ IT SENDS A COST-ONLY BODY (`buildCostOnlyBody` — no `automated`). Typing a price is not a
 * statement about whether the reviewer is a bot, and sending one would stamp the row manual,
 * permanently freezing its classification and converting an inherited row into a full row-level
 * override. That is why cost has its OWN apply button rather than riding the row's "Apply".
 *
 * Local draft state, remounted per `${teamId}:${userId}` by the caller's `key`, so switching team
 * tabs always re-seeds from that team's resolved value instead of carrying a half-typed number
 * across a scope change.
 */
function CostEditor({
  reviewer,
  teamId,
  busy,
  onApply,
}: {
  reviewer: DetectedReviewer;
  teamId: number;
  busy: boolean;
  onApply: (value: number | null) => void;
}): JSX.Element {
  const state = costStateOf(reviewer);
  const serverText = formatCostInput(reviewer.costMonthlyUsd);
  const [text, setText] = useState(serverText);
  // Re-seed when the server value changes under us (a successful save, or a refetch). Adjusting
  // state during render off a "previous props" marker is React's own documented alternative to a
  // sync effect — it avoids the extra render pass where the box still shows the old number.
  const [seededFrom, setSeededFrom] = useState(serverText);
  if (seededFrom !== serverText) {
    setSeededFrom(serverText);
    setText(serverText);
  }

  const parsed = parseCostInput(text);
  const outcome = parsed.ok
    ? costEditOutcome(state, reviewer.costMonthlyUsd, parsed.value)
    : null;
  const atDefault = teamId === NO_TEAM_KEY;

  // What the button would do / why it can't. This is the "say so rather than making the user
  // guess" requirement: emptying the box on an inherited row is a legitimate action that changes
  // nothing, and silence there is indistinguishable from a broken control.
  let hint: string;
  if (!parsed.ok) hint = parsed.error;
  else if (outcome == null) hint = '';
  else
    switch (outcome.kind) {
      case 'set':
        hint = atDefault
          ? 'Sets the default price — every team without its own price uses it.'
          : state === 'inherited'
            ? `Pins this price to this team; it stops following ${DEFAULT_SOURCE_LABEL}.`
            : 'Sets this team’s own price.';
        break;
      case 'reset':
        hint = atDefault
          ? 'Clears the default price. Teams with no price of their own will show no cost.'
          : `Clears this team’s price so it inherits ${DEFAULT_SOURCE_LABEL} again.`;
        break;
      case 'unchanged':
        hint = 'Unchanged.';
        break;
      case 'already-inheriting':
        hint = `Already inheriting ${DEFAULT_SOURCE_LABEL} — clearing the box changes nothing. Type a number to set this team’s own price.`;
        break;
      case 'no-cost':
        hint = 'No cost set anywhere. Type a number to add one.';
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
        // or invalid value, which would be indistinguishable from the CLEAR gesture — and clear
        // means "inherit again". Parsing the raw text keeps the three states honest.
        className={`w-20 rounded border bg-white px-1.5 py-0.5 text-[11px] tabular-nums outline-none focus:border-sky-400 dark:bg-gray-800 ${COST_INPUT_CLS[state]}`}
        value={text}
        placeholder="—"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && parsed.ok && outcome?.dirty === true && !busy) {
            onApply(parsed.value);
          }
        }}
        aria-label={`Monthly cost in US dollars for ${reviewer.login}`}
        title={
          state === 'inherited'
            ? `Inherited from “${DEFAULT_SOURCE_LABEL}”. Type a number to set a price for this team only.`
            : undefined
        }
      />
      <span className="text-[11px] text-gray-400">/mo</span>

      {/* The cost's OWN provenance badge, independent of the classification badge above: cost
          resolves field-wise, so a real team override can still be quoting the default's price. */}
      {state === 'inherited' ? (
        <span
          className="rounded border border-dashed border-gray-300 px-1 py-0.5 text-[9px] uppercase tracking-wide text-gray-400 dark:border-gray-600"
          title={`This price is set on the “${DEFAULT_SOURCE_LABEL}” row and applies here because this team has none of its own.`}
        >
          inherited · {DEFAULT_SOURCE_LABEL}
        </span>
      ) : state === 'set' ? (
        <span
          className={
            atDefault
              ? 'rounded bg-sky-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-600 dark:bg-sky-950 dark:text-sky-300'
              : 'rounded bg-violet-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-violet-600 dark:bg-violet-950 dark:text-violet-300'
          }
          title={
            atDefault
              ? 'The default price. Every team without its own price inherits this.'
              : 'A price set on this team’s own row — it does not follow the default.'
          }
        >
          {atDefault ? 'default price' : 'this team'}
        </span>
      ) : (
        <span className="text-[9px] uppercase tracking-wide text-gray-300 dark:text-gray-600">
          no cost
        </span>
      )}

      <button
        type="button"
        disabled={busy || !parsed.ok || outcome?.dirty !== true}
        onClick={() => {
          if (parsed.ok && outcome?.dirty === true) onApply(parsed.value);
        }}
        title={hint}
        className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        {outcome?.kind === 'reset' ? 'Clear' : 'Save cost'}
      </button>

      <span
        className={`text-[10px] ${parsed.ok ? 'text-gray-400' : 'text-red-500'}`}
        // Not a title-only hint: the two no-op outcomes are exactly the case where a user who
        // clicked and saw nothing needs the explanation on screen, not on hover.
      >
        {hint}
      </span>
    </div>
  );
}
