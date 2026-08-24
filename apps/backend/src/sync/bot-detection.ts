import type { AutomatedReviewerKind, ReviewBotKind, ReviewerRole } from '@pierre-review/shared';

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
  // OpenAI Codex — App slug `chatgpt-codex-connector` (verified 2026-08), NOT `codex`/`openai`,
  // which are ordinary user accounts. See the shared map for the full note.
  'chatgpt-codex-connector': 'codex',
};

// THE AUTOMATION VENDOR TABLE — the backend's LOCAL copy of `AUTOMATION_VENDORS` in
// `@pierre-review/shared`. Same hand-sync contract as REVIEW_BOTS above (the backend cannot
// import shared at RUNTIME — a value import fails the release build), and
// `bot-detection.test.ts` fails on any drift, key by key AND value by value.
//
// ONE table rather than five login sets plus a parallel login→kind map: a login has exactly one
// identity and one default role, and those are facts about the same key. See the shared copy for
// the full reasoning, the measured numbers behind each family, and why the per-family sets below
// are DERIVED from this rather than restated beside it.
const AUTOMATION_VENDORS: Record<string, { kind: AutomatedReviewerKind; role: ReviewerRole }> = {
  dependabot: { kind: 'dependabot', role: 'dependency' },
  'dependabot-preview': { kind: 'dependabot', role: 'dependency' },
  renovate: { kind: 'renovate', role: 'dependency' },
  'renovate-bot': { kind: 'renovate', role: 'dependency' },
  'snyk-bot': { kind: 'snyk', role: 'dependency' },
  'pyup-bot': { kind: 'pyup', role: 'dependency' },
  greenkeeper: { kind: 'greenkeeper', role: 'dependency' },
  depfu: { kind: 'depfu', role: 'dependency' },
  sonarqubecloud: { kind: 'sonarqube', role: 'quality_check' },
  sonarcloud: { kind: 'sonarqube', role: 'quality_check' },
  codecov: { kind: 'codecov', role: 'quality_check' },
  codeclimate: { kind: 'codeclimate', role: 'quality_check' },
  'codefactor-io': { kind: 'codefactor', role: 'quality_check' },
  'houndci-bot': { kind: 'hound', role: 'quality_check' },
  coveralls: { kind: 'coveralls', role: 'quality_check' },
  'codacy-bot': { kind: 'codacy', role: 'quality_check' },
  'github-actions': { kind: 'github_actions', role: 'quality_check' },
  'jit-ci': { kind: 'jit', role: 'quality_check' },
  'socket-security': { kind: 'socket', role: 'quality_check' },
  gitguardian: { kind: 'gitguardian', role: 'quality_check' },
  'semgrep-app': { kind: 'semgrep', role: 'quality_check' },
  'trunk-io': { kind: 'trunk', role: 'quality_check' },
  'devin-ai-integration': { kind: 'devin', role: 'code_agent' },
  'sweep-ai': { kind: 'sweep', role: 'code_agent' },
  'codegen-sh': { kind: 'codegen', role: 'code_agent' },
  'deepsource-autofix': { kind: 'deepsource_autofix', role: 'code_agent' },
  'pre-commit-ci': { kind: 'pre_commit_ci', role: 'code_agent' },
  'restyled-io': { kind: 'restyled', role: 'code_agent' },
  imgbot: { kind: 'imgbot', role: 'code_agent' },
  imgbotapp: { kind: 'imgbot', role: 'code_agent' },
  'transifex-integration': { kind: 'transifex', role: 'code_agent' },
  'crowdin-bot': { kind: 'crowdin', role: 'code_agent' },
  mintlify: { kind: 'mintlify', role: 'code_agent' },
  allstar: { kind: 'allstar', role: 'code_agent' },
  mergify: { kind: 'mergify', role: 'release' },
  kodiak: { kind: 'kodiak', role: 'release' },
  kodiakhq: { kind: 'kodiak', role: 'release' },
  bulldozer: { kind: 'bulldozer', role: 'release' },
  'release-please': { kind: 'release_please', role: 'release' },
  releaser: { kind: 'release_please', role: 'release' },
  'semantic-release': { kind: 'semantic_release', role: 'release' },
  'semantic-release-bot': { kind: 'semantic_release', role: 'release' },
  'release-drafter': { kind: 'release_drafter', role: 'release' },
  'changeset-bot': { kind: 'changesets', role: 'release' },
  changesets: { kind: 'changesets', role: 'release' },
  autorelease: { kind: 'release_please', role: 'release' },
  'lumberbot-app': { kind: 'backport', role: 'release' },
  meeseeksdev: { kind: 'backport', role: 'release' },
  backport: { kind: 'backport', role: 'release' },
  'cla-bot': { kind: 'cla_assistant', role: 'housekeeping' },
  'cla-assistant': { kind: 'cla_assistant', role: 'housekeeping' },
  claassistant: { kind: 'cla_assistant', role: 'housekeeping' },
  'google-cla': { kind: 'google_cla', role: 'housekeeping' },
  googlebot: { kind: 'google_cla', role: 'housekeeping' },
  'facebook-github-bot': { kind: 'meta_cla', role: 'housekeeping' },
  dco: { kind: 'dco', role: 'housekeeping' },
  stale: { kind: 'stale_bot', role: 'housekeeping' },
  welcome: { kind: 'welcome_bot', role: 'housekeeping' },
  lock: { kind: 'lock_bot', role: 'housekeeping' },
  allcontributors: { kind: 'allcontributors', role: 'housekeeping' },
  'semantic-pull-request': { kind: 'semantic_pr', role: 'housekeeping' },
  sizebot: { kind: 'sizebot', role: 'housekeeping' },
  'react-sizebot': { kind: 'sizebot', role: 'housekeeping' },
  'diffray-bot': { kind: 'sizebot', role: 'housekeeping' },
  'codesandbox-ci': { kind: 'codesandbox', role: 'housekeeping' },
  netlify: { kind: 'netlify', role: 'housekeeping' },
  vercel: { kind: 'vercel', role: 'housekeeping' },
  'gitpod-io': { kind: 'gitpod', role: 'housekeeping' },
};

function normalizeLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, '');
}

const loginsWithRole = (role: ReviewerRole): Set<string> =>
  new Set(Object.entries(AUTOMATION_VENDORS).filter(([, v]) => v.role === role).map(([k]) => k));

// ⚠ DERIVED, which is what makes the families disjoint BY CONSTRUCTION. They used to be five
// hand-written sets, so "no login appears in two of them" was a property a test had to check and
// a contributor had to remember — and whenever it was violated, the order the predicates happened
// to be tried in silently decided the answer. A login now appears exactly once.
const QUALITY_CHECK_BOTS = loginsWithRole('quality_check');
const DEPENDENCY_BOTS = loginsWithRole('dependency');
const CODE_AGENT_BOTS = loginsWithRole('code_agent');
const RELEASE_BOTS = loginsWithRole('release');
const HOUSEKEEPING_BOTS = loginsWithRole('housekeeping');

// True when a login is a known dependency automation. Mirror of `dependencyBot` in
// `@pierre-review/shared`. The `[bot]`-suffix normalisation is load-bearing here: `dependabot` and
// `dependabot[bot]` exist as SEPARATE user rows on real accounts, with conflicting automated
// flags, and normalising is what stops one actor being split across two lanes.
export function dependencyBot(login: string | null | undefined): boolean {
  if (!login) return false;
  return DEPENDENCY_BOTS.has(normalizeLogin(login));
}

// The bare dependency-automation login slugs, for the query layer's `IN (…)` predicate — the same
// shape `qualityCheckBotLogins` serves for the role seed.
export function dependencyBotLogins(): string[] {
  return [...DEPENDENCY_BOTS];
}

// True when a login is a known quality-check automation. Mirror of `qualityCheckBot` in
// `@pierre-review/shared`. Normalises case + the `[bot]` suffix so it matches whether the login
// arrived via GraphQL (bare slug) or REST (`slug[bot]`).
export function qualityCheckBot(login: string | null | undefined): boolean {
  if (!login) return false;
  return QUALITY_CHECK_BOTS.has(normalizeLogin(login));
}

// The bare quality-check login slugs — used by the query layer to resolve the DEFAULT role of a
// reviewer with no explicit classification row (a `users.githubLogin IN (…)` predicate). Without
// this, a SonarQube account nobody has opened the Bots settings tab for would still count as a
// review bot in every metric, because the role seed only lands when the lazy classifier runs.
export function qualityCheckBotLogins(): string[] {
  return [...QUALITY_CHECK_BOTS];
}

/** True when a login is a known code-authoring automation. Mirror of `codeAgentBot` in shared. */
export function codeAgentBot(login: string | null | undefined): boolean {
  if (!login) return false;
  return CODE_AGENT_BOTS.has(normalizeLogin(login));
}

/** True when a login is a known release / merge automation. Mirror of `releaseBot` in shared. */
export function releaseBot(login: string | null | undefined): boolean {
  if (!login) return false;
  return RELEASE_BOTS.has(normalizeLogin(login));
}

/** True when a login is a known housekeeping automation. Mirror of `housekeepingBot` in shared. */
export function housekeepingBot(login: string | null | undefined): boolean {
  if (!login) return false;
  return HOUSEKEEPING_BOTS.has(normalizeLogin(login));
}

export function codeAgentBotLogins(): string[] {
  return [...CODE_AGENT_BOTS];
}

export function releaseBotLogins(): string[] {
  return [...RELEASE_BOTS];
}

export function housekeepingBotLogins(): string[] {
  return [...HOUSEKEEPING_BOTS];
}

// THE ONE PLACE A LOGIN IS TURNED INTO A ROLE. Every caller that needs "what is this automation
// for" goes through here rather than testing the five predicates in its own order — because the
// ORDER only matters if the sets overlap, and `bot-detection.test.ts` asserts they are pairwise
// disjoint, so there is exactly one answer and no precedence to get wrong.
//
// Returns null for a login in NO vocabulary. That is not "it reviews" — it is "we do not know",
// and the two callers treat it differently on purpose: `defaultRoleFor` falls back to `'review'`
// (the historical default, so an unknown vendor keeps its ROI row and stays user-flippable),
// while `resolveActorLanes` falls back to the quality gate (it declines to CREDIT an unknown
// automation as a reviewer). Both are deliberate and they are allowed to differ.
export function roleForBotLogin(login: string | null | undefined): ReviewerRole | null {
  if (!login) return null;
  return AUTOMATION_VENDORS[normalizeLogin(login)]?.role ?? null;
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

// True when a login matches a built-in service-account pattern. Global/stateless — the account
// scoping lives in the caller.
//
// It used to take a second `extraAllowlist` parameter of simple `*`-globs, fed from the plugin's
// `pro_settings bots.loginAllowlist`, with a private `globToRegExp` beside it. Both are gone with
// that setting: NEITHER call site ever supplied the list (core cannot read plugin tables at all),
// so the glob branch was unreachable. If a per-account allowlist ever comes back it needs a CORE
// home — this function has no way to reach a plugin table. (The unrelated exported `globToRegExp`
// in `github/codeowners.ts` is a different, live function; don't confuse the two.)
export function matchesAutomatedLoginPattern(login: string): boolean {
  if (!login) return false;
  const norm = normalizeLogin(login);
  return AUTOMATED_LOGIN_PATTERNS.some((re) => re.test(norm));
}

/** The full vendor row for a known non-review automation login — identity AND default role in one
 *  lookup, mirroring `AUTOMATION_VENDORS` in shared. Returns null for an AI reviewer (that is
 *  `reviewBotKind`'s job) and for anything unknown. */
export function automationVendorFor(
  login: string | null | undefined,
): { kind: AutomatedReviewerKind; role: ReviewerRole } | null {
  if (!login) return null;
  return AUTOMATION_VENDORS[normalizeLogin(login)] ?? null;
}

/** The vendor identity of a non-review automation, or null. Mirror of `automationVendorKind` in
 *  shared. Deliberately SEPARATE from `reviewBotKind`, which answers the narrower "is this an AI
 *  reviewer" and drives the review-bot badge and the cross-org benchmark — widening that one
 *  would ship a linter's volume into a shared review-bot dataset. */
export function automationVendorKind(
  login: string | null | undefined,
): AutomatedReviewerKind | null {
  return automationVendorFor(login)?.kind ?? null;
}

/** Every login the vendor table covers — the drift guard's key set. */
export function automationVendorLogins(): string[] {
  return Object.keys(AUTOMATION_VENDORS);
}
