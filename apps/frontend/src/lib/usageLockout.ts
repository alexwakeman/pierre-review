import { aiProviderName, type AiProviderId, type MeResponse } from '@pierre-review/shared';

// A PROVIDER OVER ITS USAGE LIMIT (backend ai/usage-lockout.ts; docs/CLAUDE-REVIEW.md § Claude + Codex
// → Usage limits): automatic runs stand down until the reset; a reader's press still runs, so the
// Run area shows ONE plain line beside the button. Pure, tested without a DOM.

/** "Codex is over its usage limit until 8:54 PM." — or null when the lock is over or absent. */
export function usageLockLine(provider: AiProviderId, untilIso: string | null | undefined, nowMs: number = Date.now()): string | null {
  if (!untilIso) return null;
  const until = Date.parse(untilIso);
  if (!Number.isFinite(until) || until <= nowMs) return null;
  const d = new Date(until);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  const when = sameDay ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${aiProviderName(provider)} is over its usage limit until ${when}.`;
}

/** The lines for the providers a Run area may use (each locked one, in the given order). */
export function usageLockLines(me: Pick<MeResponse, 'ai'> | null | undefined, providers: readonly AiProviderId[], nowMs: number = Date.now()): string[] {
  const out: string[] = [];
  for (const p of providers) {
    const line = usageLockLine(p, me?.ai?.providers?.[p]?.usageLockedUntil ?? null, nowMs);
    if (line) out.push(line);
  }
  return out;
}
