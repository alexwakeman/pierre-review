import { useEffect, useState } from 'react';
import {
  type BuildPlanContention,
  type BuildPlanDecision,
  type BuildPlanRevision,
  type BuildPlanView,
  type StoryBuild,
  type StoryBuildSession,
} from '@pierre-review/shared';
import { ApiError } from '../../api/client.js';
import { usePlanDecision, usePlanReply, useStoryBuildPlanRevision } from '../../hooks/useStoryBuild.js';
import { TicketReview } from './TicketUpdatePanel.js';
import {
  CRITERION_STATUS_WORDS,
  contentionsHeading,
  decisionsWithPending,
  droppedLine,
  isStacked,
  pickDecision,
  planStageLine,
  stackRows,
  uiPlanRows,
} from '../../lib/buildPlan.js';
import { REVIEW_CHIP, REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import { sessionErrorText, sessionTurnRunning } from '../../lib/sandboxSession.js';
import { storyBuildRefAnchor } from '../../lib/storyBuild.js';
import { dateTime } from '../../lib/ui.js';
import { CopyButton } from '../CopyButton.js';
import { BookIcon, CaretIcon, CheckIcon, ChevronIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { Menu, type MenuEntry } from '../ui/Menu.js';
import { PlanDecisionWizard } from './PlanDecisionWizard.js';
import { ApproveRow, ContentionCard, EvidenceRow, type DecidedMap } from './PlanParts.js';

// THE PLAN PANEL ("Implement, plan first"; docs/STORY-BUILD.md § Plan first, docs/FRONTEND.md § The build
// tab). A plan-first session opens with a planning turn Limn sends itself; what the agent proposes comes
// back as a CHECKED plan revision (`session.plan`: every piece of evidence re-read by Limn). This panel
// shows the latest one above the conversation: the summary, the repositories, one line per acceptance
// criterion, the planned pull requests in order, then the POINTS TO SETTLE (where the agent says the story
// is wrong) asked ONE AT A TIME in ./PlanDecisionWizard.tsx (Agree / Keep the story / Reply), whose last
// step lists the answers and holds "Approve and start" (enabled only once every point is answered;
// lib/buildPlan.ts `planApproveState`), and the ticket review. Earlier and approved revisions list the
// points read-only. Agree / Keep the story is a DB write with no model turn; Reply and Approve are billed
// turns inside the ONE AiRunGate.
// The ticket review (./TicketUpdatePanel.tsx) is ALWAYS shown on the latest revision — the whole ticket,
// seeded with the plan's draft, else the current text — and "Update ticket" writes it to Jira on the
// reader's press; nothing else writes the ticket. After approval the plan folds to one line; the ticket
// review stays until the first build turn ends.

export function PlanPanel({ build, session }: { build: StoryBuild; session: StoryBuildSession }): JSX.Element | null {
  const plan = session.plan;
  const [viewing, setViewing] = useState<number | null>(null);
  if (plan == null) return null;
  if (plan.approvedRevision != null) {
    return (
      <>
        <ApprovedPlan build={build} plan={plan} />
        {/* Until the first build turn ends, the reader may still update the ticket. */}
        {session.phase === 'building' && build.planAutoApprovedAt == null && plan.latest != null && plan.latest.revision === plan.approvedRevision && (
          <section aria-label="The ticket" className="mt-3 rounded-ui bg-ui-surface p-4">
            <TicketReview key={plan.latest.revision} build={build} update={plan.latest.ticketUpdate} />
          </section>
        )}
      </>
    );
  }
  return (
    <section data-testid="story-plan" data-status={plan.status} aria-label="Plan" className="mt-5 rounded-ui bg-ui-surface p-4">
      <PlanHeading plan={plan} viewing={viewing} setViewing={setViewing} />
      {viewing != null && viewing !== plan.latest?.revision ? (
        <OlderRevision build={build} revision={viewing} fillGaps={plan.fillGaps} onBack={() => setViewing(null)} />
      ) : (
        <LatestPlan build={build} session={session} plan={plan} />
      )}
    </section>
  );
}

function PlanHeading({ plan, viewing, setViewing }: { plan: BuildPlanView; viewing: number | null; setViewing: (n: number | null) => void }): JSX.Element {
  const latest = plan.latest?.revision ?? null;
  const earlier: MenuEntry[] = [];
  for (let n = (latest ?? plan.revisions + 1) - 1; n >= 1; n--) earlier.push({ id: `r${n}`, label: `Revision ${n}`, onSelect: () => setViewing(n) });
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h3 className="text-title text-ui-ink">{latest != null ? `Plan · revision ${viewing ?? latest}` : 'Plan'}</h3>
      {plan.withDocs && (
        <span className={`${REVIEW_CHIP} bg-ui-raise text-ui-ink`}>
          <BookIcon size={11} />
          With docs
        </span>
      )}
      <InfoButton title="The plan">
        <p>The agent reads the ticket and the code{plan.withDocs ? ', and the reference documents Ensemble copied in,' : ''} and plans before it changes anything.</p>
        <p className="mt-2">Ensemble checks every piece of evidence itself. A point it cannot check is left out.</p>
        <p className="mt-2">Nothing is built until you approve the plan.</p>
      </InfoButton>
      {earlier.length > 0 && (
        <span className="ml-auto">
          <Menu
            label="Earlier revisions"
            align="end"
            items={earlier}
            trigger={(t) => (
              <Button {...t} size="sm" variant="ghost" data-testid="story-plan-history">
                Earlier revisions
                <CaretIcon size={9} />
              </Button>
            )}
          />
        </span>
      )}
    </div>
  );
}

// ── the latest revision (the one the reader answers) ────────────────────────────────────────────

function LatestPlan({ build, session, plan }: { build: StoryBuild; session: StoryBuildSession; plan: BuildPlanView }): JSX.Element {
  const decide = usePlanDecision(build.workspaceId, build.ident);
  const reply = usePlanReply(build.workspaceId, build.ident);
  // The reader's presses still in flight, laid over the server's answers (optimistic).
  const [pending, setPending] = useState<Record<string, BuildPlanDecision | null>>({});
  const [stale, setStale] = useState<string | null>(null);
  const latest = plan.latest;
  // A new revision clears what was in flight for the old one.
  useEffect(() => setPending({}), [latest?.revision]);
  const decided = decisionsWithPending(plan.decisions, pending);
  const running = sessionTurnRunning(session);
  const stage = planStageLine(plan);

  const press = (c: BuildPlanContention, pressed: BuildPlanDecision): void => {
    if (latest == null) return;
    const decision = pickDecision(decided[c.id], pressed);
    setPending((p) => ({ ...p, [c.id]: decision }));
    setStale(null);
    decide.mutate(
      { id: build.id, body: { revision: latest.revision, contentionId: c.id, decision } },
      {
        onSettled: () =>
          setPending((p) => {
            const next = { ...p };
            delete next[c.id];
            return next;
          }),
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'PlanStale') setStale('The plan changed. Look at the new revision.');
        },
      },
    );
  };

  return (
    <>
      {stage != null && (
        <p data-testid="story-plan-stage" className={cx('mt-1 text-body', plan.status === 'failed' ? 'text-ui-danger' : 'text-ui-mute')} aria-live="polite">
          {stage}
        </p>
      )}
      {stale != null && <p className="mt-1 text-meta text-ui-warn">{stale}</p>}
      {decide.error != null && !(decide.error instanceof ApiError && decide.error.code === 'PlanStale') && (
        <p className="mt-1 text-meta text-ui-danger">{sessionErrorText(decide.error as Error)}</p>
      )}
      {latest == null ? (
        plan.status === 'failed' ? (
          <p className="mt-2 text-meta text-ui-mute">Tell the agent what to change in the conversation, or ask it to plan again.</p>
        ) : null
      ) : (
        <RevisionBody
          build={build}
          plan={plan}
          rev={latest}
          decided={decided}
          editable
          points={
            latest.contentions.length > 0 ? (
              // Remounted on a new revision: the wizard opens again on the first open point.
              <PlanDecisionWizard
                key={`wizard-${latest.revision}`}
                build={build}
                session={session}
                plan={plan}
                rev={latest}
                decided={decided}
                revising={running || plan.status === 'revising'}
                onPick={press}
                reply={reply}
              />
            ) : undefined
          }
        />
      )}
      {/* With points to settle, Approve sits on the wizard's Review step. */}
      {latest != null && latest.contentions.length === 0 && <ApproveRow build={build} session={session} rev={latest} decided={decided} />}
    </>
  );
}

/**
 * The parts every revision shows. Read-only, the points are a list. `points` replaces that list on the
 * latest revision (the decision wizard), and comes after the pull requests so Approve is the last thing
 * before the ticket review.
 */
function RevisionBody({
  build,
  plan,
  rev,
  decided,
  points,
  editable = false,
}: {
  build: StoryBuild;
  plan: Pick<BuildPlanView, 'replies' | 'fillGaps'>;
  rev: BuildPlanRevision;
  decided: DecidedMap;
  points?: JSX.Element | undefined;
  /** The latest revision before Approve: the ticket review (always shown) can be edited and written to the ticket. */
  editable?: boolean;
}): JSX.Element {
  const dropped = droppedLine(rev.dropped);
  return (
    <div className="mt-3 space-y-4">
      {rev.summary !== '' && (
        <p data-testid="story-plan-summary" className="max-w-3xl whitespace-pre-wrap break-words text-body text-ui-ink">
          {rev.summary}
        </p>
      )}
      <PlanRepos rev={rev} />
      <PlanCriteria rev={rev} fillGaps={plan.fillGaps} />
      <PlanUi build={build} rev={rev} />
      {points != null && <PlanStack rev={rev} />}
      {points == null && rev.contentions.length > 0 && (
        <div data-testid="story-plan-contentions">
          <div className="mb-1.5 flex items-center gap-1.5">
            <h4 className={REVIEW_SUBHEAD}>{contentionsHeading(rev.contentions, decided)}</h4>
            <InfoButton title="Points to settle">
              <p>Each point is a place where the agent says the story is wrong, unclear, or does not match the code, the docs or the data.</p>
              <p className="mt-2">
                <strong>Agree</strong> tells the agent to build its proposal. <strong>Keep the story</strong> tells it to build what the story
                says. <strong>Reply</strong> sends your words, and the agent revises the plan.
              </p>
              <p className="mt-2">Your answers go into the build and into each pull request's description.</p>
            </InfoButton>
          </div>
          <ul className="space-y-2">
            {rev.contentions.map((c) => (
              <ContentionCard key={c.id} build={build} c={c} decided={decided[c.id]} replies={plan.replies.filter((r) => r.contentionId === c.id)} />
            ))}
          </ul>
        </div>
      )}
      {dropped != null && (
        <p data-testid="story-plan-dropped" className="flex items-center gap-1.5 text-meta text-ui-mute">
          {dropped}
          <InfoButton title="What Ensemble left out">
            <p>Ensemble keeps a point only when it can check its evidence: the lines in the code at the session's start, the section in the docs, or a query Ensemble saw run.</p>
            {rev.dropped.reasons.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-4">
                {rev.dropped.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </InfoButton>
        </p>
      )}
      {points ?? <PlanStack rev={rev} />}
      {editable ? (
        <TicketReview key={rev.revision} build={build} update={rev.ticketUpdate} />
      ) : (
        rev.ticketUpdate != null && <TicketUpdate update={rev.ticketUpdate} />
      )}
    </div>
  );
}

function PlanRepos({ rev }: { rev: BuildPlanRevision }): JSX.Element | null {
  if (rev.repos.length === 0) return null;
  return (
    <div data-testid="story-plan-repos">
      <h4 className={`${REVIEW_SUBHEAD} mb-1`}>Repositories ({rev.repos.length})</h4>
      <ul className="space-y-1">
        {rev.repos.map((r) => (
          <li key={r.repoId} className="grid gap-x-3 text-body text-ui-ink sm:grid-cols-[minmax(8rem,14rem)_1fr]">
            <span className="break-all font-mono text-meta">{r.fullName}</span>
            <span className="min-w-0 break-words">{r.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlanCriteria({ rev, fillGaps }: { rev: BuildPlanRevision; fillGaps: boolean }): JSX.Element | null {
  if (rev.criteria.length === 0) return null;
  return (
    <div data-testid="story-plan-criteria">
      <h4 className={`${REVIEW_SUBHEAD} mb-1`}>{fillGaps ? 'Gaps' : 'Acceptance criteria'}</h4>
      <ul className="space-y-1.5">
        {rev.criteria.map((c) => (
          <li key={c.ref} data-testid="story-plan-criterion" data-ref={c.ref} data-status={c.status} className="flex gap-2 text-body text-ui-ink">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" role="img" aria-label={CRITERION_STATUS_WORDS[c.status]}>
              {c.status === 'met' ? (
                <CheckIcon size={13} className="text-ui-success" />
              ) : c.status === 'planned' ? (
                <span className="decorative-mark h-3 w-3 rounded-sm border border-ui-mute" />
              ) : (
                <span className="decorative-mark h-px w-3 bg-ui-mute" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <button
                  type="button"
                  className="font-mono text-meta text-ui-mute hover:text-ui-ink hover:underline"
                  title="Show it in the Ticket panel"
                  onClick={() => document.getElementById(storyBuildRefAnchor(c.ref))?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                >
                  {c.ref}
                </button>
                {c.text !== '' && <span className="min-w-0 break-words">{c.text}</span>}
                {c.status !== 'planned' && <span className="text-meta text-ui-mute">{CRITERION_STATUS_WORDS[c.status]}</span>}
              </div>
              {c.how !== '' && <p className="mt-0.5 break-words text-meta text-ui-mute">{c.how}</p>}
              {(c.prs.length > 0 || c.openPoints.length > 0) && (
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {c.prs.map((p) => (
                    <span key={p} className={`${REVIEW_CHIP} bg-ui-raise font-mono text-ui-ink`}>
                      {p}
                    </span>
                  ))}
                  {c.openPoints.map((n) => (
                    <span key={`o${n}`} className={`${REVIEW_CHIP} bg-ui-raise text-ui-ink`}>
                      Open point {n}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The screens the work changes (the plan's `ui` section): the design it used, the design system and the
 *  nearest screens it follows (checked code quotes), where they render. Absent when no screen changes. */
function PlanUi({ build, rev }: { build: StoryBuild; rev: BuildPlanRevision }): JSX.Element | null {
  const rows = uiPlanRows(rev.ui);
  if (rows == null || rev.ui == null) return null;
  const evidence = [...rev.ui.designSystem.evidence, ...rev.ui.nearestScreens];
  return (
    <div data-testid="story-plan-ui">
      <div className="mb-1 flex items-center gap-1.5">
        <h4 className={REVIEW_SUBHEAD}>Screens</h4>
        <InfoButton title="Screens">
          <p>The agent looked for the design system and the screens nearest to this work in your repositories. Ensemble checked each quote against the code at the start of the session.</p>
          <p className="mt-2">When the ticket has no design, the agent builds to fit the existing screens.</p>
        </InfoButton>
      </div>
      {rev.ui.reason !== '' && <p className="mb-1 max-w-3xl break-words text-body text-ui-ink">{rev.ui.reason}</p>}
      <dl className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.key} data-testid="story-plan-ui-row" data-key={r.key} className="grid gap-x-3 text-body sm:grid-cols-[minmax(6rem,8rem)_1fr]">
            <dt className="text-meta text-ui-mute">{r.label}</dt>
            <dd className="min-w-0 break-words text-ui-ink">{r.text}</dd>
          </div>
        ))}
      </dl>
      {evidence.length > 0 && (
        <ul className="mt-1.5 space-y-1.5">
          {evidence.map((e, i) => (
            <EvidenceRow key={i} workspaceId={build.workspaceId} e={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── the pull requests and the ticket update ─────────────────────────────────────────────────────

function PlanStack({ rev }: { rev: BuildPlanRevision }): JSX.Element | null {
  if (rev.stack.length === 0) return null;
  const rows = stackRows(rev.stack);
  return (
    <div data-testid="story-plan-stack">
      <div className="mb-1 flex items-center gap-1.5">
        <h4 className={REVIEW_SUBHEAD}>
          Pull requests ({rows.length}
          {rows.length > 1 ? ', in order' : ''})
        </h4>
        <InfoButton title="The pull requests">
          {isStacked(rev.stack) || rev.stackReason != null ? (
            <p>{rev.stackReason ?? 'The agent splits the work so each pull request is smaller to review.'}</p>
          ) : (
            <p>One pull request per repository.</p>
          )}
          <p className="mt-2">Each one must build and pass its tests on its own. In one repository, each pull request builds on the one before it.</p>
        </InfoButton>
      </div>
      <ol className="space-y-1">
        {rows.map((r) => (
          <li key={r.key} data-testid="story-plan-pr" data-key={r.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-body text-ui-ink">
            <span className="w-4 shrink-0 text-right text-meta text-ui-mute">{r.n}</span>
            <span className="break-all font-mono text-meta text-ui-mute">{r.fullName}</span>
            <span className="font-mono text-meta text-ui-mute">{r.key}</span>
            <span className="min-w-0 break-words">{r.title}</span>
            {r.buildsOn != null && <span className="text-meta text-ui-mute">· {r.buildsOn}</span>}
            {r.after != null && <span className="text-meta text-ui-mute">· {r.after}</span>}
            {r.criteria.length > 0 && <span className="text-meta text-ui-mute">{r.criteria.join(' · ')}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function TicketUpdate({ update }: { update: NonNullable<BuildPlanRevision['ticketUpdate']> }): JSX.Element {
  return (
    <div data-testid="story-plan-ticket-update">
      <div className="mb-1 flex items-center gap-1.5">
        <h4 className={REVIEW_SUBHEAD}>Ticket update (draft)</h4>
        <InfoButton title="Ticket update">
          <p>A draft of the ticket with the agent's changes, in the ticket's own style. Copy it into the ticket if you agree. Ensemble never changes the ticket.</p>
        </InfoButton>
      </div>
      {update.why !== '' && <p className="mb-2 break-words text-body text-ui-ink">{update.why}</p>}
      {update.description != null && <DraftField label="Description" text={update.description} testId="story-plan-ticket-description" />}
      {update.acceptanceCriteria != null && <DraftField label="Acceptance criteria" text={update.acceptanceCriteria} testId="story-plan-ticket-criteria" />}
    </div>
  );
}

function DraftField({ label, text, testId }: { label: string; text: string; testId: string }): JSX.Element {
  return (
    <div data-testid={testId} className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-meta font-medium text-ui-ink">{label}</span>
        <CopyButton text={text} what={label.toLowerCase()} title={`Copy the ${label.toLowerCase()}, exactly as written`} />
      </div>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-ui bg-ui-raise p-2 font-mono text-meta text-ui-ink">{text}</pre>
    </div>
  );
}

// ── after approval, and earlier revisions ───────────────────────────────────────────────────────

function ApprovedPlan({ build, plan }: { build: StoryBuild; plan: BuildPlanView }): JSX.Element {
  const [open, setOpen] = useState(false);
  const rev = plan.latest != null && plan.latest.revision === plan.approvedRevision ? plan.latest : null;
  const older = useStoryBuildPlanRevision(build.id, open && rev == null ? plan.approvedRevision : null);
  const shown = rev ?? older.data?.revision ?? null;
  const decided: Record<string, BuildPlanDecision> =
    rev != null ? decisionsWithPending(plan.decisions, {}) : Object.fromEntries(Object.entries(older.data?.decisions ?? {}).map(([k, v]) => [k, v.decision]));
  return (
    <section data-testid="story-plan" data-status="approved" aria-label="Approved plan" className="mt-5 rounded-ui bg-ui-surface px-4 py-3">
      <button type="button" className="hit flex w-full items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronIcon dir={open ? 'down' : 'right'} />
        <span className="text-body font-medium text-ui-ink">Approved plan · revision {plan.approvedRevision}</span>
        {plan.approvedAt != null && <span className="text-meta text-ui-mute">{dateTime(plan.approvedAt)}</span>}
      </button>
      {open &&
        (shown == null ? (
          <p className="mt-2 text-meta text-ui-mute">{older.isError ? 'Could not load the plan.' : 'Loading…'}</p>
        ) : (
          <RevisionBody build={build} plan={plan} rev={shown} decided={decided} />
        ))}
    </section>
  );
}

function OlderRevision({ build, revision, fillGaps, onBack }: { build: StoryBuild; revision: number; fillGaps: boolean; onBack: () => void }): JSX.Element {
  const q = useStoryBuildPlanRevision(build.id, revision);
  const decided: Record<string, BuildPlanDecision> = Object.fromEntries(Object.entries(q.data?.decisions ?? {}).map(([k, v]) => [k, v.decision]));
  return (
    <div data-testid="story-plan-older">
      <p className="mt-1 flex flex-wrap items-center gap-2 text-meta text-ui-mute">
        An earlier revision. Answers are given on the latest one.
        <Button size="sm" variant="secondary" onClick={onBack}>
          Back to the latest
        </Button>
      </p>
      {q.isLoading && <p className="mt-2 text-meta text-ui-mute">Loading…</p>}
      {q.isError && <p className="mt-2 text-meta text-ui-danger">Could not load this revision.</p>}
      {q.data != null && <RevisionBody build={build} plan={{ replies: [], fillGaps }} rev={q.data.revision} decided={decided} />}
    </div>
  );
}
