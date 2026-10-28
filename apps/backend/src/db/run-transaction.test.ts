// runTransaction's in-process lock: concurrent callers queue instead of colliding on BEGIN.
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runTransaction } from './client.js';

const tick = (): Promise<void> => Promise.resolve();

describe('runTransaction', () => {
  it('two transactions started in the same tick both commit, one after the other', async () => {
    await db.run(sql`CREATE TABLE IF NOT EXISTS tx_lock_probe (n INTEGER)`);
    await db.run(sql`DELETE FROM tx_lock_probe`);
    const order: string[] = [];
    const work = (name: string) =>
      runTransaction(async (tx) => {
        order.push(`${name}:begin`);
        await tick();
        await tx.run(sql`INSERT INTO tx_lock_probe (n) VALUES (1)`);
        await tick();
        order.push(`${name}:end`);
        return name;
      });
    // Before the lock, the second BEGIN threw "cannot start a transaction within a transaction".
    await expect(Promise.all([work('a'), work('b')])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual(['a:begin', 'a:end', 'b:begin', 'b:end']);
    const rows = await db.all<{ c: number }>(sql`SELECT count(*) AS c FROM tx_lock_probe`);
    expect(rows[0]?.c).toBe(2);
  });

  it('a failed transaction rolls back and releases the lock', async () => {
    await expect(runTransaction(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(runTransaction(async () => 'next')).resolves.toBe('next');
  });

  it('a nested call throws instead of waiting on itself', async () => {
    await expect(runTransaction(async () => runTransaction(async () => 1))).rejects.toThrow('nested');
    await expect(runTransaction(async () => 'after')).resolves.toBe('after');
  });

  it('work the callback only started runs its own transaction after the commit', async () => {
    let later: Promise<string> | null = null;
    await runTransaction(async () => {
      // Deferred past the commit (still inside the callback's async context).
      later = new Promise<void>((r) => setImmediate(r)).then(() => runTransaction(async () => 'later'));
    });
    await expect(later).resolves.toBe('later');
  });
});
