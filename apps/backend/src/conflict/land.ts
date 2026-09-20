import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  foldFile,
  foldToText,
  type ConflictCommitBody,
  type ConflictCommitPhase,
  type ConflictCommitResult,
  type ConflictDecision,
  type ConflictFileResolution,
  type ConflictLandErrorCode,
  type ConflictRegionDecision,
  type ConflictSkippedFile,
  type ResolvedDecision,
} from '@pierre-review/shared';
import { getAccessToken, getAccountById } from '../auth/account.js';
import { pushForceWithLease, pushRef } from '../coding/git.js';
import { protectedRefsFor } from '../coding/git-ops.js';
import { disarmAutoMerge, getPrWriteContext, WRITE_PERMISSIONS } from '../db/queries.js';
import { ghRestGetText } from '../github/client.js';
import { createPullRequest, fetchPrHeadInfo } from '../github/mutations.js';
import { cleanupCloneCache, ensureClone, withRepoLock } from '../review/clone-manager.js';
import { resyncPrAfterWrite } from '../sync/resync-after-write.js';
import { git, gitTry } from './git.js';
import { conflictModelHash } from './hash.js';
import { allowedDecisions, buildConflictModel } from './model.js';
import type { ConflictModel, ConflictModelFile, ConflictModelRegion } from './model-types.js';

/**
 * THE LAND PATH — turn a set of per-region decisions into a tree, a commit and a push.
 *
 * MEASURED: the whole chain works with NO WORKTREE AND NO CHECKOUT.
 *   GIT_INDEX_FILE=<tmp> git read-tree <tree>
 *   git hash-object -w --stdin        ← no `--path`, so NO clean filter runs and the bytes
 *   git update-index -z --index-info    round-trip by construction rather than by luck
 *   git write-tree
 *   git commit-tree <tree> -p … -F -
 * That makes this feature immune to the worktree-collision and stale-worktree defect classes
 * rather than dependent on their fix, and it means two concurrent jobs on one clone cannot
 * collide: the only mutable state is a scratch index in a per-job temp directory.
 *
 * ⚠ NOTHING THE COMMIT BODY SENDS IS FILE CONTENT. A decision is an enum member; an accepted
 * model suggestion is an opaque `suggestionId` and a hand-edited region an opaque `editId`,
 * whose lines live in the server's session — validated, in the edit's case, on its own route
 * before that id existed. The reader can now type into the centre pane, and this path still
 * folds only bytes it holds. No caller-supplied path is ever resolved against a filesystem
 * either — paths become `update-index` entries in a tree object, which contains harder than any
 * path guard could.
 */

/* ═════════════════════════════════ errors ═════════════════════════════════ */

export interface ConflictLandError extends Error {
  code: ConflictLandErrorCode;
}

/** The land path's own coded error. `coding/git.ts`'s `codedError` carries `CodingErrorCode`,
 *  a different vocabulary; this one is the wire's `ConflictLandErrorCode` so the route can
 *  pass the code straight through to `ConflictCommitState.error`. */
export function landError(code: ConflictLandErrorCode, message: string): ConflictLandError {
  const err = new Error(message) as ConflictLandError;
  err.code = code;
  return err;
}

/* ═════════════════════════════════ the entry point ═════════════════════════════════ */

/** A suggestion the session already validated and stored. The plugin never returns text to
 *  the client, and the client never sends text back — this map is the only place the lines
 *  exist between the two. */
export interface StoredSuggestion {
  fileIndex: number;
  regionId: number;
  lines: string[];
  endsWithNewline: boolean;
}

/**
 * One region's text as the READER typed it, already through `validateConflictEdit` and already
 * pinned to the region's `fingerprint` at mint time. Structurally identical to a
 * `StoredSuggestion` and deliberately a separate type: the two have different provenances and
 * separate stores, and a shared name is the first step towards a shared map.
 */
export interface StoredEdit {
  fileIndex: number;
  regionId: number;
  lines: string[];
  endsWithNewline: boolean;
}

export interface LandArgs {
  accountId: number;
  prId: number;
  /** Namespaces the fetch refs, and names the two refs teardown deletes. */
  sessionId: string;
  /** The model the SESSION holds — the one the user's decisions were made against. */
  model: ConflictModel;
  body: ConflictCommitBody;
  suggestions: ReadonlyMap<string, StoredSuggestion>;
  /** The session's manual edits. Required rather than optional, like `suggestions`: a caller
   *  that forgets it turns every hand-edited region into `UnknownEdit` at push time. */
  edits: ReadonlyMap<string, StoredEdit>;
  onPhase: (p: ConflictCommitPhase) => void;
  signal: AbortSignal;
  /**
   * ⚠ NOT IN THE BUILD PLAN'S SIGNATURE, and required rather than optional on purpose:
   * `resyncPrAfterWrite` takes a logger, and the confirming tail is the difference between
   * `visible: true` and a copy contract about a push the reader cannot see yet. A route has
   * `req.log`; a caller that has to invent one is a caller that should be asking why.
   */
  log: FastifyBaseLogger;
}

export async function landConflictResolution(args: LandArgs): Promise<ConflictCommitResult> {
  const { model, body, signal } = args;
  const repoKey = `${model.owner}/${model.name}`;
  const ns = `refs/pierre/conflict/${args.sessionId}`;

  args.onPhase('preparing');

  // ---- the free pins, before any I/O ----
  // A decision made against different bytes is not a decision, so the session's own model
  // must be the one the client folded. This is cheap and catches a client bug without
  // spending a clone, a fetch and a merge on it.
  if (body.expectedHeadSha !== model.headSha || body.expectedBaseSha !== model.baseSha) {
    throw landError('ModelStale', 'This session was built against different commits.');
  }
  if (conflictModelHash(model) !== body.modelHash) {
    throw landError('ModelStale', 'This merge changed while it was open. Reopen it.');
  }
  if (model.files.length === 0) {
    throw landError('NoConflicts', 'This merge has no conflicts.');
  }
  if (body.strategy === 'rebase' && !model.strategies.includes('rebase')) {
    throw landError(
      'RebaseNotOffered',
      model.rebaseUnavailableReason ?? 'Rebase is not available for this pull request.',
    );
  }

  // ---- the model is the allow-list, and the fold is the same one the pane rendered ----
  // Pure CPU over strings already in memory: no side effect can survive a refusal here, which
  // is why it runs before the rebuild rather than after it. `IncompleteDecisions` is worth
  // getting for free.
  const plan = planResolution(model, body.files, args.suggestions, args.edits);

  // ⚠ REBASE IS ALL-OR-NOTHING. The model only OFFERS rebase when every conflicted file is
  // resolvable, but the request can still leave one out — and a rebased commit that reparents
  // onto the base while a conflicted file keeps head's blob has silently dropped the base
  // branch's version of it, with no marker and no second chance to notice.
  if (body.strategy === 'rebase' && !plan.full) {
    throw landError(
      'RebaseNotOffered',
      'Rebase needs every conflicted file resolved here.',
    );
  }

  if (body.target.kind === 'new_branch') {
    await assertNewBranchName(model, body.target.branch);
  }
  assertNotCancelled(signal);

  let tmpDir: string | null = null;
  let cloneDir: string | null = null;

  try {
    // ⚠ Everything ABOVE this line is pure — no token, no clone, no ref. A refusal up there
    // acquired nothing, and the session's own fetch refs are the SESSION's to drop; the
    // teardown below can only reach them once we hold a clone to delete them in.
    const token = await getAccessToken(args.accountId);
    // The clone is resolved BEFORE the rebuild so that teardown can always reach the session
    // refs — including on the bails (`HeadMoved`, `ModelStale`) where the rebuild is the thing
    // that created them. `withRepoLock` is a queue, not a reentrant lock, so this acquisition
    // must complete before `buildConflictModel` takes its own.
    cloneDir = await withRepoLock(repoKey, () => ensureClone(model.owner, model.name, token));

    // ---- re-derive through the ONE builder ----
    // Not a second derivation path: the same function, so `conflictModelHash` keeps exactly
    // one producer. Only the HEAD is pinned — the base branch is allowed to move under us,
    // and rule 3 below decides whether that matters.
    args.onPhase('fetching');
    const rebuilt = await buildConflictModel({
      accountId: args.accountId,
      prId: args.prId,
      expectHeadSha: body.expectedHeadSha,
      sessionId: args.sessionId,
      onPhase: (p) => args.onPhase(p === 'cloning' || p === 'fetching' ? 'fetching' : 'merging'),
    });
    if (!rebuilt) {
      throw landError('NotPermitted', 'This pull request is no longer available.');
    }
    if (rebuilt.status === 'moved') {
      throw landError(
        'HeadMoved',
        `The pull request moved to ${rebuilt.headSha.slice(0, 7)} while this was open.`,
      );
    }
    if (rebuilt.status === 'clean') {
      throw landError('NoConflicts', 'This merge no longer conflicts.');
    }
    if (rebuilt.status === 'failed') {
      throw landError('GitFailed', rebuilt.message);
    }
    const fresh = rebuilt.model;
    assertNotCancelled(signal);

    // Rule 3: THE BASE MOVED. Reported, never silent, and never a reason to refuse on its own
    // — every contested region the user decided is byte-identical, and the merge picking up
    // the base branch's other commits is what merging the base MEANS.
    //
    // ⚠ The comparison is the CONFLICT CONTENT, not the model hash. `conflictModelHash` folds
    // in `baseSha` and the merged tree oid, both of which move on any base commit at all —
    // so testing the hash here would make this branch unreachable and turn every base advance
    // into `ModelStale`. What has to be unchanged is the material the decisions were made
    // against, which is exactly what `conflictContentMatches` compares.
    const baseAdvanced = fresh.baseSha !== model.baseSha;
    const same = baseAdvanced
      ? conflictContentMatches(model, fresh)
      : conflictModelHash(fresh) === body.modelHash;
    if (!same) {
      throw landError('ModelStale', 'This merge changed while it was open. Reopen it.');
    }

    // ⚠ RE-CHECKED AGAINST THE REBUILT MODEL, not just the session's. A base advance moves
    // the MERGE BASE, and with it the commit count above it — so a PR that was a single
    // commit when the session opened can be two by the time it lands, and reparenting that
    // onto the base tip would silently squash the second commit away, keeping only the
    // first's message.
    if (body.strategy === 'rebase' && !fresh.strategies.includes('rebase')) {
      throw landError(
        'RebaseNotOffered',
        fresh.rebaseUnavailableReason ?? 'Rebase is not available for this pull request.',
      );
    }

    // ---- build the tree ----
    args.onPhase('committing');
    tmpDir = mkdtempSync(join(tmpdir(), 'pierre-conflict-land-'));
    const indexEnv = { GIT_INDEX_FILE: join(tmpDir, 'index') };

    const built = await withRepoLock(repoKey, async () => {
      const dir = cloneDir as string;
      // FULL seeds from merge-tree's own tree, so every file NOBODY conflicted over already
      // carries the merge's answer. PARTIAL seeds from HEAD, so an unresolved file keeps
      // head's blob oid EXACTLY and the base branch's version of it is not silently dropped.
      const seed = plan.full ? fresh.mergedTreeSha : fresh.headSha;
      await git(['read-tree', seed], dir, undefined, indexEnv);

      const entries: string[] = [];
      for (const file of plan.resolved) {
        const hashed = await git(['hash-object', '-w', '--stdin'], dir, file.content);
        const oid = hashed.stdout.toString('utf8').trim();
        if (!/^[0-9a-f]{40,64}$/.test(oid)) {
          throw landError('GitFailed', `git could not store the resolved ${file.path}.`);
        }
        entries.push(`${file.mode} ${oid}\t${file.path}`);
      }
      if (entries.length > 0) {
        await git(
          ['update-index', '-z', '--index-info'],
          dir,
          Buffer.from(`${entries.join('\0')}\0`, 'utf8'),
          indexEnv,
        );
      }

      // ⚠ FULL means the merge commit claims every conflict was settled. merge-tree's tree
      // stores CONFLICT-MARKER CONTENT at each conflicted path (MEASURED via
      // `cat-file -p $TREE:f.txt`), so a path we seeded from it and then failed to overwrite
      // would commit `<<<<<<<` under a two-parent commit. A miss is a refusal, never a commit.
      if (plan.full) {
        const written = new Set(plan.resolved.map((f) => f.path));
        for (const f of fresh.files) {
          if (!written.has(f.path)) {
            throw landError('GitFailed', `The merged tree still holds a conflict in ${f.path}.`);
          }
        }
      }

      const newTree = (await git(['write-tree'], dir, undefined, indexEnv)).stdout
        .toString('utf8')
        .trim();

      // A PARTIAL whose every decision was "ours" produces head's own tree — a commit that
      // says nothing and pushes nothing. The FULL path is allowed an identical tree: that is
      // `-s ours`, and the merge commit itself is the point.
      if (!plan.full) {
        const headTree = (
          await git(['rev-parse', `${fresh.headSha}^{tree}`], dir)
        ).stdout
          .toString('utf8')
          .trim();
        if (newTree === headTree) {
          throw landError(
            'NothingToCommit',
            'Every file already reads exactly as it does on this branch.',
          );
        }
      }

      const ident = await identFor(args.accountId);
      const commitEnv: NodeJS.ProcessEnv = {
        GIT_COMMITTER_NAME: ident.name,
        GIT_COMMITTER_EMAIL: ident.email,
        GIT_AUTHOR_NAME: ident.name,
        GIT_AUTHOR_EMAIL: ident.email,
      };
      let message: string;
      const parents: string[] = [];
      if (body.strategy === 'rebase') {
        // The rebase equivalence: for a SINGLE commit C on merge base M rebased onto base tip
        // B, the three-way is (M, B, C) — the same three inputs as the merge with the sides
        // swapped — so the resolved tree IS the merge path's tree and the rebased commit is
        // just that tree reparented onto B. No `git rebase` process runs, so there is no
        // stall, no `--continue` and no abort path to get wrong.
        const original = await readCommitIdent(cloneDir as string, fresh.headSha);
        commitEnv.GIT_AUTHOR_NAME = original.name;
        commitEnv.GIT_AUTHOR_EMAIL = original.email;
        commitEnv.GIT_AUTHOR_DATE = original.date;
        message = original.message;
        parents.push('-p', fresh.baseSha);
      } else if (plan.full) {
        message = fullMergeMessage(fresh, plan);
        parents.push('-p', fresh.headSha, '-p', fresh.baseSha);
      } else {
        message = partialMessage(fresh, plan);
        parents.push('-p', fresh.headSha);
      }

      const commit = await git(
        ['commit-tree', newTree, ...parents, '-F', '-'],
        dir,
        Buffer.from(capMessage(message), 'utf8'),
        commitEnv,
      );
      return { newTree, commitSha: commit.stdout.toString('utf8').trim() };
    });
    assertNotCancelled(signal);

    /* ───────────────────────── push safety ─────────────────────────
       Immediately before the irreversible half, and after the tree and the commit already
       exist, so the window between the checks and the push is milliseconds — the
       `auto-merge-runner.ts` land-time re-check pattern. */
    args.onPhase('pushing');
    const ctx = await getPrWriteContext(args.prId, args.accountId);
    if (!ctx || ctx.state !== 'open') {
      throw landError('NotPermitted', 'This pull request is no longer open.');
    }
    if (!WRITE_PERMISSIONS.has(ctx.viewerPermission ?? '')) {
      throw landError('NotPermitted', 'You do not have write access to this repository.');
    }

    const info = await fetchPrHeadInfo(token, model.owner, model.name, model.number);
    if (info.headSha !== body.expectedHeadSha) {
      throw landError(
        'HeadMoved',
        `The pull request moved to ${info.headSha.slice(0, 7)} while this was open.`,
      );
    }

    // The PR head branch lives in the HEAD repo, which for a fork PR is not the watched one.
    // A NEW branch always lands in the watched repo instead, which is why the fork check is
    // the pr_branch path's alone.
    const target = body.target;
    const toPrBranch = target.kind === 'pr_branch';
    let pushOwner = model.owner;
    let pushName = model.name;
    if (target.kind === 'pr_branch') {
      if (info.isFork && !info.maintainerCanModify) {
        throw landError(
          'PushDenied',
          'This pull request comes from a fork that does not allow maintainer edits. Push to a new branch instead.',
        );
      }
      const slash = info.headRepoFullName.indexOf('/');
      if (slash > 0) {
        pushOwner = info.headRepoFullName.slice(0, slash);
        pushName = info.headRepoFullName.slice(slash + 1);
      }
    }

    // ⚠ DISARM FIRST, and not for tidiness. A merge-strategy resolution commit has exactly
    // the two-parent shape `isOurUpdateMerge` proves against, so an intent still holding a
    // live `updateIssuedAgainstOid` would ADOPT this commit, re-pin to it and land code the
    // reader never consented to merge. Disarming makes that unreachable instead of relying on
    // the window being narrow.
    const autoMergeDisarmed = await disarmAutoMerge(args.accountId, args.prId);

    const protect = await protectedRefsFor(
      args.accountId,
      model.owner,
      model.name,
      model.number,
      pushOwner,
      pushName,
    );
    const push = {
      worktree: cloneDir,
      owner: pushOwner,
      name: pushName,
      token,
      committish: built.commitSha,
      protect,
    };

    let branch: string;
    let compareUrl: string | null = null;
    if (target.kind === 'pr_branch') {
      branch = info.headRef;
      if (body.strategy === 'rebase') {
        // ⚠ THE VALUE FORM OF THE LEASE. A bare `--force-with-lease` leases against the
        // remote-tracking ref, which our own fetch just updated — it would pass every time.
        await pushForceWithLease({
          ...push,
          remoteBranch: branch,
          leaseSha: body.expectedHeadSha,
        });
      } else {
        await pushRef({ ...push, remoteBranch: branch });
      }
    } else {
      branch = await pickFreeBranch(token, pushOwner, pushName, target.branch);
      await pushRef({ ...push, remoteBranch: branch });
      compareUrl = `https://github.com/${pushOwner}/${pushName}/compare/${encodeURIComponent(
        model.baseRef,
      )}...${encodeURIComponent(branch)}`;
      if (target.openPr) {
        // ⚠ ONCE GITHUB 201s, NOTHING BELOW MAY THROW. A retry double-posts, and the copy
        // contract for an unconfirmed write is "it'll show up here shortly", never "it failed".
        const opened = await createPullRequest(token, {
          owner: pushOwner,
          name: pushName,
          head: branch,
          base: model.baseRef,
          title: `Resolve conflicts with ${model.baseRef} for #${model.number}`,
          body: `Conflict resolution for #${model.number}.`,
        }).catch(() => null);
        if (opened) compareUrl = opened.url;
      }
    }

    args.onPhase('confirming');
    const visible = await resyncPrAfterWrite({
      prId: args.prId,
      accountId: args.accountId,
      log: args.log,
    });

    return {
      strategy: body.strategy,
      branch,
      pushedToPrBranch: toPrBranch,
      commitSha: built.commitSha,
      resolvedPaths: plan.resolved.map((f) => f.path),
      skipped: plan.skipped,
      stillConflicting: !plan.full,
      baseAdvanced,
      baseShaUsed: fresh.baseSha,
      autoMergeDisarmed,
      compareUrl,
      visible,
    };
  } finally {
    // Every step independently swallowed: a teardown failure must never be what the reader
    // sees instead of the result they got.
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    if (cloneDir) {
      for (const ref of [`${ns}/head`, `${ns}/base`]) {
        await gitTry(['update-ref', '-d', ref], cloneDir).catch(() => {});
      }
    }
    setImmediate(() => {
      try {
        cleanupCloneCache();
      } catch {
        /* advisory */
      }
    });
  }
}

/* ═════════════════════════════════ the resolution plan ═════════════════════════════════ */

interface ResolvedFile {
  index: number;
  path: string;
  mode: string;
  content: Buffer;
}

interface ResolutionPlan {
  resolved: ResolvedFile[];
  skipped: ConflictSkippedFile[];
  /** Every conflicted path is resolved — the only shape allowed a two-parent commit. */
  full: boolean;
  /** Conflicted paths with no resolution, for the partial commit's message. */
  unresolved: ConflictModelFile[];
}

/**
 * Turn the request's per-region decisions into per-file bytes, or refuse.
 *
 * THE MODEL IS THE ALLOW-LIST. Every index, every region id and every decision is checked
 * against it, and a `suggestionId` / `editId` is checked against the session's own store — so
 * the only text that can reach a blob is text the server holds: either produced here, or typed
 * by the reader and validated on the edit route before its id existed.
 */
function planResolution(
  model: ConflictModel,
  files: readonly ConflictFileResolution[],
  suggestions: ReadonlyMap<string, StoredSuggestion>,
  edits: ReadonlyMap<string, StoredEdit>,
): ResolutionPlan {
  const byIndex = new Map(model.files.map((f) => [f.index, f]));
  const resolved: ResolvedFile[] = [];
  const seenFiles = new Set<number>();

  for (const req of files) {
    const file = byIndex.get(req.index);
    if (!file) {
      throw landError('UnknownFileIndex', `This merge has no file ${req.index}.`);
    }
    if (seenFiles.has(req.index)) {
      throw landError('UnknownFileIndex', `File ${file.path} was sent twice.`);
    }
    seenFiles.add(req.index);
    // An unsupported file has no blob triple to resolve, and a resolvable one with no stage-2
    // mode has nothing to write the result back AS. Either way it is not on offer, and
    // pretending otherwise would put an unreviewed blob in the tree.
    if (file.unsupported !== null || file.stage2Mode === null) {
      throw landError(
        'UnknownFileIndex',
        `${file.path} cannot be resolved here${
          file.unsupportedLabel ? ` (${file.unsupportedLabel.toLowerCase()})` : ''
        }.`,
      );
    }

    const decisions = new Map<number, ResolvedDecision>();
    const regionsById = new Map(file.regions.map((r) => [r.id, r]));
    for (const d of req.decisions) {
      const region = regionsById.get(d.id);
      if (!region) {
        throw landError(
          'IncompleteDecisions',
          `${file.path} has no region ${d.id}.`,
        );
      }
      if (decisions.has(d.id)) {
        throw landError(
          'IncompleteDecisions',
          `${file.path} carries two decisions for the same region.`,
        );
      }
      decisions.set(d.id, resolveDecision(file, region, d, suggestions, edits));
    }

    // Rule 2 of the fold, enforced here so the refusal names the file: EXHAUSTIVE over every
    // non-`unchanged` region. A missing one is a line of code nobody chose.
    for (const region of file.regions) {
      if (region.kind === 'unchanged') continue;
      if (!decisions.has(region.id)) {
        throw landError(
          'IncompleteDecisions',
          `${file.path} still has an undecided change.`,
        );
      }
    }

    const folded = foldFile({ regions: file.regions, terminators: file.terminators }, decisions);
    if (!folded.ok) {
      throw landError(
        'IncompleteDecisions',
        `${file.path} could not be assembled (${folded.reason}).`,
      );
    }
    resolved.push({
      index: file.index,
      path: file.path,
      mode: file.stage2Mode,
      // Every side decoded STRICTLY as UTF-8 at model build, so this re-encode round-trips
      // byte for byte. That is the whole reason `not_text` is a refusal rather than a
      // lossy decode.
      content: Buffer.from(foldToText(folded), 'utf8'),
    });
  }

  const unresolved = model.files.filter((f) => !seenFiles.has(f.index));
  const skipped: ConflictSkippedFile[] = [];
  for (const f of unresolved) {
    if (f.unsupported === null) continue;
    skipped.push({
      index: f.index,
      path: f.path,
      reason: f.unsupported,
      label: f.unsupportedLabel ?? '',
    });
  }

  return { resolved, skipped, full: unresolved.length === 0, unresolved };
}

/** One region's decision, with the three payload-bearing members resolved from the places their
 *  lines actually live — never recomputed, so the fold that lands is the fold that was
 *  reviewed. */
function resolveDecision(
  file: ConflictModelFile,
  region: ConflictModelRegion,
  sent: ConflictRegionDecision,
  suggestions: ReadonlyMap<string, StoredSuggestion>,
  edits: ReadonlyMap<string, StoredEdit>,
): ResolvedDecision {
  const decision: ConflictDecision = sent.decision;
  if (decision === 'suggestion') {
    if (!sent.suggestionId) {
      throw landError('UnknownSuggestion', `${file.path} accepted a suggestion with no id.`);
    }
    const stored = suggestions.get(sent.suggestionId);
    // The id must address THIS region: a suggestion is a handle on one hunk's lines, and a
    // handle that travels to another hunk is text nobody read in the place it lands.
    if (!stored || stored.fileIndex !== file.index || stored.regionId !== region.id) {
      throw landError('UnknownSuggestion', 'That suggestion is no longer available.');
    }
    return {
      decision: 'suggestion',
      lines: stored.lines,
      endsWithNewline: stored.endsWithNewline,
    };
  }
  if (decision === 'edited') {
    if (!sent.editId) {
      throw landError('UnknownEdit', `${file.path} carries an edit with no id.`);
    }
    const stored = edits.get(sent.editId);
    // ⚠ THE SAME GUARD, FOR THE SAME REASON, AND IT IS NOT REDUNDANT WITH THE FINGERPRINT CHECK
    // THE EDIT ROUTE ALREADY MADE. That one proved the text was written against THIS region's
    // bytes; this one proves the handle has not since been moved onto a different region by the
    // commit body. Both are "text nobody read, in the place it lands" — one across time, one
    // across regions.
    if (!stored || stored.fileIndex !== file.index || stored.regionId !== region.id) {
      throw landError('UnknownEdit', 'That edit is no longer available.');
    }
    return {
      decision: 'edited',
      lines: stored.lines,
      endsWithNewline: stored.endsWithNewline,
    };
  }
  if (!allowedDecisions(region).includes(decision)) {
    throw landError(
      'IncompleteDecisions',
      `${file.path} cannot take '${decision}' on this change.`,
    );
  }
  if (decision === 'disjoint_merge') {
    // Non-null iff the wand called it `disjoint_words`, which `allowedDecisions` already
    // gates on — this is the belt to that braces, because a null here would fold to nothing.
    if (region.mergedLines === null) {
      throw landError(
        'IncompleteDecisions',
        `${file.path} has no word-level merge for this change.`,
      );
    }
    return {
      decision: 'disjoint_merge',
      lines: region.mergedLines,
      // Fold rule 4: the word merge is built on the ours side, so it inherits its terminator.
      endsWithNewline: file.terminators.ours,
    };
  }
  return { decision };
}

/* ═════════════════════════════════ staleness ═════════════════════════════════ */

/**
 * Did the material the decisions were made against change?
 *
 * ⚠ THIS IS NOT `conflictModelHash`, and it must not become it. The hash pins the two
 * COMMITS and the merged tree, all of which move when the base branch gains any commit at
 * all — so it answers "is this the same merge", while the question here is "are these the
 * same conflicts". A base advance that leaves every contested region byte-identical is
 * reported as `baseAdvanced`, not refused.
 */
function conflictContentMatches(a: ConflictModel, b: ConflictModel): boolean {
  if (a.files.length !== b.files.length) return false;
  if (a.renameDetection !== b.renameDetection || a.truncated !== b.truncated) return false;
  for (let i = 0; i < a.files.length; i++) {
    const x = a.files[i];
    const y = b.files[i];
    if (!x || !y) return false;
    if (x.index !== y.index || x.path !== y.path) return false;
    if (x.unsupported !== y.unsupported || x.stage2Mode !== y.stage2Mode) return false;
    if (
      x.terminators.base !== y.terminators.base ||
      x.terminators.ours !== y.terminators.ours ||
      x.terminators.theirs !== y.terminators.theirs
    ) {
      return false;
    }
    if (x.regions.length !== y.regions.length) return false;
    for (let r = 0; r < x.regions.length; r++) {
      const p = x.regions[r];
      const q = y.regions[r];
      if (!p || !q) return false;
      if (p.id !== q.id || p.kind !== q.kind || p.fingerprint !== q.fingerprint) return false;
      if (p.wand?.decision !== q.wand?.decision || p.wand?.reason !== q.wand?.reason) return false;
      if ((p.mergedLines === null) !== (q.mergedLines === null)) return false;
      if (p.mergedLines && q.mergedLines) {
        if (p.mergedLines.length !== q.mergedLines.length) return false;
        for (let l = 0; l < p.mergedLines.length; l++) {
          if (p.mergedLines[l] !== q.mergedLines[l]) return false;
        }
      }
    }
  }
  return true;
}

/* ═════════════════════════════════ branch names ═════════════════════════════════ */

/** Reserved BY NAME — the repo default branch and the PR base ref. Case-insensitive, because
 *  on a case-folding filesystem `Main` and `main` are the same branch and the refusal has to
 *  hold for the spelling the user typed. */
async function assertNewBranchName(model: ConflictModel, branch: string): Promise<void> {
  const wanted = branch.trim();
  if (!wanted) throw landError('InvalidBranch', 'Give the new branch a name.');
  const lowered = wanted.toLowerCase();
  if (model.reservedBranchNames.some((r) => r.toLowerCase() === lowered)) {
    throw landError('ReservedBranch', `${wanted} is this repository's own branch.`);
  }
  if (
    wanted.startsWith('-') ||
    wanted.startsWith('/') ||
    wanted.endsWith('/') ||
    wanted.includes('//')
  ) {
    throw landError('InvalidBranch', `git does not accept ${wanted} as a branch name.`);
  }
  // git's own format check is the authority; a regex here would refuse real branch names.
  const res = await gitTry(['check-ref-format', `refs/heads/${wanted}`], tmpdir());
  if (res.code !== 0) {
    throw landError('InvalidBranch', `git does not accept ${wanted} as a branch name.`);
  }
}

/**
 * The first free name at or after `wanted`, `-2` … `-9`, then a refusal.
 *
 * A live ref under this name belongs to someone — an earlier attempt, a person — so it is
 * never overwritten. The ladder is what makes a second attempt after a failed push work
 * without the reader having to invent a name; the result names the branch that was actually
 * created, so nothing about it is silent.
 */
async function pickFreeBranch(
  token: string,
  owner: string,
  name: string,
  wanted: string,
): Promise<string> {
  for (let n = 1; n <= 9; n++) {
    const candidate = n === 1 ? wanted : `${wanted}-${n}`;
    const existing = await ghRestGetText(
      token,
      `/repos/${owner}/${name}/git/ref/heads/${candidate}`,
    );
    if (!existing.ok) return candidate;
  }
  throw landError('BranchExists', `${wanted} and its numbered variants all exist already.`);
}

/* ═════════════════════════════════ commit messages ═════════════════════════════════ */

const MESSAGE_MAX_BYTES = 8 * 1024;
const PATHS_LISTED = 20;

function capMessage(message: string): string {
  const buf = Buffer.from(message, 'utf8');
  if (buf.length <= MESSAGE_MAX_BYTES) return message;
  // Slice on a character boundary, not a byte one: a half-encoded sequence in a commit
  // message is a mojibake bug that outlives the session by a long way.
  let cut = message;
  while (Buffer.byteLength(cut, 'utf8') > MESSAGE_MAX_BYTES - 1) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9) || 0);
  }
  return `${cut}\n`;
}

function pathList(paths: readonly string[]): string[] {
  const shown = paths.slice(0, PATHS_LISTED).map((p) => `  ${p}`);
  if (paths.length > PATHS_LISTED) shown.push(`  …and ${paths.length - PATHS_LISTED} more`);
  return shown;
}

function fullMergeMessage(model: ConflictModel, plan: ResolutionPlan): string {
  const paths = plan.resolved.map((f) => f.path);
  return [
    `Merge branch '${model.baseRef}' into ${model.headRef || 'this branch'}`,
    '',
    `Resolved conflicts in ${paths.length} ${paths.length === 1 ? 'file' : 'files'}:`,
    ...pathList(paths),
    '',
  ].join('\n');
}

/** ⚠ THE WORD "MERGE" MUST NOT APPEAR. A partial resolution is a plain one-parent commit on
 *  the PR branch, and calling it a merge in the log is a claim that the base branch landed. */
function partialMessage(model: ConflictModel, plan: ResolutionPlan): string {
  const paths = plan.resolved.map((f) => f.path);
  const lines = [
    `Resolve conflicts in ${paths.length} of ${model.files.length} files`,
    '',
    ...pathList(paths),
  ];
  if (plan.unresolved.length > 0) {
    lines.push('');
    for (const f of plan.unresolved.slice(0, PATHS_LISTED)) {
      lines.push(`Still conflicting: ${f.path}${f.unsupportedLabel ? ` (${f.unsupportedLabel})` : ''}`);
    }
    if (plan.unresolved.length > PATHS_LISTED) {
      lines.push(`…and ${plan.unresolved.length - PATHS_LISTED} more`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/* ═════════════════════════════════ small helpers ═════════════════════════════════ */

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw landError('Cancelled', 'Cancelled.');
}

interface CommitIdent {
  name: string;
  email: string;
  date: string;
  message: string;
}

/** The original commit's author and message, for the rebase path. The committer is the
 *  account doing the resolving — the author wrote the code, we only moved it. */
async function readCommitIdent(cloneDir: string, sha: string): Promise<CommitIdent> {
  const out = await git(
    ['show', '-s', '--format=%an%x00%ae%x00%aI%x00%B', sha],
    cloneDir,
  );
  const parts = out.stdout.toString('utf8').split('\0');
  return {
    name: parts[0] ?? 'pierre-review',
    email: parts[1] ?? 'pierre-review@users.noreply.github.com',
    date: parts[2] ?? new Date().toISOString(),
    message: parts[3] ?? '',
  };
}

interface Ident {
  name: string;
  email: string;
}

/** The `coding/merge.ts` ident, which is module-private there. Same fallbacks on purpose:
 *  two spellings of "who committed this" would show up in the git log as two people. */
async function identFor(accountId: number): Promise<Ident> {
  const account = await getAccountById(accountId);
  return {
    name: account?.displayName || account?.githubLogin || 'pierre-review',
    email: account?.githubLogin
      ? `${account.githubLogin}@users.noreply.github.com`
      : 'pierre-review@users.noreply.github.com',
  };
}
