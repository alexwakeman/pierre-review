// Shape ctx.queries.getAdvisorFindings' `unknown` into a typed AdvisorFindingsPayload.
// Pure `(data) => data` — no ctx, no I/O (the B.1 dependency rule: deterministic modules are
// structurally incapable of reaching the LLM because they never receive ctx at all).
//
// Validation is structural and shallow on purpose: the payload comes from OUR host across a
// version-gated contract, not from a user — the checks exist to fail loudly on contract
// drift (an apiVersion half-bump scenario), not to sanitize.
import type { AdvisorFindingsPayload } from '@pierre-review/shared';

export function parseFindingsPayload(raw: unknown): AdvisorFindingsPayload {
  const p = raw as AdvisorFindingsPayload | null;
  if (
    !p ||
    typeof p !== 'object' ||
    !Array.isArray(p.bots) ||
    !Array.isArray(p.pathCells) ||
    !Array.isArray(p.categoryCells) ||
    !Array.isArray(p.overlapCells) ||
    typeof p.window?.kind !== 'string' ||
    typeof p.floors?.minCellThreads !== 'number'
  ) {
    throw new Error('getAdvisorFindings returned an unrecognized payload (host/plugin contract drift?)');
  }
  return p;
}
