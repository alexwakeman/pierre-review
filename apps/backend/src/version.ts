// THE RUNNING LIMN VERSION, for the hidden metadata on a posted review (shared limn-review-meta.ts).
// The nearest package.json above this module that is Limn's own (`limn-review` in a release, the
// backend workspace in dev). Read once; null when it cannot be read — never throws.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAMES = new Set(['limn-review', '@pierre-review/backend']);
let cached: string | null | undefined;

export function limnVersion(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      const file = join(dir, 'package.json');
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown };
        if (typeof pkg.name === 'string' && NAMES.has(pkg.name) && typeof pkg.version === 'string') {
          cached = pkg.version;
          break;
        }
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    cached = null;
  }
  return cached;
}
