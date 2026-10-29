import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

// THE IMAGE-DESCRIPTION CACHE (`reference_doc_figure_descriptions`, migration 0145; docs/REFERENCE-DOCS.md
// § Figures): one row per (account, image sha256). Every statement carries the ACCOUNT predicate. The
// caller asks only for hashes its own document holds (figures.ts `resolveFigures`).

const HASH = /^[0-9a-f]{64}$/;

export async function cachedFigureDescriptions(accountId: number, hashes: readonly string[]): Promise<Map<string, string>> {
  const ok = [...new Set(hashes.filter((h) => HASH.test(h)))];
  const out = new Map<string, string>();
  const t = schema.referenceDocFigureDescriptions;
  // SQLite's variable limit: ask in slices.
  for (let i = 0; i < ok.length; i += 200) {
    const rows = await db
      .select({ imageHash: t.imageHash, description: t.description })
      .from(t)
      .where(and(eq(t.accountId, accountId), inArray(t.imageHash, ok.slice(i, i + 200))))
      .execute();
    for (const r of rows) out.set(r.imageHash, r.description);
  }
  return out;
}

export async function saveFigureDescription(
  accountId: number,
  imageHash: string,
  description: string,
  ran: { provider: string | null; model: string | null; costUsd: number | null },
): Promise<void> {
  if (!HASH.test(imageHash)) return;
  const t = schema.referenceDocFigureDescriptions;
  const cols = { description, provider: ran.provider, model: ran.model, costUsd: ran.costUsd };
  await db
    .insert(t)
    .values({ accountId, imageHash, ...cols, createdAt: new Date() })
    .onConflictDoUpdate({ target: [t.accountId, t.imageHash], set: cols })
    .execute();
}
