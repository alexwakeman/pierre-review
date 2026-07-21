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
  'deepsource-io': 'deepsource',
  deepsourcebot: 'deepsource',
  'github-code-quality': 'github_code_quality',
  'github-advanced-security': 'github_advanced_security',
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

// ---- WS1 service-account login heuristics (bot-triage platform) ----
//
// Plain-User logins that LOOK like automation (`acme-ci`, `deploy-bot`, `foo-svc`,
// k8s-style `*-machine-user`). These are SOFT signals only: a match PROMOTES a
// reviewer into the behavioral MEDIUM band (never a hard auto-badge — see
// reviewer-classify.ts), and the manual override is always the escape hatch. GitHub
// Apps are the recommended automation pattern, so the bare-PAT service account is a
// deliberate minority long-tail we catch here + let a single click confirm forever.
// Matched case-insensitively on the NORMALIZED login (lowercased, `[bot]` stripped).
export const AUTOMATED_LOGIN_PATTERNS: RegExp[] = [
  /-ci$/,
  /-bot$/,
  /-svc$/,
  /-robot$/,
  /-automation$/,
  /^bot-/,
  /-machine-user$/,
];

// Turn a simple `*`-glob (the per-account allowlist entries, e.g. `*-agent`, `svc-*`)
// into an anchored, case-insensitive RegExp. Only `*` is special; every other regex
// metacharacter is escaped.
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

// True when a login matches a built-in service-account pattern OR one of the
// per-account allowlist globs (from the account's Pro settings `bots.loginAllowlist`,
// simple `*` wildcards). Global/stateless — the account scoping lives in the caller.
export function matchesAutomatedLoginPattern(
  login: string,
  extraAllowlist: string[] = [],
): boolean {
  if (!login) return false;
  const norm = normalizeLogin(login);
  if (AUTOMATED_LOGIN_PATTERNS.some((re) => re.test(norm))) return true;
  for (const raw of extraAllowlist) {
    const glob = raw.trim().toLowerCase();
    if (!glob) continue;
    if (globToRegExp(glob).test(norm)) return true;
  }
  return false;
}
