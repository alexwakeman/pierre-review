import { createHash } from 'node:crypto';
import { CONFLICT_MODEL_VERSION } from '@pierre-review/shared';
import type { ConflictModel, ConflictModelRegion } from './model-types.js';

/**
 * The model hash. Echoed on the commit body; a mismatch is `ModelStale` and nothing is
 * written, because a decision made against different bytes is not a decision.
 *
 * ⚠ `CONFLICT_MODEL_VERSION` IS FOLDED IN, so a change to the fold or the chunker
 * self-invalidates every live session rather than landing bytes the user did not choose —
 * the `PERIOD_METRICS_SCHEMA_VERSION` discipline.
 *
 * ⚠ ONLY MODEL FACTS GO IN. Nothing `Date.now()`-derived, nothing hydrated, nothing that
 * depends on how the session was OPENED: `autoApply` changes which decision a region starts
 * on, not what the region IS, and folding it in would make the same model hash two different
 * values depending on a checkbox.
 */
export function conflictModelHash(model: ConflictModel): string {
  const h = createHash('sha256');
  const put = (s: string): void => {
    h.update(s);
    h.update('\0');
  };
  put(`v${CONFLICT_MODEL_VERSION}`);
  put(model.headSha);
  put(model.baseSha);
  put(model.mergedTreeSha);
  put(model.mergeBaseSha ?? '');
  put(model.mergeBaseIsVirtual ? '1' : '0');
  put(String(model.totalConflictedPaths));
  put(model.truncated ? '1' : '0');
  put(model.renameDetection);
  for (const f of model.files) {
    put(String(f.index));
    put(f.path);
    put(f.unsupported ?? '');
    put(f.stage2Mode ?? '');
    put(`${f.terminators.base ? 1 : 0}${f.terminators.ours ? 1 : 0}${f.terminators.theirs ? 1 : 0}`);
    put(String(f.regions.length));
    for (const r of f.regions) {
      put(String(r.id));
      put(r.kind);
      // The fingerprint already covers all three sides' bytes, so hashing it rather than the
      // lines keeps this linear in region count instead of in file size.
      put(r.fingerprint);
      put(r.wand?.decision ?? '');
      put(r.wand?.reason ?? '');
      put(r.mergedLines === null ? '' : regionMergeDigest(r));
    }
  }
  return h.digest('hex');
}

function regionMergeDigest(region: ConflictModelRegion): string {
  const h = createHash('sha256');
  for (const line of region.mergedLines ?? []) {
    h.update(line);
    h.update('\0');
  }
  return h.digest('hex');
}

/** sha256 of `base \0 ours \0 theirs`. The CONTENT pin the Pro suggestion route checks
 *  against the id's ADDRESS — a region can keep its id while its bytes move only if the
 *  whole model was rebuilt, and then this differs. */
export function regionFingerprint(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): string {
  const h = createHash('sha256');
  for (const side of [base, ours, theirs]) {
    for (const line of side) {
      h.update(line);
      h.update('\n');
    }
    h.update('\0');
  }
  return h.digest('hex');
}
