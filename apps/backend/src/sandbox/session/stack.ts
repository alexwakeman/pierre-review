// THE APPROVED STACK LEAVES THE SANDBOX AS COMMITS (docs/STORY-BUILD.md § Plan first → Stacks; docs/SANDBOX.md
// § The plan and its checks → Extraction). After every build turn of a session with an approved plan, each
// repository with planned PRs runs ONE script, as the agent:
//
//   sh -c EXTRACT_STACK_SCRIPT sh <repo dir> <max bundle bytes> <branch 1> [<branch 2> [<branch 3>]]
//
//   1. `refs/limn/base` must exist (the mirror's base commit); each planned branch must exist (`missing`);
//   2. uncommitted work: folded into ONE commit (a throw-away index; the agent's own branch and index are
//      untouched) ONLY when HEAD is the LAST planned branch of the repository. Dirty on another branch is
//      reported (`dirty`), never folded in. A repository with ONE planned PR reads HEAD, as before plans;
//   3. `refs/limn/stack/<k>` = each tip that is not the base; ONE git bundle of them `^refs/limn/base`,
//      base64 on stdout, at most STACK_BUNDLE_MAX_BYTES (over ⇒ `toolarge`, never cut).
//
// ⚠ NOTHING HERE IS TRUSTED: the agent controls the sandbox's refs and even its `git`. The host checks the
// bundle in Limn's own clone cache (coding/story-build/stack-verify.ts) and computes every patch and tree
// itself. The tip lines are only the agent's claim, checked against the bundle.
import type { SandboxRuntime } from '../runtime/types.js';
import { SANDBOX_BASE_REF } from '../workspace/store.js';

/** One repository's bundle (base64 on stdout); past it the repository's PRs fail as too large. */
export const STACK_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
export const STACK_REF_PREFIX = 'refs/limn/stack/';
const MARK = '@@LIMN-STACK@@';
const SHA = /^[0-9a-f]{40}$/;

export const EXTRACT_STACK_SCRIPT = [
  'set -e',
  'cd "$1"',
  'max="$2"',
  'shift 2',
  `git rev-parse -q --verify ${SANDBOX_BASE_REF} >/dev/null || { echo "no base ref" >&2; exit 3; }`,
  `base=$(git rev-parse ${SANDBOX_BASE_REF})`,
  `for r in $(git for-each-ref --format='%(refname)' ${STACK_REF_PREFIX}); do git update-ref -d "$r"; done`,
  'head=$(git symbolic-ref -q --short HEAD || true)',
  'n=$#',
  'idx=$(mktemp /tmp/limn-stack-index.XXXXXX)',
  'bun=$(mktemp /tmp/limn-stack-bundle.XXXXXX)',
  'trap \'rm -f "$idx" "$bun"\' EXIT',
  'GIT_INDEX_FILE="$idx" git read-tree HEAD',
  'GIT_INDEX_FILE="$idx" git add -A',
  'tree=$(GIT_INDEX_FILE="$idx" git write-tree)',
  'dirty=0',
  '[ "$tree" = "$(git rev-parse \'HEAD^{tree}\')" ] || dirty=1',
  'used=0',
  'k=0',
  'refs=""',
  'for b in "$@"; do',
  '  k=$((k + 1))',
  '  onb=0',
  '  if [ "$n" -eq 1 ]; then',
  '    tip=$(git rev-parse HEAD); onb=1',
  '  elif tip=$(git rev-parse -q --verify "refs/heads/$b^{commit}"); then',
  '    [ "$b" != "$head" ] || onb=1',
  '  else',
  `    printf '%s missing\\n%s %s\\n' '${MARK}' "$k" "$b"`,
  '    continue',
  '  fi',
  '  if [ "$dirty" -eq 1 ] && [ "$onb" -eq 1 ]; then',
  '    used=1',
  '    if [ "$k" -eq "$n" ]; then',
  '      tip=$(git commit-tree "$tree" -p "$tip" -m "Changes not committed in the sandbox")',
  '    else',
  `      printf '%s dirty\\n%s %s\\n' '${MARK}' "$k" "$b"`,
  '    fi',
  '  fi',
  `  printf '%s tip\\n%s %s\\n' '${MARK}' "$k" "$tip"`,
  '  if [ "$tip" != "$base" ]; then',
  `    git update-ref "${STACK_REF_PREFIX}$k" "$tip"`,
  `    refs="$refs ${STACK_REF_PREFIX}$k"`,
  '  fi',
  'done',
  `if [ "$dirty" -eq 1 ] && [ "$used" -eq 0 ]; then printf '%s dirty\\n0 %s\\n' '${MARK}' "\${head:-HEAD}"; fi`,
  'if [ -n "$refs" ]; then',
  `  git bundle create -q "$bun" $refs ^${SANDBOX_BASE_REF} >/dev/null 2>&1 || { echo "the bundle could not be made" >&2; exit 5; }`,
  '  size=$(wc -c <"$bun" | tr -d " ")',
  '  if [ "$size" -gt "$max" ]; then',
  `    printf '%s toolarge\\n%s\\n' '${MARK}' "$size"`,
  '  else',
  `    printf '%s bundle\\n' '${MARK}'`,
  '    base64 <"$bun"',
  '  fi',
  'fi',
].join('\n');

export interface StackExtract {
  /** k → the tip the script reported (the agent's claim: the bundle is checked against it). */
  tips: Map<number, string>;
  /** k values whose branch does not exist. */
  missing: Map<number, string>;
  /** Uncommitted work NOT folded in (k = 0: HEAD is on no planned branch). */
  dirty: Array<{ k: number; branch: string }>;
  tooLargeBytes: number | null;
  bundle: Buffer | null;
}

/** EXTRACT_STACK_SCRIPT's stdout. Pure. */
export function parseStackExtract(out: string): StackExtract {
  const r: StackExtract = { tips: new Map(), missing: new Map(), dirty: [], tooLargeBytes: null, bundle: null };
  const re = new RegExp(`^${MARK} (tip|missing|dirty|toolarge|bundle)\\n`, 'gm');
  const marks = [...out.matchAll(re)];
  marks.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    // The bundle is LAST and runs to the end.
    const end = m[1] === 'bundle' ? out.length : (marks[i + 1]?.index ?? out.length);
    const body = out.slice(start, end).trim();
    if (m[1] === 'bundle') {
      const b64 = body.replace(/\s+/g, '');
      if (b64 !== '' && /^[A-Za-z0-9+/=]+$/.test(b64)) r.bundle = Buffer.from(b64, 'base64');
      return;
    }
    if (m[1] === 'toolarge') {
      const n = Number.parseInt(body, 10);
      r.tooLargeBytes = Number.isFinite(n) ? n : STACK_BUNDLE_MAX_BYTES + 1;
      return;
    }
    const sp = body.indexOf(' ');
    const k = Number.parseInt(sp < 0 ? body : body.slice(0, sp), 10);
    const rest = sp < 0 ? '' : body.slice(sp + 1).trim();
    if (!Number.isInteger(k) || k < 0 || k > 3) return;
    if (m[1] === 'tip' && SHA.test(rest)) r.tips.set(k, rest);
    else if (m[1] === 'missing') r.missing.set(k, rest);
    else if (m[1] === 'dirty') r.dirty.push({ k, branch: rest });
  });
  return r;
}

/** One repository's stack out of the sandbox. Throws with one sentence when the script fails. */
export async function extractStack(
  runtime: SandboxRuntime,
  container: string,
  repoPath: string,
  branches: readonly string[],
  o: { maxBundleBytes?: number; timeoutMs?: number } = {},
): Promise<StackExtract> {
  const max = o.maxBundleBytes ?? STACK_BUNDLE_MAX_BYTES;
  const r = await runtime.run(container, ['sh', '-c', EXTRACT_STACK_SCRIPT, 'sh', repoPath, String(max), ...branches], { timeoutMs: o.timeoutMs ?? 180_000 });
  if (r.code !== 0) throw new Error(`Reading the commits in ${repoPath} failed: ${String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
  return parseStackExtract(Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8') : String(r.stdout));
}

/** Resume, stacked: put each stored PR patch back as ONE commit on its own branch, each made from the
 *  previous one, then check out the last. `sh -c RESTORE_STACK sh <repo> <branch> <patch file> <msg file> <first: 1|0>`. */
export const RESTORE_STACK_SCRIPT = [
  'set -e',
  'cd "$1"',
  'if [ "$5" != "1" ]; then git checkout --quiet -B "$2"; fi',
  'if [ -s "$3" ]; then git apply --index --binary "$3"; git commit --quiet --no-verify -F "$4"; fi',
  'rm -f "$3" "$4"',
].join('\n');

export async function restoreStackPr(
  runtime: SandboxRuntime,
  container: string,
  repoPath: string,
  a: { branch: string; patch: string; message: string; first: boolean; n: number },
): Promise<void> {
  const patchFile = `/tmp/limn-restore-stack-${a.n}.patch`;
  const msgFile = `/tmp/limn-restore-stack-${a.n}.msg`;
  await runtime.copyIn(container, [
    { path: patchFile, content: a.patch },
    { path: msgFile, content: a.message },
  ]);
  const r = await runtime.run(container, ['sh', '-c', RESTORE_STACK_SCRIPT, 'sh', repoPath, a.branch, patchFile, msgFile, a.first ? '1' : '0'], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`Putting the stored changes back in ${repoPath} failed: ${String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
}
