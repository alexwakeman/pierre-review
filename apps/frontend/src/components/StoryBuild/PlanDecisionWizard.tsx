import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { BuildPlanContention, BuildPlanDecision, BuildPlanRevision, BuildPlanView, StoryBuild, StoryBuildSession } from '@pierre-review/shared';
import type { usePlanReply } from '../../hooks/useStoryBuild.js';
import {
  PLAN_DECISION_WORDS,
  aboutLine,
  clampStep,
  contentionsHeading,
  firstOpenStep,
  pickDecision,
  planReviewLines,
  planStepLabel,
  stepAfterPick,
} from '../../lib/buildPlan.js';
import { REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import { CheckIcon, ChevronIcon, ScalesIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { ApproveRow, ContentionCard, PlanReplyBox, type DecidedMap } from './PlanParts.js';

// THE DECISION WIZARD (docs/STORY-BUILD.md § Plan first, docs/FRONTEND.md § The build tab). The latest
// revision's points to settle, ONE STEP PER POINT, then a Review step that lists every answer and holds
// "Approve and start". Each step offers two numbered choices, Agree and Keep the story (the 1 and 2 keys
// pick them while focus is in the wizard; ← and → move), and a quieter Reply that opens the reply box.
//
// A pick is saved AT ONCE through the per-point decisions endpoint (the panel's optimistic `onPick`), then
// the wizard moves to the next open point, else to Review. Picking the chosen answer again keeps it (no
// toggle-to-clear). The reader may move freely with the step strip or Back / Next, past open points too.
//
// ⚠ THE STEP IS DERIVED ONCE PER REVISION: the wizard opens on the first open point (else Review) when it
// mounts, and the panel remounts it on a new revision (`key`). After that only the reader moves it, so a
// teammate's or a second tab's answer never moves the step under the reader.

const OPTIONS: ReadonlyArray<{ decision: BuildPlanDecision; action: 'agree' | 'keep'; key: string }> = [
  { decision: 'agree', action: 'agree', key: '1' },
  { decision: 'keep_story', action: 'keep', key: '2' },
];

export function PlanDecisionWizard({
  build,
  session,
  plan,
  rev,
  decided,
  revising,
  onPick,
  reply,
}: {
  build: StoryBuild;
  session: StoryBuildSession;
  plan: Pick<BuildPlanView, 'replies'>;
  rev: BuildPlanRevision;
  /** The answers as shown (the server's, with presses in flight). */
  decided: DecidedMap;
  /** The agent is revising the plan: the step shows that line instead of the choices. */
  revising: boolean;
  onPick: (c: BuildPlanContention, d: BuildPlanDecision) => void;
  reply: ReturnType<typeof usePlanReply>;
}): JSX.Element {
  const contentions = rev.contentions;
  const total = contentions.length;
  const [rawStep, setRawStep] = useState(() => firstOpenStep(contentions, decided));
  const [composing, setComposing] = useState(false);
  const step = clampStep(rawStep, contentions);
  const c = step < total ? contentions[step]! : null;
  const rootRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  // After the reader moves, keep the keys working: a step whose focused control went away hands focus
  // to the wizard itself.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const root = rootRef.current;
    if (root != null && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  }, [step]);

  const go = (n: number): void => {
    moved.current = true;
    setComposing(false);
    setRawStep(clampStep(n, contentions));
  };

  const pick = (point: BuildPlanContention, pressed: BuildPlanDecision): void => {
    const decision = pickDecision(decided[point.id], pressed);
    if (decided[point.id] !== decision) onPick(point, decision);
    go(stepAfterPick(contentions, { ...decided, [point.id]: decision }, step));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // ⚠ A held key repeats: it must not answer every point after this one.
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    // ⚠ React bubbles portal events up the COMPONENT tree: a key pressed in a popover (an ⓘ, a doc list)
    // reaches this handler although the popover is not inside the wizard's DOM. Only keys from inside count.
    if (!(rootRef.current?.contains(e.target as Node) ?? false)) return;
    const t = e.target as HTMLElement;
    if (t.closest('textarea, input, select, [contenteditable="true"]') != null) return;
    if (e.key === 'ArrowLeft' && step > 0) {
      e.preventDefault();
      go(step - 1);
    } else if (e.key === 'ArrowRight' && step < total) {
      e.preventDefault();
      go(step + 1);
    } else if (c != null && !revising) {
      const o = OPTIONS.find((x) => x.key === e.key);
      if (o != null) {
        e.preventDefault();
        pick(c, o.decision);
      }
    }
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="story-plan-contentions"
      data-step={c != null ? step : 'review'}
      onKeyDown={onKeyDown}
      className="rounded-ui outline-none"
    >
      <div className="mb-2 flex items-center gap-1.5">
        <h4 className={REVIEW_SUBHEAD}>{contentionsHeading(contentions, decided)}</h4>
        <InfoButton title="Points to settle">
          <p>Each point is a place where the agent says the story is wrong, unclear, or does not match the code, the docs or the data.</p>
          <p className="mt-2">
            <strong>Agree</strong> tells the agent to build its proposal. <strong>Keep the story</strong> tells it to build what the story says.{' '}
            <strong>Reply</strong> sends your words, and the agent revises the plan.
          </p>
          <p className="mt-2">Each answer is saved when you pick it. Press 1 or 2 to pick, and ← or → to move between points.</p>
          <p className="mt-2">Your answers go into the build and into each pull request's description.</p>
        </InfoButton>
      </div>
      <StepStrip contentions={contentions} decided={decided} step={step} go={go} />
      {c != null ? (
        <div data-testid="story-plan-step" data-id={c.id} data-step={step} className="mt-3">
          {/* ⚠ Keyed by point: each step gets fresh card state (an evidence row's open/closed) and fresh
              choice buttons, so focus never stays on "Agree" for the next point. */}
          <ContentionCard
            key={c.id}
            build={build}
            c={c}
            as="div"
            decided={decided[c.id]}
            outcomes={false}
            replies={plan.replies.filter((r) => r.contentionId === c.id)}
            title={<StepTitle c={c} index={step} total={total} />}
          >
            {revising ? (
              <p className="mt-3 text-meta text-ui-mute">The agent is revising the plan…</p>
            ) : (
              <>
                <Choices c={c} chosen={decided[c.id]} onPick={(d) => pick(c, d)} />
                {session.live && (
                  <div className="mt-2">
                    <Button size="sm" variant="ghost" data-plan-action="reply" aria-expanded={composing} onClick={() => setComposing((v) => !v)}>
                      Reply
                    </Button>
                    {composing && <PlanReplyBox build={build} rev={rev} c={c} reply={reply} onClose={() => setComposing(false)} />}
                  </div>
                )}
              </>
            )}
          </ContentionCard>
          <div className="mt-2 flex items-center gap-2">
            {step > 0 && (
              <Button size="sm" variant="ghost" data-plan-nav="back" icon={<ChevronIcon dir="left" />} onClick={() => go(step - 1)}>
                Back
              </Button>
            )}
            <Button size="sm" variant="secondary" data-plan-nav="next" className="ml-auto" onClick={() => go(step + 1)}>
              {step + 1 < total ? 'Next' : 'Review'}
              <ChevronIcon dir="right" />
            </Button>
          </div>
        </div>
      ) : (
        <ReviewStep build={build} session={session} rev={rev} decided={decided} go={go} />
      )}
    </div>
  );
}

function StepTitle({ c, index, total }: { c: BuildPlanContention; index: number; total: number }): JSX.Element {
  const about = aboutLine(c.about);
  return (
    <>
      <ScalesIcon size={13} className="text-ui-mute" />
      <h5 className="text-body font-medium text-ui-ink">{planStepLabel(index, total)}</h5>
      {about != null && <span className="font-mono text-meta text-ui-mute">{about}</span>}
    </>
  );
}

/** "1 · 2 · 3 · Review": every step, answered ones ticked, open ones ringed; the reader may jump to any. */
function StepStrip({
  contentions,
  decided,
  step,
  go,
}: {
  contentions: readonly BuildPlanContention[];
  decided: DecidedMap;
  step: number;
  go: (n: number) => void;
}): JSX.Element {
  const total = contentions.length;
  return (
    <ol aria-label="Steps" data-testid="story-plan-steps" className="flex flex-wrap items-center gap-1">
      {contentions.map((c, i) => {
        const answered = decided[c.id] != null;
        const label = planStepLabel(i, total);
        return (
          <li key={c.id}>
            <button
              type="button"
              data-state={answered ? 'answered' : 'open'}
              aria-current={i === step ? 'step' : undefined}
              aria-label={`${label}, ${answered ? PLAN_DECISION_WORDS[decided[c.id]!] : 'not answered'}`}
              onClick={() => go(i)}
              className={cx(
                'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-ui px-2 text-meta ring-1 ring-inset touch:h-10 touch:min-w-10',
                FOCUS_RING,
                i === step ? 'bg-ui-sel font-medium text-ui-ink ring-ui-accent' : answered ? 'bg-ui-raise text-ui-ink ring-transparent hover:bg-ui-hover' : 'text-ui-ink ring-ui-warn/60 hover:bg-ui-hover',
              )}
            >
              {answered && <CheckIcon size={11} className="text-ui-success" />}
              {i + 1}
            </button>
          </li>
        );
      })}
      <li>
        <button
          type="button"
          data-state="review"
          aria-current={step === total ? 'step' : undefined}
          onClick={() => go(total)}
          className={cx(
            'inline-flex h-7 items-center rounded-ui px-2 text-meta ring-1 ring-inset touch:h-10',
            FOCUS_RING,
            step === total ? 'bg-ui-sel font-medium text-ui-ink ring-ui-accent' : 'bg-ui-raise text-ui-ink ring-transparent hover:bg-ui-hover',
          )}
        >
          Review
        </button>
      </li>
    </ol>
  );
}

/** The two numbered choices, each with what the agent then builds. */
function Choices({ c, chosen, onPick }: { c: BuildPlanContention; chosen: BuildPlanDecision | undefined; onPick: (d: BuildPlanDecision) => void }): JSX.Element {
  const id = useId();
  return (
    <div role="group" aria-label="Your answer" className="mt-3 space-y-1.5" data-noactivate>
      {OPTIONS.map((o) => {
        const on = chosen === o.decision;
        const outcome = o.decision === 'agree' ? c.proposal : c.ifKept;
        return (
          <button
            key={o.decision}
            type="button"
            data-plan-action={o.action}
            aria-pressed={on}
            aria-keyshortcuts={o.key}
            aria-label={PLAN_DECISION_WORDS[o.decision]}
            aria-describedby={`${id}-${o.key}`}
            // ⚠ The second click of a double-click lands on the NEXT point's button: ignore it.
            onClick={(e) => {
              if (e.detail > 1) return;
              onPick(o.decision);
            }}
            className={cx(
              'flex w-full items-start gap-2.5 rounded-ui px-3 py-2 text-left ring-1 ring-inset touch:min-h-10',
              FOCUS_RING,
              on ? 'bg-ui-sel ring-ui-accent' : 'bg-ui-surface ring-ui-line hover:bg-ui-hover',
            )}
          >
            <span aria-hidden className="w-4 shrink-0 font-mono text-body text-ui-mute">
              {o.key}.
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium text-ui-ink">{PLAN_DECISION_WORDS[o.decision]}</span>
              <span id={`${id}-${o.key}`} className="mt-0.5 block break-words text-meta text-ui-ink">
                {outcome}
              </span>
            </span>
            {on && <CheckIcon size={14} className="mt-0.5 shrink-0 text-ui-success" />}
          </button>
        );
      })}
    </div>
  );
}

/** The last step: every point with its answer (each line goes back to its step), then Approve and start. */
function ReviewStep({
  build,
  session,
  rev,
  decided,
  go,
}: {
  build: StoryBuild;
  session: StoryBuildSession;
  rev: BuildPlanRevision;
  decided: DecidedMap;
  go: (n: number) => void;
}): JSX.Element {
  const lines = planReviewLines(rev.contentions, decided);
  return (
    <div data-testid="story-plan-review" className="mt-3 rounded-ui bg-ui-bg p-3 ring-1 ring-inset ring-ui-line">
      <h5 className="text-body font-medium text-ui-ink">Review</h5>
      <ul className="mt-1.5 space-y-0.5">
        {lines.map((l) => (
          <li key={l.id} data-testid="story-plan-review-line" data-id={l.id} data-open={l.choice == null ? 'true' : 'false'}>
            <button
              type="button"
              onClick={() => go(l.step)}
              className={cx('flex w-full min-w-0 items-baseline gap-2 rounded-ui px-2 py-1.5 text-left text-body hover:bg-ui-hover touch:min-h-10', FOCUS_RING)}
            >
              <span className="shrink-0 text-meta font-medium text-ui-ink">{l.label}</span>
              {l.about != null && <span className="shrink-0 font-mono text-meta text-ui-mute">{l.about}</span>}
              <span className="min-w-0 flex-1 truncate text-ui-ink">{l.problem}</span>
              {l.choice != null ? (
                <span className="flex shrink-0 items-center gap-1 text-meta text-ui-ink">
                  <CheckIcon size={12} className="text-ui-success" />
                  {l.choice}
                </span>
              ) : (
                <span className="shrink-0 text-meta font-medium text-ui-warn">Not answered</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <ApproveRow build={build} session={session} rev={rev} decided={decided} inWizard />
    </div>
  );
}
