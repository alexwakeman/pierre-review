import { useMemo } from 'react';
import type { PrBotBehaviour, PrBotTouch, PrDetail } from '@pierre-review/shared';
import { usePrBotBehaviour } from '../hooks/useBotTriage.js';
import { useBotColors } from '../hooks/useBotColors.js';
import { useRepos } from '../hooks/useTimeline.js';
import { automatedReviewerMeta, dateTime, relativeTime, vendorInk } from '../lib/ui.js';
import { fmtDuration } from './charts/common.js';
import { CommentIcon, ReviewIcon, WarningIcon } from './Icons.js';

// The PrDetail "Bot activity" tab (EXPERIMENTAL, CORE, deterministic) — the per-PR view of the
// aggregate Behaviour tab. For each automated reviewer that touched THIS PR: its on-PR timeline
// (first review + follow-ups) and how its behaviour compares to that bot's OWN typical (an
// 84-day account-wide robust baseline). The "delays beyond typical" evidence, per PR.

function dur(h: number | null): string {
  return h == null ? '—' : fmtDuration(h);
}

/**
 * ONE CHIP PER RUN OF TOUCHES THAT RENDER THE SAME TIME — the touch row's fold.
 *
 * Two things used to collapse this row into the same string over and over. The server emits one
 * touch per DB ROW (a review submitted with three inline comments is FOUR rows carrying the same
 * second), and `relativeTime` rounds anything past a day to whole days. Measured on a real PR: a
 * 94-touch Codex card printed "9 days ago" fourteen times and "8 days ago" twice before hitting
 * the cap — a row whose resolution was coarser than the differences it existed to show.
 *
 * ⚠ ADJACENT touches only, never a global bucket. The row is a TIMELINE, so sorting or bucketing
 * across the whole list would stop it being one; a run that comes back to an earlier day (it
 * cannot, but the fold does not depend on that) stays its own chip.
 *
 * WHAT SURVIVES, AND THROUGH WHICH CHANNEL. On the chip itself: order, each run's rendered time,
 * its count, and WHICH kinds it holds (the two icons). In the hover title only: the span's exact
 * instants and the review/comment SPLIT (see `mixPhrase`) — the icons say a run holds both kinds,
 * not that it was 1 review + 13 comments rather than 13 + 1. Only the repetitions go.
 *
 * ⚠ A hover title is mouse-only, so that last pair is genuinely weaker on touch and to a keyboard.
 * It is the right trade HERE and the wrong one in `charts/RepoRows.tsx`, which refuses a `title=`
 * for the opposite reason: there the hidden string is the row's repository NAME, without which the
 * bar is unidentifiable. A collapsed run's internal split is a detail about a chip that already
 * names its time, its size and its kinds. Do not cite one file at the other.
 */
interface TouchGroup {
  /** The group's first and last instant — equal when the group holds one touch. */
  from: string;
  to: string;
  /** The rendered relative time every touch in the group shares. It IS the grouping key. */
  label: string;
  count: number;
  reviews: number;
  comments: number;
}

function groupTouches(touches: PrBotTouch[]): TouchGroup[] {
  const out: TouchGroup[] = [];
  for (const t of touches) {
    const label = relativeTime(t.at);
    const last = out[out.length - 1];
    if (last && last.label === label) {
      last.to = t.at;
      last.count += 1;
      if (t.kind === 'review') last.reviews += 1;
      else last.comments += 1;
      continue;
    }
    out.push({
      from: t.at,
      to: t.at,
      label,
      count: 1,
      reviews: t.kind === 'review' ? 1 : 0,
      comments: t.kind === 'review' ? 0 : 1,
    });
  }
  return out;
}

/**
 * The group's review/comment split in words, for the hover title. The icons beside the count say
 * only which kinds are PRESENT — spelling the split is what keeps "×14" from hiding whether the
 * run was one review with thirteen inline comments or thirteen reviews with one. A zero side is
 * omitted rather than printed as "0 reviews".
 */
function mixPhrase(g: TouchGroup): string {
  const parts: string[] = [];
  if (g.reviews > 0) parts.push(`${g.reviews} review${g.reviews === 1 ? '' : 's'}`);
  if (g.comments > 0) parts.push(`${g.comments} comment${g.comments === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * A safety rail, not a display budget. A chip needs its own DISTINCT rendered time, so real cards
 * fold hard: measured over all 4,525 (PR × bot) cards in the dev DB, the busiest (240 deepsource-io
 * touches on erxes/erxes#9178) folds to FOUR chips, the most any card produces is 21 (a 50-touch
 * gopherbot run spread over 262 days, where every touch renders its own calendar date), and NOT ONE
 * reaches 40 — so the overflow line never appears. The cap survives only so a pathological PR
 * cannot paint an unbounded row.
 */
const TOUCH_GROUP_CAP = 40;

// A compact labelled stat used in the per-bot header row.
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'default' }): JSX.Element {
  return (
    <div>
      <div className="text-[11px] font-semibold text-gray-500 dark:text-gray-400">{label}</div>
      <div
        className={`text-sm font-semibold ${
          tone === 'warn' ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function BotBlock({ bot, color }: { bot: PrBotBehaviour; color: string }): JSX.Element {
  const meta = automatedReviewerMeta(bot.kind);
  const anomaly = bot.ttfrAnomaly;
  const building = bot.typicalTtfrHours == null;
  // Follow-up "more than usual" hint (no per-PR z — a simple exceeds-typical-by-2 heuristic).
  const moreFollowups =
    bot.typicalFollowups != null && bot.followupCount >= bot.typicalFollowups + 2;
  // Folded on every render rather than memoised: `relativeTime` reads the clock, so a memo keyed
  // on the touches alone would freeze the row's labels at first paint.
  const groups = groupTouches(bot.touches);
  const shownGroups = groups.slice(0, TOUCH_GROUP_CAP);
  const hiddenTouches = bot.touches.length - shownGroups.reduce((n, g) => n + g.count, 0);

  // TTFR vs-typical evidence line. The caution mark is rendered as an icon beside this text
  // (see below) rather than baked into the string — it has to take the line's red tint.
  //
  // ⚠ THE ABSOLUTE TTFR IS NOT PRINTED HERE. The `<Stat label="Time to first review">` two lines
  // down owns that number; this line's own fact is the BASELINE it is being judged against. The
  // anomaly branch used to read "slower than typical — 3.7d vs 6m typical", which put a third
  // "3.7d" on a card that already showed it in the Stat and in the badge.
  const ttfrNote = building
    ? 'building baseline'
    : anomaly
      ? `slower than typical — usually ${dur(bot.typicalTtfrHours)}`
      : `within typical (${dur(bot.typicalTtfrHours)})`;

  // The anomaly badge's delta over typical, and whether printing it would say anything the Stat
  // below does not.
  //
  // ⚠ THE BADGE CARRIES NO NUMBER, AND THAT IS NOT A MISSING MAGNITUDE. Every figure it could
  // print is already on this card, once each and closer to its own label: the `<Stat>` two lines
  // down is how long this PR waited ("4.3h") and `ttfrNote` beside it is what this bot usually
  // takes ("usually 19m"). A delta is those two subtracted — a third rendering of a fact the
  // reader can already see, and on this account it is not even a distinguishable one. MEASURED
  // (2026-09-09, 84-day baseline): all ten review bots with n ≥ 5 have a typical TTFR under 25
  // minutes (sourcery-ai 0.002h, coderabbitai 0.013h, deepsource-io 0.03h, cursor 0.35h,
  // gopherbot 0.40h), and the gate floors sigma at 0.5h, so z ≥ 3 fires precisely ON those
  // near-zero-typical bots. `fmtDuration` prints one decimal, so subtracting a typical that small
  // changes nothing it renders: a 3-day anomaly printed "3.0d" as the delta beside "3.0d" as the
  // absolute. Even where the strings did differ they differed by one rounding digit — 16.5h
  // against a 16.6h Stat.
  //
  // The badge's job is to say WHICH cards to look at; the two figures beside it say how much.
  // An earlier cut printed the delta and defended it with "typical 3h against a TTFR of 20h
  // prints 17h here and 20h there" — a bot this account does not have. Do not restore it on an
  // argument about a bot you have not measured.

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />
          {bot.label}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[11px] font-medium"
          style={{ ...vendorInk(meta.color), background: `${meta.color}1a` }}
        >
          {meta.label}
        </span>
        {bot.firstTouchAt && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            first touch {relativeTime(bot.firstTouchAt)}
          </span>
        )}
        {anomaly && (
          // A flag, not a figure — see the note above `anomaly`. The size lives in the `<Stat>`
          // and the typical in `ttfrNote`, each once.
          <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-red-600 dark:text-red-400">
            <WarningIcon size={11} className="inline-block align-[-0.1em]" /> slower than usual
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Time to first review" value={dur(bot.ttfrHours)} tone={anomaly ? 'warn' : 'default'} />
        <Stat label="Follow-ups" value={String(bot.followupCount)} tone={moreFollowups ? 'warn' : 'default'} />
        <Stat label="Comments" value={String(bot.commentCount)} />
        <Stat label="Touches" value={String(bot.touchCount)} />
      </div>

      <div className="text-[11px] text-gray-500 dark:text-gray-400">
        {/* TTFR vs the bot's own typical — the "vs typical" evidence. */}
        <span className={anomaly ? 'font-medium text-red-600 dark:text-red-400' : ''}>
          {!building && anomaly && (
            <WarningIcon size={11} className="mr-1 inline-block align-[-0.1em]" />
          )}
          {ttfrNote}
        </span>
        {/* The trailing clauses INHERIT the wrapper's paired muted colour. A bare `text-gray-400`
            here (what they used to carry) is #9ca3af on the light page — 2.54:1, well under AA —
            and no test measures a class the scanner treats as already-paired elsewhere. */}
        {bot.ttfrBasis && !building && (
          <span> · from {bot.ttfrBasis === 'ready' ? 'ready-for-review' : 'opened'}</span>
        )}
        {bot.typicalFollowups != null && (
          <span>
            {' · '}
            {bot.followupCount} follow-up{bot.followupCount === 1 ? '' : 's'} vs {bot.typicalFollowups} typical
            {moreFollowups ? ' (more than usual)' : ''}
          </span>
        )}
        {!building && <span> · baseline: {bot.baselinePrs} PRs</span>}
      </div>

      {/* On-PR touch timeline — first review + follow-ups, in order, one chip per RUN of touches
          sharing a rendered time (see groupTouches). */}
      {groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {shownGroups.map((g, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-300"
              // Everything the fold collapsed: the run's review/comment split (only when it stands
              // for more than one touch — for a single touch the icon already says which kind it
              // was), then the only absolute timestamps on the whole tab, which for a group are a
              // RANGE. Through `dateTime`, never a bare toLocaleString: lib/ui's formatters are
              // where the app's date format is decided.
              title={`${g.count > 1 ? `${mixPhrase(g)} · ` : ''}${
                g.from === g.to ? dateTime(g.from) : `${dateTime(g.from)} – ${dateTime(g.to)}`
              }`}
            >
              {g.reviews > 0 && <ReviewIcon size={11} />}
              {g.comments > 0 && <CommentIcon size={11} />}
              {/* "×3" is TEXT THAT SAYS SOMETHING — how many touches this chip stands for — so it
                  takes the chip's own measured colour and must never carry `decorative-mark`. It
                  is also not a pictograph, which is why it is a character rather than an icon. */}
              {g.count > 1 && <span className="font-medium">×{g.count}</span>}
              {g.label}
            </span>
          ))}
          {hiddenTouches > 0 && (
            // Named in TOUCHES, not groups: the cap is on chips but the reader's denominator is
            // the "Touches" Stat on this same card, and the two have to reconcile.
            <span className="text-[11px] text-gray-500 dark:text-gray-400">
              +{hiddenTouches} more touches
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function PrBotBehaviourTab({ pr }: { pr: PrDetail }): JSX.Element {
  const { data, isLoading, isError } = usePrBotBehaviour(pr.id, true);
  // Colours come from the PR'S OWN workspace, not the selected one: vendor identity is a
  // per-workspace fact on `workspace_reviewers`, and a PR tab can hold a PR from any workspace
  // (a `?pr=<id>` deep link, a restored `pierre:tabs` entry, a search hit). Reading
  // `filters.workspaceId` here would paint these bots with another workspace's identities.
  // `Repo.workspaceId` is the only repo→workspace mapping the client has (same predicate as
  // ThreadList's `prWorkspaceId`); null before `useRepos()` lands, which the hook degrades to
  // brand-by-kind for.
  const { data: repos } = useRepos();
  const prWorkspaceId = useMemo(
    () => (repos ?? []).find((r) => r.id === pr.repoId)?.workspaceId ?? null,
    [repos, pr.repoId],
  );
  const botColor = useBotColors(prWorkspaceId);
  const bots = data?.bots ?? [];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* Said ONCE for the whole tab, not per card and never per chip: "touch" is the unit of
            both the Touches stat and the timeline chips, and a reader who does not know a review
            and its inline comments are separate rows cannot check either number. */}
        <span className="text-[12px] text-gray-500 dark:text-gray-400">
          How each review bot behaved on THIS PR vs its <span className="font-medium">own</span>{' '}
          typical (84-day baseline). Deterministic, no AI. A touch is one review or one comment, so
          a review submitted with three inline comments counts as four.
        </span>
      </div>

      {isLoading ? (
        <div className="h-24 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40" />
      ) : isError ? (
        <div className="text-sm text-red-500">Couldn’t load bot behaviour for this PR.</div>
      ) : bots.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          No automated-reviewer activity on this PR.
        </div>
      ) : (
        bots.map((b) => <BotBlock key={b.key} bot={b} color={botColor({ login: b.login, kind: b.kind })} />)
      )}
    </div>
  );
}
