// What an agent run spent before it failed. The run core (agent.ts `runAgentInWorktree`) attaches
// it to the error it rethrows, so a caller's catch path can still record the spend — a failed
// pass bills like any other. Kept in its own module so the manager can read it without importing
// the agent core (and the AI runtime behind it).

export interface PartialSpend {
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number | null;
  /** True ⇒ the provider already wrote the ledger row for this spend (Codex): write no second one. */
  usageRecorded?: boolean;
}

const KEY = '__limnPartialSpend';

export function withPartialSpend(err: unknown, spend: PartialSpend): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  // Keep the first (innermost) reading if a caller rethrows through here twice.
  if (!(KEY in e)) Object.defineProperty(e, KEY, { value: spend, enumerable: false });
  return e;
}

export function partialSpendOf(err: unknown): PartialSpend | null {
  if (err == null || typeof err !== 'object' || !(KEY in err)) return null;
  const v = (err as Record<string, unknown>)[KEY] as PartialSpend | undefined;
  return v ?? null;
}
