// THE OPEN PRs ROW MENU'S "Start review" (docs/FRONTEND.md § Open PRs → the row menu) — the pure
// half, so tests pin it without React. It starts the SAME run the AI Review tab's Run button starts
// with nothing picked (lib/modelPick.ts `resolveReviewModelPick` with no pick: Claude + Codex while
// both can review, else the default provider's model at the usual depth), and it is gated by the
// SAME checks as that button (`AiRunGate kind="review" anyProvider`, components/AiSetup.tsx).
//
// ⚠ NOTHING HERE FETCHES. The row's state is the list's ONE batched Claude Review states answer; the
// budget is the shared `['ai-budget']` reading the header already holds.
import type { ClaudeReviewPrState, MeResponse } from '@pierre-review/shared';
import { DEFAULT_CLAUDE_REVIEW_MODEL } from '@pierre-review/shared';
import { aiAuthFor, aiCapabilitiesOf, aiGateReadyFor } from './aiCapabilities.js';
import { reviewCellFor } from './claudeReviewColumn.js';
import { resolveReviewModelPick, type ModelPickState } from './modelPick.js';

/** The request body's choice: the pair, or one provider's model. */
export type DefaultReviewChoice =
  | { pair: true; model: ModelPickState['chosen']['model']; provider: 'claude' }
  | { pair: false; model: ModelPickState['chosen']['model']; provider: ModelPickState['chosen']['provider'] };

/** The AI Review tab's opening choice (no pick yet). `provider` is the one whose budget applies. */
export function defaultReviewChoice(me: MeResponse | undefined): DefaultReviewChoice {
  const pick = resolveReviewModelPick(me, DEFAULT_CLAUDE_REVIEW_MODEL, null);
  return pick.pair
    ? { pair: true, model: pick.chosen.model, provider: 'claude' }
    : { pair: false, model: pick.chosen.model, provider: pick.chosen.provider };
}

export type StartReviewMenuItem =
  /** AI is off (`me.ai.enabled` false): no item. */
  | { show: false }
  /** `hint`: why it cannot run now (disabled), or "Over budget" (enabled; choosing it asks first). */
  | { show: true; disabled: boolean; hint: string | null; overBudget: boolean };

export function startReviewMenuItem(o: {
  me: MeResponse | undefined;
  state: ClaudeReviewPrState | undefined;
  /** A start for this PR is in flight from any surface (`useClaudeReviewStarting`). */
  starting: boolean;
  /** The run's provider is over the spend budget. */
  overBudget: boolean;
}): StartReviewMenuItem {
  const ai = aiCapabilitiesOf(o.me);
  if (!ai.enabled) return { show: false };
  const blocked = (hint: string): StartReviewMenuItem => ({ show: true, disabled: true, hint, overBudget: false });

  // The Run gate, in its own order: ready by any provider that can review; else the runtime, then
  // the sign-in.
  if (aiGateReadyFor(o.me, { kind: 'review', anyProvider: true }) !== true) {
    if (ai.runtime === 'installing') return blocked('Setting up AI…');
    if (ai.runtime !== 'ready') return blocked('AI not set up');
    if (aiAuthFor(ai, 'review').auth === 'none') return blocked('Not signed in');
  }

  // Where the PR's run is: the Open PRs column's own reading (an auto review in flight included).
  const cell = reviewCellFor(o.state, o.starting);
  if (cell.kind === 'starting') return blocked('Starting…');
  if (cell.kind === 'queued') return blocked('Queued');
  if (cell.kind === 'running') return blocked('Running');
  // The column offers a start only before a review, or once the PR moved past it.
  if (cell.kind === 'done' && !cell.headMoved) return blocked('Already reviewed');

  return { show: true, disabled: false, hint: o.overBudget ? 'Over budget' : null, overBudget: o.overBudget };
}
