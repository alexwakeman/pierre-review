import { useState } from 'react';
import { aiRunProviderName, type AiFix, type AiFixPlan, type AiFixReviewItem } from '@pierre-review/shared';
import { ChevronIcon } from '../Icons.js';

// A PLAN FROM THE REMOVED PLAN MODE, READ-ONLY (history). "Plan first" is now a chat-mode workspace
// session (docs/SANDBOX.md § AI Fix sessions): its plan is the conversation. Rows from before keep their
// structured plan and chat; they are shown here as they were, with nothing to press.

const REF_CHIP =
  'inline-flex items-center rounded-ui bg-ui-raise px-1.5 py-px font-mono text-meta text-ui-ink';

/** The summary bullets — the plan at a glance. Shared with the build's "Built from your plan" note. */
export function PlanBullets({ plan }: { plan: AiFixPlan }): JSX.Element {
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-body text-ui-ink">
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
    <div className="mt-2 space-y-3 text-meta text-ui-ink">
      {plan.steps.length > 0 && (
        <ol className="list-decimal space-y-2 pl-5">
          {plan.steps.map((s, i) => (
            <li key={i}>
              <div className="font-medium text-ui-ink">{s.title}</div>
              {s.files.length > 0 && (
                <div className="mt-0.5 font-mono text-meta text-ui-mute">{s.files.join(', ')}</div>
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
          <div className="mb-1 font-semibold text-ui-mute">Will not fix</div>
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
          <span className="font-semibold text-ui-mute">Not in the plan: </span>
          {plan.notCovered.join(', ')}
        </p>
      )}
    </div>
  );
}

/** An older row's plan (the removed plan mode): bullets, then the steps and the chat behind a toggle. */
export function PlanHistory({ fix }: { fix: AiFix }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const state = fix.plan;
  // An approved plan shows as "Built from your plan" (ApprovedPlanNote) above the result.
  if (state == null || state.plan == null || state.status === 'approved') return null;
  const plan = state.plan;
  const by = aiRunProviderName(state.model != null ? state : fix);
  return (
    <div data-testid="ai-fix-plan-history" className="mt-3 rounded-ui bg-ui-surface p-2">
      <div className="mb-1 text-meta font-semibold text-ui-mute">The plan {by} made</div>
      <PlanBullets plan={plan} />
      <button
        type="button"
        className="hit mt-1 inline-flex items-center gap-1 text-meta text-ui-mute hover:text-ui-ink"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronIcon dir={open ? 'down' : 'right'} />
        {open ? 'Hide the details' : 'Show the details'}
      </button>
      {open && <PlanDetails plan={plan} items={fix.reviewItems} />}
      {open && state.transcript.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-ui-line pt-2 text-meta">
          {state.transcript.map((m, i) => (
            <li key={i} className="whitespace-pre-wrap text-ui-ink">
              <span className="font-semibold">{m.role === 'reader' ? 'You' : by}: </span>
              {m.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Above a build that came from a plan: the approved bullets, so the reader sees what was agreed. */
export function ApprovedPlanNote({ fix }: { fix: AiFix }): JSX.Element | null {
  const plan = fix.plan?.status === 'approved' ? fix.plan.plan : null;
  if (!plan) return null;
  return (
    <div className="mb-2 rounded-ui bg-ui-surface p-2">
      <div className="mb-1 text-meta font-semibold text-ui-mute">Built from your plan</div>
      <PlanBullets plan={plan} />
    </div>
  );
}
