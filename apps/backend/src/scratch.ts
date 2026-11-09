// THE SCRATCH STACK'S START-UP REFUSALS (docs/TESTING.md § Scratch stack).
//
// `pnpm dev:scratch` (scripts/dev-scratch.mjs) starts a second, throwaway backend from a git worktree
// while the reader's own Limn keeps running. It sets LIMN_SCRATCH=1. With it set, config.ts:
//   - loads ONLY `<repo>/.env.scratch`, never `.env` / `apps/backend/.env` (they can re-point a path);
//   - calls `scratchRefusal` below and refuses to start on any answer;
//   - installs the write guard (scratch-guard.ts) unless LIMN_SCRATCH_GITHUB=write.
//
// The check applies however the process is started, so a hand-run `LIMN_SCRATCH=1 tsx src/index.ts`
// gets the same protection as the script.
//
// No imports outside `node:*`: config.ts loads this before it builds `config`.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export type ScratchGithubMode = 'off' | 'read' | 'write';

export function isScratchEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LIMN_SCRATCH?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** LIMN_SCRATCH_GITHUB: `off` | `read` | `write`; anything else is `off` (the safe answer). */
export function scratchGithubMode(env: NodeJS.ProcessEnv = process.env): ScratchGithubMode {
  const v = env.LIMN_SCRATCH_GITHUB?.trim().toLowerCase();
  return v === 'read' || v === 'write' ? v : 'off';
}

/** realpath of the nearest existing ancestor, plus the part that does not exist yet. */
export function realishPath(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(cur)) {
      try {
        return join(realpathSync(cur), ...tail);
      } catch {
        return join(cur, ...tail);
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return join(cur, ...tail);
    tail.unshift(basename(cur));
    cur = parent;
  }
}

/** `child` is `parent` or lies inside it (both already real-ish). */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel);
}

export interface ScratchPaths {
  dbPath: string;
  dataDir: string;
  cloneDir: string;
  docsDir: string;
  port: number;
  frontendPort: number;
  /** The home directory (a test seam). */
  home?: string;
}

/** The reader's own instance's port pair; a scratch backend never takes either. */
export const REAL_BACKEND_PORT = 4000;
export const REAL_FRONTEND_PORT = 5173;

/**
 * Why this scratch configuration must not start, or null when it is safe. Refused:
 *   - a database under `~/.limn`, `~/.pierre-review`, or ANY checkout's `apps/backend/data/` (the
 *     `pnpm dev` default — the reader's real database lives there);
 *   - a data directory that is, or is inside, `~/.limn` / `~/.pierre-review`;
 *   - a clone or docs directory outside the scratch data directory;
 *   - port 4000 or frontend port 5173.
 */
export function scratchRefusal(p: ScratchPaths): string | null {
  const home = realishPath(p.home ?? homedir());
  const realHomes = [join(home, '.limn'), join(home, '.pierre-review')];
  const db = realishPath(p.dbPath);
  const dataDir = realishPath(p.dataDir);

  for (const h of realHomes) {
    if (isWithin(dataDir, h)) return `the data folder ${p.dataDir} is the real Limn's (${h})`;
    if (isWithin(db, h)) return `the database ${p.dbPath} is inside the real Limn's folder ${h}`;
  }
  const parts = db.split(/[\\/]+/);
  for (let i = 0; i + 2 < parts.length; i++) {
    if (parts[i] === 'apps' && parts[i + 1] === 'backend' && parts[i + 2] === 'data') {
      return `the database ${p.dbPath} is in apps/backend/data, where \`pnpm dev\` keeps the real database`;
    }
  }
  if (!isWithin(realishPath(p.cloneDir), dataDir)) {
    return `the clone folder ${p.cloneDir} is outside the scratch data folder ${p.dataDir}`;
  }
  if (!isWithin(realishPath(p.docsDir), dataDir)) {
    return `the docs folder ${p.docsDir} is outside the scratch data folder ${p.dataDir}`;
  }
  if (p.port === REAL_BACKEND_PORT) return `port ${REAL_BACKEND_PORT} belongs to the real Limn`;
  if (p.frontendPort === REAL_FRONTEND_PORT) {
    return `frontend port ${REAL_FRONTEND_PORT} belongs to the real Limn (set FRONTEND_PORT)`;
  }
  return null;
}

export class ScratchRefusedError extends Error {
  constructor(reason: string) {
    super(`Scratch Limn refused to start: ${reason}. Start it with \`pnpm dev:scratch\` from a git worktree.`);
    this.name = 'ScratchRefusedError';
  }
}
