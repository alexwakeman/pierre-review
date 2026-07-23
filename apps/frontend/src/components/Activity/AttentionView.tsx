import type { InsightCard } from '@pierre-review/shared';
import { useAttentionCards } from '../../hooks/useAttentionCards.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { AttentionCards } from './AttentionCards.js';

// The Feed "Needs attention" tab (CORE/free) — the attention cards (stalled reviews / untouched
// threads / reviewer load / needs-a-reviewer) that used to sit under the Pro Insights AI panels,
// now a first-class Feed rail entry available on every tier. Scoped to the active team (teamScope);
// the bot cards live in the free Bots console, so they're excluded here.
const BOT_CARD_KINDS = new Set<InsightCard['kind']>(['bot_signal', 'bot_only_review']);

export function AttentionView(): JSX.Element {
  const teamScope = useFilters((s) => s.teamScope);
  const scope = scopeToParam(teamScope);
  const { data, isLoading, isError } = useAttentionCards(scope);
  const cards = (data?.cards ?? []).filter((c) => !BOT_CARD_KINDS.has(c.kind));

  return (
    <div className="space-y-3" data-testid="attention-view">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Needs attention</h2>
        {!isLoading && !isError && (
          <span className="text-[11px] text-gray-400">
            {cards.length} item{cards.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="text-sm text-red-500">Couldn’t load what needs attention.</div>
      ) : cards.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          Nothing needs attention across your watched repos right now. 🎉
          <div className="mt-1 text-[11px]">
            Stalled reviews, untouched threads, reviewer load and un-assigned PRs will surface here.
          </div>
        </div>
      ) : (
        <AttentionCards cards={cards} users={data?.users} />
      )}
    </div>
  );
}
