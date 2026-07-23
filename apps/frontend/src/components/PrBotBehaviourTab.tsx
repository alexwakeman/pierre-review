import type { PrBotBehaviour, PrDetail } from '@pierre-review/shared';
import { usePrBotBehaviour } from '../hooks/useBotTriage.js';
import { useBotColors } from '../hooks/useBotColors.js';
import { automatedReviewerMeta, relativeTime } from '../lib/ui.js';
import { fmtDuration } from './charts/common.js';

// The PrDetail "Bot activity" tab (EXPERIMENTAL, CORE, deterministic) — the per-PR view of the
// aggregate Behaviour tab. For each automated reviewer that touched THIS PR: its on-PR timeline
// (first review + follow-ups) and how its behaviour compares to that bot's OWN typical (an
// 84-day account-wide robust baseline). The "delays beyond typical" evidence, per PR.

function dur(h: number | null): string {
  return h == null ? '—' : fmtDuration(h);
}

// A compact labelled stat used in the per-bot header row.
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'default' }): JSX.Element {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
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

  // TTFR vs-typical evidence line.
  const ttfrNote = building
    ? 'building baseline'
    : anomaly
      ? `⚠ slower than typical — ${dur(bot.ttfrHours)} vs ${dur(bot.typicalTtfrHours)} typical`
      : `within typical (${dur(bot.typicalTtfrHours)})`;

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />
          {bot.label}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{ color: meta.color, background: `${meta.color}1a` }}
        >
          {meta.label}
        </span>
        {bot.firstTouchAt && (
          <span className="text-[11px] text-gray-400">first touch {relativeTime(bot.firstTouchAt)}</span>
        )}
        {anomaly && (
          // The ABSOLUTE delta over typical (not a ratio — a ratio rounds to a misleading "1×"
          // near the threshold, and divides by ~0 when a bot's typical TTFR is 0).
          <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400">
            ⚠ {dur((bot.ttfrHours ?? 0) - (bot.typicalTtfrHours ?? 0))} slower than usual
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
        <span className={anomaly ? 'font-medium text-red-600 dark:text-red-400' : ''}>{ttfrNote}</span>
        {bot.ttfrBasis && !building && (
          <span className="text-gray-400"> · from {bot.ttfrBasis === 'ready' ? 'ready-for-review' : 'opened'}</span>
        )}
        {bot.typicalFollowups != null && (
          <span className="text-gray-400">
            {' · '}
            {bot.followupCount} follow-up{bot.followupCount === 1 ? '' : 's'} vs {bot.typicalFollowups} typical
            {moreFollowups ? ' (more than usual)' : ''}
          </span>
        )}
        {!building && (
          <span className="text-gray-400"> · baseline: {bot.baselinePrs} PRs</span>
        )}
      </div>

      {/* On-PR touch timeline — first review + follow-ups, in order. */}
      {bot.touches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {bot.touches.slice(0, 16).map((t, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[10px] text-gray-600 dark:text-gray-300"
              title={new Date(t.at).toLocaleString()}
            >
              <span aria-hidden>{t.kind === 'review' ? '📝' : '💬'}</span>
              {relativeTime(t.at)}
            </span>
          ))}
          {bot.touches.length > 16 && (
            <span className="text-[10px] text-gray-400">+{bot.touches.length - 16} more</span>
          )}
        </div>
      )}
    </div>
  );
}

export function PrBotBehaviourTab({ pr }: { pr: PrDetail }): JSX.Element {
  const { data, isLoading, isError } = usePrBotBehaviour(pr.id, true);
  const botColor = useBotColors();
  const bots = data?.bots ?? [];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-gray-400">
          How each review bot behaved on THIS PR vs its <span className="font-medium">own</span>{' '}
          typical (84-day baseline). Deterministic, no AI.
        </span>
      </div>

      {isLoading ? (
        <div className="h-24 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40" />
      ) : isError ? (
        <div className="text-sm text-red-500">Couldn’t load bot behaviour for this PR.</div>
      ) : bots.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          No automated-reviewer activity on this PR.
        </div>
      ) : (
        bots.map((b) => <BotBlock key={b.key} bot={b} color={botColor({ login: b.login, kind: b.kind })} />)
      )}
    </div>
  );
}
