/**
 * Token-usage accounting for a Claude review run.
 *
 * The SDK streams several messages per API REQUEST (e.g. a thinking message + a
 * text message, or an outright duplicate), and each carries that ONE request's
 * `usage` — so naively SUMMING per message double-counts (~2× — the symptom was a
 * live cost tally about double the finished-run cost). These helpers de-duplicate
 * per `request_id` (then message uuid) and total the result for the LIVE estimate.
 *
 * The AUTHORITATIVE finished-run figures come from the SDK result's `modelUsage`
 * (the same tally behind `total_cost_usd`) — see `sumModelUsage` — so the persisted
 * tokens stay consistent with the persisted cost.
 */

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function emptyUsage(): UsageTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

// One assistant message's usage (defensive — fields may be missing/null; the API
// reports input_tokens EXCLUSIVE of the cache_* buckets, so the three are additive).
export function readTurnUsage(message: unknown): UsageTokens {
  const u =
    (message as { message?: { usage?: Record<string, unknown> } })?.message
      ?.usage ?? {};
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
  };
}

// Per-field max — merges several messages that report the same request's usage into
// one (idempotent under duplicates / a later empty-usage repeat of the request).
export function maxUsage(a: UsageTokens, b: UsageTokens): UsageTokens {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
  };
}

// Record one streamed assistant message into the per-request usage map, keyed by API
// `request_id` (then uuid, then a positional fallback) and merged by per-field max so
// each request is counted exactly once however many messages carry its usage.
export function recordUsage(
  map: Map<string, UsageTokens>,
  message: unknown,
): void {
  const m = message as { request_id?: unknown; uuid?: unknown };
  const key =
    (typeof m.request_id === 'string' && m.request_id) ||
    (typeof m.uuid === 'string' && m.uuid) ||
    `anon-${map.size}`;
  const u = readTurnUsage(message);
  const prev = map.get(key);
  map.set(key, prev ? maxUsage(prev, u) : u);
}

// Total the de-duplicated per-request usage map — the live tally.
export function sumUsageMap(map: Map<string, UsageTokens>): UsageTokens {
  const out = emptyUsage();
  for (const u of map.values()) {
    out.inputTokens += u.inputTokens;
    out.outputTokens += u.outputTokens;
    out.cacheReadTokens += u.cacheReadTokens;
    out.cacheCreationTokens += u.cacheCreationTokens;
  }
  return out;
}

// The AUTHORITATIVE cumulative usage, summed across models from the SDK result's
// `modelUsage`. Typed `unknown` to stay decoupled from the SDK result type. Null if
// absent (e.g. an early failure with no result message).
export function sumModelUsage(result: unknown): UsageTokens | null {
  const mu = (result as { modelUsage?: Record<string, unknown> } | null)
    ?.modelUsage;
  if (!mu || typeof mu !== 'object') return null;
  const out = emptyUsage();
  let any = false;
  for (const v of Object.values(mu)) {
    if (!v || typeof v !== 'object') continue;
    const m = v as Record<string, unknown>;
    out.inputTokens += num(m.inputTokens);
    out.outputTokens += num(m.outputTokens);
    out.cacheReadTokens += num(m.cacheReadInputTokens);
    out.cacheCreationTokens += num(m.cacheCreationInputTokens);
    any = true;
  }
  return any ? out : null;
}
