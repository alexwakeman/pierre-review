import {
  SPRINT_BRIEF_MODEL,
  commentaryFigures,
  validateCommentary,
  type AdoptionCommentaryResponse,
  type AdoptionCommentarySlide,
  type AiAdoptionReport,
  type CommentaryFigure,
} from '@pierre-review/shared';
import { pickReviewNonce } from '../claude-review/prompts.js';
import { cheapUsage, type CheapUsage } from '../cheap-usage.js';
import { labelCostUsd, type CompleteFn } from '../story-labels/manager.js';
import { ADOPTION_COMMENTARY_SYSTEM, adoptionCommentaryPrompt, adoptionCommentaryUntrusted } from './prompt.js';

// ONE SLIDE'S COMMENTARY (docs/AI-ADOPTION-REPORT.md § The commentary and its grounding). ONE
// completion; the model's text is accepted only through the shared grounding gate
// (`validateCommentary`), and the route returns the TEMPLATE (placeholders): the SPA fills it from its
// own figure table, so every number in the PDF is code's. A refused text is a fallback, never repaired.

/** Claude's model for the commentary (the one-shot Haiku the sprint brief uses). */
export const ADOPTION_COMMENTARY_MODEL = SPRINT_BRIEF_MODEL;
const COMMENTARY_TOKENS = 400;

export interface CommentaryDeps {
  complete: CompleteFn;
  /** Called once per completed call (accepted or refused), with its ledger facts. */
  record: (u: CheapUsage) => Promise<void>;
  /** The gate's reasons for a refused text (logged at debug). */
  onRejected?: (problems: string[]) => void;
}

/** Is there a figure to interpret, beyond the period phrases, the sample sizes and counts of none? */
export function hasUsableFigure(figures: readonly CommentaryFigure[]): boolean {
  return figures.some((f) => f.usable && !f.key.startsWith('period.') && !f.key.endsWith('.sample') && f.text !== '0');
}

/**
 * Write one slide's commentary. Throws when the call itself fails (the route maps it to 503 / 502);
 * a refused text and a slide with nothing to say come back as `source: 'fallback'`.
 */
export async function writeAdoptionCommentary(
  report: AiAdoptionReport,
  slide: AdoptionCommentarySlide,
  deps: CommentaryDeps,
): Promise<AdoptionCommentaryResponse> {
  const table = commentaryFigures(report, slide);
  if (!hasUsableFigure(table)) return { slide, source: 'fallback', reason: 'nothing_to_say' };
  const nonce = pickReviewNonce(adoptionCommentaryUntrusted(table));
  const out = await deps.complete({
    model: ADOPTION_COMMENTARY_MODEL,
    system: ADOPTION_COMMENTARY_SYSTEM,
    prompt: adoptionCommentaryPrompt(slide, table, nonce),
    maxTokens: COMMENTARY_TOKENS,
  });
  const u = cheapUsage(out, ADOPTION_COMMENTARY_MODEL, labelCostUsd);
  await deps.record(u);
  const v = validateCommentary(out.text, table);
  if (!v.ok) {
    deps.onRejected?.(v.problems);
    return { slide, source: 'fallback', reason: 'rejected' };
  }
  return { slide, source: 'ai', template: v.template, provider: u.provider, model: u.model, costUsd: Number.isFinite(u.costUsd) ? u.costUsd : null };
}
