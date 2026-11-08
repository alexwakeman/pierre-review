import { useEffect, useId, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  BUILD_PLAN_LIMITS,
  TICKET_UPDATE_FIELD_MAX,
  isTrackerIdent,
  parseTicketIdent,
  type BuildPlanContention,
  type BuildPlanDecision,
  type BuildPlanEvidence,
  type BuildPlanRevision,
  type BuildPlanView,
  type StoryBuild,
  type StoryBuildSession,
} from '@pierre-review/shared';
import { ApiError } from '../../api/client.js';
import { storyBuildMutationKey, usePlanApprove, usePlanDecision, usePlanReply, useStoryBuildPlanRevision } from '../../hooks/useStoryBuild.js';
import { useUpdateTicket } from '../../hooks/useTicketPrs.js';
import {
  CRITERION_STATUS_WORDS,
  PLAN_DECISION_WORDS,
  contentionsHeading,
  decisionsWithPending,
  droppedLine,
  evidenceGithubUrl,
  evidenceLabel,
  excerptLines,
  isStacked,
  nextDecision,
  planApproveState,
  planStageLine,
  stackRows,
} from '../../lib/buildPlan.js';
import { REVIEW_CHIP, REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import { sessionErrorText, sessionTurnRunning } from '../../lib/sandboxSession.js';
import { storyBuildRefAnchor } from '../../lib/storyBuild.js';
import { dateTime, safeExternalUrl } from '../../lib/ui.js';
import { AiRunGate } from '../AiSetup.js';
import { CopyButton } from '../CopyButton.js';
import { DocReferenceList } from '../DocReferences.js';
import { BookIcon, CaretIcon, CheckIcon, ChevronIcon, DatabaseIcon, DiffIcon, ExternalLinkIcon, ScalesIcon, WrenchIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { Menu, type MenuEntry } from '../ui/Menu.js';

// THE PLAN PANEL ("Implement, plan first"; docs/STORY-BUILD.md § Plan first, docs/FRONTEND.md § The build
// tab). A plan-first session opens with a planning turn Limn sends itself; what the agent proposes comes
// back as a CHECKED plan revision (`session.plan`: every piece of evidence re-read by Limn). This panel
// shows the latest one above the conversation: the summary, the repositories, one line per acceptance
// criterion, each POINT TO SETTLE (where the agent says the story is wrong) with its evidence and Agree /
// Keep the story / Reply, the planned pull requests in order, and a draft ticket update to paste. "Approve
// and start" is enabled only once every point is answered (lib/buildPlan.ts `planApproveState`). Agree /
// Keep the story is a DB write with no model turn; Reply and Approve are billed turns inside the ONE
// AiRunGate. The ticket draft is editable on the latest revision, and "Update ticket" writes it to Jira
// on the reader's press (EditableTicketUpdate); nothing else writes the ticket. After approval it folds
// to one line.

type DecidedMap = Readonly<Record<string, BuildPlanDecision>>;

/** A Jira ticket: the only tracker Limn writes a ticket update to. */
const isJiraIdent = (ident: string): boolean => {
  const p = parseTicketIdent(ident);
  return isTrackerIdent(p) && p.provider === 'jira';
};

export function PlanPanel({ build, session }: { build: StoryBuild; session: StoryBuildSession }): JSX.Element | null {
  const plan = session.plan;
  const [viewing, setViewing] = useState<number | null>(null);
  if (plan == null) return null;
  if (plan.approvedRevision != null) return <ApprovedPlan build={build} plan={plan} />;
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
        <p>The agent reads the ticket and the code{plan.withDocs ? ', and the reference documents Limn copied in,' : ''} and plans before it changes anything.</p>
        <p className="mt-2">Limn checks every piece of evidence itself. A point it cannot check is left out.</p>
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
    const decision = nextDecision(decided[c.id], pressed);
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
          card={(c) => (
            <ContentionActions
              build={build}
              plan={plan}
              rev={latest}
              c={c}
              decided={decided[c.id]}
              running={running}
              live={session.live}
              onPress={(d) => press(c, d)}
              reply={reply}
            />
          )}
        />
      )}
      {latest != null && <ApproveRow build={build} session={session} rev={latest} decided={decided} />}
    </>
  );
}

/** The parts every revision shows, read-only. `card` adds the answer row under each point (the latest). */
function RevisionBody({
  build,
  plan,
  rev,
  decided,
  card,
  editable = false,
}: {
  build: StoryBuild;
  plan: Pick<BuildPlanView, 'replies' | 'fillGaps'>;
  rev: BuildPlanRevision;
  decided: DecidedMap;
  card?: (c: BuildPlanContention) => JSX.Element;
  /** The latest revision before Approve: the ticket draft can be edited and written to the ticket. */
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
      {rev.contentions.length > 0 && (
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
              <ContentionCard key={c.id} build={build} c={c} decided={decided[c.id]} replies={plan.replies.filter((r) => r.contentionId === c.id)}>
                {card?.(c)}
              </ContentionCard>
            ))}
          </ul>
        </div>
      )}
      {dropped != null && (
        <p data-testid="story-plan-dropped" className="flex items-center gap-1.5 text-meta text-ui-mute">
          {dropped}
          <InfoButton title="What Limn left out">
            <p>Limn keeps a point only when it can check its evidence: the lines in the code at the session's start, the section in the docs, or a query Limn saw run.</p>
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
      <PlanStack rev={rev} />
      {rev.ticketUpdate != null &&
        (editable ? (
          <EditableTicketUpdate key={rev.revision} build={build} update={rev.ticketUpdate} />
        ) : (
          <TicketUpdate update={rev.ticketUpdate} />
        ))}
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

// ── one point to settle ──────────────────────────────────────────────────────────────────────────

function ContentionCard({
  build,
  c,
  decided,
  replies,
  children,
}: {
  build: StoryBuild;
  c: BuildPlanContention;
  decided: BuildPlanDecision | undefined;
  replies: BuildPlanView['replies'];
  children?: JSX.Element | undefined;
}): JSX.Element {
  const titleId = useId();
  return (
    <li
      data-testid="story-plan-contention"
      data-id={c.id}
      data-decision={decided ?? ''}
      aria-labelledby={titleId}
      className={cx('rounded-ui bg-ui-bg p-3 ring-1 ring-inset', decided != null ? 'ring-ui-line' : 'ring-ui-warn/60')}
    >
      <div id={titleId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ScalesIcon size={13} className="text-ui-mute" />
        <span className="font-mono text-meta text-ui-mute">{c.id}</span>
        {c.about.map((a) => (
          <span key={a} className={`${REVIEW_CHIP} bg-ui-raise font-mono text-ui-ink`}>
            {a}
          </span>
        ))}
        {decided != null && (
          <span data-testid="story-plan-answered" className="ml-auto flex items-center gap-1 text-meta text-ui-ink">
            <CheckIcon size={12} className="text-ui-success" />
            {PLAN_DECISION_WORDS[decided]}
          </span>
        )}
      </div>
      {c.storySays != null && (
        <p className="mt-2 break-words text-body text-ui-ink">
          <span className="text-ui-mute">The story says: </span>“{c.storySays}”
        </p>
      )}
      <p className="mt-1.5 break-words text-body text-ui-ink">{c.problem}</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-body sm:grid-cols-2">
        <div>
          <dt className={REVIEW_SUBHEAD}>If you agree</dt>
          <dd className="break-words text-ui-ink">{c.proposal}</dd>
        </div>
        <div>
          <dt className={REVIEW_SUBHEAD}>If you keep the story</dt>
          <dd className="break-words text-ui-ink">{c.ifKept}</dd>
        </div>
      </dl>
      <div className="mt-2">
        <h5 className={`${REVIEW_SUBHEAD} mb-1`}>Evidence</h5>
        <ul className="space-y-1.5">
          {c.evidence.map((e, i) => (
            <EvidenceRow key={i} workspaceId={build.workspaceId} e={e} />
          ))}
        </ul>
      </div>
      {replies.length > 0 && (
        <ul className="mt-2 space-y-1">
          {replies.map((r, i) => (
            <li key={i} className="break-words text-meta text-ui-ink">
              <span className="text-ui-mute">You replied (revision {r.revision}): </span>
              {r.text}
            </li>
          ))}
        </ul>
      )}
      {children}
    </li>
  );
}

function EvidenceRow({ workspaceId, e }: { workspaceId: number; e: BuildPlanEvidence }): JSX.Element {
  const [open, setOpen] = useState(e.kind !== 'docs');
  const label = evidenceLabel(e);
  const url = safeExternalUrl(evidenceGithubUrl(e));
  const icon = label.kind === 'Docs' ? <BookIcon size={12} /> : label.kind === 'Data' ? <DatabaseIcon size={12} /> : <DiffIcon size={12} />;
  if (e.kind === 'docs') {
    return (
      <li data-testid="story-plan-evidence" data-kind="docs">
        <div className="text-meta">
          <DocReferenceList references={[{ ...e, workspaceId: e.workspaceId ?? workspaceId }]} />
        </div>
      </li>
    );
  }
  return (
    <li data-testid="story-plan-evidence" data-kind={e.kind}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta">
        <span className="flex items-center gap-1 text-ui-mute">
          {icon}
          {label.kind}
        </span>
        <button type="button" className="hit inline-flex min-w-0 items-center gap-1 break-all text-left font-mono text-ui-ink hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <ChevronIcon dir={open ? 'down' : 'right'} />
          {label.where}
        </button>
        {label.note != null && label.note !== '' && <span className="text-ui-mute">{label.note}</span>}
        {url != null && (
          <a href={url} target="_blank" rel="noreferrer noopener" className="hit text-ui-mute hover:text-ui-ink" aria-label="Open these lines on GitHub">
            <ExternalLinkIcon size={11} />
          </a>
        )}
      </div>
      {open && e.kind === 'data_run' && (
        <div className="mt-1 rounded-ui bg-ui-raise p-2 font-mono text-meta text-ui-ink">
          <div className="break-all text-ui-mute">
            $ {e.command.join(' ')} · {dateTime(e.at)}
          </div>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{e.excerpt}</pre>
        </div>
      )}
      {open && (e.kind === 'code' || e.kind === 'data_file') && (
        <pre className="mt-1 max-h-60 overflow-auto rounded-ui bg-ui-raise py-1.5 font-mono text-meta text-ui-ink">
          {excerptLines(e).map((l) => (
            <div key={l.n} className="flex">
              <span aria-hidden className="decorative-mark w-10 shrink-0 select-none pr-2 text-right text-ui-faint">
                {l.n}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">{l.text}</span>
            </div>
          ))}
        </pre>
      )}
    </li>
  );
}

/** Agree / Keep the story / Reply under a point of the latest revision. */
function ContentionActions({
  build,
  plan,
  rev,
  c,
  decided,
  running,
  live,
  onPress,
  reply,
}: {
  build: StoryBuild;
  plan: BuildPlanView;
  rev: BuildPlanRevision;
  c: BuildPlanContention;
  decided: BuildPlanDecision | undefined;
  running: boolean;
  live: boolean;
  onPress: (d: BuildPlanDecision) => void;
  reply: ReturnType<typeof usePlanReply>;
}): JSX.Element {
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState('');
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  const trimmed = text.trim();
  const tooLong = trimmed.length > BUILD_PLAN_LIMITS.reply;
  const mine = reply.variables?.body.contentionId === c.id;
  if (running || plan.status === 'revising') {
    return <p className="mt-2 text-meta text-ui-mute">The agent is revising the plan…</p>;
  }
  const send = (): void => {
    if (trimmed === '' || tooLong) return;
    reply.mutate(
      { id: build.id, body: { revision: rev.revision, contentionId: c.id, text: trimmed } },
      {
        onSuccess: () => {
          setText('');
          setComposing(false);
        },
      },
    );
  };
  return (
    <div className="mt-2.5">
      <div className="flex flex-wrap items-center gap-1.5" data-noactivate>
        <Button
          size="sm"
          variant={decided === 'agree' ? 'primary' : 'secondary'}
          aria-pressed={decided === 'agree'}
          data-plan-action="agree"
          onClick={() => onPress('agree')}
        >
          Agree
        </Button>
        <Button
          size="sm"
          variant={decided === 'keep_story' ? 'primary' : 'secondary'}
          aria-pressed={decided === 'keep_story'}
          data-plan-action="keep"
          onClick={() => onPress('keep_story')}
        >
          Keep the story
        </Button>
        {live && (
          <Button size="sm" variant="ghost" data-plan-action="reply" aria-expanded={composing} onClick={() => setComposing((v) => !v)}>
            Reply
          </Button>
        )}
      </div>
      {composing && (
        <div className="mt-2 space-y-1.5">
          <textarea
            aria-label={`Reply to ${c.id}`}
            className="block w-full resize-y rounded-ui bg-ui-surface px-2 py-1.5 text-body text-ui-ink ring-1 ring-inset ring-ui-line placeholder:text-ui-faint focus:outline-none focus:ring-2 focus:ring-ui-accent"
            rows={2}
            placeholder="Tell the agent what you think. It revises the plan."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <AiRunGate kind="story_plan" followUp provider={build.provider ?? null} meter={false}>
              <Button size="sm" data-ai-run data-plan-action="send-reply" disabled={busy || trimmed === '' || tooLong} onClick={send}>
                Send
              </Button>
            </AiRunGate>
            <Button size="sm" variant="ghost" onClick={() => setComposing(false)}>
              Cancel
            </Button>
            {tooLong && <span className="text-meta text-ui-warn">Keep it under {BUILD_PLAN_LIMITS.reply.toLocaleString('en-GB')} characters.</span>}
            {mine && reply.error != null && <span className="text-meta text-ui-danger">{planErrorText(reply.error)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function planErrorText(err: unknown): string | null {
  if (err == null) return null;
  if (err instanceof ApiError && err.code === 'PlanStale') return 'The plan changed. Look at the new revision.';
  return sessionErrorText(err instanceof ApiError ? err : { message: (err as Error).message });
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
          <p>A draft of the ticket with the agent's changes, in the ticket's own style. Copy it into the ticket if you agree. Limn never changes the ticket.</p>
        </InfoButton>
      </div>
      {update.why !== '' && <p className="mb-2 break-words text-body text-ui-ink">{update.why}</p>}
      {update.description != null && <DraftField label="Description" text={update.description} testId="story-plan-ticket-description" />}
      {update.acceptanceCriteria != null && <DraftField label="Acceptance criteria" text={update.acceptanceCriteria} testId="story-plan-ticket-criteria" />}
    </div>
  );
}

/**
 * THE TICKET DRAFT, EDITABLE (the latest revision, before Approve): the agent's draft in a text box
 * per field, which the reader may change ("Back to the draft" undoes their edits), copy, or write to
 * the ticket with "Update ticket" (Jira only; docs/TRACKERS.md § The ticket update). The write asks
 * once ("Replace …?") and is never retried. Approve and start reads the ticket again, so the build
 * gets the updated text. An empty box leaves that field as it is.
 */
function EditableTicketUpdate({ build, update }: { build: StoryBuild; update: NonNullable<BuildPlanRevision['ticketUpdate']> }): JSX.Element {
  const [description, setDescription] = useState(update.description);
  const [criteria, setCriteria] = useState(update.acceptanceCriteria);
  const [asking, setAsking] = useState(false);
  const write = useUpdateTicket(build.workspaceId, build.ident);
  const jira = isJiraIdent(build.ident);
  const edited = description !== update.description || criteria !== update.acceptanceCriteria;
  const body = { description: blankToNull(description), acceptanceCriteria: blankToNull(criteria) };
  const tooLong = [description, criteria].some((t) => t != null && t.length > TICKET_UPDATE_FIELD_MAX);
  const nothing = body.description == null && body.acceptanceCriteria == null;
  const what = [body.description != null ? 'description' : null, body.acceptanceCriteria != null ? 'acceptance criteria' : null]
    .filter((x) => x != null)
    .join(' and ');
  const err = write.error != null ? (sessionErrorText(write.error) ?? 'Could not update the ticket.') : null;
  // An edit after a write makes the ticket differ again: forget the "Updated" line.
  const change = (set: (v: string) => void) => (v: string) => {
    set(v);
    if (write.isSuccess || write.isError) write.reset();
  };
  return (
    <div data-testid="story-plan-ticket-update" data-editable="true">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <h4 className={REVIEW_SUBHEAD}>Ticket update{edited ? ' (edited)' : ' (draft)'}</h4>
        <InfoButton title="Ticket update">
          <p>The agent's draft of the ticket, in the ticket's own style, as if you agree with every point. Change it as you like.</p>
          <p className="mt-2">
            {jira
              ? 'Update ticket writes it to Jira: the description, and the acceptance criteria into the field Limn read them from. An empty box leaves that field as it is. Approve and start reads the ticket again.'
              : 'Updating the ticket from Limn works with Jira only. Copy the text into the ticket instead.'}
          </p>
        </InfoButton>
        {edited && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            data-testid="story-plan-ticket-reset"
            onClick={() => {
              setDescription(update.description);
              setCriteria(update.acceptanceCriteria);
              write.reset();
            }}
          >
            Back to the draft
          </Button>
        )}
      </div>
      {update.why !== '' && <p className="mb-2 break-words text-body text-ui-ink">{update.why}</p>}
      {description != null && (
        <DraftEditor label="Description" text={description} onChange={change(setDescription)} testId="story-plan-ticket-description" />
      )}
      {criteria != null && (
        <DraftEditor label="Acceptance criteria" text={criteria} onChange={change(setCriteria)} testId="story-plan-ticket-criteria" />
      )}
      {jira && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-meta">
          {asking ? (
            <>
              <span className="text-ui-ink">Replace the ticket's {what} in Jira?</span>
              <Button
                size="sm"
                variant="primary"
                data-testid="story-plan-ticket-update-confirm"
                busy={write.isPending}
                busyLabel="Updating…"
                onClick={() => write.mutate(body, { onSettled: () => setAsking(false) })}
              >
                Replace
              </Button>
              <Button size="sm" variant="ghost" disabled={write.isPending} onClick={() => setAsking(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              data-testid="story-plan-ticket-update-button"
              disabled={nothing || tooLong || write.isPending || write.isSuccess}
              onClick={() => setAsking(true)}
            >
              Update ticket
            </Button>
          )}
          {write.isSuccess && (
            <span data-testid="story-plan-ticket-updated" className="text-ui-mute">
              Updated in Jira. Approve and start reads the ticket again.
            </span>
          )}
          {tooLong && <span className="text-ui-warn">Keep each box under {TICKET_UPDATE_FIELD_MAX.toLocaleString('en-GB')} characters.</span>}
          {err != null && <span className="text-ui-danger">{err}</span>}
        </div>
      )}
    </div>
  );
}

const blankToNull = (t: string | null): string | null => (t == null || t.trim() === '' ? null : t);

function DraftEditor({ label, text, onChange, testId }: { label: string; text: string; onChange: (v: string) => void; testId: string }): JSX.Element {
  const id = useId();
  return (
    <div data-testid={testId} className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-meta font-medium text-ui-ink">
          {label}
        </label>
        <CopyButton text={text} what={label.toLowerCase()} title={`Copy the ${label.toLowerCase()}, exactly as written`} />
      </div>
      <textarea
        id={id}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        rows={Math.min(14, Math.max(4, text.split('\n').length + 1))}
        spellCheck
        className="mt-1 block max-h-[28rem] w-full resize-y rounded-ui bg-ui-raise p-2 font-mono text-meta text-ui-ink ring-1 ring-inset ring-ui-line focus:outline-none focus:ring-2 focus:ring-ui-accent"
      />
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

// ── Approve and start ──────────────────────────────────────────────────────────────────────────

function ApproveRow({ build, session, rev, decided }: { build: StoryBuild; session: StoryBuildSession; rev: BuildPlanRevision; decided: DecidedMap }): JSX.Element | null {
  const approve = usePlanApprove(build.workspaceId, build.ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  const state = planApproveState(session, decided);
  if (!state.shown) return null;
  const err = planErrorText(approve.error);
  return (
    <div data-testid="story-plan-approve-row" className="mt-4 flex flex-wrap items-center gap-2 border-t border-ui-line pt-3">
      <AiRunGate kind="story_build" followUp provider={session.provider ?? build.provider ?? null}>
        <Button
          variant="primary"
          size="sm"
          data-ai-run
          data-story-build-action="approve"
          icon={<WrenchIcon size={12} />}
          disabled={!state.enabled || busy}
          busy={approve.isPending}
          busyLabel="Starting…"
          onClick={() => approve.mutate({ id: build.id, body: { revision: rev.revision } })}
        >
          Approve and start
        </Button>
      </AiRunGate>
      {state.reason != null && (
        <span data-testid="story-plan-approve-reason" className="text-meta text-ui-mute">
          {state.reason}
        </span>
      )}
      {state.enabled && <span className="text-meta text-ui-mute">The agent then builds to the end. You can stop it or message it.</span>}
      {err != null && <span className="text-meta text-ui-danger">{err}</span>}
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
