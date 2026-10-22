import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AnnotationKind, AnnotationTargetKind, BlastSignals } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';

// The corpus + target for the blast-radius IMPACT NOTE — the one kind left on the annotations
// platform. (The comment-level corpus — threads, review comments, PR comments, commits, hydrated
// hunks — left with the removed validity / addressed / simplify judgements.)

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const clamp = (s: string | null | undefined, n: number): string =>
  s == null ? '' : s.length > n ? `${s.slice(0, n)}…` : s;

// ---- the corpus ----------------------------------------------------------------------------

export interface PrCorpus {
  prId: number;
  repoId: number;
  prNumber: number;
  prTitle: string | null;
  repoFullName: string;
  /** The PR's head sha — part of the impact payload hash. */
  headSha: string | null;
  /** The pull request's DESCRIPTION. ⚠ Attacker-authored: it reaches the model only inside the
   *  fenced UNTRUSTED block. */
  prBody: string | null;
  /** The changed files, path + per-file churn. Straight from the stored column. */
  files: { path: string; additions: number; deletions: number }[];
  /** The DETERMINISTIC blast-radius vector, folded by CORE (`db/blast-radius.ts`) and handed over
   *  through `ctx.queries.getBlastSignals`.
   *
   *  ⚠ NEVER RE-DERIVED HERE. A second path classifier on the plugin side could disagree with the
   *  chip rendered inches away, and the note's entire job is to explain that chip. Null when the
   *  host is older than the seam, or when the pull request was never measured — the `impact`
   *  target is simply not enumerated in either case, because there is nothing to explain. */
  blast: BlastSignals | null;
}

/**
 * Load everything the impact prompt needs for one PR, ownership-scoped
 * (pullRequests.accountId). Returns null for a foreign or unknown PR → the caller 404s.
 */
export async function loadPrCorpus(
  ctx: ProContext,
  accountId: number,
  prId: number,
): Promise<PrCorpus | null> {
  const prsT = ctx.schema.pullRequests;
  const prRows = (await ctx.db
    .select({
      id: prsT.id,
      repoId: prsT.repoId,
      number: prsT.number,
      title: prsT.title,
      body: prsT.body,
      files: prsT.files,
      headSha: prsT.headSha,
    })
    .from(prsT)
    .where(and(eq(prsT.id, prId), eq(prsT.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{
    id: number;
    repoId: number;
    number: number;
    title: string | null;
    body: string | null;
    files: { path: string; additions: number; deletions: number }[] | null;
    headSha: string | null;
  }>;
  const pr = prRows[0];
  if (!pr) return null;

  const reposT = ctx.schema.repos;
  const repoRows = (await ctx.db
    .select({ owner: reposT.owner, name: reposT.name })
    .from(reposT)
    .where(eq(reposT.id, pr.repoId))
    .limit(1)
    .execute()) as Array<{ owner: string; name: string }>;
  const repoFullName = repoRows[0] ? `${repoRows[0].owner}/${repoRows[0].name}` : '';

  return {
    prId: pr.id,
    repoId: pr.repoId,
    prNumber: pr.number,
    prTitle: pr.title,
    repoFullName,
    headSha: pr.headSha,
    prBody: pr.body,
    files: pr.files ?? [],
    // ⚠ CORE'S FOLD, never a plugin re-derivation — see the field's doc. The seam is OPTIONAL, so
    // an older host leaves this null and `impact` simply never enumerates a target.
    blast: (await ctx.queries.getBlastSignals?.(accountId, prId)) ?? null,
  };
}

// ---- the target ----------------------------------------------------------------------------

export interface AnnotationTarget {
  kind: AnnotationKind;
  targetKind: AnnotationTargetKind;
  targetId: number;
  prId: number;
  repoId: number;
  /** The $0-on-unchanged signature of everything that could change this judgement. */
  payloadHash: string;
  /** The full single-call user prompt. */
  prompt: string;
}

// ---- impact (BLAST RADIUS, the Pro half) ---------------------------------------------------

/** How much of a file list to show the model. A pull request past this is described by its first
 *  N files plus a count — the point is what it TOUCHES, and a 400-line file listing buys nothing
 *  that the first forty do not. */
const IMPACT_MAX_FILES = 40;

/** How much of the pull-request description to carry. Attacker-authored, fenced, and clamped for
 *  the same budget reason every other body on this surface is. */
const IMPACT_MAX_BODY_CHARS = 1200;

/** The deterministic LEVEL, recomputed here for the PROMPT only.
 *
 *  ⚠ THIS IS NOT A SECOND RESOLVER. The SPA's `blastRadius()` owns the level a user sees; this is
 *  a coarse restatement so the model knows roughly what it is explaining, and its only consumer
 *  is a sentence of prompt text. It deliberately reads ONLY the fields that cannot be configured
 *  away, so it can never contradict the chip in the direction that matters: if the chip says high
 *  and this says medium, the model is merely told less, and the level the reader sees is
 *  unchanged. Nothing it produces is stored or rendered. */
function promptLevelFor(b: BlastSignals): 'low' | 'medium' | 'high' {
  // ⚠ THE TRIVIAL-CHANGE CAP, MIRRORED. The SPA's resolver caps a comments-only or
  // formatting-only change at medium; if this said "high" the model would be explaining a
  // verdict the reader is not looking at. First, so it wins over every arm below — exactly the
  // order `blastRadius()` applies it in.
  const trivial = b.contentKind === 'comments' || b.contentKind === 'formatting';
  if (b.surfaces.some((x) => x !== 'ci' && x !== 'deps')) return trivial ? 'medium' : 'high';
  if (b.hubDegree != null && b.hubBar != null && b.hubDegree >= b.hubBar) {
    return trivial ? 'medium' : 'high';
  }
  if (b.subsystems >= 3 || b.dirs >= 6 || b.codeFiles >= 15) return trivial ? 'medium' : 'high';
  if (b.codeFiles === 0 || (b.codeFiles <= 3 && b.subsystems <= 1)) return 'low';
  return 'medium';
}

/**
 * The ONE `impact` target for a pull request — or null when there is nothing to explain.
 *
 * ⚠ IT REFUSES ON AN UNMEASURED PULL REQUEST. `blast == null` is the same ~10% population the
 * chip renders nothing for; asking a model to describe a diff nobody measured is how a confident
 * paragraph gets written about a file list we do not hold.
 */
export function impactForPr(corpus: PrCorpus): AnnotationTarget | null {
  const b = corpus.blast;
  if (b == null) return null;
  // Nothing changed that anyone reads → nothing to say. (A pull request with no files at all is
  // also the shape a failed sync leaves behind.)
  if (corpus.files.length === 0) return null;

  const level = promptLevelFor(b);
  const shown = corpus.files.slice(0, IMPACT_MAX_FILES);
  const more = corpus.files.length - shown.length;
  const fileList = shown
    .map((f) => `${f.path} (+${f.additions} -${f.deletions})`)
    .join('\n');

  const surfaces = b.surfaces.length > 0 ? b.surfaces.join(', ') : 'none';
  const hub =
    b.hubDegree != null && b.hubPath != null
      ? `\n${b.hubPath} has historically changed alongside ${b.hubDegree} other files in this repository.`
      : '';

  // ⚠ THE CHANGE SHAPE IS STATED FIRST WHEN WE HAVE IT, and it is the strongest fact on this
  // list. Without it a model shown "crypto/ touched" will reach for a security consequence that
  // a documentation change does not have — the exact hallucination the deterministic cap exists
  // to prevent, one layer up. `null` says nothing rather than claiming the change IS code, for
  // the same reason the cap does not fire on null.
  const shape =
    b.contentKind === 'comments'
      ? 'READ FROM THE DIFF: every changed line in every code file is a COMMENT. No code behaviour changed.'
      : b.contentKind === 'formatting'
        ? 'READ FROM THE DIFF: the added and removed lines are the same lines with different whitespace. This is a formatting change only.'
        : '';

  const facts = [
    shape,
    `Computed blast radius: ${level}.`,
    `${b.codeFiles} code files, ${b.testFiles} test files, ${b.nonCodeFiles} documentation/config files, across ${b.dirs} directories and ${b.subsystems} top-level areas.`,
    `Contract surfaces touched: ${surfaces}.${hub}`,
    b.truncated ? 'The file list below was TRUNCATED by GitHub, so it is incomplete.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = `${facts}

---BEGIN PULL REQUEST---
Title: ${clamp(corpus.prTitle, 200)}
Description: ${clamp(corpus.prBody, IMPACT_MAX_BODY_CHARS) || '(none)'}

Changed files:
${fileList}${more > 0 ? `\n… and ${more} more files` : ''}
---END PULL REQUEST---`;

  return {
    kind: 'impact',
    targetKind: 'pull_request',
    targetId: corpus.prId,
    prId: corpus.prId,
    repoId: corpus.repoId,
    payloadHash: impactPayloadHash(corpus, b),
    prompt,
  };
}

/**
 * The $0-on-unchanged signature of an impact judgement.
 *
 * ⚠ EVERY INPUT IS A STORED FACT AND NOTHING IS DERIVED FROM `now`. The free cached GET
 * recomputes this on every PR open, on a path that hydrates nothing — so a value that were
 * hydrated, or clock-derived, would make the GET and the run disagree forever: every judgement
 * permanently `stale`, re-billed on every click. That defect has already cost this codebase two
 * bugs; see `PrCorpus.hydratedHunkByCommentId`.
 *
 * ⚠ THE HUB FIELDS ARE IN. They come from a DERIVED table that a later sync can rebuild, which is
 * exactly why they belong: if a file becomes a hub, the note that did not mention it IS stale.
 */
function impactPayloadHash(corpus: PrCorpus, b: BlastSignals): string {
  return sha(
    [
      'i1',
      corpus.prId,
      // The head sha alone would miss a force-push that lands the same tree, and the file list
      // alone would miss a same-files rewrite. Both, cheaply.
      corpus.headSha ?? '',
      corpus.files.map((f) => `${f.path}:${f.additions}:${f.deletions}`).join(','),
      corpus.prTitle ?? '',
      clamp(corpus.prBody, IMPACT_MAX_BODY_CHARS),
      b.codeFiles,
      b.testFiles,
      b.nonCodeFiles,
      b.dirs,
      b.subsystems,
      b.surfaces.join('|'),
      b.allNew ? '1' : '0',
      b.truncated ? '1' : '0',
      b.hubDegree ?? '',
      b.hubBar ?? '',
      b.hubPath ?? '',
      // ⚠ IN THE HASH. The change shape arrives LATER than the first note for a pull request —
      // the diff read happens on a subsequent sync — so a note written before it landed describes
      // the change without knowing it was comments-only. Folding it in marks exactly those notes
      // stale and offers a re-read; leaving it out would freeze the wrong answer forever.
      b.contentKind ?? '',
    ].join('|'),
  );
}

/**
 * The CURRENT payload hash for one already-stored row, used to compute `stale` on read. Null when
 * the target no longer exists or the kind is not one this module knows (a DORMANT row of a removed
 * kind is skipped before it gets here).
 *
 * ⚠ The hash is recomputed from the SAME builder the run uses, never a second formula. And it
 * returns null once the pull request can no longer be measured — a stored note about a diff we
 * have since lost the file list for is GONE, not stale.
 */
export function currentHashFor(
  corpus: PrCorpus,
  kind: string,
  targetKind: string,
  targetId: number,
): string | null {
  if (kind !== 'impact' || targetKind !== 'pull_request' || targetId !== corpus.prId) return null;
  return corpus.blast ? impactPayloadHash(corpus, corpus.blast) : null;
}
