import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { getPrWriteContext, WRITE_PERMISSIONS } from '../db/queries.js';
import { getSession, storeSuggestion } from './session.js';
import type { ConflictModel, ConflictModelFile } from './model-types.js';
import {
  conflictFences,
  hunkRegionChars,
  validateConflictSuggestion,
  HUNK_CONTEXT_LINES,
  HUNK_CONTEXT_LINE_CHARS,
  type ConflictFences,
  type ConflictHunkContext,
  type ConflictHunkLoadError,
  type ConflictHunkRef,
  type ConflictSuggestionCheck,
} from './suggestion.js';

/**
 * THE PRO CONFLICT SEAM — how the plugin reaches one hunk, and how its answer gets back.
 *
 * The shape of the exchange is the security property:
 *
 *   · The plugin sends the host an ADDRESS (`{prId, sessionId, fileIndex, regionId,
 *     fingerprint}`, ~200 bytes) and the host reads the bytes out of its OWN session. No source
 *     code travels in the request body, so there is no client-forgeable region and no way to ask
 *     the model about text that is not in a merge this reader opened.
 *   · The VALIDATORS are core's (`suggestion.ts`), not the plugin's — see that file's header for
 *     why. The plugin runs the model; it never decides whether an answer is usable.
 *   · The plugin NEVER RETURNS TEXT TO THE CLIENT. It hands validated lines back here, the HOST
 *     stores them and mints the `suggestionId`, and the commit body carries only that id. So the
 *     lines the fold splices are lines the server produced, held in the server's own memory, and
 *     shown to the reader read-only in between.
 *
 * ⚠ THE SESSION IS SCOPED BY `accountId` AND THAT IS NOT THE WHOLE CHECK. `getSession` keys on
 * `(accountId, prId)`, so it cannot cross tenants — but a session outlives nothing else, and the
 * ownership rule the six core routes share is `getPrWriteContext` → 404 / WRITE → 403. This seam
 * runs it too rather than leaning on the session, because a reader who lost push access mid-way
 * has no business spending money to have their conflict rewritten.
 */

export interface ConflictSeam {
  /** The marker pair for every fenced prompt region. ONE producer, so the prompt's fences and
   *  the validator's extraction cannot come apart. */
  fences(nonce: string): ConflictFences;
  loadHunk(
    accountId: number,
    ref: ConflictHunkRef,
  ): Promise<
    { ok: true; hunk: ConflictHunkContext } | { ok: false; error: ConflictHunkLoadError }
  >;
  /** PURE. Returns the validated lines; the HOST stores them and mints the `suggestionId`. */
  validateSuggestion(
    hunk: ConflictHunkContext,
    nonce: string,
    rawModelText: string,
  ): ConflictSuggestionCheck;
  /**
   * Host-side store. Returns the handle the commit body carries, or NULL when the session went
   * away between the model answering and now — a restart or a close, both of which the reader
   * can do while Claude is thinking. Minting an id into a store nothing can read would be worse
   * than saying so.
   */
  storeSuggestion(
    accountId: number,
    ref: ConflictHunkRef,
    lines: string[],
    endsWithNewline: boolean,
  ): string | null;
}

/** Clip one context line. Safe in a way clipping the region is not — context is read-only in the
 *  prompt and never spliced back, and check 6 compares against exactly these strings. */
const clip = (line: string): string =>
  line.length > HUNK_CONTEXT_LINE_CHARS ? `${line.slice(0, HUNK_CONTEXT_LINE_CHARS)}…` : line;

/**
 * The lines either side of a region, walked out across its neighbours.
 *
 * ⚠ ANCESTOR TEXT, NOT THE CENTRE PANE. The centre is whatever the reader has decided so far,
 * which moves while they work and is different in two tabs; the ancestor is the one text both
 * branches agree existed. Nothing here is hashed, so this choice costs nothing but a clearer
 * prompt — and it is what makes "the context bytes are byte-identical by construction" true.
 */
function contextAround(
  file: ConflictModelFile,
  at: number,
): { before: string[]; after: string[] } {
  const before: string[] = [];
  for (let i = at - 1; i >= 0 && before.length < HUNK_CONTEXT_LINES; i -= 1) {
    const region = file.regions[i];
    if (!region) break;
    for (let j = region.base.length - 1; j >= 0 && before.length < HUNK_CONTEXT_LINES; j -= 1) {
      before.unshift(clip(region.base[j] ?? ''));
    }
  }
  const after: string[] = [];
  for (let i = at + 1; i < file.regions.length && after.length < HUNK_CONTEXT_LINES; i += 1) {
    const region = file.regions[i];
    if (!region) break;
    for (let j = 0; j < region.base.length && after.length < HUNK_CONTEXT_LINES; j += 1) {
      after.push(clip(region.base[j] ?? ''));
    }
  }
  return { before, after };
}

/** The PR's repo, for the plugin's memo key and its usage-ledger row. Tenanted on
 *  `pull_requests.account_id`, the denormalised anchor column. */
async function repoIdFor(accountId: number, prId: number): Promise<number | null> {
  const { pullRequests } = schema;
  const rows = await db
    .select({ repoId: pullRequests.repoId })
    .from(pullRequests)
    .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
    .limit(1)
    .execute();
  return rows[0]?.repoId ?? null;
}

export function makeConflictSeam(): ConflictSeam {
  return {
    fences: conflictFences,
    validateSuggestion: validateConflictSuggestion,

    async loadHunk(accountId, ref) {
      // ---- ownership ----------------------------------------------------------------------
      // 404 for another tenant's id AND for a reader without push access: one answer, so this
      // route is not an existence oracle either.
      const owned = await getPrWriteContext(ref.prId, accountId);
      if (!owned || !WRITE_PERMISSIONS.has(owned.viewerPermission ?? '')) {
        return { ok: false, error: 'not_found' };
      }

      // ---- the session and its pins ---------------------------------------------------------
      const rec = getSession(accountId, ref.prId, ref.sessionId);
      const model: ConflictModel | null = rec?.model ?? null;
      if (!rec || !model || rec.status !== 'ready') {
        return { ok: false, error: 'session_expired' };
      }

      // ---- the file and the region ----------------------------------------------------------
      const file = model.files.find((f) => f.index === ref.fileIndex) ?? null;
      if (!file || file.unsupported !== null) return { ok: false, error: 'unknown_region' };
      const at = file.regions.findIndex((r) => r.id === ref.regionId);
      const region = at >= 0 ? file.regions[at] : undefined;
      if (!region) return { ok: false, error: 'unknown_region' };
      // Only a CONTESTED region is worth a model: everything else has a deterministic answer the
      // buttons already offer, and paying for a suggestion on one would be paying for a coin toss
      // between two identical outcomes.
      if (region.kind !== 'conflict') return { ok: false, error: 'not_conflict' };

      // ---- text-ness -------------------------------------------------------------------------
      // Every side decoded STRICTLY as UTF-8 at model build (`not_text` is a file-level refusal
      // there), so this is the belt to that braces — a NUL reaching a prompt would be a fact
      // about our own decoder, not about the model.
      const sides = [region.base, region.ours, region.theirs];
      if (sides.some((side) => side.some((l) => l.includes('\0')))) {
        return { ok: false, error: 'not_text' };
      }

      // ---- size ------------------------------------------------------------------------------
      // ⚠ REFUSE, NEVER TRUNCATE. A truncated region spliced back deletes code the model never
      // saw, and the reader would have no way to tell.
      if (
        hunkRegionChars(region.base, region.ours, region.theirs) > config.conflictSuggestMaxChars
      ) {
        return { ok: false, error: 'too_large' };
      }

      // ---- the content pin --------------------------------------------------------------------
      // `regionId` is the ADDRESS and `fingerprint` is the CONTENT. Checked last because it is the
      // one refusal that means "reopen", not "this hunk is not for us".
      if (region.fingerprint !== ref.fingerprint) return { ok: false, error: 'moved' };

      const repoId = await repoIdFor(accountId, ref.prId);
      if (repoId == null) return { ok: false, error: 'not_found' };

      const { before, after } = contextAround(file, at);
      return {
        ok: true,
        hunk: {
          repoId,
          path: file.path,
          headRef: model.headRef,
          baseRef: model.baseRef,
          base: region.base,
          ours: region.ours,
          theirs: region.theirs,
          contextBefore: before,
          contextAfter: after,
          // Fold rule 4: a suggestion sits where the OURS side's text was, so it inherits the
          // ours terminator — the same rule `disjoint_merge` follows in `land.ts`.
          endsWithNewline: file.terminators.ours,
        },
      };
    },

    storeSuggestion(accountId, ref, lines, endsWithNewline) {
      const rec = getSession(accountId, ref.prId, ref.sessionId);
      if (!rec) return null;
      return storeSuggestion(rec, {
        fileIndex: ref.fileIndex,
        regionId: ref.regionId,
        lines,
        endsWithNewline,
      });
    },
  };
}
