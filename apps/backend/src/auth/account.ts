import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import type { LocalUser } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { getGithubToken } from '../github/auth.js';
import { decryptToken } from './crypto.js';

// A tenant identity. The non-sensitive view of an `accounts` row (the encrypted
// token is never carried here). In local mode there is exactly one (id 1,
// isLocal=true); in cloud mode one per signed-in GitHub user.
export interface Account {
  id: number;
  githubUserId: string;
  githubLogin: string;
  displayName: string | null;
  avatarUrl: string | null;
  isLocal: boolean;
  // Billing plan, set only by the Stripe webhook (never by the OAuth upsert).
  // Local accounts are always fully entitled regardless of this value.
  plan: AccountPlan;
  // Stripe customer id (cus_…) from checkout; the join key for subscription webhooks.
  stripeCustomerId: string | null;
  // Per-account monthly SUMMARY-AI credit-allowance override (metered cloud plan). null =
  // plan default (2,500 for paid cloud); local accounts are unmetered regardless.
  aiCreditAllowance: number | null;
}

export type AccountPlan = 'free' | 'pro';

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
    plan: row.plan === 'pro' ? 'pro' : 'free',
    stripeCustomerId: row.stripeCustomerId,
    aiCreditAllowance: row.aiCreditAllowance ?? null,
  };
}

// Module cache of the local account, set by ensureLocalAccount() at startup so
// the per-request auth hook can resolve it synchronously.
let cachedLocalAccount: Account | null = null;

/**
 * Ensure the synthesized local account (id 1) reflects the locally-authenticated
 * GitHub user. Refetches via `gh api user` on first run and once per day;
 * otherwise returns the cached row. Never throws — failure leaves "you" unknown
 * and triage degrades gracefully to empty. Local mode only.
 */
export async function ensureLocalAccount(): Promise<Account | null> {
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
  if (existing && fresh) {
    cachedLocalAccount = rowToAccount(existing);
    return cachedLocalAccount;
  }

  const gh = fetchFromGh();
  if (!gh) {
    // Fall back to whatever row exists (the migration seeds a placeholder).
    cachedLocalAccount = existing ? rowToAccount(existing) : null;
    return cachedLocalAccount;
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

  cachedLocalAccount = updatedRows[0] ? rowToAccount(updatedRows[0]) : null;
  return cachedLocalAccount;
}

/** The local account from the module cache (no network / no DB). */
export function getLocalAccountCached(): Account | null {
  return cachedLocalAccount;
}

/**
 * Upsert a cloud account from a completed OAuth sign-in (keyed on the GitHub
 * user node id). Re-login refreshes the login/avatar, the encrypted token, and
 * lastLoginAt. Returns the account.
 */
export async function upsertCloudAccount(input: {
  githubUserId: string;
  githubLogin: string;
  displayName: string | null;
  avatarUrl: string | null;
  accessTokenEnc: string;
}): Promise<Account> {
  const { accounts } = schema;
  const now = new Date();
  const rows = await db
    .insert(accounts)
    .values({
      githubUserId: input.githubUserId,
      githubLogin: input.githubLogin,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      accessTokenEnc: input.accessTokenEnc,
      isLocal: false,
      lastLoginAt: now,
      // Seed activity at sign-in so the user's repos are eligible on the very next
      // scheduled sync tick (don't wait for the first heartbeat).
      lastActiveAt: now,
    })
    .onConflictDoUpdate({
      target: accounts.githubUserId,
      set: {
        githubLogin: input.githubLogin,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        accessTokenEnc: input.accessTokenEnc,
        lastLoginAt: now,
        lastActiveAt: now,
      },
    })
    .returning()
    .execute();
  return rowToAccount(rows[0]!);
}

// In-memory throttle for the activity stamp below: accountId → last-stamp epoch ms.
// A loaded SPA is chatty (timeline, polls, heartbeat), so we only touch the DB at
// most once per window per account.
const lastActiveStampMs = new Map<number, number>();
const ACTIVE_STAMP_THROTTLE_MS = 60_000;

/**
 * Record that a loaded frontend for this account just talked to the backend
 * (drives the scheduler's "only sync accounts with an open tab" gate). Throttled
 * in-memory and fire-and-forget — a dropped stamp only means a slightly staler
 * signal, and the next request re-stamps. Cloud-only in practice (the caller gates
 * on isCloud; local has a single always-synced account).
 */
export function stampAccountActive(accountId: number): void {
  const now = Date.now();
  const last = lastActiveStampMs.get(accountId) ?? 0;
  if (now - last < ACTIVE_STAMP_THROTTLE_MS) return;
  lastActiveStampMs.set(accountId, now);
  const { accounts } = schema;
  void db
    .update(accounts)
    .set({ lastActiveAt: new Date() })
    .where(eq(accounts.id, accountId))
    .execute()
    .catch(() => {
      // Best-effort: roll back the throttle so the next request retries the stamp.
      lastActiveStampMs.delete(accountId);
    });
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
 * Set an account's billing plan (and, when known, its Stripe customer id).
 * Called only by the Stripe webhook handler (api/routes/billing.ts).
 */
export async function setAccountPlan(
  accountId: number,
  plan: AccountPlan,
  stripeCustomerId?: string | null,
): Promise<void> {
  const { accounts } = schema;
  const set: { plan: AccountPlan; stripeCustomerId?: string } = { plan };
  if (stripeCustomerId != null) set.stripeCustomerId = stripeCustomerId;
  await db.update(accounts).set(set).where(eq(accounts.id, accountId)).execute();
}

/** Resolve an account by its Stripe customer id (subscription webhooks). */
export async function getAccountByStripeCustomerId(
  customerId: string,
): Promise<Account | null> {
  const { accounts } = schema;
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1)
    .execute();
  return rows[0] ? rowToAccount(rows[0]) : null;
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
 * Resolve the GitHub access token to use for an account's API calls.
 * - Local account (isLocal): live `gh auth token` (no token stored).
 * - Cloud account: decrypt the stored AES-256-GCM sealed token.
 * Throws if the account is missing or a cloud account has no stored token.
 */
export async function getAccessToken(accountId: number): Promise<string> {
  const { accounts } = schema;
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
    .execute();
  const row = rows[0];
  if (!row) throw new Error(`account ${accountId} not found`);
  if (row.isLocal) return getGithubToken();
  if (!row.accessTokenEnc) {
    throw new Error(`account ${accountId} has no stored access token (re-auth needed)`);
  }
  return decryptToken(row.accessTokenEnc);
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
