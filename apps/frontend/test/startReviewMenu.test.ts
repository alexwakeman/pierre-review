// THE OPEN PRs ROW MENU'S "Start review" (lib/startReviewMenu.ts, docs/FRONTEND.md § Open PRs → the
// row menu): it runs the AI Review tab's opening choice and is gated by the tab's Run checks.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend startReviewMenu
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiKindStatus, AiRunKind, ClaudeReviewPrState, MeResponse } from '@pierre-review/shared';
import { defaultReviewChoice, startReviewMenuItem } from '../src/lib/startReviewMenu.js';
import { reviewStartNoteText } from '../src/store/reviewStartNote.js';

const KINDS: AiRunKind[] = ['review', 'review_chat', 'fix', 'plan', 'complete'];
const kinds = (s: AiKindStatus): Record<AiRunKind, AiKindStatus> =>
  Object.fromEntries(KINDS.map((k) => [k, s])) as Record<AiRunKind, AiKindStatus>;

function me(o: {
  enabled?: boolean;
  runtime?: 'ready' | 'installing' | 'absent' | 'failed';
  claude?: boolean;
  codex?: boolean;
  provider?: 'claude' | 'codex';
}): MeResponse {
  const runtime = o.runtime ?? 'ready';
  const ok = { auth: 'ok' as const, message: null };
  const none = { auth: 'none' as const, message: 'no' };
  const top = (o.provider ?? 'claude') === 'codex' ? !!o.codex : !!o.claude;
  return {
    ai: {
      enabled: o.enabled ?? true,
      runtime,
      runtimeMessage: null,
      auth: top ? 'ok' : 'none',
      authMessage: null,
      provider: o.provider ?? 'claude',
      providerSetting: { value: 'auto', source: 'settings' },
      kinds: kinds(top ? ok : none),
      providers: {
        claude: { auth: o.claude ? 'ok' : 'none', route: o.claude ? 'login' : 'none', message: null, runtime },
        codex: {
          runtime,
          runtimeMessage: null,
          auth: o.codex ? 'ok' : 'none',
          route: o.codex ? 'login' : 'none',
          signedIn: !!o.codex,
          plan: null,
          available: !!o.codex,
          message: null,
          kinds: kinds(o.codex ? ok : none),
        },
      },
    },
  } as unknown as MeResponse;
}

function state(o: Partial<ClaudeReviewPrState>): ClaudeReviewPrState {
  return {
    prId: 1,
    reviewId: 9,
    status: 'succeeded',
    verdict: 'COMMENT',
    reviewedHeadSha: 'a',
    finishedAt: null,
    ticket: null,
    headMoved: false,
    ...o,
  } as ClaudeReviewPrState;
}

const item = (m: MeResponse, s?: ClaudeReviewPrState, extra: { starting?: boolean; overBudget?: boolean } = {}) =>
  startReviewMenuItem({ me: m, state: s, starting: extra.starting ?? false, overBudget: extra.overBudget ?? false });

describe('Start review: the choice', () => {
  it('is the AI Review tab’s opening choice: Claude + Codex while both can review', () => {
    expect(defaultReviewChoice(me({ claude: true, codex: true }))).toEqual({ pair: true, model: 'claude-opus-5-5', provider: 'claude' });
  });
  it('else the default provider’s model at the usual depth', () => {
    expect(defaultReviewChoice(me({ claude: true }))).toMatchObject({ pair: false, provider: 'claude' });
    const codex = defaultReviewChoice(me({ codex: true, provider: 'codex' }));
    expect(codex).toMatchObject({ pair: false, provider: 'codex' });
  });
});

describe('Start review: the gate', () => {
  it('is hidden while AI is off', () => {
    expect(item(me({ enabled: false, claude: true }))).toEqual({ show: false });
  });

  it('is enabled before a review, with no hint', () => {
    expect(item(me({ claude: true }))).toEqual({ show: true, disabled: false, hint: null, overBudget: false });
    // A failed or cancelled run: start again.
    expect(item(me({ claude: true }), state({ status: 'failed' }))).toMatchObject({ disabled: false });
    expect(item(me({ claude: true }), state({ status: 'cancelled' }))).toMatchObject({ disabled: false });
  });

  it('is disabled with the runtime’s reason while AI is not set up', () => {
    expect(item(me({ runtime: 'installing', claude: true }))).toMatchObject({ show: true, disabled: true, hint: 'Setting up AI…' });
    expect(item(me({ runtime: 'absent', claude: true }))).toMatchObject({ disabled: true, hint: 'AI not set up' });
    expect(item(me({ runtime: 'failed', claude: true }))).toMatchObject({ disabled: true, hint: 'AI not set up' });
  });

  it('is disabled with "Not signed in" while no provider can review', () => {
    expect(item(me({}))).toMatchObject({ show: true, disabled: true, hint: 'Not signed in' });
  });

  it('is enabled when ANY provider can review (the tab’s per-run menu rule)', () => {
    // Claude is the default and signed out; Codex can review.
    expect(item(me({ codex: true }))).toMatchObject({ disabled: false });
  });

  it('is disabled while a review is starting, queued or running — the auto lane too', () => {
    expect(item(me({ claude: true }), undefined, { starting: true })).toMatchObject({ disabled: true, hint: 'Starting…' });
    expect(item(me({ claude: true }), state({ status: 'queued' }))).toMatchObject({ disabled: true, hint: 'Queued' });
    expect(item(me({ claude: true }), state({ status: 'running' }))).toMatchObject({ disabled: true, hint: 'Running' });
    expect(item(me({ claude: true }), state({ status: 'running', trigger: 'auto' }))).toMatchObject({ disabled: true, hint: 'Running' });
    expect(item(me({ claude: true }), state({ status: 'queued', trigger: 'auto', reviewId: null }))).toMatchObject({
      disabled: true,
      hint: 'Queued',
    });
  });

  it('is disabled at the reviewed commit, enabled once the PR moves past it', () => {
    expect(item(me({ claude: true }), state({ headMoved: false }))).toMatchObject({ disabled: true, hint: 'Already reviewed' });
    expect(item(me({ claude: true }), state({ headMoved: true }))).toMatchObject({ disabled: false });
  });

  it('over the spend budget it stays enabled and says so (the SPA asks; a click is never refused)', () => {
    expect(item(me({ claude: true }), undefined, { overBudget: true })).toEqual({
      show: true,
      disabled: false,
      hint: 'Over budget',
      overBudget: true,
    });
    // A blocked item names its own reason, never the budget.
    expect(item(me({}), undefined, { overBudget: true })).toMatchObject({ disabled: true, hint: 'Not signed in', overBudget: false });
  });
});

describe('Start review: the wiring', () => {
  const src = (p: string): string => readFileSync(join(__dirname, '../src', p), 'utf8');

  it('starts through the ONE start route and per-PR mutation key, then the shared follow-up', () => {
    const hook = src('hooks/useClaudeReview.ts');
    const fn = hook.slice(hook.indexOf('export async function startDefaultReview'), hook.indexOf('export function isAutoReviewHoldError'));
    expect(fn).toMatch(/mutationKey: claudeReviewStartKey\(pr\.id\)/);
    expect(fn).toMatch(/api\.generateClaudeReview\(/);
    expect(fn).toMatch(/afterReviewStarted\(qc, pr\.id\)/);
    // Review only: nothing is posted from the menu.
    expect(fn).not.toMatch(/postMode/);
  });

  it('the row menu offers it and the over-budget ask', () => {
    const menu = src('components/Activity/OpenPrsRowMenu.tsx');
    expect(menu).toMatch(/id: 'start-review'/);
    expect(menu).toMatch(/startReviewMenuItem\(/);
    expect(src('components/Activity/OpenPrsRows.tsx')).toMatch(/<OpenPrsBudgetAsk/);
  });

  it('the toast note reads plainly', () => {
    expect(reviewStartNoteText({ prNumber: 615, error: null })).toBe('Review started for #615');
    expect(reviewStartNoteText({ prNumber: 615, error: 'x' })).toBe('Review not started for #615');
  });
});
