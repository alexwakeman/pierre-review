// THE MERGE OF AN AI FIX (docs/SANDBOX.md § AI Fix sessions, "The merge"). When the reader ticks "Resolve
// merge conflicts with <base>" (or dependency automation asks for it), the fix session's agent merges the
// PR's base into the PR branch and resolves the conflicts FIRST, then fixes the other items on top.
//
//   1. HOST, before the mirror (fix.ts `bases`): the base branch's tip and the merge base, from Limn's clone
//      cache, both pinned (`aiFixMergeRef`). The tip is the merge's second parent; it never moves after.
//   2. SANDBOX, after the mirror (fix.ts `afterMirror`): the two commits come in through the mirror seams
//      (`prepare` = the clone cache's depth-1 copy, streamed as a tar), as `refs/limn/merge-target` and
//      `refs/limn/merge-base`. The repository stays SHALLOW: it has the PR head, the base tip and the merge
//      base, each with its whole tree, and no history between them.
//   3. SANDBOX, before the agent starts: Limn starts the merge itself with git's own three-way merge and
//      the EXPLICIT merge base (`git merge-recursive <merge base> -- HEAD <base tip>`: a shallow repository
//      cannot find the base by itself, and the image's git 2.39 has no `merge-tree --merge-base`). The
//      conflicts sit in the index and in the files, `MERGE_HEAD` is the base tip, so the agent's
//      `git commit` makes a MERGE COMMIT whose parents are the PR head and the base tip. A snapshot of
//      git's automatic merge WITH the markers is kept (`refs/limn/auto-merge`): the resolution diff the
//      reader reviews is the merge commit against it.
//   4. SANDBOX, after every build turn: the agent's commits leave as REAL COMMITS — a git bundle of
//      `refs/limn/out ^<PR head> ^<base tip>` — never a flattened patch: GitHub sees conflicts resolved
//      only through a merge commit. The fix ON TOP of the merge is the row's `patch` (merge..out).
//   5. HOST: coding/ai-fix/merge-verify.ts checks the bundle (parents, markers, fixes on top) after every
//      turn and again before Push, then rebuilds the commits from the verified trees and pushes them.
//
// ⚠ A run with the merge item pushes ONLY a VALID merge (`status === 'valid'`). A missing or invalid merge
//   pushes nothing — not even the other fixes, which may depend on it (owner decision 2026-11-07).
import { posix } from 'node:path';
import type { AiFixMerge, AiFixMergeStatus } from '@pierre-review/shared';
import type { SandboxRuntime } from '../runtime/types.js';
import { SANDBOX_HOME } from '../workspace/seed.js';
import { SANDBOX_BASE_REF } from '../workspace/store.js';
import { parseExtractOutput, PatchTooLargeError, type ExtractedPatch } from './patches.js';

/** The report ref of the merge item (FIX.md, the change report). */
export const MERGE_ITEM_REF = 'MERGE';
/** The picker key of the merge item (`AiFixPickerItem.key`). */
export const MERGE_ITEM_KEY = 'conflict:merge';
export const MERGE_TARGET_REF = 'refs/limn/merge-target';
export const MERGE_BASE_REF = 'refs/limn/merge-base';
export const AUTO_MERGE_REF = 'refs/limn/auto-merge';
export const OUT_REF = 'refs/limn/out';
/** The script the agent runs to start the merge again (also what Limn runs at boot). */
export const START_MERGE_FILE = posix.join(SANDBOX_HOME, '.limn', 'start-merge.sh');
/** The bundle Limn keeps (base64 in `ai_fixes.merge_bundle`); past it the merge is invalid, never cut. */
export const MERGE_BUNDLE_MAX_BYTES = 4 * 1024 * 1024;
/** The resolution diff shown to the reader (cut with a note past it). */
export const RESOLUTION_DIFF_MAX_CHARS = 1_000_000;

const SHA = /^[0-9a-f]{40}$/;
const MARK = '@@LIMN-PATCH@@';
const RESOLUTION_FILE = '/tmp/limn-merge-resolution.diff';
const BUNDLE_FILE = '/tmp/limn-merge.bundle';
// In the script: the same two files under `$LIMN_MERGE_OUT` (unset in the sandbox ⇒ /tmp; a host test sets
// its own folder so two test files never share them).
const RES_IN_SCRIPT = '"${LIMN_MERGE_OUT:-/tmp}/limn-merge-resolution.diff"';
const BUNDLE_IN_SCRIPT = '"${LIMN_MERGE_OUT:-/tmp}/limn-merge.bundle"';

/** `ai_fixes.merge_json`. */
export interface FixMergeState {
  baseRef: string;
  baseSha: string;
  mergeBaseSha: string;
  /** The PR head the merge's first parent must be (the session's start). */
  headSha: string;
  conflictedFiles: string[];
  status: AiFixMergeStatus;
  reason: string | null;
  /** The agent's merge commit and the last commit (both in the bundle), once valid. */
  mergeSha: string | null;
  resultSha: string | null;
  resolutionDiff: string | null;
  resolutionFiles: string[];
}

export function readMergeState(raw: unknown): FixMergeState | null {
  if (raw == null || typeof raw !== 'object') return null;
  const v = raw as Partial<FixMergeState>;
  if (typeof v.baseSha !== 'string' || typeof v.baseRef !== 'string' || typeof v.headSha !== 'string') return null;
  return {
    baseRef: v.baseRef,
    baseSha: v.baseSha,
    mergeBaseSha: typeof v.mergeBaseSha === 'string' ? v.mergeBaseSha : '',
    headSha: v.headSha,
    conflictedFiles: Array.isArray(v.conflictedFiles) ? v.conflictedFiles.filter((x): x is string => typeof x === 'string') : [],
    status: v.status === 'valid' || v.status === 'invalid' || v.status === 'missing' ? v.status : 'pending',
    reason: typeof v.reason === 'string' ? v.reason : null,
    mergeSha: typeof v.mergeSha === 'string' ? v.mergeSha : null,
    resultSha: typeof v.resultSha === 'string' ? v.resultSha : null,
    resolutionDiff: typeof v.resolutionDiff === 'string' ? v.resolutionDiff : null,
    resolutionFiles: Array.isArray(v.resolutionFiles) ? v.resolutionFiles.filter((x): x is string => typeof x === 'string') : [],
  };
}

/** The wire shape (`AiFix.merge`). */
export function mergeWire(s: FixMergeState | null): AiFixMerge | null {
  if (s == null) return null;
  return {
    baseRef: s.baseRef,
    baseSha: s.baseSha,
    conflictedFiles: s.conflictedFiles,
    status: s.status,
    reason: s.reason,
    resolutionDiff: s.resolutionDiff,
    resolutionFiles: s.resolutionFiles,
  };
}

/** Does a stored fix hold something Push can send? A run with the merge item: only a VALID merge. */
export function fixRowHasWork(r: { patch?: string | null; mergeJson?: unknown; mergeBundle?: string | null }): boolean {
  const m = readMergeState(r.mergeJson ?? null);
  if (m != null) return m.status === 'valid' && (r.mergeBundle ?? '') !== '';
  return (r.patch ?? '') !== '';
}

// ---- 2. the two commits into the sandbox ------------------------------------------------------------------

/** As the agent: a depth-1 repository's `.git` arrives as a tar on stdin and is fetched in as `$2`. */
export const FETCH_INTO_REPO_SCRIPT = [
  'set -e',
  'repo="$1"; ref="$2"; sha="$3"',
  'tmp=$(mktemp -d /tmp/limn-merge.XXXXXX)',
  'trap \'rm -rf "$tmp"\' EXIT',
  'tar -x --no-same-owner --exclude="._*" -f - -C "$tmp" 2>/tmp/limn-merge-tar.err || { cat /tmp/limn-merge-tar.err >&2; exit 1; }',
  'cd "$repo"',
  `git -c protocol.file.allow=always fetch --quiet --no-tags --no-write-fetch-head --depth 1 "$tmp" "+${SANDBOX_BASE_REF}:$ref"`,
  '[ "$(git rev-parse "$ref")" = "$sha" ] || { echo "The commit did not arrive." >&2; exit 1; }',
  'git rev-parse "$ref"',
].join('\n');

/** A source from the mirror seams (`prepare`), into the PR repository as `ref`. */
export async function fetchCommitIntoSandbox(
  runtime: SandboxRuntime,
  container: string,
  repoPath: string,
  ref: string,
  source: { sha: string; dir: string },
  tarGitDir: (dir: string) => AsyncIterable<Buffer>,
): Promise<void> {
  if (!SHA.test(source.sha)) throw new Error('Not a commit id');
  const h = runtime.exec(container, ['sh', '-c', FETCH_INTO_REPO_SCRIPT, 'sh', repoPath, ref, source.sha], { interactive: true, timeoutMs: 600_000 });
  let stdout = '';
  let stderr = '';
  const drain = (async () => {
    for await (const ev of h.events) {
      if (ev.type === 'stdout') stdout += ev.data.toString('utf8');
      else if (ev.type === 'stderr' && stderr.length < 4000) stderr += ev.data.toString('utf8');
    }
  })();
  try {
    for await (const chunk of tarGitDir(source.dir)) h.write(chunk);
  } catch (err) {
    h.kill();
    await drain.catch(() => {});
    throw err;
  } finally {
    h.end();
  }
  const done = await h.done;
  await drain;
  if (done.code !== 0) throw new Error(`Bringing ${source.sha.slice(0, 7)} into ${repoPath} failed: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
  if (stdout.trim().split('\n').pop() !== source.sha) throw new Error(`Bringing ${source.sha.slice(0, 7)} into ${repoPath} did not reach it.`);
}

// ---- 3. the merge, started by Limn (and again by the agent, from the same file) ---------------------------

/**
 * `sh START_MERGE_FILE <repo> <base label>`: git's three-way merge with the EXPLICIT merge base, the
 * conflicts left in the index and the files, `MERGE_HEAD` set; then the snapshot of the automatic merge.
 * Prints the files in conflict. Refuses unless HEAD is the PR head with a clean tree.
 */
export const START_MERGE_SCRIPT = [
  '#!/bin/sh',
  '# Limn: start the merge of the pull request\'s base into its branch. Run: sh <this file> <repository> <base name>',
  'set -e',
  'cd "$1"',
  'label="${2:-the base}"',
  `target=$(git rev-parse -q --verify '${MERGE_TARGET_REF}^{commit}') || { echo "Limn: the base commit is missing." >&2; exit 3; }`,
  `git rev-parse -q --verify '${MERGE_BASE_REF}^{commit}' >/dev/null || { echo "Limn: the merge base is missing." >&2; exit 3; }`,
  'gd=$(git rev-parse --git-dir)',
  `again="To start again: git reset --hard ${SANDBOX_BASE_REF} && sh ${START_MERGE_FILE} $1 $label"`,
  '[ ! -f "$gd/MERGE_HEAD" ] || { echo "Limn: a merge is in progress already. $again" >&2; exit 4; }',
  `[ "$(git rev-parse HEAD)" = "$(git rev-parse ${SANDBOX_BASE_REF})" ] || { echo "Limn: HEAD is not the pull request's head. $again" >&2; exit 4; }`,
  '{ git diff --quiet && git diff --cached --quiet; } || { echo "Limn: there are uncommitted changes. $again" >&2; exit 4; }',
  'set +e',
  `env "GITHEAD_$target=$label" git merge-recursive ${MERGE_BASE_REF} -- HEAD "$target" >"$gd/limn-merge.log" 2>&1`,
  'rc=$?',
  'set -e',
  '[ $rc -le 1 ] || { cat "$gd/limn-merge.log" >&2; exit 5; }',
  'printf \'%s\\n\' "$target" >"$gd/MERGE_HEAD"',
  'printf \'Merge %s into the pull request\\n\' "$label" >"$gd/MERGE_MSG"',
  ': >"$gd/MERGE_MODE"',
  // The automatic merge, markers and all, for the resolution diff (a throw-away index; the agent's is kept).
  'idx=$(mktemp /tmp/limn-auto.XXXXXX)',
  'trap \'rm -f "$idx"\' EXIT',
  'GIT_INDEX_FILE="$idx" git read-tree HEAD',
  'GIT_INDEX_FILE="$idx" git add -A',
  't=$(GIT_INDEX_FILE="$idx" git write-tree)',
  `git update-ref ${AUTO_MERGE_REF} "$(git commit-tree "$t" -p HEAD -m "Limn: git's automatic merge, with the conflict markers")"`,
  'git diff --name-only --diff-filter=U',
].join('\n');

/** Boot: copy the script in and start the merge. Returns the files in conflict. */
export async function startMergeInSandbox(
  runtime: SandboxRuntime,
  container: string,
  repoPath: string,
  baseLabel: string,
): Promise<string[]> {
  await runtime.copyIn(container, [{ path: START_MERGE_FILE, content: START_MERGE_SCRIPT, mode: 0o755 }]);
  const r = await runtime.run(container, ['sh', START_MERGE_FILE, repoPath, baseLabel], { timeoutMs: 300_000 });
  if (r.code !== 0) throw new Error(`Starting the merge failed: ${String(r.stderr).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  return String(r.stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 1000);
}

/** Resume: the stored commits back into a fresh clone (the base and the merge base are in already). */
export const RESTORE_BUNDLE_SCRIPT = [
  'set -e',
  'cd "$1"',
  `git fetch --quiet --no-tags --no-write-fetch-head "$2" "+${OUT_REF}:refs/limn/restored"`,
  'git reset --quiet --hard refs/limn/restored',
  'rm -f "$2"',
  'git rev-parse HEAD',
].join('\n');

export async function restoreMergeBundle(runtime: SandboxRuntime, container: string, repoPath: string, bundle: Buffer): Promise<void> {
  const file = '/tmp/limn-restore.bundle';
  await runtime.copyIn(container, [{ path: file, content: bundle }]);
  const r = await runtime.run(container, ['sh', '-c', RESTORE_BUNDLE_SCRIPT, 'sh', repoPath, file], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`Putting the stored merge back in ${repoPath} failed: ${String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
}

// ---- 4. after a build turn: the commits out ----------------------------------------------------------------

/**
 * As the agent: `refs/limn/out` = HEAD, plus ONE commit over any uncommitted change (a throw-away index:
 * the agent's own index and branch are untouched); the merge commit = the oldest merge on the first-parent
 * line since the PR head; the fix = merge..out (or base..out with no merge). Writes the resolution diff and
 * the bundle to /tmp for the two reads after it. The patch section is LAST (patches.ts parser).
 */
export const EXTRACT_MERGE_SCRIPT = [
  'set -e',
  'cd "$1"',
  `for r in ${SANDBOX_BASE_REF} ${MERGE_TARGET_REF}; do git rev-parse -q --verify "$r" >/dev/null || { echo "no $r" >&2; exit 3; }; done`,
  'gd=$(git rev-parse --git-dir)',
  'merging=0; [ ! -f "$gd/MERGE_HEAD" ] || merging=1',
  `rm -f ${RES_IN_SCRIPT} ${BUNDLE_IN_SCRIPT}`,
  'idx=$(mktemp /tmp/limn-index.XXXXXX)',
  'trap \'rm -f "$idx"\' EXIT',
  'GIT_INDEX_FILE="$idx" git read-tree HEAD',
  'GIT_INDEX_FILE="$idx" git add -A',
  'tree=$(GIT_INDEX_FILE="$idx" git write-tree)',
  'out=$(git rev-parse HEAD)',
  'if [ "$tree" != "$(git rev-parse "HEAD^{tree}")" ]; then out=$(git commit-tree "$tree" -p HEAD -m "Changes not committed in the sandbox"); fi',
  `git update-ref ${OUT_REF} "$out"`,
  `merge=$(git rev-list --first-parent --merges ${OUT_REF} ^${SANDBOX_BASE_REF} | tail -n 1)`,
  `from=${SANDBOX_BASE_REF}`,
  'if [ -n "$merge" ]; then from="$merge"; fi',
  `printf '%s merging\\n%s\\n' '${MARK}' "$merging"`,
  `printf '%s out\\n%s\\n' '${MARK}' "$out"`,
  `printf '%s merge\\n%s\\n' '${MARK}' "$merge"`,
  `printf '%s resolution-files\\n' '${MARK}'`,
  `if [ -n "$merge" ] && git rev-parse -q --verify ${AUTO_MERGE_REF} >/dev/null; then`,
  `  git diff --name-only --no-renames ${AUTO_MERGE_REF} "$merge"`,
  `  git diff --no-renames --no-ext-diff --no-color ${AUTO_MERGE_REF} "$merge" >${RES_IN_SCRIPT}`,
  'fi',
  'if [ -n "$merge" ]; then',
  `  git bundle create -q ${BUNDLE_IN_SCRIPT} ${OUT_REF} ^${SANDBOX_BASE_REF} ^${MERGE_TARGET_REF}`,
  'fi',
  `printf '%s commits\\n' '${MARK}'`,
  `git rev-list --count "$from..${OUT_REF}"`,
  `printf '%s numstat\\n' '${MARK}'`,
  `git diff --numstat --no-renames "$from" ${OUT_REF}`,
  `printf '%s messages\\n' '${MARK}'`,
  `git log --reverse --format='%B%x1e' "$from..${OUT_REF}"`,
  `printf '%s patch\\n' '${MARK}'`,
  `git diff --binary --no-renames "$from" ${OUT_REF}`,
].join('\n');

/** Reads one /tmp file out (at most `max + 1` bytes) and removes it. */
export const READ_OUT_SCRIPT = 'f="$1"; [ -f "$f" ] || exit 4; head -c "$2" "$f"; rm -f "$f"';

export interface MergeExtract {
  /** A merge was started and not committed (`MERGE_HEAD` still there). */
  merging: boolean;
  outSha: string | null;
  mergeSha: string | null;
  resolutionFiles: string[];
  /** The fix ON TOP of the merge (or on the PR head, with no merge). */
  fix: ExtractedPatch;
}

/** EXTRACT_MERGE_SCRIPT's stdout. Pure. */
export function parseMergeExtract(out: string): MergeExtract {
  const re = new RegExp(`^${MARK} (merging|out|merge|resolution-files|commits)\\n`, 'gm');
  const marks = [...out.matchAll(re)];
  const sec = new Map<string, string>();
  marks.forEach((m, i) => {
    if (m[1] === 'commits') return;
    const start = (m.index ?? 0) + m[0].length;
    const end = marks[i + 1]?.index ?? out.length;
    if (!sec.has(m[1]!)) sec.set(m[1]!, out.slice(start, end));
  });
  const one = (k: string): string => (sec.get(k) ?? '').trim();
  const sha = (k: string): string | null => (SHA.test(one(k)) ? one(k) : null);
  return {
    merging: one('merging') === '1',
    outSha: sha('out'),
    mergeSha: sha('merge'),
    resolutionFiles: (sec.get('resolution-files') ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 1000),
    fix: parseExtractOutput(out),
  };
}

export async function extractMergeTurn(
  runtime: SandboxRuntime,
  container: string,
  repoPath: string,
  opts: { maxPatchBytes: number },
): Promise<MergeExtract & { resolutionDiff: string | null; bundle: Buffer | null; bundleTooLarge: boolean }> {
  const r = await runtime.run(container, ['sh', '-c', EXTRACT_MERGE_SCRIPT, 'sh', repoPath], { timeoutMs: 180_000 });
  if (r.code !== 0) throw new Error(`Reading the changes in ${repoPath} failed: ${String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
  const got = parseMergeExtract(Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8') : String(r.stdout));
  const bytes = Buffer.byteLength(got.fix.patch, 'utf8');
  if (bytes > opts.maxPatchBytes) throw new PatchTooLargeError(bytes, opts.maxPatchBytes);
  if (got.mergeSha == null) return { ...got, resolutionDiff: null, bundle: null, bundleTooLarge: false };
  const read = async (file: string, max: number): Promise<Buffer | null> => {
    const x = await runtime.run(container, ['sh', '-c', READ_OUT_SCRIPT, 'sh', file, String(max + 1)], { timeoutMs: 120_000 });
    if (x.code !== 0) return null;
    return Buffer.isBuffer(x.stdout) ? x.stdout : Buffer.from(String(x.stdout), 'binary');
  };
  const res = await read(RESOLUTION_FILE, RESOLUTION_DIFF_MAX_CHARS * 4);
  let resolutionDiff = res == null ? null : res.toString('utf8');
  if (resolutionDiff != null && resolutionDiff.length > RESOLUTION_DIFF_MAX_CHARS) {
    resolutionDiff = `${resolutionDiff.slice(0, RESOLUTION_DIFF_MAX_CHARS)}\n… (cut: the resolution is longer than Limn shows)\n`;
  }
  const bundle = await read(BUNDLE_FILE, MERGE_BUNDLE_MAX_BYTES);
  const tooLarge = bundle != null && bundle.length > MERGE_BUNDLE_MAX_BYTES;
  return { ...got, resolutionDiff, bundle: tooLarge ? null : bundle, bundleTooLarge: tooLarge };
}

/** The FIX.md item block's body for the merge (review seeds; the plain seed names it in its text). */
export function mergeItemBody(baseRef: string): string {
  return `Merge \`${baseRef}\` into this pull request and resolve the merge conflicts. FIX.md, section "First: the merge conflicts", says how. Do this before any other item.`;
}
