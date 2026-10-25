// NOTHING IN THE BACKEND COPIES OR READS THE READER'S OWN CODEX SIGN-IN. A copy of ~/.codex/auth.json
// is a second holder of ONE rotating refresh token: whichever copy refreshes first logs the other one
// out (the reader's own Codex, or Limn). Tests — the live test included — use Limn's own home
// (~/.limn/codex, `limn ai login codex`) and skip when it holds no sign-in. This scans the source so a
// new test (or helper) cannot quietly bring the copy back.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = fileURLToPath(import.meta.url);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith('.ts') && p !== SELF) out.push(p);
  }
  return out;
}

describe("the reader's own Codex home", () => {
  it('no source file copies an auth.json, or reads one from ~/.codex', () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'latin1');
      if (!text.includes('auth.json')) continue;
      // A copy of any auth.json, or a path to one under the REAL home directory (`homedir()` — a test
      // that fakes HOME in a temp folder to prove the reader's file is ignored is fine).
      const copies = /\b(copyFileSync|copyFile|cpSync|cp)\s*\([^)]*auth\.json/.test(text);
      const readsUserHome = text.split('\n').some((l) => /homedir\(\)/.test(l) && /\.codex/.test(l) && /auth\.json/.test(l));
      if (copies || readsUserHome) offenders.push(relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });
});
