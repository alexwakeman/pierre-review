// THE STORED PROVIDER CHOICE (Settings → AI; `accounts.ai_provider`, migration 0128), THE STORED
// EFFORT (`accounts.ai_effort`, migration 0130) AND "USE MY API KEYS FIRST" (`accounts.ai_use_api_key`,
// migration 0184). One per machine each, like the spend budget.
// ai/provider-setting.ts and ai/effort.ts hold them in memory and resolve them (an explicitly set
// LIMN_AI_PROVIDER / REVIEW_EFFORT wins); this module is the only reader and writer of the columns,
// apart from the boot's load and the routes' writes it serves.
import { eq } from 'drizzle-orm';
import { isAiEffort, isAiProviderSetting, parseAiRunProfiles, type AiEffort, type AiProviderSetting, type AiRunProfiles } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { LOCAL_ACCOUNT_ID } from '../auth/account.js';
import { setStoredAiProviderSetting } from './provider-setting.js';
import { setStoredAiEffort } from './effort.js';
import { setStoredAiRunProfiles, storedAiRunProfiles } from './run-profile.js';
import { setStoredPrefersApiKey } from './credentials.js';

/** Read the stored choice into memory (the boot, after migrations). A bad or missing value ⇒ none. */
export async function loadStoredAiProvider(accountId: number = LOCAL_ACCOUNT_ID): Promise<AiProviderSetting | null> {
  let value: AiProviderSetting | null = null;
  try {
    const rows = await db
      .select({ v: schema.accounts.aiProvider })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .limit(1)
      .execute();
    const raw = rows[0]?.v;
    value = isAiProviderSetting(raw) ? raw : null;
  } catch {
    value = null;
  }
  setStoredAiProviderSetting(value);
  return value;
}

/**
 * Store the choice and hold it in memory at once, so the NEXT run (and the next /api/me) uses it. A run
 * already going keeps the provider it picked when it started.
 */
export async function writeStoredAiProvider(value: AiProviderSetting, accountId: number = LOCAL_ACCOUNT_ID): Promise<void> {
  await db.update(schema.accounts).set({ aiProvider: value }).where(eq(schema.accounts.id, accountId)).execute();
  setStoredAiProviderSetting(value);
}

/** Read the stored Effort level into memory (the boot, after migrations). A bad or missing value ⇒ Default. */
export async function loadStoredAiEffort(accountId: number = LOCAL_ACCOUNT_ID): Promise<AiEffort | null> {
  let value: AiEffort | null = null;
  try {
    const rows = await db
      .select({ v: schema.accounts.aiEffort })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .limit(1)
      .execute();
    const raw = rows[0]?.v;
    value = isAiEffort(raw) ? raw : null;
  } catch {
    value = null;
  }
  setStoredAiEffort(value);
  return value;
}

/**
 * Store the Effort level (null ⇒ back to Default) and hold it in memory at once, so the NEXT run uses
 * it. A run already going keeps the effort it started with (and stored).
 *
 * THE COMPAT PATH (PUT /api/ai/effort, since the run profiles): the one level is for EVERY surface, so
 * every effort a run profile stores is dropped in the same write — each surface then falls back to it.
 */
export async function writeStoredAiEffort(value: AiEffort | null, accountId: number = LOCAL_ACCOUNT_ID): Promise<void> {
  const profiles = withoutEfforts(storedAiRunProfiles());
  await db
    .update(schema.accounts)
    .set({ aiEffort: value, aiRunProfiles: profiles })
    .where(eq(schema.accounts.id, accountId))
    .execute();
  setStoredAiEffort(value);
  setStoredAiRunProfiles(profiles);
}

/** The profiles with every effort removed (so each surface reads the one level); null stays null. */
export function withoutEfforts(p: AiRunProfiles | null): AiRunProfiles | null {
  if (p == null) return null;
  const strip = <T extends { effort?: unknown }>(b: T | undefined): T | undefined => {
    if (b == null) return undefined;
    const { effort: _e, ...rest } = b;
    return Object.keys(rest).length > 0 ? (rest as T) : undefined;
  };
  const out: AiRunProfiles = {};
  if (p.review) {
    const claude = strip(p.review.claude);
    const codex = strip(p.review.codex);
    if (claude || codex) out.review = { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) };
  }
  const fix = strip(p.fix);
  if (fix) out.fix = fix;
  const build = strip(p.build);
  if (build) out.build = build;
  return Object.keys(out).length > 0 ? out : null;
}

/** Read the stored run profiles into memory (the boot). A read error or a value the validator refuses ⇒ none. */
export async function loadStoredAiRunProfiles(accountId: number = LOCAL_ACCOUNT_ID): Promise<AiRunProfiles | null> {
  let value: AiRunProfiles | null = null;
  try {
    const rows = await db
      .select({ v: schema.accounts.aiRunProfiles })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .limit(1)
      .execute();
    const raw = rows[0]?.v;
    const parsed = raw == null ? null : parseAiRunProfiles(raw);
    value = parsed?.ok ? parsed.value : null;
  } catch {
    value = null;
  }
  setStoredAiRunProfiles(value);
  return value;
}

/** Store the run profiles (already validated; an empty object ⇒ NULL) and hold them in memory at once. */
export async function writeStoredAiRunProfiles(value: AiRunProfiles, accountId: number = LOCAL_ACCOUNT_ID): Promise<void> {
  const v = Object.keys(value).length > 0 ? value : null;
  await db.update(schema.accounts).set({ aiRunProfiles: v }).where(eq(schema.accounts.id, accountId)).execute();
  setStoredAiRunProfiles(v);
}

/** Read the stored "Use my API keys first" box into memory (the boot). A read error or NULL ⇒ off. */
export async function loadStoredPrefersApiKey(accountId: number = LOCAL_ACCOUNT_ID): Promise<boolean> {
  let value = false;
  try {
    const rows = await db
      .select({ v: schema.accounts.aiUseApiKey })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .limit(1)
      .execute();
    value = rows[0]?.v === true;
  } catch {
    value = false;
  }
  setStoredPrefersApiKey(value);
  return value;
}

/** Store the box and hold it in memory at once, so the NEXT model call uses the chosen credential. */
export async function writeStoredPrefersApiKey(value: boolean, accountId: number = LOCAL_ACCOUNT_ID): Promise<void> {
  await db.update(schema.accounts).set({ aiUseApiKey: value }).where(eq(schema.accounts.id, accountId)).execute();
  setStoredPrefersApiKey(value);
}
