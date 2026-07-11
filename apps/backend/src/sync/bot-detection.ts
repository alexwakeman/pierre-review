import type { ReviewBotKind } from '@pierre-review/shared';

// Known bot logins (without the [bot] suffix). Anything weird gets a manual
// override via PATCH /api/users/:id.
const KNOWN_BOTS = new Set([
  'dependabot',
  'renovate',
  'github-actions',
  'codecov',
  'sonarcloud',
  'snyk-bot',
  'mergify',
  'imgbot',
  'allcontributors',
  'pre-commit-ci',
  'sonarqubecloud',
  'coderabbitai',
]);

// Third-party AI *review* bots (login → vendor kind). This is the backend's LOCAL copy
// of `REVIEW_BOTS` in `@pierre-review/shared` — the backend can't import shared at
// runtime (it isn't shipped server-side), so the two are kept in lockstep BY HAND and
// `bot-detection.test.ts` fails on any drift. See the shared map for the verification
// notes + the deliberately-excluded coding agents / dependency bots.
const REVIEW_BOTS: Record<string, ReviewBotKind> = {
  coderabbitai: 'coderabbit',
  'greptile-apps': 'greptile',
  'copilot-pull-request-reviewer': 'copilot',
  'qodo-ai': 'qodo',
  'qodo-merge': 'qodo',
  'qodo-merge-pro': 'qodo',
  'qodo-merge-for-open-source': 'qodo',
  'codiumai-pr-agent-free': 'qodo',
  'sourcery-ai': 'sourcery',
  'bito-code-review': 'bito',
  'ellipsis-dev': 'ellipsis',
  'korbit-ai': 'korbit',
  'baz-reviewer': 'baz',
  'graphite-app': 'graphite',
  cursor: 'cursor',
  'devin-ai-integration': 'devin',
  'entelligence-ai-pr-reviews': 'entelligence',
};

function normalizeLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, '');
}

// Every review bot is also a bot, so folding REVIEW_BOTS into the known set keeps a
// newly-seen review-bot login classified `isBot=true` at sync time.
export function isLikelyBot(login: string): boolean {
  const lower = login.toLowerCase();
  if (lower.endsWith('[bot]')) return true;
  const stripped = normalizeLogin(lower);
  return KNOWN_BOTS.has(stripped) || stripped in REVIEW_BOTS;
}

// Classify a login as a known AI review bot's vendor, or null. Mirror of
// `reviewBotKind` in `@pierre-review/shared`.
export function reviewBotKind(login: string | null | undefined): ReviewBotKind | null {
  if (!login) return null;
  return REVIEW_BOTS[normalizeLogin(login)] ?? null;
}

export function isReviewBot(login: string | null | undefined): boolean {
  return reviewBotKind(login) != null;
}

// The bare review-bot login slugs — used by the query layer to segment threads/reviews
// by review-bot authorship (via a `users.githubLogin IN (...)` predicate), which is
// robust even for rows synced before the login joined the known set (their `isBot` may
// still be false until the next sync).
export function reviewBotLogins(): string[] {
  return Object.keys(REVIEW_BOTS);
}
