// ISOLATING ONE BOT ON THE BOTS PAGE — the pure half of the click-to-isolate legend.
//
// One bot key (`u<userId>`, the same spelling the ROI rows, the behaviour rows and the "where bots
// work" rows use) or null. Every per-bot chart on the Bots page reads the SAME value
// (`components/Activity/BotIsolate.tsx`), so isolating a bot in one legend dims the others in
// every chart at once.

/** Clicking a legend entry: isolate that bot, or clear it when it is already the isolated one. */
export function toggleIsolated(current: string | null, key: string): string | null {
  return current === key ? null : key;
}

/**
 * The isolation THIS chart applies. A bot that is not in the chart (it has no data here) isolates
 * nothing — dimming every line for a bot that is not drawn would leave an empty-looking chart.
 */
export function effectiveIsolated(
  isolated: string | null,
  keys: readonly string[],
): string | null {
  return isolated != null && keys.includes(isolated) ? isolated : null;
}

/** True when `key` is drawn faint because another bot is isolated. */
export function isDimmed(isolated: string | null, key: string): boolean {
  return isolated != null && isolated !== key;
}

/**
 * Mark every series but the isolated bot's `dimmed`, and paint the isolated one LAST so it sits on
 * top. A `dashed` series (a fitted overlay such as a trend line) is never a bot and is never
 * dimmed. No isolation in this chart ⇒ the input array, unchanged.
 */
export function applyIsolation<T extends { key: string; dashed?: boolean; dimmed?: boolean }>(
  series: readonly T[],
  isolated: string | null,
): T[] {
  const eff = effectiveIsolated(
    isolated,
    series.filter((s) => !s.dashed).map((s) => s.key),
  );
  if (eff == null) return [...series];
  const marked = series.map((s) => (s.dashed ? s : { ...s, dimmed: s.key !== eff }));
  return [...marked.filter((s) => s.dimmed === true), ...marked.filter((s) => s.dimmed !== true)];
}
