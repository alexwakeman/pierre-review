// LOCAL PINNED REFS (docs/CLAUDE-REVIEW.md § Reviewing a branch → The head source).
//
// A commit Ensemble made ITSELF in its clone cache and has NOT pushed — a fix round's work, a reader's
// uploaded branch — is kept reachable by ONE ref namespace:
//
//   refs/pierre/local/<kind>/<id>/<name>
//
// `kind` names the owner (lower-case word, e.g. `ai-fix-loop`), `id` its row id, `name` the one commit
// (`r1`, `head`, …). A branch review reads such a ref as its HEAD SOURCE (clone-manager.ts
// `BranchHeadSource` `{ localRef, sha }`): the diff and the checkout come from the clone cache and NOTHING
// is fetched from GitHub for it. Nothing here pushes.
//
// THE ONE SWEEP RULE: a ref is kept while its owner HOLDS it in this process (`holdLocalRefs`), or while the
// owner's kind registered a keeper (`registerLocalRefKeeper`) that says its row still needs it. Everything
// else in the namespace is dropped
//   • on DISCARD — the owner calls `dropLocalRefs(owner, name, kind, id)`;
//   • at BOOT — `sweepLocalRefs()` after listen (index.ts), never awaited, BOUNDED by a deadline and a ref
//     cap (what it does not reach waits for the next boot).
// A ref under the prefix that does not parse is KEPT, never guessed at (as the story-build base refs).
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { LOCAL_PINNED_REF_PREFIX, repoCloneDir, withRepoLock } from './clone-manager.js';

const execFileAsync = promisify(execFile);

export interface LocalRefKey {
  kind: string;
  id: number;
  name: string;
}

const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The ref of one local commit. Throws on a malformed key (a caller bug, never data). */
export function localRefName(k: LocalRefKey): string {
  if (!KIND.test(k.kind) || !Number.isInteger(k.id) || k.id <= 0 || !NAME.test(k.name) || k.name.endsWith('.lock') || k.name.includes('..')) {
    throw new Error(`not a local ref key: ${k.kind}/${k.id}/${k.name}`);
  }
  return `${LOCAL_PINNED_REF_PREFIX}${k.kind}/${k.id}/${k.name}`;
}

/** The key of a ref in the namespace, or null (an unrecognised ref is kept, never guessed at). */
export function parseLocalRef(ref: string): LocalRefKey | null {
  if (!ref.startsWith(LOCAL_PINNED_REF_PREFIX)) return null;
  const m = /^([^/]+)\/(\d+)\/([^/]+)$/.exec(ref.slice(LOCAL_PINNED_REF_PREFIX.length));
  if (m == null) return null;
  const k = { kind: m[1]!, id: Number(m[2]), name: m[3]! };
  return KIND.test(k.kind) && k.id > 0 && NAME.test(k.name) ? k : null;
}

/** The owner key (`kind/id`) the hold and the keepers speak in. */
export const ownerKey = (kind: string, id: number): string => `${kind}/${id}`;

// ---- the hold (in-process) and the keepers (stored state) ------------------------------------------------

const held = new Map<string, number>();

/** A run that reads or makes these refs holds them; the sweep never drops a held owner's refs. Returns the release. */
export function holdLocalRefs(kind: string, id: number): () => void {
  const key = ownerKey(kind, id);
  held.set(key, (held.get(key) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (held.get(key) ?? 1) - 1;
    if (n <= 0) held.delete(key);
    else held.set(key, n);
  };
}

/** For a kind whose refs outlive a process (a resumable row): which of these owner ids still need them. */
export type LocalRefKeeper = (ids: readonly number[]) => Promise<ReadonlySet<number>>;

const keepers = new Map<string, LocalRefKeeper>();

/** Register (or, with null, remove) a kind's keeper. A kind with none keeps its refs only while held. */
export function registerLocalRefKeeper(kind: string, keeper: LocalRefKeeper | null): void {
  if (keeper) keepers.set(kind, keeper);
  else keepers.delete(kind);
}

async function gitOut(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', dir, ...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Point a local ref at a commit already in the clone (the caller holds the repo lock). */
export async function pinLocalRefLocked(cloneDir: string, k: LocalRefKey, sha: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('not a commit id');
  const ref = localRefName(k);
  await gitOut(cloneDir, ['update-ref', ref, sha]);
  return ref;
}

/** DISCARD: every ref of one owner in one clone. Takes the repo lock; never throws. Returns how many went. */
export async function dropLocalRefs(owner: string, name: string, kind: string, id: number): Promise<number> {
  const dir = repoCloneDir(owner, name);
  if (!existsSync(join(dir, '.git'))) return 0;
  let n = 0;
  await withRepoLock(`${owner}/${name}`, async () => {
    const refs = lines(await gitOut(dir, ['for-each-ref', '--format=%(refname)', `${LOCAL_PINNED_REF_PREFIX}${ownerKey(kind, id)}/`]).catch(() => ''));
    for (const ref of refs) {
      await gitOut(dir, ['update-ref', '-d', ref]).then(
        () => void (n += 1),
        () => {},
      );
    }
  }).catch(() => {});
  return n;
}

export interface LocalRefSweepOptions {
  cloneRoot?: string;
  /** Stop looking after this long (the boot sweep is bounded). */
  maxMs?: number;
  /** Delete at most this many refs in one pass. */
  maxDeletes?: number;
  now?: () => number;
}

export interface LocalRefSweepReport {
  deleted: number;
  kept: number;
  /** The deadline or the cap stopped the pass before every clone was looked at. */
  truncated: boolean;
}

/**
 * THE BOOT SWEEP (see the header): every clone's local refs, sequential (git does not scale with
 * concurrency here, clone-hygiene.ts), each clone under its repo lock. A ref is kept when its owner is held
 * now or its kind's keeper keeps the id; a keeper that throws keeps its whole kind (refuse rather than guess).
 * Never throws.
 */
export async function sweepLocalRefs(o: LocalRefSweepOptions = {}): Promise<LocalRefSweepReport> {
  const root = o.cloneRoot ?? config.cloneDir;
  const now = o.now ?? Date.now;
  const deadline = now() + (o.maxMs ?? 30_000);
  const maxDeletes = o.maxDeletes ?? 500;
  const report: LocalRefSweepReport = { deleted: 0, kept: 0, truncated: false };
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return report;
  }
  for (const entry of entries) {
    if (now() > deadline || report.deleted >= maxDeletes) {
      report.truncated = true;
      break;
    }
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, '.git'))) continue;
    } catch {
      continue;
    }
    // `owner__name`: the FIRST `__` splits it (a login has no underscore; a repository name may).
    const split = entry.indexOf('__');
    if (split <= 0) continue;
    const owner = entry.slice(0, split);
    const name = entry.slice(split + 2);
    try {
      await withRepoLock(`${owner}/${name}`, async () => {
        const parsed = lines(await gitOut(dir, ['for-each-ref', '--format=%(refname)', LOCAL_PINNED_REF_PREFIX]))
          .map((ref) => ({ ref, key: parseLocalRef(ref) }))
          .filter((x): x is { ref: string; key: LocalRefKey } => x.key != null);
        if (parsed.length === 0) return;
        const keptIds = new Map<string, ReadonlySet<number> | 'all'>();
        for (const kind of new Set(parsed.map((p) => p.key.kind))) {
          const keeper = keepers.get(kind);
          if (!keeper) continue;
          const ids = [...new Set(parsed.filter((p) => p.key.kind === kind).map((p) => p.key.id))];
          keptIds.set(kind, await keeper(ids).catch(() => 'all' as const));
        }
        for (const p of parsed) {
          const k = keptIds.get(p.key.kind);
          const keep = held.has(ownerKey(p.key.kind, p.key.id)) || k === 'all' || (k != null && k.has(p.key.id));
          if (keep) {
            report.kept += 1;
            continue;
          }
          if (report.deleted >= maxDeletes) {
            report.truncated = true;
            return;
          }
          await gitOut(dir, ['update-ref', '-d', p.ref]).then(
            () => void (report.deleted += 1),
            () => {},
          );
        }
      });
    } catch {
      /* this clone next time */
    }
  }
  return report;
}
