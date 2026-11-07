// THE RESULT LEAVES AS A PATCH (docs/SANDBOX.md § Sessions; plan invariant 1). After every build-mode
// turn, each repository's work is read OUT of the sandbox as ONE binary-safe unified diff against the
// commit the session started from (`refs/limn/base`, mirror.ts), and stored exactly where the old build
// stored its patch (`story_build_repos.patch`), so the EXISTING diff view and Push work unchanged: Push
// applies it with `git apply --3way` on a fresh host worktree at `base_sha` and makes ONE commit.
//
//   • commits AND uncommitted edits both count: the agent may commit on the branch or not;
//   • the agent's own index is never touched — a THROW-AWAY index (`GIT_INDEX_FILE`) takes `git add -A`
//     (the repository's .gitignore applies, so build output stays out);
//   • the commit messages the agent wrote become the commit message Push uses;
//   • a patch past the cap is refused (the row says so), never cut.
//
// Resume (a closed session booted again) applies a stored patch back onto the fresh clone and commits it,
// so the next extraction diffs against the same base and gives the same patch plus the new work.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { SandboxRepoStat } from '@pierre-review/shared';
import type { SandboxRuntime } from '../runtime/types.js';
import { SANDBOX_BASE_REF } from '../workspace/mirror.js';

const MARK = '@@LIMN-PATCH@@';

/** Runs as the agent inside the sandbox: `sh -c EXTRACT sh <repo dir>`. */
export const EXTRACT_SCRIPT = [
  'set -e',
  'cd "$1"',
  `git rev-parse --verify --quiet ${SANDBOX_BASE_REF} >/dev/null || { echo "no base ref" >&2; exit 3; }`,
  'idx=$(mktemp /tmp/limn-index.XXXXXX)',
  'trap \'rm -f "$idx"\' EXIT',
  'export GIT_INDEX_FILE="$idx"',
  'git read-tree HEAD',
  'git add -A',
  `printf '%s commits\\n' '${MARK}'`,
  `git rev-list --count ${SANDBOX_BASE_REF}..HEAD`,
  `printf '%s numstat\\n' '${MARK}'`,
  `git diff --cached --numstat --no-renames ${SANDBOX_BASE_REF}`,
  `printf '%s messages\\n' '${MARK}'`,
  `git log --reverse --format='%B%x1e' ${SANDBOX_BASE_REF}..HEAD`,
  `printf '%s patch\\n' '${MARK}'`,
  `git diff --cached --binary ${SANDBOX_BASE_REF}`,
].join('\n');

export interface ExtractedPatch {
  /** '' when the repository has no change. */
  patch: string;
  sha: string | null;
  filesChanged: string[];
  stat: SandboxRepoStat;
  /** The agent's commit messages, folded into one (null when it made no commit). */
  commitMessage: string | null;
}

/** numstat → files and line counts. A binary file (`-\t-\tpath`) counts as a file with no lines. */
function parseNumstat(text: string): { files: string[]; insertions: number; deletions: number } {
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    if (m[1] !== '-') insertions += Number(m[1]);
    if (m[2] !== '-') deletions += Number(m[2]);
    files.push(unquote(m[3]!));
  }
  return { files, insertions, deletions };
}

/** git's C-quoted path (`"a\tb.txt"`) → the path. */
function unquote(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  try {
    return JSON.parse(p.replace(/\\([0-7]{3})/g, (_m, o: string) => `\\u00${Number.parseInt(o, 8).toString(16).padStart(2, '0')}`)) as string;
  } catch {
    return p.slice(1, -1);
  }
}

/** The commit message Push will use: one commit's message as written; several as the first subject
 *  followed by every subject as a list. Pure. */
export function foldCommitMessages(raw: string): string | null {
  const msgs = raw
    .split('\x1e')
    .map((m) => m.trim())
    .filter(Boolean);
  if (msgs.length === 0) return null;
  if (msgs.length === 1) return msgs[0]!.slice(0, 2_000);
  const subjects = msgs.map((m) => m.split('\n')[0]!.trim());
  return [subjects[0]!, '', ...subjects.map((s) => `- ${s}`)].join('\n').slice(0, 2_000);
}

/** The extraction script's stdout → the patch and its numbers. Pure. */
export function parseExtractOutput(out: string): ExtractedPatch {
  const sections = new Map<string, string>();
  const re = new RegExp(`^${MARK} (commits|numstat|messages|patch)\\n`, 'gm');
  const marks = [...out.matchAll(re)];
  marks.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    // The patch is LAST and runs to the end: a marker-looking line inside it is the patch's own.
    const end = m[1] === 'patch' ? out.length : (marks[i + 1]?.index ?? out.length);
    if (!sections.has(m[1]!)) sections.set(m[1]!, out.slice(start, end));
  });
  if (!sections.has('patch')) throw new Error('The patch could not be read from the sandbox.');
  const patch = sections.get('patch') ?? '';
  const ns = parseNumstat(sections.get('numstat') ?? '');
  const commits = Number.parseInt((sections.get('commits') ?? '0').trim(), 10);
  return {
    patch,
    sha: patch === '' ? null : createHash('sha256').update(patch).digest('hex'),
    filesChanged: ns.files,
    stat: { files: ns.files.length, insertions: ns.insertions, deletions: ns.deletions, commits: Number.isFinite(commits) ? commits : 0 },
    commitMessage: foldCommitMessages(sections.get('messages') ?? ''),
  };
}

export class PatchTooLargeError extends Error {
  constructor(readonly bytes: number, readonly max: number) {
    super(`The change is ${(bytes / 1024 / 1024).toFixed(1)} MB, more than the ${(max / 1024 / 1024).toFixed(0)} MB Limn keeps.`);
    this.name = 'PatchTooLargeError';
  }
}

/** One repository's work, out of the sandbox. */
export async function extractRepoPatch(
  runtime: SandboxRuntime,
  container: string,
  repoPath: string,
  opts: { maxBytes: number; timeoutMs?: number },
): Promise<ExtractedPatch> {
  const r = await runtime.run(container, ['sh', '-c', EXTRACT_SCRIPT, 'sh', repoPath], { timeoutMs: opts.timeoutMs ?? 120_000 });
  if (r.code !== 0) throw new Error(`Reading the changes in ${repoPath} failed: ${r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
  const out = r.stdout.toString('utf8');
  const got = parseExtractOutput(out);
  const bytes = Buffer.byteLength(got.patch, 'utf8');
  if (bytes > opts.maxBytes) throw new PatchTooLargeError(bytes, opts.maxBytes);
  return got;
}

/** Runs as the agent: `sh -c RESTORE sh <repo dir> <patch file> <message file>`. */
export const RESTORE_SCRIPT = [
  'set -e',
  'cd "$1"',
  'git apply --index --binary "$2"',
  'git commit --quiet --no-verify -F "$3"',
  'rm -f "$2" "$3"',
].join('\n');

/** Put a stored patch back onto a fresh clone (Resume), as ONE commit on the session branch. */
export async function restoreRepoPatch(
  runtime: SandboxRuntime,
  container: string,
  repoPath: string,
  patch: string,
  message: string,
  n: number,
): Promise<void> {
  const patchFile = posix.join('/tmp', `limn-restore-${n}.patch`);
  const msgFile = posix.join('/tmp', `limn-restore-${n}.msg`);
  await runtime.copyIn(container, [
    { path: patchFile, content: patch },
    { path: msgFile, content: message },
  ]);
  const r = await runtime.run(container, ['sh', '-c', RESTORE_SCRIPT, 'sh', repoPath, patchFile, msgFile], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`Putting the stored changes back in ${repoPath} failed: ${r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
}
