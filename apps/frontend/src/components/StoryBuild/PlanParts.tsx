import { useId, useState, type ReactNode } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  BUILD_PLAN_LIMITS,
  type BuildPlanContention,
  type BuildPlanDecision,
  type BuildPlanEvidence,
  type BuildPlanRevision,
  type BuildPlanView,
  type StoryBuild,
  type StoryBuildSession,
} from '@pierre-review/shared';
import { ApiError } from '../../api/client.js';
import { storyBuildMutationKey, usePlanApprove, usePlanReply } from '../../hooks/useStoryBuild.js';
import { PLAN_DECISION_WORDS, evidenceGithubUrl, evidenceLabel, excerptLines, planApproveState } from '../../lib/buildPlan.js';
import { REVIEW_CHIP, REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import { sessionErrorText } from '../../lib/sandboxSession.js';
import { dateTime, safeExternalUrl } from '../../lib/ui.js';
import { AiRunGate } from '../AiSetup.js';
import { DocReferenceList } from '../DocReferences.js';
import { BookIcon, CheckIcon, ChevronIcon, DatabaseIcon, DiffIcon, ExternalLinkIcon, ScalesIcon, WrenchIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';

// THE PLAN PANEL'S SHARED PARTS (./PlanPanel.tsx, ./PlanDecisionWizard.tsx; docs/STORY-BUILD.md § Plan
// first): one point to settle with its evidence, the Reply box under a point, and "Approve and start".
// The read-only revisions list the points with `ContentionCard`; the latest one asks them one at a time in
// the wizard, which draws the same card.

export type DecidedMap = Readonly<Record<string, BuildPlanDecision>>;

// ── one point to settle ──────────────────────────────────────────────────────────────────────────

export function ContentionCard({
  build,
  c,
  decided,
  replies,
  as = 'li',
  title,
  outcomes = true,
  children,
}: {
  build: StoryBuild;
  c: BuildPlanContention;
  decided: BuildPlanDecision | undefined;
  replies: BuildPlanView['replies'];
  /** `div` inside the wizard's step; `li` in a list. */
  as?: 'li' | 'div';
  /** Replaces the card's own heading row (the wizard's "Point 2 of 4"). */
  title?: ReactNode;
  /** The "If you agree" / "If you keep the story" pair (the wizard shows them on its two choices). */
  outcomes?: boolean;
  children?: ReactNode;
}): JSX.Element {
  const titleId = useId();
  const Tag = as;
  return (
    <Tag
      data-testid="story-plan-contention"
      data-id={c.id}
      data-decision={decided ?? ''}
      aria-labelledby={titleId}
      className={cx('rounded-ui bg-ui-bg p-3 ring-1 ring-inset', decided != null ? 'ring-ui-line' : 'ring-ui-warn/60')}
    >
      <div id={titleId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {title ?? (
          <>
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
          </>
        )}
      </div>
      {c.storySays != null && (
        <p className="mt-2 break-words text-body text-ui-ink">
          <span className="text-ui-mute">The story says: </span>“{c.storySays}”
        </p>
      )}
      <p className="mt-1.5 break-words text-body text-ui-ink">{c.problem}</p>
      {outcomes && (
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
      )}
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
    </Tag>
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

// ── Reply (a billed revision turn) ───────────────────────────────────────────────────────────────

/** The reply box under a point of the latest revision: the reader's words, then the agent revises. */
export function PlanReplyBox({
  build,
  rev,
  c,
  reply,
  onClose,
}: {
  build: StoryBuild;
  rev: BuildPlanRevision;
  c: BuildPlanContention;
  reply: ReturnType<typeof usePlanReply>;
  onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  const trimmed = text.trim();
  const tooLong = trimmed.length > BUILD_PLAN_LIMITS.reply;
  const mine = reply.variables?.body.contentionId === c.id;
  const send = (): void => {
    if (trimmed === '' || tooLong) return;
    reply.mutate(
      { id: build.id, body: { revision: rev.revision, contentionId: c.id, text: trimmed } },
      {
        onSuccess: () => {
          setText('');
          onClose();
        },
      },
    );
  };
  return (
    <div className="mt-2 space-y-1.5">
      <textarea
        aria-label={`Reply to ${c.id}`}
        className="block w-full resize-y rounded-ui bg-ui-surface px-2 py-1.5 text-body text-ui-ink ring-1 ring-inset ring-ui-line placeholder:text-ui-faint focus:outline-none focus:ring-2 focus:ring-ui-accent"
        rows={2}
        autoFocus
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
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {tooLong && <span className="text-meta text-ui-warn">Keep it under {BUILD_PLAN_LIMITS.reply.toLocaleString('en-GB')} characters.</span>}
        {mine && reply.error != null && <span className="text-meta text-ui-danger">{planErrorText(reply.error)}</span>}
      </div>
    </div>
  );
}

export function planErrorText(err: unknown): string | null {
  if (err == null) return null;
  if (err instanceof ApiError && err.code === 'PlanStale') return 'The plan changed. Look at the new revision.';
  return sessionErrorText(err instanceof ApiError ? err : { message: (err as Error).message });
}

// ── Approve and start ──────────────────────────────────────────────────────────────────────────

export function ApproveRow({
  build,
  session,
  rev,
  decided,
  inWizard = false,
}: {
  build: StoryBuild;
  session: StoryBuildSession;
  rev: BuildPlanRevision;
  decided: DecidedMap;
  /** On the wizard's Review step (no rule above it). */
  inWizard?: boolean;
}): JSX.Element | null {
  const approve = usePlanApprove(build.workspaceId, build.ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  const state = planApproveState(session, decided);
  if (!state.shown) return null;
  const err = planErrorText(approve.error);
  return (
    <div data-testid="story-plan-approve-row" className={cx('flex flex-wrap items-center gap-2', inWizard ? 'mt-3' : 'mt-4 border-t border-ui-line pt-3')}>
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
