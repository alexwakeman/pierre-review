import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type {
  ConflictDecision,
  ConflictFileContent,
  ConflictFileEntry,
  ConflictLandStrategy,
  ConflictPreparePhase,
  ConflictRegion,
  ConflictUnsupportedReason,
  ConflictWandSuggestion,
} from '@pierre-review/shared';
import { config } from '../config.js';
import { getAccessToken } from '../auth/account.js';
import { db, schema } from '../db/client.js';
import { hasConflictMarkers } from '../coding/merge.js';
import { fetchPrHeadInfo } from '../github/mutations.js';
import {
  cleanupCloneCache,
  ensureClone,
  fetchRefIntoClone,
  withRepoLock,
} from '../review/clone-manager.js';
import { gitSupportsMergeTree, gitTry } from './git.js';
import { diffTokens, threeWayChunks } from './diff.js';
import type { ThreeWayRegion } from './diff.js';
import { parseMergeTree, stripMangledSuffix } from './parse.js';
import type { MergeTreeMessage, MergeTreeStage } from './parse.js';
import { regionFingerprint } from './hash.js';
import {
  TokenInterner,
  internAll,
  isWhitespaceToken,
  splitLines,
  tokenizeWords,
} from './tokens.js';
import type {
  ConflictModel,
  ConflictModelFile,
  ConflictModelRegion,
  ConflictModelResult,
} from './model-types.js';

const { pullRequests, repos } = schema;

/**
 * THE CONFLICT MODEL BUILDER.
 *
 * ⚠ NO WORKTREE. NONE, ANYWHERE, AT ANY PHASE. `merge-tree --write-tree` performs a full
 * three-way merge with no index and no working tree, every other command here is
 * worktree-free, and the oracle runs `merge-file` in `os.tmpdir()` over three loose files.
 * That makes the resolver immune to the worktree defect classes rather than dependent on
 * their fix, and it is why a session costs nothing to hold open.
 *
 * ⚠ NO GIT 2.40+ FLAGS. No `merge-tree --merge-base=`, no `-X ours|theirs`, no
 * `merge-file --object-id`. v1 is local-only and the dev machine is on 2.54, but the cloud
 * image is 2.39.5 where all three exit 129 — a later port must not be a rewrite. The one
 * version floor we do have is 2.38 for `--write-tree`, probed once and refused as
 * `git_too_old` at the open route.
 *
 * The lock is held for the GIT phase only (seconds; merge-tree itself is 17ms). The oracle
 * and the region folding hold nothing.
 */

/** Above this, listing the files is not help — it is a wall of text. Distinct from
 *  `conflictMaxFiles`, which degrades the extras to `budget_exhausted` and still lists them. */
const HARD_CONFLICTED_PATH_CEILING = 1000;

/** `git fetch` takes the oids as argv, so they go in batches rather than one 2000-arg line. */
const PREFETCH_BATCH = 200;

/* ═════════════════════════════ the UTF-8 gate ═════════════════════════════ */

// `ignoreBOM: true` KEEPS a leading U+FEFF as a character instead of swallowing it, so the
// re-encode at land time writes the same bytes back. Dropping it would silently strip the BOM
// from every file that has one.
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Strict decode, or nothing.
 *
 * ⚠ `Buffer.includes(0)` IS NOT SUFFICIENT to call something text. `[63 61 66 e9 0a]` — "caf"
 * plus a Latin-1 é — has no NUL, so a naive check calls it text; `.toString('utf8')` yields
 * `caf�` and re-encoding writes `EF BF BD`. That corrupts the WHOLE file, not just the
 * region the user touched, because the land path replaces the entire path with the fold
 * output. We refuse rather than guess an encoding.
 */
export function decodeStrict(buf: Buffer): string | null {
  try {
    return STRICT_UTF8.decode(buf);
  } catch {
    return null;
  }
}

/* ═════════════════════════════ classification ═════════════════════════════ */

/** The label under an unresolvable file. A NOUN PHRASE — no instruction, no full stop. The
 *  panel states "N files need resolving on GitHub." once, above the list. */
export const UNSUPPORTED_LABELS: Record<ConflictUnsupportedReason, string> = {
  binary: 'Binary file',
  submodule: 'Submodule',
  symlink: 'Symlink',
  file_directory: 'A directory of the same name',
  rename_rename: 'Renamed differently on each side',
  rename_delete: 'Renamed on one side, deleted on the other',
  modify_delete: 'Changed on one side, deleted on the other',
  mode_change: 'File mode changed',
  not_text: 'Not UTF-8 text',
  too_large: 'Too large to resolve here',
  too_many_conflicts: 'Too many conflicts to resolve here',
  no_common_ancestor: 'No common ancestor',
  engine_disagreement: 'Git splits this file differently',
  budget_exhausted: 'Past this session’s limit',
};

/** Everything merge-tree said about ONE path. */
interface PathRecords {
  rawPath: string;
  stages: Map<1 | 2 | 3, MergeTreeStage>;
  types: Set<string>;
  relatedRaw: Set<string>;
}

const REGULAR_MODES = new Set(['100644', '100755']);

/**
 * Classify a path from merge-tree's records.
 *
 * ⚠ PRECEDENCE-ORDERED OVER ALL RECORDS FOR THE PATH, NEVER A FIRST MATCH. A binary conflict
 * emits BOTH `CONFLICT (binary)` and `CONFLICT (contents)`; a gitlink emits both
 * `CONFLICT (submodule not initialized)` and `CONFLICT (contents)`. Taking the first record
 * wins the race for whichever git happened to print first, and a binary file classified as
 * text is a file we would offer to rewrite as UTF-8.
 *
 * Returns `null` for "text, resolvable here" — the blob-level NUL and UTF-8 checks happen
 * afterwards, once the bytes are in hand.
 */
export function classifyPath(rec: PathRecords): ConflictUnsupportedReason | null {
  const modes = [...rec.stages.values()].map((s) => s.mode);
  if (modes.includes('160000')) return 'submodule';
  if (rec.types.has('CONFLICT (binary)')) return 'binary';
  if (rec.types.has('CONFLICT (distinct modes)') || modes.includes('120000')) return 'symlink';
  if (rec.types.has('CONFLICT (file/directory)')) return 'file_directory';
  if (rec.types.has('CONFLICT (rename/rename)')) return 'rename_rename';
  if (rec.types.has('CONFLICT (rename/delete)')) return 'rename_delete';
  if (rec.types.has('CONFLICT (modify/delete)')) return 'modify_delete';

  const s2 = rec.stages.get(2);
  const s3 = rec.stages.get(3);
  if (s2 && s3 && s2.mode !== s3.mode) {
    return REGULAR_MODES.has(s2.mode) && REGULAR_MODES.has(s3.mode) ? 'mode_change' : 'symlink';
  }
  if (!s2 || !s3) return 'modify_delete';
  if (!rec.types.has('CONFLICT (contents)')) return 'engine_disagreement';
  if (!REGULAR_MODES.has(s2.mode)) return 'symlink';
  // An ADD/ADD carries stages 2 and 3 with NO stage 1 (git types it `CONFLICT (contents)`
  // and words the message `CONFLICT (add/add)`). We could model it with an empty base, but
  // then "keep the ancestor" means DELETE THE FILE, offered as a plain third button beside
  // the two versions. It is refused by name instead.
  const s1 = rec.stages.get(1);
  if (!s1) return 'no_common_ancestor';
  return null;
}

/* ═════════════════════════════ the wand ═════════════════════════════ */

export interface DisjointMerge {
  lines: string[];
}

/**
 * The wand's word-level merge for ONE contested region: the same three-way chunker, run over
 * word tokens instead of lines.
 *
 * The disjointness bar, and every clause of it earns its place:
 *  • no `conflict` chunk at word grain — the two edits must not touch the same words;
 *  • between two consecutive changed chunks of OPPOSITE sides, the intervening stable run
 *    must hold at least one NON-WHITESPACE token. `foo(a, b)` with one side on `a` and one
 *    on `b` is disjoint; `foo bar` is not — a single space is not evidence two authors were
 *    working on different things;
 *  • neither word diff exceeded its budget, and the token count is under the cap.
 *
 * Then three mechanical checks before we hand back a merge: no conflict marker survived,
 * every changed run is present in order, every stable run is unchanged. Returns null on any
 * failure — the region simply gets no wand, which is the safe outcome.
 */
export function disjointWordMerge(
  baseText: string,
  oursText: string,
  theirsText: string,
): DisjointMerge | null {
  const baseTok = tokenizeWords(baseText);
  const oursTok = tokenizeWords(oursText);
  const theirsTok = tokenizeWords(theirsText);
  const total = baseTok.length + oursTok.length + theirsTok.length;
  if (total > config.conflictWordTokenCap) return null;

  const interner = new TokenInterner();
  const b = internAll(baseTok, interner);
  const o = internAll(oursTok, interner);
  const t = internAll(theirsTok, interner);

  const oursDiff = diffTokens(b, o, config.conflictWordDiffMaxD);
  const theirsDiff = diffTokens(b, t, config.conflictWordDiffMaxD);
  if (!oursDiff || !theirsDiff) return null;

  const chunks = threeWayChunks(b, o, t, oursDiff, theirsDiff);
  if (chunks.some((c) => c.kind === 'conflict')) return null;

  // The "opposite sides need real evidence between them" rule.
  let lastChangedSide: 'ours' | 'theirs' | null = null;
  let stableSinceLastChange: string[] = [];
  for (const c of chunks) {
    if (c.kind === 'unchanged') {
      stableSinceLastChange.push(...baseTok.slice(c.baseStart, c.baseEnd));
      continue;
    }
    const side =
      c.kind === 'ours_only' ? 'ours' : c.kind === 'theirs_only' ? 'theirs' : 'both';
    if (side === 'both') {
      // `both_same` needs no separation argument: neither author is being overruled.
      lastChangedSide = null;
      stableSinceLastChange = [];
      continue;
    }
    if (lastChangedSide && lastChangedSide !== side) {
      if (!stableSinceLastChange.some((tok) => !isWhitespaceToken(tok))) return null;
    }
    lastChangedSide = side;
    stableSinceLastChange = [];
  }

  // Assemble, then verify the assembly independently of the loop that produced it.
  const merged: string[] = [];
  const expected: string[][] = [];
  for (const c of chunks) {
    const run =
      c.kind === 'theirs_only'
        ? theirsTok.slice(c.theirsStart, c.theirsEnd)
        : c.kind === 'unchanged'
          ? baseTok.slice(c.baseStart, c.baseEnd)
          : oursTok.slice(c.oursStart, c.oursEnd);
    expected.push(run);
    merged.push(...run);
  }

  let pos = 0;
  for (const run of expected) {
    for (const tok of run) {
      if (merged[pos] !== tok) return null;
      pos++;
    }
  }
  if (pos !== merged.length) return null;

  const mergedText = merged.join('');
  // `MARKER_RE` deliberately ignores a bare `=======`, which real markdown contains.
  if (hasConflictMarkers(mergedText)) return null;

  return { lines: splitLines(mergedText).lines };
}

/* ═════════════════════════════ per-file region building ═════════════════════════════ */

export interface FileRegionsResult {
  regions: ConflictModelRegion[];
  /** Set when a cap or a check refused this file. */
  unsupported: ConflictUnsupportedReason | null;
}

/**
 * Build the region list for ONE text file from its three decoded sides.
 *
 * A diff that runs out of budget degrades this file to ONE conflict spanning everything —
 * honest and still resolvable, rather than a wrong split.
 */
export function buildFileRegions(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): FileRegionsResult {
  const interner = new TokenInterner();
  const b = internAll(baseLines, interner);
  const o = internAll(oursLines, interner);
  const t = internAll(theirsLines, interner);

  const oursDiff = diffTokens(b, o, config.conflictDiffMaxD);
  const theirsDiff = diffTokens(b, t, config.conflictDiffMaxD);

  let chunks: ThreeWayRegion[];
  if (!oursDiff || !theirsDiff) {
    chunks = [
      {
        kind: 'conflict',
        baseStart: 0,
        baseEnd: baseLines.length,
        oursStart: 0,
        oursEnd: oursLines.length,
        theirsStart: 0,
        theirsEnd: theirsLines.length,
      },
    ];
  } else {
    chunks = threeWayChunks(b, o, t, oursDiff, theirsDiff);
  }

  const conflictCount = chunks.filter((c) => c.kind === 'conflict').length;
  if (conflictCount > config.conflictMaxRegions) {
    return { regions: [], unsupported: 'too_many_conflicts' };
  }

  const regions: ConflictModelRegion[] = chunks.map((c, i) => {
    const base = baseLines.slice(c.baseStart, c.baseEnd);
    // ⚠ On `unchanged`, ours and theirs are EMPTY — not copies of base. Three copies of every
    // untouched line is what turns a 30-file conflict into a multi-megabyte model, and the
    // fold reads `base` there anyway. Their LENGTHS are still recoverable from base, which is
    // what the per-side line numbering and the oracle walk rely on.
    const ours = c.kind === 'unchanged' ? [] : oursLines.slice(c.oursStart, c.oursEnd);
    const theirs = c.kind === 'unchanged' ? [] : theirsLines.slice(c.theirsStart, c.theirsEnd);
    const wandAndMerge = wandFor(c.kind, base, ours, theirs);
    return {
      id: i + 1,
      kind: c.kind,
      base,
      ours,
      theirs,
      fingerprint: regionFingerprint(base, ours, theirs),
      wand: wandAndMerge.wand,
      mergedLines: wandAndMerge.mergedLines,
    };
  });

  return { regions, unsupported: null };
}

function wandFor(
  kind: ThreeWayRegion['kind'],
  base: string[],
  ours: string[],
  theirs: string[],
): { wand: ConflictWandSuggestion | null; mergedLines: string[] | null } {
  switch (kind) {
    case 'unchanged':
      return { wand: null, mergedLines: null };
    case 'ours_only':
      return { wand: { decision: 'ours', reason: 'only_ours' }, mergedLines: null };
    case 'theirs_only':
      return { wand: { decision: 'theirs', reason: 'only_theirs' }, mergedLines: null };
    case 'both_same':
      return { wand: { decision: 'ours', reason: 'both_same' }, mergedLines: null };
    case 'conflict': {
      // Computed EAGERLY for every contested region: it is pure CPU over strings already in
      // memory, it is what the wand button keys on, and a lazy second path could disagree
      // with the first.
      const merged = disjointWordMerge(
        joinRegion(base),
        joinRegion(ours),
        joinRegion(theirs),
      );
      if (!merged) return { wand: null, mergedLines: null };
      return {
        wand: { decision: 'disjoint_merge', reason: 'disjoint_words' },
        mergedLines: merged.lines,
      };
    }
  }
}

/** A region's lines as one string for the word pass. The trailing newline is deliberate: it
 *  keeps line boundaries as real tokens, so a word-level merge cannot silently join two
 *  lines that were separate on both sides. */
function joinRegion(lines: readonly string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/* ═════════════════════════════ the oracle ═════════════════════════════ */

export interface LineRange {
  start: number;
  end: number;
}

/**
 * Parse `git merge-file -p --diff3` output into the OURS-side ranges git contested.
 *
 * ⚠ POSITIONS, NOT COUNTS. `merge-file`'s exit status is the conflict count CAPPED AT 127, so
 * a file with 200 contested regions reports 127 and a count comparison silently passes.
 *
 * The ours section of each block is verbatim ours text, so each block is located by searching
 * ours FORWARD from the previous block's end — monotonic, and a block we cannot place is a
 * refusal rather than a guess. An empty ours section (both sides added at the same point) is
 * an insertion point, recorded as a zero-length range at the cursor.
 */
export function oracleConflictRanges(
  mergedText: string,
  oursLines: string[],
  oursFinalNewline = true,
): LineRange[] | null {
  const out: LineRange[] = [];
  const lines = splitLines(mergedText).lines;
  let cursor = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.startsWith('<<<<<<<')) {
      i++;
      continue;
    }
    i++;
    const oursSection: string[] = [];
    while (i < lines.length && !(lines[i] as string).startsWith('|||||||')) {
      oursSection.push(lines[i] as string);
      i++;
    }
    // Skip the base and theirs sections; only the ours side is used for placement.
    while (i < lines.length && !(lines[i] as string).startsWith('>>>>>>>')) i++;
    if (i >= lines.length) return null; // unterminated block — refuse rather than guess
    i++;

    if (oursSection.length === 0) {
      out.push({ start: cursor, end: cursor });
      continue;
    }
    const at = findSequence(oursLines, oursSection, cursor, oursFinalNewline);
    if (at < 0) return null;
    out.push({ start: at, end: at + oursSection.length });
    cursor = at + oursSection.length;
  }
  return out;
}

function findSequence(
  haystack: string[],
  needle: string[],
  from: number,
  haystackFinalNewline: boolean,
): number {
  outer: for (let s = from; s + needle.length <= haystack.length; s++) {
    for (let k = 0; k < needle.length; k++) {
      if (!lineMatches(haystack, s + k, needle[k] as string, haystackFinalNewline)) {
        continue outer;
      }
    }
    return s;
  }
  return -1;
}

/**
 * ⚠ `merge-file` RE-TERMINATES a file that ended without a newline, and on a CRLF file the
 * terminator it adds is `\r\n` — so ours' final line comes back one `\r` longer than it
 * actually is. That is an artefact of the oracle's own output, not a disagreement about where
 * the conflict is, and treating it as one made every CRLF file with no trailing newline
 * `engine_disagreement`. The relaxation is deliberately confined to that exact case: the LAST
 * line of ours, and only when ours has no terminator.
 */
function lineMatches(
  haystack: string[],
  at: number,
  needle: string,
  haystackFinalNewline: boolean,
): boolean {
  const hay = haystack[at];
  if (hay === undefined) return false;
  if (hay === needle) return true;
  return at === haystack.length - 1 && !haystackFinalNewline && `${hay}\r` === needle;
}

/**
 * Every region git contested must overlap one of ours. OUR extra regions are fine — being
 * more conservative than git is allowed; contesting LESS than git is not, because that is a
 * region we would merge silently and git would not.
 */
export function oracleAgrees(
  ourConflictRanges: readonly LineRange[],
  gitRanges: readonly LineRange[],
): boolean {
  for (const g of gitRanges) {
    const hit = ourConflictRanges.some((r) => g.start <= r.end && g.end >= r.start);
    if (!hit) return false;
  }
  return true;
}

/** Run the oracle over one file's three sides. Returns true when git agrees, false when it
 *  contests something we merged silently — which makes the file `engine_disagreement`. */
async function runOracle(
  baseText: string,
  oursText: string,
  theirsText: string,
  oursLines: string[],
  oursFinalNewline: boolean,
  ourConflictRanges: LineRange[],
): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'pierre-oracle-'));
  try {
    const o = join(dir, 'ours');
    const b = join(dir, 'base');
    const t = join(dir, 'theirs');
    writeFileSync(o, oursText, 'utf8');
    writeFileSync(b, baseText, 'utf8');
    writeFileSync(t, theirsText, 'utf8');
    const res = await gitTry(
      ['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', o, b, t],
      dir,
    );
    // ⚠ merge-file's exit status is the CONFLICT COUNT, capped at 127 — which is why we do
    // not read it. Above 127 it is a real failure (unreadable input), and a cross-check that
    // cannot run must not turn every file into a refusal.
    if (res.code > 127) return true;
    const gitRanges = oracleConflictRanges(
      res.stdout.toString('utf8'),
      oursLines,
      oursFinalNewline,
    );
    if (gitRanges === null) return false;
    return oracleAgrees(ourConflictRanges, gitRanges);
  } catch {
    // The oracle is a cross-check, not a dependency: if it cannot run we do not turn every
    // file into a refusal.
    return true;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a temp dir we could not remove is not worth failing a merge over */
    }
  }
}

/* ═════════════════════════════ the builder ═════════════════════════════ */

export interface ConflictBuildContext {
  accountId: number;
  prId: number;
  cloneDir: string;
  owner: string;
  name: string;
  number: number;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  reservedBranchNames: string[];
  /** Can we push to the PR's own head branch? Decided by the CALLER, from one live REST read
   *  — this builder is deliberately network-free apart from the blob prefetch, and the tests
   *  drive it against real temp repositories with no GitHub at all. Defaults true. */
  prBranchPushable?: boolean;
  prBranchUnavailableReason?: string | null;
  /** null ⇒ never reach the network. The tests run against a clone that already has every
   *  object; production always has one. */
  token: string | null;
}

export interface ConflictBuildOptions {
  onPhase?: (p: ConflictPreparePhase) => void;
  deadlineMs?: number;
}

/**
 * Build the model inside an EXISTING clone that already has both commits.
 *
 * Exported separately from `buildConflictModel` so the tests can drive it against real temp
 * repositories with no GitHub and no database — the git behaviour this whole feature rests on
 * is the half worth testing against real git.
 */
export async function buildConflictModelInClone(
  ctx: ConflictBuildContext,
  opts: ConflictBuildOptions = {},
): Promise<ConflictModelResult> {
  const deadline = opts.deadlineMs ?? Date.now() + config.conflictModelTimeoutMs;
  const expired = (): boolean => Date.now() > deadline;

  if (!(await gitSupportsMergeTree(ctx.cloneDir))) {
    return {
      status: 'failed',
      code: 'git_too_old',
      message: 'This machine’s git is older than 2.38. Update git to resolve conflicts here.',
    };
  }

  opts.onPhase?.('merging');

  // ---- the merge base ----
  // ⚠ Used for the REBASE COMMIT COUNT and the blob prefetch, never for the `base` TEXT of a
  // region — that always comes from merge-tree's stage 1. MEASURED on a real criss-cross:
  // `merge-base --all` returned two commits whose file read `x/MID/yA` and `xB/MID/y` while
  // stage 1 was `xB/MID/yA`, different from BOTH. A second base resolution is how "keep the
  // ancestor" comes to commit bytes the pane never showed.
  const mb = await gitTry(['merge-base', '--all', ctx.headSha, ctx.baseSha], ctx.cloneDir);
  const mbCandidates = mb.stdout
    .toString('utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (mbCandidates.length === 0) {
    return {
      status: 'failed',
      code: 'unrelated_histories',
      message: 'This branch and its base share no history.',
    };
  }
  const mergeBaseIsVirtual = mbCandidates.length > 1;
  const mergeBaseSha = mergeBaseIsVirtual ? null : (mbCandidates[0] as string);
  const rebaseBase = mbCandidates[0] as string;

  // ---- prefetch the blobs merge-tree will need ----
  opts.onPhase?.('fetching');
  const prefetch = await prefetchBlobs(ctx, mbCandidates);
  if (prefetch === 'unavailable') {
    return {
      status: 'failed',
      code: 'objects_unavailable',
      message: 'Some of this merge’s file contents could not be fetched from GitHub.',
    };
  }
  if (expired()) return timedOut();

  // ---- the merge ----
  opts.onPhase?.('merging');
  const mtArgs = ['merge-tree', '--write-tree', '-z'];
  if (prefetch === 'narrowed') {
    // A CONFIG KEY, not a 2.40 flag: `-c merge.renames=false` works everywhere `merge-tree`
    // does, and rename detection is what makes the blob budget explode.
    mtArgs.unshift('-c', 'merge.renames=false');
  }
  const mt = await gitTry([...mtArgs, ctx.headSha, ctx.baseSha], ctx.cloneDir);
  if (mt.stdout.length === 0) {
    // ⚠ A non-zero exit with EMPTY stdout is an error; a non-zero exit with a leading tree
    // oid is conflicts. Branching on the code alone turns "not something we can merge" into
    // a model with no files in it.
    const stderr = mt.stderr.trim();
    if (/unrelated histories/i.test(stderr)) {
      return {
        status: 'failed',
        code: 'unrelated_histories',
        message: 'This branch and its base share no history.',
      };
    }
    return {
      status: 'failed',
      code: 'objects_unavailable',
      message: stderr.slice(0, 300) || 'git could not merge these two commits.',
    };
  }
  const parsed = parseMergeTree(mt.stdout);

  const commitsAboveBase = await countCommits(ctx.cloneDir, rebaseBase, ctx.headSha);

  const skeleton = {
    accountId: ctx.accountId,
    prId: ctx.prId,
    owner: ctx.owner,
    name: ctx.name,
    number: ctx.number,
    headSha: ctx.headSha,
    baseSha: ctx.baseSha,
    headRef: ctx.headRef,
    baseRef: ctx.baseRef,
    mergeBaseSha,
    mergeBaseIsVirtual,
    mergedTreeSha: parsed.treeOid,
    commitsAboveBase,
    reservedBranchNames: ctx.reservedBranchNames,
    prBranchPushable: ctx.prBranchPushable ?? true,
    prBranchUnavailableReason: ctx.prBranchUnavailableReason ?? null,
  };

  if (parsed.stages.length === 0) {
    const model: ConflictModel = {
      ...skeleton,
      files: [],
      totalConflictedPaths: 0,
      truncated: false,
      renameDetection: prefetch === 'narrowed' ? 'off' : 'on',
      strategies: ['merge'],
      rebaseUnavailableReason: null,
    };
    return { status: 'clean', model };
  }

  // ---- group every record by path ----
  const byPath = groupRecords(parsed.stages, parsed.messages);
  if (byPath.size > HARD_CONFLICTED_PATH_CEILING) {
    return {
      status: 'failed',
      code: 'too_many_files',
      message: `This merge conflicts in ${byPath.size} files. Resolve it on GitHub.`,
    };
  }

  opts.onPhase?.('reading');
  const files = await buildFiles(ctx, [...byPath.values()], deadline);

  const resolvable = files.filter((f) => f.unsupported === null);
  const strategies: ConflictLandStrategy[] = ['merge'];
  let rebaseUnavailableReason: string | null = null;
  if (commitsAboveBase !== 1) {
    rebaseUnavailableReason = `This branch has ${commitsAboveBase} commits. Rebasing can conflict once per commit — merge instead.`;
  } else if (resolvable.length !== files.length) {
    const stuck = files.length - resolvable.length;
    rebaseUnavailableReason = `Rebase needs every conflicted file resolved here. ${stuck} of ${files.length} must be resolved on GitHub.`;
  } else {
    strategies.push('rebase');
  }

  const model: ConflictModel = {
    ...skeleton,
    files,
    totalConflictedPaths: byPath.size,
    truncated: files.some((f) => f.unsupported === 'budget_exhausted'),
    renameDetection: prefetch === 'narrowed' ? 'off' : 'on',
    strategies,
    rebaseUnavailableReason,
  };
  return { status: 'ready', model };
}

function timedOut(): ConflictModelResult {
  return {
    status: 'failed',
    code: 'timeout',
    message: 'Working out this merge took too long.',
  };
}

function groupRecords(
  stages: readonly MergeTreeStage[],
  messages: readonly MergeTreeMessage[],
): Map<string, PathRecords> {
  const byPath = new Map<string, PathRecords>();
  const get = (rawPath: string): PathRecords => {
    let rec = byPath.get(rawPath);
    if (!rec) {
      rec = { rawPath, stages: new Map(), types: new Set(), relatedRaw: new Set() };
      byPath.set(rawPath, rec);
    }
    return rec;
  };
  // Only STAGE entries mint a file. A path that appears solely in a message — the directory
  // half of a file/directory conflict, say — is carried as a related path, because there is
  // no blob triple to resolve there.
  for (const s of stages) get(s.path).stages.set(s.stage, s);
  for (const m of messages) {
    for (const p of m.paths) {
      const rec = byPath.get(p);
      if (!rec) continue;
      rec.types.add(m.type);
      for (const other of m.paths) if (other !== p) rec.relatedRaw.add(other);
    }
  }
  return byPath;
}

async function buildFiles(
  ctx: ConflictBuildContext,
  records: PathRecords[],
  deadline: number,
): Promise<ConflictModelFile[]> {
  const committishes = [ctx.headSha, ctx.baseSha];
  const sorted = [...records].sort((a, b) => (a.rawPath < b.rawPath ? -1 : 1));
  const files: ConflictModelFile[] = [];
  let bytesAttached = 0;

  for (let index = 0; index < sorted.length; index++) {
    const rec = sorted[index] as PathRecords;
    const path = stripMangledSuffix(rec.rawPath, committishes);
    const relatedPaths = [...rec.relatedRaw]
      .map((p) => stripMangledSuffix(p, committishes))
      .filter((p) => p !== path);
    const s2 = rec.stages.get(2);

    const base = (reason: ConflictUnsupportedReason | null): ConflictModelFile => ({
      index,
      path,
      relatedPaths,
      unsupported: reason,
      unsupportedLabel: reason === null ? null : UNSUPPORTED_LABELS[reason],
      regions: [],
      terminators: { base: false, ours: false, theirs: false },
      maxSideBytes: 0,
      stage2Mode: s2?.mode ?? null,
    });

    const structural = classifyPath(rec);
    if (structural !== null) {
      files.push(base(structural));
      continue;
    }
    if (index >= config.conflictMaxFiles || Date.now() > deadline) {
      // Still listed and still classified — an unlisted file is why the PR stays conflicted
      // after a commit, with nothing on screen to explain it.
      files.push(base('budget_exhausted'));
      continue;
    }

    const s1 = rec.stages.get(1);
    const s3 = rec.stages.get(3);
    if (!s1 || !s2 || !s3) {
      files.push(base('no_common_ancestor'));
      continue;
    }

    const blobs = await readBlobs(ctx.cloneDir, [s1.oid, s2.oid, s3.oid]);
    if (!blobs) {
      files.push(base('budget_exhausted'));
      continue;
    }
    const [baseBuf, oursBuf, theirsBuf] = blobs;
    const maxSideBytes = Math.max(baseBuf.length, oursBuf.length, theirsBuf.length);
    if (maxSideBytes > config.conflictMaxFileBytes) {
      files.push({ ...base('too_large'), maxSideBytes });
      continue;
    }
    if (bytesAttached + baseBuf.length + oursBuf.length + theirsBuf.length >
      config.conflictMaxTotalBytes) {
      files.push({ ...base('budget_exhausted'), maxSideBytes });
      continue;
    }

    // The NUL check is the cheap half of the binary test and it comes first; the strict
    // decode is the half that catches Latin-1, which has no NUL at all.
    if (baseBuf.includes(0) || oursBuf.includes(0) || theirsBuf.includes(0)) {
      files.push({ ...base('binary'), maxSideBytes });
      continue;
    }
    const baseText = decodeStrict(baseBuf);
    const oursText = decodeStrict(oursBuf);
    const theirsText = decodeStrict(theirsBuf);
    if (baseText === null || oursText === null || theirsText === null) {
      files.push({ ...base('not_text'), maxSideBytes });
      continue;
    }

    const baseSplit = splitLines(baseText);
    const oursSplit = splitLines(oursText);
    const theirsSplit = splitLines(theirsText);
    const built = buildFileRegions(baseSplit.lines, oursSplit.lines, theirsSplit.lines);
    const terminators = {
      base: baseSplit.finalNewline,
      ours: oursSplit.finalNewline,
      theirs: theirsSplit.finalNewline,
    };
    if (built.unsupported !== null) {
      files.push({ ...base(built.unsupported), maxSideBytes, terminators });
      continue;
    }

    const ourRanges = ourConflictRangesOf(built.regions, oursSplit.lines);
    const agrees = await runOracle(
      baseText,
      oursText,
      theirsText,
      oursSplit.lines,
      oursSplit.finalNewline,
      ourRanges,
    );
    if (!agrees) {
      files.push({ ...base('engine_disagreement'), maxSideBytes, terminators });
      continue;
    }

    bytesAttached += baseBuf.length + oursBuf.length + theirsBuf.length;
    files.push({
      index,
      path,
      relatedPaths,
      unsupported: null,
      unsupportedLabel: null,
      regions: built.regions,
      terminators,
      maxSideBytes,
      stage2Mode: s2.mode,
    });
  }
  return files;
}

/** Our contested regions expressed as OURS-side line ranges, for the oracle comparison. */
function ourConflictRangesOf(
  regions: readonly ConflictModelRegion[],
  oursLines: readonly string[],
): LineRange[] {
  const out: LineRange[] = [];
  let cursor = 0;
  for (const r of regions) {
    const len = r.kind === 'unchanged' ? r.base.length : r.ours.length;
    if (r.kind === 'conflict') out.push({ start: cursor, end: cursor + len });
    cursor += len;
  }
  // A defensive clamp: the walk above must land exactly on the ours side's length.
  if (cursor !== oursLines.length) return out;
  return out;
}

/* ═════════════════════════════ git plumbing ═════════════════════════════ */

async function countCommits(cloneDir: string, from: string, to: string): Promise<number> {
  const res = await gitTry(['rev-list', '--count', `${from}..${to}`], cloneDir);
  if (res.code !== 0) return -1;
  const n = Number(res.stdout.toString('utf8').trim());
  return Number.isInteger(n) ? n : -1;
}

/** Read the merge base / ours / theirs blobs. `null` when any of them is missing, which the
 *  caller treats as a budget problem for that ONE file rather than a failure of the model. */
async function readBlobs(
  cloneDir: string,
  oids: readonly [string, string, string],
): Promise<[Buffer, Buffer, Buffer] | null> {
  const out: Buffer[] = [];
  for (const oid of oids) {
    const res = await gitTry(['cat-file', 'blob', oid], cloneDir);
    if (res.code !== 0) return null;
    out.push(res.stdout);
  }
  const [a, b, c] = out;
  if (!a || !b || !c) return null;
  return [a, b, c];
}

/**
 * Make sure every blob merge-tree will read is in the local store.
 *
 * The clone is BLOBLESS and its `origin` carries no credential, so git cannot lazily fetch
 * on its own. We name the oids explicitly.
 *
 * ⚠ THE BY-OID FETCH EXITS NON-ZERO ON COMPLETE SUCCESS — `fatal: bad revision '<oid>'`,
 * `error: … did not send all necessary objects` — because git cannot make a ref out of a
 * blob oid. SUCCESS IS PROVEN ONLY BY THE FOLLOW-UP `cat-file --batch-check`. Any
 * implementation that checks the exit code refuses every PR.
 *
 * ⚠ `--filter=blob:none` on that fetch is load-bearing: without it the blob does not land.
 */
async function prefetchBlobs(
  ctx: ConflictBuildContext,
  mergeBaseCandidates: readonly string[],
): Promise<'ok' | 'narrowed' | 'unavailable'> {
  // ⚠ EVERY candidate, not just the first. On a criss-cross history merge-tree builds a
  // VIRTUAL base by merging the candidates, so it reads content from all of them; prefetching
  // against one leaves the others' blobs missing in a blobless clone, and the merge then
  // fails for a reason that looks nothing like its cause.
  const ours = new Map<string, string>();
  const theirs = new Map<string, string>();
  // Stage-1 material: the base side's own blobs, which the two maps above (keyed on the
  // DESTINATION oid) do not carry.
  const ancestors = new Set<string>();
  for (const mergeBase of mergeBaseCandidates) {
    for (const [path, oid] of await diffTreeOids(ctx.cloneDir, mergeBase, ctx.headSha)) {
      ours.set(path, oid);
    }
    for (const [path, oid] of await diffTreeOids(ctx.cloneDir, mergeBase, ctx.baseSha)) {
      theirs.set(path, oid);
    }
    for (const oid of (await diffTreeOids(ctx.cloneDir, ctx.headSha, mergeBase)).values()) {
      ancestors.add(oid);
    }
  }

  let narrowed = false;
  let wanted = new Set<string>([...ours.values(), ...theirs.values(), ...ancestors]);
  if (wanted.size > config.conflictPrefetchMaxBlobs) {
    // Narrow to the paths BOTH sides touched — with rename detection off those are the only
    // ones that can conflict, so they are the only ones whose content merge-tree must read.
    narrowed = true;
    wanted = new Set<string>(ancestors);
    for (const [path, oid] of ours) {
      if (!theirs.has(path)) continue;
      wanted.add(oid);
      const t = theirs.get(path);
      if (t) wanted.add(t);
    }
  }

  const missing = await missingOids(ctx.cloneDir, [...wanted]);
  if (missing.length === 0) return narrowed ? 'narrowed' : 'ok';
  if (!ctx.token) return 'unavailable';

  const url = `https://x-access-token:${ctx.token}@github.com/${ctx.owner}/${ctx.name}.git`;
  for (let i = 0; i < missing.length; i += PREFETCH_BATCH) {
    const batch = missing.slice(i, i + PREFETCH_BATCH);
    await gitTry(
      [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--recurse-submodules=no',
        '--filter=blob:none',
        url,
        ...batch,
      ],
      ctx.cloneDir,
    );
  }
  const stillMissing = await missingOids(ctx.cloneDir, missing);
  if (stillMissing.length > 0) return 'unavailable';
  return narrowed ? 'narrowed' : 'ok';
}

/** path → blob oid on the `to` side, for every path that differs. `--no-renames` keeps this
 *  a plain per-path list; rename detection here would cost blob content we have not fetched. */
async function diffTreeOids(
  cloneDir: string,
  from: string,
  to: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const res = await gitTry(['diff-tree', '-r', '-z', '--no-renames', from, to], cloneDir);
  if (res.code !== 0) return out;
  // `:<srcmode> <dstmode> <srcoid> <dstoid> <status>\0<path>\0`
  const fields = res.stdout.toString('utf8').split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f === undefined || !f.startsWith(':')) continue;
    const bits = f.slice(1).split(' ');
    const dstOid = bits[3];
    const path = fields[i + 1];
    if (dstOid === undefined || path === undefined) continue;
    if (/^0+$/.test(dstOid)) continue; // deleted on this side — no blob to fetch
    out.set(path, dstOid);
    i++;
  }
  return out;
}

async function missingOids(cloneDir: string, oids: readonly string[]): Promise<string[]> {
  if (oids.length === 0) return [];
  const stdin = Buffer.from(`${oids.join('\n')}\n`, 'utf8');
  const res = await gitTry(['cat-file', '--batch-check', '--buffer'], cloneDir, stdin);
  const lines = res.stdout.toString('utf8').split('\n');
  const missing: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.endsWith(' missing')) {
      const oid = line.slice(0, line.length - ' missing'.length);
      if (oid) missing.push(oid);
    }
  }
  return missing;
}

/* ═════════════════════════════ the public entry point ═════════════════════════════ */

/**
 * Resolve the PR, make sure the clone has both commits, and build the model.
 *
 * Returns `null` when `prId` is not this account's PR — the caller 404s, so the route never
 * becomes an existence oracle for another tenant's ids.
 */
export async function buildConflictModel(args: {
  accountId: number;
  prId: number;
  expectHeadSha?: string;
  expectBaseSha?: string;
  /** Namespaces the fetch refs. NEVER FETCH_HEAD — the clone cache is shared across accounts
   *  and jobs and FETCH_HEAD is one file per repository. */
  sessionId: string;
  onPhase?: (p: ConflictPreparePhase) => void;
  deadlineMs?: number;
}): Promise<ConflictModelResult | null> {
  const rows = await db
    .select({
      prId: pullRequests.id,
      number: pullRequests.number,
      state: pullRequests.state,
      headRefName: pullRequests.headRefName,
      baseRefName: pullRequests.baseRefName,
      owner: repos.owner,
      name: repos.name,
      defaultBranch: repos.defaultBranch,
      defaultBranchName: repos.defaultBranchName,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(pullRequests.id, args.prId), eq(repos.accountId, args.accountId)))
    .limit(1)
    .execute();
  const pr = rows[0];
  if (!pr) return null;
  if (pr.state !== 'open') {
    return {
      status: 'failed',
      code: 'not_open',
      message: 'This pull request is closed.',
    };
  }
  const baseRef = pr.baseRefName;
  if (!baseRef) {
    return {
      status: 'failed',
      code: 'objects_unavailable',
      message: 'This pull request’s base branch hasn’t been synced yet.',
    };
  }

  const token = await getAccessToken(args.accountId);
  const reserved = [...new Set(
    [pr.defaultBranchName, pr.defaultBranch, baseRef].filter(
      (b): b is string => typeof b === 'string' && b.length > 0,
    ),
  )];
  // ── CAN WE PUSH TO THE PR'S OWN BRANCH? ──────────────────────────────────────────────────
  // `isFork` / `maintainerCanModify` are NOT synced columns, so the only way to know is to ask,
  // and the answer has to be known BEFORE the reader fills in the landing form — otherwise the
  // screen offers "Push to <headRef>" for a head we cannot write to and the refusal arrives
  // after the button. One REST call, on a path that is about to clone and fetch two branches
  // and is click-gated besides.
  //
  // ⚠ NON-FATAL, AND TRUE IS THE FALLBACK. A head-info failure must not cost the whole session:
  // we say "pushable", the landing step offers the option, and `landConflictResolution` —
  // which re-reads exactly these two fields immediately before the push — refuses with
  // `PushDenied`. That is the behaviour that shipped before this field existed.
  let prBranchPushable = true;
  let prBranchUnavailableReason: string | null = null;
  try {
    const head = await fetchPrHeadInfo(token, pr.owner, pr.name, pr.number);
    if (head.isFork && !head.maintainerCanModify) {
      prBranchPushable = false;
      prBranchUnavailableReason =
        'This pull request comes from a fork that does not allow maintainer edits, so its branch can’t be pushed to.';
    }
  } catch {
    /* see above: the land route is the authorisation, not this read */
  }

  args.onPhase?.('cloning');

  try {
    // ⚠ ONE lock across the whole git phase — clone, fetch, merge-tree, blob reads. Taking it
    // twice leaves a window in which another job's cleanup can reach the refs we just
    // fetched, and the shas we pinned would then resolve to nothing.
    return await withRepoLock(`${pr.owner}/${pr.name}`, async () => {
      const cloneDir = await ensureClone(pr.owner, pr.name, token);
      args.onPhase?.('fetching');
      // ⚠ SESSION-NAMESPACED, NEVER FETCH_HEAD. The clone cache is keyed `owner__name` and
      // shared across accounts and jobs; FETCH_HEAD is ONE FILE per repository, so a
      // concurrent job's fetch would hand us its commit.
      const ns = `refs/pierre/conflict/${args.sessionId}`;
      const headSha = await fetchRefIntoClone({
        cloneDir,
        owner: pr.owner,
        name: pr.name,
        token,
        remoteRef: `refs/pull/${pr.number}/head`,
        destRef: `${ns}/head`,
      });
      const baseSha = await fetchRefIntoClone({
        cloneDir,
        owner: pr.owner,
        name: pr.name,
        token,
        remoteRef: `refs/heads/${baseRef}`,
        destRef: `${ns}/base`,
      });

      if (
        (args.expectHeadSha && args.expectHeadSha !== headSha) ||
        (args.expectBaseSha && args.expectBaseSha !== baseSha)
      ) {
        return { status: 'moved', headSha, baseSha } satisfies ConflictModelResult;
      }

      return buildConflictModelInClone(
        {
          accountId: args.accountId,
          prId: args.prId,
          cloneDir,
          owner: pr.owner,
          name: pr.name,
          number: pr.number,
          headSha,
          baseSha,
          headRef: pr.headRefName ?? '',
          baseRef,
          reservedBranchNames: reserved,
          prBranchPushable,
          prBranchUnavailableReason,
          token,
        },
        { onPhase: args.onPhase, deadlineMs: args.deadlineMs },
      );
    });
  } finally {
    // The clone cache is a cache: sweep it off the hot path, never inside the lock.
    setImmediate(() => {
      void cleanupCloneCache();
    });
  }
}

/* ═════════════════════════════ the wire projection ═════════════════════════════ */

/**
 * The manifest rows. `regionCount` counts EVERY region; `conflictCount` counts the contested
 * ones; `decidableCount` counts every region that takes a decision — the population the commit
 * gate and the header both work in — and `wandResolvableCount` is the subset of the contested
 * ones the wand can settle without picking a side.
 */
export function conflictFileEntries(model: ConflictModel): ConflictFileEntry[] {
  return model.files.map((f) => ({
    index: f.index,
    path: f.path,
    relatedPaths: f.relatedPaths,
    unsupported: f.unsupported,
    unsupportedLabel: f.unsupportedLabel,
    regionCount: f.regions.length,
    conflictCount: f.regions.filter((r) => r.kind === 'conflict').length,
    decidableCount: f.regions.filter((r) => r.kind !== 'unchanged').length,
    wandResolvableCount: f.regions.filter(
      (r) => r.kind === 'conflict' && r.wand !== null,
    ).length,
    maxSideBytes: f.maxSideBytes,
  }));
}

/** Which buttons a region offers. ⚠ `'suggestion'` never appears — it is a session fact, not
 *  a model fact, and a model that advertised it would be advertising a Pro capability the
 *  account may not have. */
export function allowedDecisions(region: ConflictModelRegion): ConflictDecision[] {
  switch (region.kind) {
    case 'unchanged':
      return ['base'];
    case 'ours_only':
      return ['ours', 'base'];
    case 'theirs_only':
      return ['theirs', 'base'];
    case 'both_same':
      return ['ours', 'base'];
    case 'conflict': {
      const out: ConflictDecision[] = [
        'ours',
        'theirs',
        'both_ours_first',
        'both_theirs_first',
        'base',
      ];
      if (region.wand?.reason === 'disjoint_words') out.push('disjoint_merge');
      return out;
    }
  }
}

/** What the centre pane starts on. With auto-apply (the default) a one-sided region defaults
 *  to its own side and `both_same` to `ours`; a genuine conflict always starts at `base`,
 *  undecided, because there is nothing to apply. */
export function defaultDecisionFor(
  region: ConflictModelRegion,
  autoApply: boolean,
): ConflictDecision {
  if (!autoApply || region.kind === 'conflict' || region.kind === 'unchanged') return 'base';
  return region.wand?.decision ?? 'base';
}

export function conflictFileContent(
  model: ConflictModel,
  index: number,
  autoApply: boolean,
): ConflictFileContent | null {
  const file = model.files.find((f) => f.index === index);
  if (!file) return null;
  // `n` is that SIDE's own 1-based file line number, so the three panes can be read against
  // the real file. Walked once, in order — every side is covered end to end.
  let baseLine = 1;
  let oursLine = 1;
  let theirsLine = 1;
  const regions: ConflictRegion[] = file.regions.map((r) => {
    const region: ConflictRegion = {
      id: r.id,
      kind: r.kind,
      fingerprint: r.fingerprint,
      base: numbered(r.base, baseLine),
      ours: numbered(r.ours, oursLine),
      theirs: numbered(r.theirs, theirsLine),
      defaultDecision: defaultDecisionFor(r, autoApply),
      allowed: allowedDecisions(r),
      wand: r.wand,
      // ⚠ THE BYTES, NOT A PROMISE THE CLIENT CAN RECOMPUTE. `land.ts` splices exactly this
      // array for a `'disjoint_merge'` decision, so the centre pane must render exactly this
      // array — see the ⚠ on `ConflictRegion.mergedLines` for the divergence that made the
      // SPA's own word merge print the ancestor for a region the commit landed merged.
      mergedLines: r.mergedLines,
    };
    // An `unchanged` region carries empty `ours`/`theirs` but still occupies those lines,
    // and its length there is the base's by construction.
    const sideLen = r.kind === 'unchanged' ? r.base.length : 0;
    baseLine += r.base.length;
    oursLine += r.ours.length + sideLen;
    theirsLine += r.theirs.length + sideLen;
    return region;
  });
  return { index: file.index, path: file.path, terminators: file.terminators, regions };
}

function numbered(lines: readonly string[], from: number): { n: number; text: string }[] {
  return lines.map((text, i) => ({ n: from + i, text }));
}
