// STUB — replaced by stream C (`codex app-server`: account/read, account/rateLimits/read,
// account/usage/read). Only the contract's exports; stream C's file wins on merge.
import type { AiUsageReading } from '@pierre-review/shared';

/** STUB: never signed in. Stream C asks `account/read {refreshToken:true}`. */
export async function codexAccount(): Promise<{ signedIn: boolean; plan: string | null }> {
  return { signedIn: false, plan: null };
}

/** STUB: no reading. Stream C asks `account/rateLimits/read`. */
export async function codexRateLimits(): Promise<AiUsageReading | null> {
  return null;
}

/** STUB: unknown. Stream C asks `account/usage/read`. */
export async function codexAccountTokens(_window: 'five_hour' | 'week'): Promise<number | null> {
  return null;
}
