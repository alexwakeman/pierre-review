// THE STORED PROVIDER CHOICE (Settings → AI; `accounts.ai_provider`, migration 0128). One per machine,
// like the spend budget. ai/provider-setting.ts holds it in memory and resolves it (an explicitly set
// LIMN_AI_PROVIDER wins); this module is the only reader and writer of the column, apart from the
// boot's load and the route's write it serves.
import { eq } from 'drizzle-orm';
import { isAiProviderSetting, type AiProviderSetting } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { LOCAL_ACCOUNT_ID } from '../auth/account.js';
import { setStoredAiProviderSetting } from './provider-setting.js';

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
