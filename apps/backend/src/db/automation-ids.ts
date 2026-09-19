// ── THE GLOBAL AUTOMATION READERS (CORE) ─────────────────────────────────────────────────────
//
// Two account-free signals that an actor is automation, beside `users.isBot` and the review-bot
// login table (queries.ts `botUserIds` / `reviewBotUserIds`):
//
//   • GitHub TYPES the account a Bot (`users.github_type = 'Bot'`) — the App accounts `isLikelyBot`
//     misses because GraphQL returns their login WITHOUT `[bot]`. Measured on the dev DB: seven such
//     users with `is_bot = 0` (Copilot, lumberbot-app, gitguardian, socket-security, google-cla,
//     cdp-github-action, jit-ci), who wrote 112 PR comments on open PRs.
//   • the login is a known NON-review vendor (`AUTOMATION_VENDORS`, bare or `[bot]`, plus the
//     per-org prefixes such as Semgrep's `semgrep-code-<org>`) — Renovate, Snyk, ImgBot…
//
// A separate module, not private functions in queries.ts, because My Turn's mention scanner
// (`db/pr-mentions.ts`, which imports nothing but `client.js`) builds its automation set from these
// too; reaching them through queries.ts would drag that whole module (and its cycle with
// ml-labels.ts) into it.
//
// ⚠ IDS, used only as MEMBERSHIP tests. `users` is a GLOBAL table: nothing here may hand a tenant
// a row, and a caller that needs a workspace's answer folds these through
// `resolveWorkspaceReviewers`, where a person's manual "this is a human" still wins.
// ⚠ ONE reader returns a LOGIN, and it matches EXACT vendor logins only — a public identity, like
// the REVIEW_BOTS seed. The PREFIX half (`semgrep-code-<org>`) matches logins that name ANOTHER
// tenant's organisation, so it only ever yields ids. A new reader here returns ids.
import { eq, inArray, like, or, sql } from 'drizzle-orm';
import { db, schema } from './client.js';
import { automationVendorLoginsForSql, automationVendorPrefixes } from '../sync/bot-detection.js';

const { users } = schema;

/** Users GitHub itself types as a Bot (`users.github_type = 'Bot'`) — the App accounts
 *  `isLikelyBot` misses because GraphQL returns their login WITHOUT `[bot]` (socket-security,
 *  gitguardian, jit-ci, Copilot, google-cla, lumberbot-app, cdp-github-action on the dev DB). */
export async function githubTypeBotUserIds(): Promise<number[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.githubType, 'Bot'))
    .execute();
  return rows.map((r) => r.id);
}

/** `lower(github_login)` — built per call, never at import: tests that mock `client.js` with a
 *  partial schema import this module too. */
const loweredLogin = () => sql`lower(${users.githubLogin})`;

/** Users whose login is in AUTOMATION_VENDORS (bare or `[bot]`) or matches a vendor PREFIX:
 *  `lower(github_login) IN (…) OR lower(github_login) LIKE 'semgrep-code-%' OR … 'semgrepcode-%'`.
 *  ⚠ Lowercased on BOTH sides, so pg's case-sensitive `LIKE` and SQLite's case-blind one agree;
 *  no prefix contains `_`, LIKE's single-character wildcard. */
export async function automationVendorUserIds(): Promise<number[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      or(
        inArray(loweredLogin(), automationVendorLoginsForSql()),
        ...automationVendorPrefixes().map((p) => like(loweredLogin(), `${p}%`)),
      ),
    )
    .execute();
  return rows.map((r) => r.id);
}

/**
 * THE BALL RULE'S AUTOMATION SET — every actor we know to be automation WITHOUT a workspace:
 * `users.isBot` ∪ `users.github_type = 'Bot'` ∪ the AUTOMATION_VENDORS logins and prefixes. GLOBAL,
 * so the unscoped `getMyTurn` (browser notifications, the CLI) and the scoped one (the board, the
 * brief) agree, and the mention scanner (db/pr-mentions.ts) honours exactly the mentions the ball
 * rule would.
 *
 * WHY NOT `users.isBot` ALONE: My Turn's newer rules read OTHER people's comments ("a person
 * commented after you", "a person replied to you", "a person @-mentioned you"), and on the dev DB
 * the accounts GitHub types as a Bot but `isBot` misses wrote 112 PR comments on 82 open PRs
 * (google-cla 73, socket-security 24, cdp-github-action 12, gitguardian 2, jit-ci 1). Under the
 * `isBot`-only set each of those summons the viewer as though a colleague had answered them. The
 * Pending cards already call the same accounts automation.
 *
 * ⚠ STILL NOT `hiddenBotUserIds`: that union needs a workspaceId, and `getMyTurn` also runs
 * unscoped. A workspace's manual "this is a human" therefore cannot reach this set — accepted,
 * because every member here is an account GitHub types as an App or a known vendor login.
 * ⚠ `users.isBot` keeps its own meaning; this set is a union READ, never a write.
 */
export async function globalAutomationUserIds(): Promise<Set<number>> {
  const [flagged, typed, vendors] = await Promise.all([
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isBot, true))
      .execute()
      .then((rows) => rows.map((r) => r.id)),
    githubTypeBotUserIds(),
    automationVendorUserIds(),
  ]);
  return new Set([...flagged, ...typed, ...vendors]);
}

/** The users whose login is EXACTLY a vendor login (bare or `[bot]`), with that login — the kind
 *  seed in queries.ts (`classificationKindForUser`) names each one's vendor from it. ⚠ NEVER the
 *  prefix half: that kind map is also the bot drill-downs' "is this id classified here" gate, which
 *  then resolves the login, so a prefix match would read another org's name back to any tenant. */
export async function exactAutomationVendorUsers(): Promise<{ id: number; login: string }[]> {
  return db
    .select({ id: users.id, login: users.githubLogin })
    .from(users)
    .where(inArray(loweredLogin(), automationVendorLoginsForSql()))
    .execute();
}
