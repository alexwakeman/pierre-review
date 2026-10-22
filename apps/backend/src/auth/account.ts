import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import type {
  BlastRadiusConfig,
  BlastSensitivity,
  BlastSurface,
  BlastThresholds,
  LocalUser,
  MyTurnSettings,
} from '@pierre-review/shared';
import { compactMyTurnSettings } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { getGithubTokenAsync } from '../github/auth.js';

// A tenant identity. The non-sensitive view of an `accounts` row. Limn runs locally, so there is
// one (id 1, isLocal=true); the accountId columns stay so the data model keeps its scoping.
export interface Account {
  id: number;
  githubUserId: string;
  githubLogin: string;
  displayName: string | null;
  avatarUrl: string | null;
  isLocal: boolean;
  // The LARGE-PR FLAG's threshold in lines of CODE churn, or null when the user has never set
  // one (→ the 1,500-line product default; resolve through `resolveLargePrThreshold`). ONE
  // per-account setting — no workspace or repo grain, so nothing here needs a resolver.
  largePrCodeLocThreshold: number | null;
  // The BLAST-RADIUS reading settings, or null when the user has never set any (→ the product
  // defaults, applied SPA-side — see the column comment in schema.sqlite.ts for why the defaults
  // are not mirrored on this side). Same account grain and same two-state rule as the threshold
  // above.
  blastRadiusConfig: BlastRadiusConfig | null;
  // MY TURN settings — which card types count as your turn, their order, and the Do next weights
  // — as the STORED overrides, or null when the user has never changed anything (→ the product
  // defaults; resolve through `resolveMyTurnSettings`). Same account grain and same two-state rule
  // as the two settings above. Optional only so the auth hook's no-account-yet fallback literal
  // (api/plugins/auth.ts) needs no entry: absent reads exactly as null.
  myTurnSettings?: MyTurnSettings | null;
}

const STALE_MS = 24 * 60 * 60 * 1000; // re-fetch the local identity once a day

// The synthesized local account is always id 1 (seeded by migration 0008).
export const LOCAL_ACCOUNT_ID = 1;

interface GhUser {
  login: string;
  node_id: string;
  name: string | null;
  avatar_url: string | null;
}

function fetchFromGh(): GhUser | null {
  try {
    const out = execFileSync('gh', ['api', 'user'], { encoding: 'utf-8' });
    const parsed = JSON.parse(out) as Partial<GhUser>;
    if (!parsed.login || !parsed.node_id) return null;
    return {
      login: parsed.login,
      node_id: parsed.node_id,
      name: parsed.name ?? null,
      avatar_url: parsed.avatar_url ?? null,
    };
  } catch {
    // gh missing / not authed / offline — non-fatal; my-turn just stays empty.
    return null;
  }
}

function rowToAccount(row: typeof schema.accounts.$inferSelect): Account {
  return {
    id: row.id,
    githubUserId: row.githubUserId,
    githubLogin: row.githubLogin,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    isLocal: row.isLocal,
    largePrCodeLocThreshold: row.largePrCodeLocThreshold ?? null,
    blastRadiusConfig: row.blastRadiusConfig ?? null,
    myTurnSettings: row.myTurnSettings ?? null,
  };
}

// Module cache of the local account, set by ensureLocalAccount() at startup so
// the per-request auth hook can resolve it synchronously.
let cachedLocalAccount: Account | null = null;

/**
 * Guarantee the account's DEFAULT WORKSPACE exists before the account is handed to anyone.
 *
 * A workspace id is the only scope this app has: every scoped read resolves one, repos land in
 * the Default on sync, and reviewer rows key on it. An account with no workspace therefore has
 * no reachable state at all — not an empty board but a resolver with nothing to return — so
 * account resolution closes the gap at startup. Migration 0044 backfills a Default for every
 * account that existed when it ran.
 *
 * `db/queries.ts` STATICALLY imports `getAccountUserId` from this file, so the import here is
 * DYNAMIC to avoid closing that cycle. It costs nothing: the caller is cold (process startup)
 * and the module is cached after the first call.
 *
 * It is deliberately NOT swallowed. `ensureDefaultWorkspace` only throws when the partial unique
 * index `workspaces_one_default` is missing, i.e. migration 0044 never ran — and the caller runs
 * `runMigrations()` first. Failing there names the real fault; swallowing it would instead have
 * every later request resolve a scope that does not exist.
 */
async function ensureAccountWorkspace(accountId: number): Promise<void> {
  const { ensureDefaultWorkspace } = await import('../db/queries.js');
  await ensureDefaultWorkspace(accountId);
}

/**
 * Ensure the synthesized local account (id 1) reflects the locally-authenticated
 * GitHub user, and that it owns a Default workspace. Refetches via `gh api user`
 * on first run and once per day; otherwise returns the cached row.
 *
 * A missing/unauthenticated/offline `gh` is non-fatal — it leaves "you" unknown and
 * triage degrades gracefully to empty. (A failing DB is not: see
 * `ensureAccountWorkspace`.)
 */
export async function ensureLocalAccount(): Promise<Account | null> {
  const account = await resolveLocalAccount();
  cachedLocalAccount = account;
  // ONE call site covering all three resolution paths — the fresh cache hit included, since an
  // account row that predates the workspace tables reaches this function by that path too.
  if (account) await ensureAccountWorkspace(account.id);
  return account;
}

/** The `accounts` half of ensureLocalAccount: resolve/refresh the row, no workspace, no caching. */
async function resolveLocalAccount(): Promise<Account | null> {
  const { accounts } = schema;
  const existingRows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, LOCAL_ACCOUNT_ID))
    .limit(1)
    .execute();
  const existing = existingRows[0] ?? null;
  const fresh =
    existing &&
    existing.githubUserId !== '' &&
    existing.lastLoginAt != null &&
    Date.now() - existing.lastLoginAt.getTime() < STALE_MS &&
    // Backfill the display name on the first run after it was added (older rows have
    // it NULL). A genuinely name-less GitHub user re-fetches each startup — cheap;
    // the daily refresh would repopulate it anyway.
    existing.displayName != null;
  if (existing && fresh) return rowToAccount(existing);

  const gh = fetchFromGh();
  if (!gh) {
    // Fall back to whatever row exists (the migration seeds a placeholder).
    return existing ? rowToAccount(existing) : null;
  }

  const updatedRows = await db
    .insert(accounts)
    .values({
      id: LOCAL_ACCOUNT_ID,
      githubUserId: gh.node_id,
      githubLogin: gh.login,
      displayName: gh.name,
      avatarUrl: gh.avatar_url,
      isLocal: true,
      lastLoginAt: new Date(),
    })
    .onConflictDoUpdate({
      target: accounts.id,
      set: {
        githubUserId: gh.node_id,
        githubLogin: gh.login,
        displayName: gh.name,
        avatarUrl: gh.avatar_url,
        isLocal: true,
        lastLoginAt: new Date(),
      },
    })
    .returning()
    .execute();

  return updatedRows[0] ? rowToAccount(updatedRows[0]) : null;
}

/** The local account from the module cache (no network / no DB). */
export function getLocalAccountCached(): Account | null {
  return cachedLocalAccount;
}

/**
 * Re-read the LOCAL account's row into the module cache after a column write.
 *
 * ⚠ WITHOUT THIS, A PER-ACCOUNT SETTING SILENTLY DOES NOT SAVE IN LOCAL MODE. The cache is
 * populated once at startup by `ensureLocalAccount` and the per-request hook serves `req.account`
 * straight out of it, so `/api/me` keeps echoing the value the process booted with. The write
 * route's own response is correct, so the SPA paints the new setting — and is then told the old
 * one by the `['me']` refetch its mutation triggers, which reverts the control the user just used.
 * Measured on the shipping large-PR threshold before this existed: POST 900 → 200 OK with
 * `{threshold: 900}`, then `/api/me` → `{threshold: 1500, isDefault: true}`.
 *
 * A no-op for any account that is not the cached one.
 */
export async function refreshLocalAccountCache(accountId: number): Promise<void> {
  if (cachedLocalAccount == null || cachedLocalAccount.id !== accountId) return;
  const fresh = await getAccountById(accountId);
  if (fresh) cachedLocalAccount = fresh;
}

/** Load an account by id. */
export async function getAccountById(id: number): Promise<Account | null> {
  const { accounts } = schema;
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id))
    .limit(1)
    .execute();
  return rows[0] ? rowToAccount(rows[0]) : null;
}

/**
 * Set (or clear) an account's LARGE-PR FLAG threshold, in lines of CODE churn.
 *
 * `null` CLEARS it — back to the two-state "no opinion → product default", which is what makes a
 * later change to that default reach every account that never overrode it. It is a column write,
 * never a delete of anything, and it is deliberately validated HERE as well as by the route's
 * schema: a threshold of 0 or a fraction would flag every PR or none, silently.
 */
export async function setLargePrCodeLocThreshold(
  accountId: number,
  threshold: number | null,
): Promise<void> {
  const { accounts } = schema;
  const value =
    threshold != null && Number.isInteger(threshold) && threshold > 0 ? threshold : null;
  await db
    .update(accounts)
    .set({ largePrCodeLocThreshold: value })
    .where(eq(accounts.id, accountId))
    .execute();
  // ⚠ REQUIRED, not tidiness — see refreshLocalAccountCache. Without it this setting appears not
  // to save in local mode: the route 200s with the new number and the SPA's own `['me']` refetch
  // immediately reports the old one.
  await refreshLocalAccountCache(accountId);
}

// The runtime spellings of two `packages/shared` unions. ⚠ MIRRORED ON PURPOSE, and this is the
// small mirror the design chose over the big one: `shared` is types-only on this side
// (PACKAGING), so a route that validates a stored enum needs the members as VALUES. Ten strings
// and three, versus the 18-number BLAST_THRESHOLDS table the SPA resolves instead. If a member is
// added to either union in shared, add it here — `blast-radius-config.test.ts` pins the count so
// the omission fails rather than silently rejecting a valid write.
const BLAST_SURFACE_VALUES: readonly BlastSurface[] = [
  'db_migration',
  'db_schema',
  'sql',
  'public_types',
  'idl',
  'openapi',
  'infra',
  'auth',
  'ci',
  'deps',
];
const BLAST_SENSITIVITY_VALUES: readonly BlastSensitivity[] = ['cautious', 'balanced', 'relaxed'];
const BLAST_THRESHOLD_KEYS: readonly (keyof BlastThresholds)[] = [
  'highCodeLoc',
  'highCodeFiles',
  'highDirs',
  'highSubsystems',
  'lowCodeLoc',
  'lowCodeFiles',
];

/**
 * Validate an untrusted blast-radius config into the shape the column may hold, or `null`.
 *
 * ⚠ RETURNS null FOR ANYTHING IT CANNOT FULLY VALIDATE, which is the same "no opinion" state a
 * cleared setting has — never a partially-applied blob. An unknown surface string is DROPPED
 * rather than failing the whole write, so an older backend reading a newer client's payload
 * degrades to ignoring one opt-out instead of discarding the user's dial.
 */
export function sanitizeBlastRadiusConfig(input: unknown): BlastRadiusConfig | null {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;

  const sensitivity = BLAST_SENSITIVITY_VALUES.find((v) => v === raw.sensitivity);
  if (sensitivity == null) return null;

  const surfacesOff = Array.isArray(raw.surfacesOff)
    ? BLAST_SURFACE_VALUES.filter((v) => (raw.surfacesOff as unknown[]).includes(v))
    : [];

  let overrides: Partial<BlastThresholds> | undefined;
  if (raw.overrides != null && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides)) {
    const src = raw.overrides as Record<string, unknown>;
    const out: Partial<BlastThresholds> = {};
    for (const k of BLAST_THRESHOLD_KEYS) {
      const v = src[k];
      // Same rule as the large-PR threshold: a 0 or a fraction would bucket everything or
      // nothing, silently. Only a positive integer is an opinion.
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v;
    }
    if (Object.keys(out).length > 0) overrides = out;
  }

  // ⚠ ONLY STORED WHEN IT IS `false`. `showImpactNote` defaults to SHOWN, so writing `true`
  // would persist the product default as a choice — the same two-state rule the whole config
  // follows, one field down. A blob whose only content was `{showImpactNote: true}` would also
  // stop `isDefault` reading true in Settings for a user who changed nothing that matters.
  const hide = raw.showImpactNote === false;

  const base: BlastRadiusConfig = { sensitivity, surfacesOff };
  if (overrides) base.overrides = overrides;
  if (hide) base.showImpactNote = false;
  return base;
}

/**
 * Set (or clear) an account's BLAST-RADIUS reading settings.
 *
 * `null` — and any payload that fails validation — CLEARS the column, back to the two-state
 * "no opinion → product defaults". Exactly the rule `setLargePrCodeLocThreshold` follows, and for
 * the same reason: a stored blob would freeze this account against a later change to those
 * defaults.
 */
export async function setBlastRadiusConfig(
  accountId: number,
  config: BlastRadiusConfig | null,
): Promise<BlastRadiusConfig | null> {
  const { accounts } = schema;
  const value = sanitizeBlastRadiusConfig(config);
  await db
    .update(accounts)
    .set({ blastRadiusConfig: value })
    .where(eq(accounts.id, accountId))
    .execute();
  // ⚠ Same rule as the threshold above, and the same failure without it.
  await refreshLocalAccountCache(accountId);
  return value;
}

/**
 * Set (or clear) an account's MY TURN settings, and return what was STORED.
 *
 * The value is COMPACTED first (`compactMyTurnSettings`, the ONE definition of "an override" the
 * Settings form builds its body with too), so a default is never frozen into the row — `null`, or
 * anything that compacts to nothing, stores NULL and the account follows the product defaults
 * again. Validate BEFORE calling: compaction drops a malformed part silently, which is right for a
 * stored value and wrong for a request.
 */
export async function setMyTurnSettings(
  accountId: number,
  settings: MyTurnSettings | null,
): Promise<MyTurnSettings | null> {
  const { accounts } = schema;
  const value = compactMyTurnSettings(settings);
  await db
    .update(accounts)
    .set({ myTurnSettings: value })
    .where(eq(accounts.id, accountId))
    .execute();
  // ⚠ Same rule as the two settings above, and the same failure without it: Settings would save,
  // then `/api/me` would hand the old value back and revert the form.
  await refreshLocalAccountCache(accountId);
  return value;
}

/**
 * Resolve an account's owner to a row in `users` (by login) if they've appeared
 * in any synced repo. Returns null when "you" haven't authored/acted anywhere
 * yet. This is the "who am I" used by all triage ("my turn").
 */
export async function getAccountUserId(
  accountId: number,
): Promise<number | null> {
  const account = await getAccountById(accountId);
  if (!account || !account.githubLogin) return null;
  const { users } = schema;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.githubLogin, account.githubLogin))
    .limit(1)
    .execute();
  return rows[0]?.id ?? null;
}

/**
 * Resolve the GitHub access token to use for an account's API calls: the live `gh auth token`
 * (nothing is stored). Throws if the account is missing.
 */
export async function getAccessToken(accountId: number): Promise<string> {
  const { accounts } = schema;
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
    .execute();
  if (!rows[0]) throw new Error(`account ${accountId} not found`);
  // The ASYNC form: this runs on request paths (PR-detail hydration, repo search, every write
  // action), and the synchronous `gh auth token` it used to call blocked the event loop for
  // 50–300ms per call while forking a child process. Both are now cached with a short TTL and
  // share one in-flight invocation — see github/auth.ts.
  return getGithubTokenAsync();
}

/** Shape an Account as the legacy LocalUser wire type for /api/me. */
export function accountToLocalUser(account: Account | null): LocalUser | null {
  if (!account || !account.githubLogin) return null;
  return {
    login: account.githubLogin,
    githubId: account.githubUserId,
    avatarUrl: account.avatarUrl,
    displayName: account.displayName,
  };
}
