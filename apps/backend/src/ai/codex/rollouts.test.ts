// CODEX SESSION FILES (ai/codex/rollouts.ts): one thread's files go, nobody else's; leftovers older
// than a day are swept; erasure removes every rollout but never the sign-in or the config.
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteThreadRollouts, removeAllRollouts, sweepOldRollouts } from './rollouts.js';

let home = '';
afterEach(() => rmSync(home, { recursive: true, force: true }));

function setup(): { a: string; b: string; archived: string; auth: string; config: string } {
  home = mkdtempSync(join(tmpdir(), 'limn-codex-rollouts-'));
  const day = join(home, 'sessions', '2026', '10', '25');
  mkdirSync(day, { recursive: true });
  mkdirSync(join(home, 'archived_sessions'), { recursive: true });
  const a = join(day, 'rollout-2026-10-25T16-53-36-01a173fb-6094-7113-bd54-691bb6d13631.jsonl');
  const b = join(day, 'rollout-2026-10-25T16-53-32-01a173fb-5228-7eb1-a959-e20bd3414337.jsonl');
  const archived = join(home, 'archived_sessions', 'rollout-2026-10-24T01-00-00-01a173fb-6094-7113-bd54-691bb6d13631.jsonl');
  const auth = join(home, 'auth.json');
  const config = join(home, 'config.toml');
  for (const f of [a, b, archived, auth, config]) writeFileSync(f, '{}');
  return { a, b, archived, auth, config };
}

describe('Codex rollouts', () => {
  it('deletes exactly one thread’s files (archived too), never a prefix match or a bad id', () => {
    const f = setup();
    expect(deleteThreadRollouts(home, '01a173fb-6094-7113-bd54-691bb6d13631')).toBe(2);
    expect(existsSync(f.a)).toBe(false);
    expect(existsSync(f.archived)).toBe(false);
    expect(existsSync(f.b)).toBe(true);
    expect(deleteThreadRollouts(home, '13631')).toBe(0); // a suffix of nobody's whole id
    expect(deleteThreadRollouts(home, '../x')).toBe(0);
    expect(deleteThreadRollouts(home, null)).toBe(0);
    expect(existsSync(f.b)).toBe(true);
  });

  it('sweeps only files older than the limit, and never the sign-in', () => {
    const f = setup();
    const old = (Date.now() - 2 * 24 * 60 * 60_000) / 1000;
    utimesSync(f.b, old, old);
    utimesSync(f.auth, old, old);
    expect(sweepOldRollouts(home)).toBe(1);
    expect(existsSync(f.b)).toBe(false);
    expect(existsSync(f.a)).toBe(true);
    expect(existsSync(f.auth)).toBe(true);
  });

  it('erasure removes every rollout, keeps auth.json and config.toml', () => {
    const f = setup();
    removeAllRollouts(home);
    expect(existsSync(join(home, 'sessions'))).toBe(false);
    expect(existsSync(join(home, 'archived_sessions'))).toBe(false);
    expect(existsSync(f.auth)).toBe(true);
    expect(existsSync(f.config)).toBe(true);
  });
});
