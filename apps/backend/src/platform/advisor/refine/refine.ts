// THE ONLY LLM MODULE in the advisor (§B.1): reword the templated prose inside the managed
// marker block. Called only from routes.ts, and only for targets whose adapter declared
// format 'prose' — structured formats (yaml/json) have NO LLM code path at all, not a
// guarded one.
//
// Credential: ctx.llm.complete() with NO credential — the host's ambient agent-SDK path, which
// resolves the creator's logged-in Claude session and otherwise the environment's
// ANTHROPIC_API_KEY. ⚠ It used to pass `credential:'local-review-key'` for a BYO key stored
//           in ~/.pierre-review/config.json; that key is RETIRED and the option is inert, so
//           the ladder is two rungs and this call names neither.
// Every output passes the DETERMINISTIC diff-guard; a rejected rewording returns the
// templated version with the reason, never a failure.
import type { ProContext } from '../../contract.js';
import { guardRefinedBlock } from './diff-guard.js';
import { HAIKU_MODEL } from '../../llm/seam.js';

const REFINE_MODEL = HAIKU_MODEL;
const REFINE_MAX_TOKENS = 700;

const SYSTEM = `You reword bot-configuration instructions for clarity and tone. You are given a
markdown block delimited by <!-- limn:advisor:start --> and <!-- limn:advisor:end --> markers.
Rewrite ONLY the instruction sentences to read naturally for this team, keeping every
instruction's meaning intact. HARD RULES: keep both marker lines and the
<!-- limn:advisor:intents: ... --> header line EXACTLY as they are, byte for byte; do not add,
drop, merge or reorder instructions; no code fences; output the full block and nothing else.`;

export interface RefineOutcome {
  templated: string;
  refined: string | null;
  creditsExhausted?: boolean;
  guardRejected?: string;
}

export async function refineManagedBlock(
  ctx: ProContext,
  accountId: number,
  templated: string,
  opts?: { charBudget?: number },
): Promise<RefineOutcome> {
  try {
    const out = await ctx.llm.complete({
      model: REFINE_MODEL,
      system: SYSTEM,
      prompt: templated,
      maxTokens: REFINE_MAX_TOKENS,
    });
    return applyGuard(templated, out.text, opts);
  } catch (err) {
    return {
      templated,
      refined: null,
      guardRejected: err instanceof Error ? err.message : String(err),
    };
  }
}

function applyGuard(
  templated: string,
  raw: string,
  opts?: { charBudget?: number },
): RefineOutcome {
  const guarded = guardRefinedBlock(templated, raw, opts);
  if (!guarded.ok) return { templated, refined: null, guardRejected: guarded.reason };
  return { templated, refined: guarded.content };
}
