import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from './client.js';

// THIS DATABASE'S ID (migration 0139, `instance_meta`). A random id written ONCE, the first time
// anything asks, and read back from then on. It names the database FILE, not a path: the file can be
// moved (the ~/.pierre-review → ~/.limn rename) and keeps its id; a second database on the same
// machine (a worktree's dev server, the installed CLI) always has a different one. The reference-docs
// janitor writes it into each workspace docs folder as `.owner` and never deletes a folder holding
// another id (reference-docs/owner.ts).

const KEY = 'instance_id';
let cached: Promise<string> | null = null;

async function readOrCreate(): Promise<string> {
  const t = schema.instanceMeta;
  const read = async (): Promise<string | null> => {
    const rows = await db.select({ value: t.value }).from(t).where(eq(t.key, KEY)).execute();
    return rows[0]?.value ?? null;
  };
  const existing = await read();
  if (existing) return existing;
  // Two first callers race to the insert; the loser's row is dropped and both read the winner's.
  await db.insert(t).values({ key: KEY, value: randomUUID() }).onConflictDoNothing().execute();
  const id = await read();
  if (!id) throw new Error('instance_meta: instance_id could not be written');
  return id;
}

/** This database's random id (created on first call, cached for the process). */
export function getInstanceId(): Promise<string> {
  if (!cached) {
    cached = readOrCreate().catch((err: unknown) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}
