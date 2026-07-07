import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { getAccessToken, getAccountById } from '../auth/account.js';
import {
  cleanupCloneCache,
  prepWorktree,
  prepWorktreeAtRef,
  removeWorktreeLocked,
} from '../review/clone-manager.js';
import {
  createPullRequest,
  fetchMergeability,
  fetchPrHeadInfo,
} from '../github/mutations.js';
import type {
  ApplyResolveResult,
  CodingProgress,
  MergePreviewArgs,
  MergePreviewResult,
  MergeResolveAndPushArgs,
  PushResolvedArgs,
  RebaseResolveArgs,
  RebaseResolveResult,
} from '../pro/contract.js';
import { applyPatchToWorktree, codedError, commitAll, pushRef } from './git.js';

const execFileAsync = promisify(execFile);

// Trunk-conflict handling for AI Fix: apply a stored fix onto its base, reconcile with
// the PR's trunk (merge or rebase, agentically resolving conflicts), and push safely.
// Same discipline as git.ts / clone-manager.ts: args are ALWAYS arrays (no shell), a
// tokenized URL is passed per-op and never persisted, and the host owns every git write
// (the resolver agent has no shell). Never pushes a tree that still has conflicts.

// Non-interactive git env: no credential prompt, no editor, no merge-message editor.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
};

interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git, throwing on a non-zero exit (for ops that MUST succeed). */
async function git(args: string[], cwd: string): Promise<GitResult> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    env: GIT_ENV,
    timeout: 120_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  return { ok: true, code: 0, stdout, stderr };
}

/** Run git WITHOUT throwing; returns the exit code + output (for merge/rebase). */
async function gitTry(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      env: GIT_ENV,
      timeout: 120_000,
      maxBuffer: 128 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      ok: false,
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
    };
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tokenizedUrl(owner: string, name: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
}

function lines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

interface Ident {
  name: string;
  email: string;
}

async function identFor(accountId: number): Promise<Ident> {
  const account = await getAccountById(accountId);
  const name = account?.displayName || account?.githubLogin || 'pierre-review';
  const email = account?.githubLogin
    ? `${account.githubLogin}@users.noreply.github.com`
    : 'pierre-review@users.noreply.github.com';
  return { name, email };
}

function identArgs(ident: Ident): string[] {
  return ['-c', `user.name=${ident.name}`, '-c', `user.email=${ident.email}`];
}

async function scheduleCleanup(repoCloneDir: string | null): Promise<void> {
  if (!repoCloneDir) return;
  setImmediate(() => {
    try {
      cleanupCloneCache();
    } catch {
      /* advisory */
    }
  });
}

async function teardown(
  owner: string,
  name: string,
  repoCloneDir: string | null,
  worktreePath: string | null,
): Promise<void> {
  if (repoCloneDir && worktreePath) {
    await removeWorktreeLocked(owner, name, repoCloneDir, worktreePath).catch(
      () => {},
    );
  }
  void scheduleCleanup(repoCloneDir);
}

/** Fetch a branch into the worktree's object store and return its tip sha. */
async function fetchTrunk(
  worktree: string,
  owner: string,
  name: string,
  token: string,
  trunk: string,
): Promise<string> {
  const res = await gitTry(
    ['fetch', '--no-tags', '--force', tokenizedUrl(owner, name, token), trunk],
    worktree,
  );
  if (!res.ok) {
    throw codedError(
      'TRUNK_FETCH_FAILED',
      `couldn't fetch trunk '${trunk}': ${res.stderr || res.stdout}`,
    );
  }
  const { stdout } = await git(['rev-parse', 'FETCH_HEAD'], worktree);
  return stdout.trim();
}

/** Apply the stored fix patch onto the checked-out base and commit it → commit sha. */
async function buildFixCommit(
  worktree: string,
  patch: string,
  commitMessage: string,
  ident: Ident,
): Promise<string> {
  await applyPatchToWorktree(worktree, patch); // throws APPLY_FAILED on a bad patch
  return commitAll(worktree, {
    message: commitMessage,
    authorName: ident.name,
    authorEmail: ident.email,
  });
}

/** True if `ancestor` is an ancestor of `descendant` (i.e. already contained). */
async function isAncestor(
  worktree: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const res = await gitTry(
    ['merge-base', '--is-ancestor', ancestor, descendant],
    worktree,
  );
  return res.ok;
}

/** The currently-unmerged (conflicted) paths. */
async function conflictedFiles(worktree: string): Promise<string[]> {
  const { stdout } = await git(
    ['diff', '--name-only', '--diff-filter=U'],
    worktree,
  );
  return lines(stdout);
}

/** Reject binary conflicts up front — the text-editing resolver can't fix them. */
async function assertNoBinaryConflicts(
  worktree: string,
  files: string[],
): Promise<void> {
  for (const f of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(worktree, f));
    } catch {
      continue; // deleted-both / missing — not a binary content conflict
    }
    if (buf.includes(0)) {
      throw codedError(
        'CONFLICTS_UNRESOLVED',
        `binary conflict in ${f} — resolve it on GitHub instead`,
      );
    }
  }
}

// A leftover conflict marker: `<<<<<<< `, `>>>>>>> ` or diff3's `||||||| ` (the
// `=======` divider alone is ambiguous — real files contain it — so we rely on the
// unambiguous open/close markers plus git's own unmerged-index check).
const MARKER_RE = /^(<{7}|>{7}|\|{7})[ \t]/m;

/** True if `text` still contains an (unambiguous) unresolved conflict marker. */
export function hasConflictMarkers(text: string): boolean {
  return MARKER_RE.test(text);
}

/** Verify the tree is fully resolved: no unmerged index entries and no markers. */
async function assertResolved(worktree: string, files: string[]): Promise<void> {
  const { stdout } = await git(['ls-files', '-u'], worktree);
  if (stdout.trim().length > 0) {
    const still = await conflictedFiles(worktree);
    throw codedError(
      'CONFLICTS_UNRESOLVED',
      `unresolved conflicts remain in ${still.join(', ') || 'the tree'}`,
    );
  }
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(worktree, f), 'utf-8');
    } catch {
      continue;
    }
    if (hasConflictMarkers(text)) {
      throw codedError(
        'CONFLICTS_UNRESOLVED',
        `conflict markers still present in ${f}`,
      );
    }
  }
}

/** True if a rebase or merge is currently in progress in this worktree. */
async function opInProgress(
  worktree: string,
  kind: 'rebase' | 'merge',
): Promise<boolean> {
  const probes = kind === 'rebase' ? ['rebase-merge', 'rebase-apply'] : ['MERGE_HEAD'];
  for (const p of probes) {
    try {
      const { stdout } = await git(['rev-parse', '--git-path', p], worktree);
      const rel = stdout.trim();
      const abs = isAbsolute(rel) ? rel : join(worktree, rel);
      if (existsSync(abs)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

interface ResolveOpts {
  autoResolve: boolean;
  model: string;
  resolverSystemPrompt?: string;
  contextNote?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  abortController: AbortController;
  onProgress: (p: CodingProgress) => void;
}

// Lazy-loads the SDK-backed resolver (so mergePreview never pulls the SDK in).
async function resolveConflictsInPlace(
  worktree: string,
  files: string[],
  opts: ResolveOpts,
): Promise<void> {
  await assertNoBinaryConflicts(worktree, files);
  const { runConflictResolver } = await import('./agent.js');
  const r = await runConflictResolver({
    worktreePath: worktree,
    model: opts.model,
    systemPrompt: opts.resolverSystemPrompt,
    conflictFiles: files,
    contextNote: opts.contextNote,
    maxTurns: opts.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd,
    abortController: opts.abortController,
    onActivity: (activity) =>
      opts.onProgress({ phase: 'resolving_conflicts', recentActivity: activity }),
  });
  if (r.aborted || opts.abortController.signal.aborted) {
    throw codedError('REBASE_FAILED', 'cancelled');
  }
  await assertResolved(worktree, files);
  await git(['add', '-A'], worktree);
}

// ---- rebase the fix onto the trunk (agentic per-commit resolution) ----
async function runRebase(
  worktree: string,
  trunkSha: string,
  ident: Ident,
  opts: ResolveOpts,
): Promise<{ any: boolean; files: string[] }> {
  const gc = identArgs(ident);
  const seen = new Set<string>();

  let res = await gitTry([...gc, 'rebase', trunkSha], worktree);
  let step = 0;
  while (!res.ok) {
    if (!(await opInProgress(worktree, 'rebase'))) {
      // The rebase never started / hard-failed (not a conflict stop).
      throw codedError('REBASE_FAILED', res.stderr || res.stdout || 'rebase failed');
    }
    if (opts.abortController.signal.aborted) {
      await gitTry(['rebase', '--abort'], worktree);
      throw codedError('REBASE_FAILED', 'cancelled');
    }
    const files = await conflictedFiles(worktree);
    if (files.length > 0) {
      if (!opts.autoResolve) {
        await gitTry(['rebase', '--abort'], worktree);
        throw codedError(
          'CONFLICTS_UNRESOLVED',
          `rebase conflicts in ${files.join(', ')}`,
        );
      }
      files.forEach((f) => seen.add(f));
      await resolveConflictsInPlace(worktree, files, opts);
    }
    if (++step > config.aiFixRebaseMaxSteps) {
      await gitTry(['rebase', '--abort'], worktree);
      throw codedError(
        'REBASE_FAILED',
        `rebase exceeded ${config.aiFixRebaseMaxSteps} conflict steps`,
      );
    }
    res = await continueOrSkip(worktree, gc);
  }
  return { any: seen.size > 0, files: [...seen] };
}

// `git rebase --continue`, falling back to `--skip` when a resolved commit became
// empty (its changes are already on the trunk).
async function continueOrSkip(
  worktree: string,
  gc: string[],
): Promise<GitResult> {
  const cont = await gitTry([...gc, 'rebase', '--continue'], worktree);
  if (cont.ok) return cont;
  const blob = `${cont.stderr}\n${cont.stdout}`.toLowerCase();
  if (
    blob.includes('no changes') ||
    blob.includes('nothing to commit') ||
    blob.includes('did you forget') ||
    blob.includes('patch is empty')
  ) {
    return gitTry([...gc, 'rebase', '--skip'], worktree);
  }
  return cont;
}

// ---- merge the trunk into the fix branch (single agentic resolution) ----
async function runMerge(
  worktree: string,
  trunkSha: string,
  trunk: string,
  branchLabel: string,
  ident: Ident,
  opts: ResolveOpts,
): Promise<{ any: boolean; files: string[] }> {
  const gc = identArgs(ident);
  if (await isAncestor(worktree, trunkSha, 'HEAD')) {
    return { any: false, files: [] }; // already contains the trunk
  }
  const res = await gitTry(
    [...gc, 'merge', '--no-ff', '--no-edit', '-m', `Merge ${trunk} into ${branchLabel}`, trunkSha],
    worktree,
  );
  if (res.ok) return { any: false, files: [] };

  const files = await conflictedFiles(worktree);
  if (files.length === 0) {
    await gitTry(['merge', '--abort'], worktree);
    throw codedError('MERGE_FAILED', res.stderr || res.stdout || 'merge failed');
  }
  if (!opts.autoResolve) {
    await gitTry(['merge', '--abort'], worktree);
    throw codedError('CONFLICTS_UNRESOLVED', `merge conflicts in ${files.join(', ')}`);
  }
  try {
    await resolveConflictsInPlace(worktree, files, opts);
  } catch (err) {
    await gitTry(['merge', '--abort'], worktree);
    throw err;
  }
  // Complete the merge commit (both parents preserved).
  await git([...gc, 'commit', '--no-verify', '--no-edit'], worktree);
  return { any: true, files };
}

/** git am a stored series onto the checked-out trunk tip (preserves the commits). */
async function amMbox(worktree: string, mbox: string, ident: Ident): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'pierre-am-'));
  const file = join(tmp, 'series.mbox');
  try {
    writeFileSync(file, mbox, 'utf-8');
    const res = await gitTry([...identArgs(ident), 'am', '--3way', file], worktree);
    if (!res.ok) {
      await gitTry(['am', '--abort'], worktree);
      throw codedError(
        'APPLY_FAILED',
        `the resolved series no longer applies onto the trunk (it advanced) — re-run rebase: ${
          res.stderr || res.stdout
        }`,
      );
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* advisory */
    }
  }
}

async function pushForceWithLease(
  worktree: string,
  owner: string,
  name: string,
  token: string,
  committish: string,
  remoteBranch: string,
  leaseSha: string,
): Promise<void> {
  const url = tokenizedUrl(owner, name, token);
  const res = await gitTry(
    [
      'push',
      `--force-with-lease=refs/heads/${remoteBranch}:${leaseSha}`,
      url,
      `${committish}:refs/heads/${remoteBranch}`,
    ],
    worktree,
  );
  if (!res.ok) {
    throw codedError(
      'PUSH_DENIED',
      `force-with-lease push failed (branch moved since / protected / no write): ${
        res.stderr || res.stdout
      }`,
    );
  }
}

// ================= the four CodingSeam methods =================

// NEAR-INSTANT: uses GitHub's own mergeability (a REST call or two) rather than cloning
// + trial-merging. It reflects the PR as it stands on GitHub (not the not-yet-pushed
// fix) — a fast approximation to OFFER the options; the rebase/merge job is the
// authoritative, with-fix resolver. GitHub doesn't expose the conflicting file list
// here, so conflictFiles is empty (the UI shows a count-less warning).
export async function mergePreview(
  args: MergePreviewArgs,
): Promise<MergePreviewResult> {
  const { accountId, owner, name, prNumber, trunk } = args;
  const token = await getAccessToken(accountId);
  try {
    const m = await fetchMergeability(token, owner, name, prNumber);
    return {
      trunk,
      trunkSha: m.baseSha,
      behindBy: m.behindBy,
      aheadBy: m.aheadBy,
      // mergeable === false (or state 'dirty') ⇒ conflicts; true/null ⇒ clean/unknown.
      clean: m.mergeable !== false && m.mergeableState !== 'dirty',
      conflictFiles: [],
    };
  } catch {
    return {
      trunk,
      trunkSha: null,
      behindBy: 0,
      aheadBy: 0,
      clean: true,
      conflictFiles: [],
    };
  }
}

export async function rebaseResolve(
  args: RebaseResolveArgs,
): Promise<RebaseResolveResult> {
  const {
    accountId,
    owner,
    name,
    prNumber,
    baseSha,
    patch,
    commitMessage,
    trunk,
    abortController,
    onProgress,
  } = args;
  const token = await getAccessToken(accountId);
  const ident = await identFor(accountId);
  let repoCloneDir: string | null = null;
  let worktreePath: string | null = null;
  try {
    onProgress({ phase: 'cloning' });
    ({ repoCloneDir, worktreePath } = await prepWorktree(
      owner,
      name,
      prNumber,
      baseSha,
      token,
    ));

    onProgress({ phase: 'applying_fix' });
    await buildFixCommit(worktreePath, patch, commitMessage, ident);

    onProgress({ phase: 'fetching_trunk' });
    const trunkSha = await fetchTrunk(worktreePath, owner, name, token, trunk);

    onProgress({ phase: 'rebasing' });
    const resolveOpts: ResolveOpts = {
      autoResolve: args.autoResolve,
      model: args.model,
      resolverSystemPrompt: args.resolverSystemPrompt,
      contextNote: commitMessage,
      maxTurns: args.maxTurns,
      maxBudgetUsd: args.maxBudgetUsd,
      abortController,
      onProgress,
    };
    const { any, files } = await runRebase(
      worktreePath,
      trunkSha,
      ident,
      resolveOpts,
    );

    if (abortController.signal.aborted) {
      return {
        diff: '',
        mbox: '',
        filesChanged: [],
        conflictFiles: [],
        resolvedConflicts: false,
        trunkSha,
        aborted: true,
      };
    }

    onProgress({ phase: 'verifying' });
    const range = `${trunkSha}..HEAD`;
    const diff = (await git(['diff', range], worktreePath)).stdout;
    const mbox = (
      await git(['format-patch', '--stdout', range], worktreePath)
    ).stdout;
    const filesChanged = lines(
      (await git(['diff', '--name-only', range], worktreePath)).stdout,
    );
    if (
      mbox.length > config.aiFixPatchMaxBytes ||
      diff.length > config.aiFixPatchMaxBytes
    ) {
      throw new Error('resolved changeset too large to store');
    }
    return {
      diff,
      mbox,
      filesChanged,
      conflictFiles: files,
      resolvedConflicts: any,
      trunkSha,
      aborted: false,
    };
  } finally {
    await teardown(owner, name, repoCloneDir, worktreePath);
  }
}

export async function mergeResolveAndPush(
  args: MergeResolveAndPushArgs,
): Promise<ApplyResolveResult> {
  const {
    accountId,
    owner,
    name,
    prNumber,
    baseSha,
    patch,
    commitMessage,
    trunk,
    target,
    abortController,
    onProgress,
  } = args;
  const token = await getAccessToken(accountId);
  const ident = await identFor(accountId);

  // Head-moved / un-pushable-fork guard for the existing-branch path (a merge only
  // fast-forwards the branch, so a plain push is enough — but the head must not have
  // moved out from under us).
  if (target.kind === 'existing') {
    const info = await fetchPrHeadInfo(token, owner, name, prNumber);
    if (info.headSha !== baseSha) {
      throw codedError(
        'HEAD_MOVED',
        `the PR head advanced (now ${info.headSha.slice(0, 7)}, fix built on ${baseSha.slice(0, 7)})`,
      );
    }
    if (info.isFork && !info.maintainerCanModify) {
      throw codedError(
        'PUSH_DENIED',
        'the PR head is a fork this account cannot push to — push to a new branch instead',
      );
    }
  }

  let repoCloneDir: string | null = null;
  let worktreePath: string | null = null;
  try {
    onProgress({ phase: 'cloning' });
    ({ repoCloneDir, worktreePath } = await prepWorktree(
      owner,
      name,
      prNumber,
      baseSha,
      token,
    ));

    onProgress({ phase: 'applying_fix' });
    await buildFixCommit(worktreePath, patch, commitMessage, ident);

    onProgress({ phase: 'fetching_trunk' });
    const trunkSha = await fetchTrunk(worktreePath, owner, name, token, trunk);

    onProgress({ phase: 'merging' });
    const branchLabel =
      target.kind === 'existing' ? target.headRef : target.branch;
    const merged = await runMerge(worktreePath, trunkSha, trunk, branchLabel, ident, {
      autoResolve: args.autoResolve,
      model: args.model,
      resolverSystemPrompt: args.resolverSystemPrompt,
      contextNote: commitMessage,
      maxTurns: args.maxTurns,
      maxBudgetUsd: args.maxBudgetUsd,
      abortController,
      onProgress,
    });
    if (abortController.signal.aborted) {
      throw codedError('MERGE_FAILED', 'cancelled');
    }

    onProgress({ phase: 'pushing' });
    const commitSha = (await git(['rev-parse', 'HEAD'], worktreePath)).stdout.trim();
    if (target.kind === 'existing') {
      await pushRef(worktreePath, owner, name, token, 'HEAD', target.headRef);
      return {
        pushedBranch: target.headRef,
        commitSha,
        strategy: 'merge',
        resolvedConflicts: merged.any,
        conflictFilesResolved: merged.files,
        forcePushed: false,
      };
    }
    await pushRef(worktreePath, owner, name, token, 'HEAD', target.branch);
    const pr = await createPullRequest(token, {
      owner,
      name,
      head: target.branch,
      base: target.base,
      title: target.title,
      body: target.body,
    });
    return {
      pushedBranch: target.branch,
      commitSha,
      prNumber: pr.number,
      prUrl: pr.url,
      strategy: 'merge',
      resolvedConflicts: merged.any,
      conflictFilesResolved: merged.files,
      forcePushed: false,
    };
  } finally {
    await teardown(owner, name, repoCloneDir, worktreePath);
  }
}

// ---- CORE (free tier): update a PR's OWN branch from its base/trunk ----
// Rebase (default) or merge the trunk into the PR's head branch and push. This is the local,
// clone-based path for the free-tier "Update branch from trunk" — reusing runRebase/runMerge
// with autoResolve:false, so on ANY conflict the op is aborted and CONFLICTS_UNRESOLVED is
// thrown (never the SDK resolver — conflict resolution is a Pro feature). No stored patch is
// involved (unlike the AI-Fix paths above): we check the PR head out as-is and reconcile it.
export async function updatePrBranchFromTrunk(args: {
  accountId: number;
  owner: string;
  name: string;
  prNumber: number;
  headRef: string;
  headSha: string;
  trunk: string;
  strategy: 'rebase' | 'merge';
}): Promise<{ headSha: string; strategy: 'rebase' | 'merge' }> {
  const { accountId, owner, name, prNumber, headRef, headSha, trunk, strategy } = args;
  const token = await getAccessToken(accountId);
  const ident = await identFor(accountId);

  // The head must not have moved out from under us, and a fork head must be pushable.
  const info = await fetchPrHeadInfo(token, owner, name, prNumber);
  if (info.headSha !== headSha) {
    throw codedError(
      'HEAD_MOVED',
      `the PR head advanced (now ${info.headSha.slice(0, 7)}, expected ${headSha.slice(0, 7)})`,
    );
  }
  if (info.isFork && !info.maintainerCanModify) {
    throw codedError(
      'PUSH_DENIED',
      'the PR head is a fork this account cannot push to — update it on GitHub instead',
    );
  }
  // The PR head branch lives in the HEAD repo, which for a fork PR is NOT the base (watched)
  // repo — push there, or a merge would create a stray branch on the base and a rebase's lease
  // would target the wrong ref. The clone/fetch still uses the base repo below (pull/N/head
  // resolves there); only the PUSH target is the head repo. full_name is always `owner/name`.
  const slash = info.headRepoFullName.indexOf('/');
  const headOwner = slash > 0 ? info.headRepoFullName.slice(0, slash) : owner;
  const headName = slash > 0 ? info.headRepoFullName.slice(slash + 1) : name;

  // autoResolve:false → runRebase/runMerge abort on the first conflict and throw
  // CONFLICTS_UNRESOLVED; the model/resolver fields are never touched (no SDK import).
  const opts: ResolveOpts = {
    autoResolve: false,
    model: '',
    abortController: new AbortController(),
    onProgress: () => {},
  };

  let repoCloneDir: string | null = null;
  let worktreePath: string | null = null;
  try {
    // Check out the PR head branch (prepWorktree checks out at the given sha).
    ({ repoCloneDir, worktreePath } = await prepWorktree(owner, name, prNumber, headSha, token));
    const trunkSha = await fetchTrunk(worktreePath, owner, name, token, trunk);

    if (strategy === 'rebase') {
      await runRebase(worktreePath, trunkSha, ident, opts); // throws CONFLICTS_UNRESOLVED on conflict
      const newSha = (await git(['rev-parse', 'HEAD'], worktreePath)).stdout.trim();
      // Rewriting history requires a force push; the lease pins to the sha we cloned so a
      // concurrent push aborts it (never blows away someone else's work).
      await pushForceWithLease(worktreePath, headOwner, headName, token, 'HEAD', headRef, headSha);
      return { headSha: newSha, strategy };
    }

    await runMerge(worktreePath, trunkSha, trunk, headRef, ident, opts); // throws on conflict
    const newSha = (await git(['rev-parse', 'HEAD'], worktreePath)).stdout.trim();
    // A merge only adds a commit (the old head is its ancestor) → a plain push. Already
    // up-to-date (runMerge no-op) leaves HEAD unchanged → nothing to push.
    if (newSha !== headSha) {
      await pushRef(worktreePath, headOwner, headName, token, 'HEAD', headRef);
    }
    return { headSha: newSha, strategy };
  } finally {
    await teardown(owner, name, repoCloneDir, worktreePath);
  }
}

export async function pushResolved(
  args: PushResolvedArgs,
): Promise<ApplyResolveResult> {
  const { accountId, owner, name, prNumber, trunk, mbox, target, onProgress } =
    args;
  const token = await getAccessToken(accountId);
  const ident = await identFor(accountId);

  let leaseSha: string | null = null;
  if (target.kind === 'existing') {
    const info = await fetchPrHeadInfo(token, owner, name, prNumber);
    if (info.isFork && !info.maintainerCanModify) {
      throw codedError(
        'PUSH_DENIED',
        'the PR head is a fork this account cannot push to — push to a new branch instead',
      );
    }
    // The lease is the CURRENT remote head: force-with-lease aborts if it moved.
    leaseSha = info.headSha;
  }

  let repoCloneDir: string | null = null;
  let worktreePath: string | null = null;
  try {
    onProgress?.({ phase: 'cloning' });
    const prep = await prepWorktreeAtRef(owner, name, trunk, token).catch((err) => {
      throw codedError('TRUNK_FETCH_FAILED', `couldn't fetch trunk '${trunk}': ${msg(err)}`);
    });
    repoCloneDir = prep.repoCloneDir;
    worktreePath = prep.worktreePath;

    onProgress?.({ phase: 'applying_fix' });
    await amMbox(worktreePath, mbox, ident);

    onProgress?.({ phase: 'pushing' });
    const commitSha = (await git(['rev-parse', 'HEAD'], worktreePath)).stdout.trim();
    if (target.kind === 'existing') {
      await pushForceWithLease(
        worktreePath,
        owner,
        name,
        token,
        'HEAD',
        target.headRef,
        leaseSha as string,
      );
      return {
        pushedBranch: target.headRef,
        commitSha,
        strategy: 'rebase',
        resolvedConflicts: args.resolvedConflicts,
        conflictFilesResolved: [],
        forcePushed: true,
      };
    }
    await pushRef(worktreePath, owner, name, token, 'HEAD', target.branch);
    const pr = await createPullRequest(token, {
      owner,
      name,
      head: target.branch,
      base: target.base,
      title: target.title,
      body: target.body,
    });
    return {
      pushedBranch: target.branch,
      commitSha,
      prNumber: pr.number,
      prUrl: pr.url,
      strategy: 'rebase',
      resolvedConflicts: args.resolvedConflicts,
      conflictFilesResolved: [],
      forcePushed: false,
    };
  } finally {
    await teardown(owner, name, repoCloneDir, worktreePath);
  }
}
