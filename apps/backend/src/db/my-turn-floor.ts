// ── MY TURN'S ONBOARDING FLOOR (docs/BACKEND.md § My Turn — The first-onboarding lookback) ──────
//
// An event before a repo's floor never summons anyone: without it, adding a repo and its 90-day
// backfill would surface two months of old replies, mentions and pushes at once. The floor is the
// repo's add time (`repos.createdAt`) — except for a repo of the account's FIRST onboarding
// (`repos.first_onboarding`), whose floor sits `FIRST_ONBOARDING_LOOKBACK_DAYS` earlier, so the
// first landing on Pending shows the last week's open business instead of nothing.
//
// ⚠ ONE spelling: `getMyTurn` builds its per-repo floor map through this and every rule that reads
// the floor (S2, S3c, S3d, S5, S6) reads that map. Never re-derive it from `createdAt` elsewhere.
import { FIRST_ONBOARDING_LOOKBACK_DAYS } from '@pierre-review/shared';

const DAY_MS = 86_400_000;

export function myTurnFloorOf(repo: { createdAt: Date; firstOnboarding: boolean }): Date {
  if (!repo.firstOnboarding) return repo.createdAt;
  return new Date(repo.createdAt.getTime() - FIRST_ONBOARDING_LOOKBACK_DAYS * DAY_MS);
}
