// The repository's declared checks, read from a WORKTREE on disk (the run's own, at the fix's base
// commit). Only `CHECK_MANIFEST_FILES` are read, only REGULAR files (a symlink is skipped — a PR could
// point `Makefile` at a file outside the tree), each capped at 1 MB. Node built-ins only.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_MANIFEST_FILES, discoverChecks, type RepoFiles } from './discover.js';
import type { CheckPlan } from './types.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;

export function localRepoFiles(dir: string): RepoFiles {
  const cache = new Map<string, string | null>();
  const allowed = new Set<string>(CHECK_MANIFEST_FILES);
  return {
    read(path: string): string | null {
      if (!allowed.has(path)) return null;
      if (cache.has(path)) return cache.get(path)!;
      let text: string | null = null;
      try {
        // Every folder on the way must be a real folder too (`.husky` may not be a symlink).
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          if (!lstatSync(join(dir, ...parts.slice(0, i))).isDirectory()) throw new Error('not a folder');
        }
        const st = lstatSync(join(dir, path));
        if (st.isFile() && st.size <= MAX_MANIFEST_BYTES) text = readFileSync(join(dir, path), 'utf8');
      } catch {
        text = null;
      }
      cache.set(path, text);
      return text;
    },
  };
}

export function discoverLocalChecks(dir: string): CheckPlan {
  return discoverChecks(localRepoFiles(dir));
}
