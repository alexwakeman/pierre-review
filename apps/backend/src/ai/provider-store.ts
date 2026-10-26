// THE STORED PROVIDER CHOICE (Settings → AI; `accounts.ai_provider`, migration 0128) AND THE STORED
// EFFORT (`accounts.ai_effort`, migration 0130). One per machine each, like the spend budget.
// ai/provider-setting.ts and ai/effort.ts hold them in memory and resolve them (an explicitly set
// LIMN_AI_PROVIDER / REVIEW_EFFORT wins); this module is the only reader and writer of the columns,
// apart from the boot's load and the routes' writes it serves.
import { eq } from 'drizzle-orm';
import { isAiEffort, isAiProviderSetting, type AiEffort, type AiProviderSetting } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { LOCAL_ACCOUNT_ID } from '../auth/account.js';
import { setStoredAiProviderSetting } from './provider-setting.js';
import { setStoredAiEffort } from './effort.js';

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
 */
export async function writeStoredAiEffort(value: AiEffort | null, accountId: number = LOCAL_ACCOUNT_ID): Promise<void> {
  await db.update(schema.accounts).set({ aiEffort: value }).where(eq(schema.accounts.id, accountId)).execute();
  setStoredAiEffort(value);
}
