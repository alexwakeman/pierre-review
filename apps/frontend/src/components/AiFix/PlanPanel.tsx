import { useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  AI_FIX_PLAN_MAX_MESSAGE_CHARS,
  aiRunLabel,
  type AiFix,
  type AiFixPlan,
  type AiFixReviewItem,
  type AiFixStatusResponse,
  type ClaudeAuthStatus,
  type PrDetail,
} from '@pierre-review/shared';
import {
  aiFixPlanMutationKey,
  useApprovePlan,
  useCancelFix,
  useDiscardPlan,
  usePlanMessage,
} from '../../hooks/useAiFix.js';
import { useFilters } from '../../store/filters.js';
import { fixProgressPct, PHASE_LABEL } from '../../lib/aiFixProgress.js';
import { ApiError } from '../../api/client.js';
import { AiRunGate } from '../AiSetup.js';
import { InfoButton } from '../InfoModal.js';
import { ChevronIcon } from '../Icons.js';
import { RegenProgressBar } from '../Activity/RegenProgressBar.js';
import { aiProviderName, aiRunProvider, aiRunProviderName } from '@pierre-review/shared';
import { useFollowUpProvider } from '../../hooks/useModelPick.js';

// PLAN MODE (manual AI Fix only; docs/CLAUDE-REVIEW.md § AI Fix "Plan mode"). Claude reads the code
// and writes a plan; it edits nothing. The reader steers it by chat — each message runs a fresh
// planning pass with the whole chat — and "Approve and build" runs the normal fix on the SAME row
// with the plan as its brief. Everything here reads the ONE ai-fix query; the live progress is the
// tab's own SSE stream (`liveStatus`).

const BTN_PRIMARY =
  'whitespace-nowrap rounded border border-blue-400 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';
const BTN_SECONDARY =
  'whitespace-nowrap rounded border border-gray-300 px-2.5 py-1 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';
const REF_CHIP =
  'inline-flex items-center rounded bg-gray-500/10 px-1.5 py-px font-mono text-[11px] text-gray-700 dark:text-gray-200';

function errText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

/** The summary bullets — the plan at a glance. Shared with the build's "Built from your plan" note. */
export function PlanBullets({ plan }: { plan: AiFixPlan }): JSX.Element {
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-gray-800 dark:text-gray-100">
      {plan.summary.map((b, i) => (
        <li key={i}>{b}</li>
      ))}
    </ul>
  );
}

function itemTitle(items: AiFixReviewItem[] | null, ref: string): string | null {
  return items?.find((i) => i.ref === ref)?.title ?? null;
}

/** The detailed plan: steps (files, change, refs), then what it leaves alone. */
function PlanDetails({ plan, items }: { plan: AiFixPlan; items: AiFixReviewItem[] | null }): JSX.Element {
  return (
    <div className="mt-2 space-y-3 text-xs text-gray-700 dark:text-gray-200">
      {plan.steps.length > 0 && (
        <ol className="list-decimal space-y-2 pl-5">
          {plan.steps.map((s, i) => (
            <li key={i}>
              <div className="font-medium text-gray-800 dark:text-gray-100">{s.title}</div>
              {s.files.length > 0 && (
                <div className="mt-0.5 font-mono text-[11px] text-gray-600 dark:text-gray-300">{s.files.join(', ')}</div>
              )}
              <p className="mt-0.5 whitespace-pre-wrap">{s.change}</p>
              {s.refs.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.refs.map((r) => (
                    <span key={r} className={REF_CHIP}>
                      {r}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {plan.notAddressed.length > 0 && (
        <div>
          <div className="mb-1 font-semibold text-gray-600 dark:text-gray-300">Will not fix</div>
          <ul className="space-y-1">
            {plan.notAddressed.map((n) => (
              <li key={n.ref}>
                <span className={REF_CHIP}>{n.ref}</span>{' '}
                {itemTitle(items, n.ref) && <span className="font-medium">{itemTitle(items, n.ref)}: </span>}
                {n.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.notCovered.length > 0 && (
        <p>
          <span className="font-semibold text-gray-600 dark:text-gray-300">Not in the plan: </span>
          {plan.notCovered.join(', ')}
        </p>
      )}
    </div>
  );
}

export function PlanPanel({
  pr,
  fix,
  liveStatus,
  passRunning,
  auth,
}: {
  pr: PrDetail;
  fix: AiFix;
  liveStatus: AiFixStatusResponse | null;
  // A planning pass is queued or running (the DB says 'planning', or the live stream says so).
  passRunning: boolean;
  auth: ClaudeAuthStatus | undefined;
}): JSX.Element | null {
  const state = fix.plan;
  // The one that wrote this plan, and the providers that run the next pass and the build: the plan's
  // own while it can run them, else the default (the server's rule, ai/run-choice.ts).
  const plannedBy = aiRunProviderName(fix.plan ?? fix);
  const planProvider = aiRunProvider((fix.plan ?? fix).provider, (fix.plan ?? fix).model);
  const passProvider = useFollowUpProvider(planProvider, 'plan');
  const buildProvider = useFollowUpProvider(planProvider, 'fix');
  const name = aiProviderName(passProvider);
  const message = usePlanMessage(pr.id);
  const approve = useApprovePlan(pr.id);
  const discard = useDiscardPlan(pr.id);
  const cancel = useCancelFix(pr.id);
  const busy = useIsMutating({ mutationKey: aiFixPlanMutationKey(pr.id) }) > 0;
  const noteAiFixRun = useFilters((s) => s.noteAiFixRun);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  if (!state) return null;

  const plan = state.plan;
  const ready = state.status === 'plan_ready' && !passRunning;
  const text = draft.trim();
  const tooLong = text.length > AI_FIX_PLAN_MAX_MESSAGE_CHARS;

  const send = (): void => {
    if (!ready || busy || text === '' || tooLong) return;
    message.mutate({ fixId: fix.id, text }, { onSuccess: () => setDraft('') });
  };
  const doApprove = (): void => {
    // The bottom-right AiFixBanner follows the build once the reader leaves this tab.
    noteAiFixRun({ prId: pr.id, repoFullName: pr.repoFullName, prNumber: pr.number, prTitle: pr.title });
    approve.mutate(fix.id);
  };
  const actionError = message.error ?? approve.error ?? discard.error;

  return (
    <div className="mt-3 rounded border border-gray-200 p-3 dark:border-gray-800">
      <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
        Plan
        {plan && state.revision > 1 && (
          <span className="font-normal text-gray-500 dark:text-gray-400">· version {state.revision}</span>
        )}
        {state.model && (
          <span className="font-normal text-gray-500 dark:text-gray-400">· {aiRunLabel(state.provider, state.model)}</span>
        )}
        <InfoButton title="Plan first">
          <p>{name} reads the code and writes a plan. It changes nothing.</p>
          <p>
            Tell {name} what to change and it rewrites the plan, taking the whole conversation into account. Each
            message runs {name} again.
          </p>
          <p>When you approve, {name} builds the fix from this plan. You still review the diff and press Push.</p>
        </InfoButton>
      </div>

      {plan ? (
        <>
          <PlanBullets plan={plan} />
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronIcon dir={open ? 'down' : 'right'} />
            Details
          </button>
          {open && <PlanDetails plan={plan} items={fix.reviewItems} />}
        </>
      ) : (
        !passRunning && <p className="text-xs text-gray-600 dark:text-gray-300">No plan yet.</p>
      )}

      {/* A re-plan that failed keeps the plan above; the reason sits here. */}
      {fix.error && (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          {fix.error}
        </p>
      )}

      {state.transcript.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-gray-200 pt-2 text-xs dark:border-gray-800">
          {state.transcript.map((m, i) => (
            <li key={i} className="whitespace-pre-wrap text-gray-700 dark:text-gray-200">
              <span className="font-semibold">{m.role === 'reader' ? 'You' : plannedBy}: </span>
              {m.text}
            </li>
          ))}
        </ul>
      )}

      {passRunning && (
        <div className="mt-3">
          <RegenProgressBar
            active
            label={plan ? 'Updating the plan' : 'Making the plan'}
            value={fixProgressPct(liveStatus)}
            timeConstantSec={30}
          />
          <div className="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            {PHASE_LABEL[liveStatus?.progress?.phase ?? ''] ?? 'Working…'}
            <button type="button" className={BTN_SECONDARY} onClick={() => cancel.mutate()}>
              Cancel
            </button>
          </div>
          {liveStatus?.progress?.recentActivity && liveStatus.progress.recentActivity.length > 0 && (
            <pre className="mt-1 max-h-32 overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              {liveStatus.progress.recentActivity.slice(-8).join('\n')}
            </pre>
          )}
        </div>
      )}

      {/* Three buttons, three gates: "Update plan" is a PLAN run, "Approve and build" a FIX run (a
          provider may run one and not the other — Codex), and "Discard plan" runs no model at all,
          so it is never gated: a plan must always be clearable, or it blocks the PR's auto fixes. */}
      {ready && plan && (
        <div className="mt-3">
          <AiRunGate kind="plan" auth={auth} meter={false} anyProvider provider={passProvider}>
            <textarea
              aria-label="Change the plan"
              className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 text-xs dark:border-gray-700"
              rows={2}
              placeholder={`Tell ${name} what to change in the plan`}
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {tooLong && (
              <p className="text-[12px] text-red-600 dark:text-red-400">
                Keep it under {AI_FIX_PLAN_MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters.
              </p>
            )}
            <div className="mt-2">
              <button type="button" data-ai-run className={BTN_SECONDARY} disabled={busy || text === '' || tooLong} onClick={send}>
                Update plan
              </button>
            </div>
          </AiRunGate>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <AiRunGate kind="fix" auth={auth} anyProvider provider={buildProvider}>
              <button type="button" data-ai-run className={BTN_PRIMARY} disabled={busy} onClick={doApprove}>
                Approve and build
              </button>
            </AiRunGate>
            <button type="button" className={BTN_SECONDARY} disabled={busy} onClick={() => discard.mutate(fix.id)}>
              Discard plan
            </button>
          </div>
        </div>
      )}
      {actionError != null && <p className="mt-1 text-[12px] text-red-600 dark:text-red-400">{errText(actionError)}</p>}
    </div>
  );
}

/** Above a build that came from a plan: the approved bullets, so the reader sees what was agreed. */
export function ApprovedPlanNote({ fix }: { fix: AiFix }): JSX.Element | null {
  const plan = fix.plan?.status === 'approved' ? fix.plan.plan : null;
  if (!plan) return null;
  return (
    <div className="mb-2 rounded border border-gray-200 p-2 dark:border-gray-800">
      <div className="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-300">Built from your plan</div>
      <PlanBullets plan={plan} />
    </div>
  );
}
