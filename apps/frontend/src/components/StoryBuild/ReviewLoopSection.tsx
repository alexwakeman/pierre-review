import { useEffect, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type {
  ClaudeFinding,
  StoryBuild,
  StoryBuildLoop,
  StoryBuildLoopFinding,
  StoryBuildLoopRound,
  StoryBuildLoopTarget,
  StoryBuildLoopTargetReview,
} from '@pierre-review/shared';
import { ApiError } from '../../api/client.js';
import { storyBuildMutationKey, useContinueStoryBuildLoop, useStopStoryBuildLoop } from '../../hooks/useStoryBuild.js';
import { REVIEW_CHIP, REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import {
  BRANCH_EXISTS_CODE,
  LOOP_RESPONSE_WORDS,
  buildBranchNames,
  loopCoverage,
  loopFindingsShown,
  loopFixLine,
  loopRoundTitle,
  loopRunning,
  loopStateWords,
  loopTargetName,
  storyBuildErrorText,
} from '../../lib/storyBuild.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { PrCardChips, PrCardFrame, PrCardMeta, PrCardTitle } from '../Activity/PrCardShell.js';
import { AiRunLabel } from '../AiRunLabel.js';
import { FindingRow, VerdictBadge } from '../ClaudeReviewTab.js';
import { FollowUpRow } from '../ClaudeReviewFollowUp.js';
import { ChevronIcon, CloseIcon, ExternalLinkIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { CriterionRow, MissingList } from '../TicketReviewParts.js';
import { Button } from '../ui/Button.js';
import { RenameBranch } from './RenameBranch.js';
import { StoryBuildSection } from './StoryBuildSection.js';

// THE REVIEW LOOP'S SECTION (docs/STORY-BUILD.md § The review loop; docs/FRONTEND.md § The build tab):
// mounted by StoryBuildTabView between the conversation and the changes when `build.loop.on`. Top to
// bottom: the state chip and the "what happens next" line (both from the server), Continue / Stop (HIDDEN,
// never disabled, when they do not apply), the acceptance-criteria coverage of the latest story check, then
// one collapsible row per round, newest open. A round shows, per target, the review the PR review tab would
// show — the verdict, the findings (FindingRow, read only, `prUrl` null: the file at the reviewed commit)
// with the agent's response under each, what the reviewer said about the last round's answers
// (FollowUpRow) — and the story check (CriterionRow / MissingList, read only) with the agent's answers on
// the criteria. Everything here stays in Limn: nothing is posted to GitHub until the pull request opens.

const RESPONSE_CLASS: Record<string, string> = {
  fixed: 'bg-ui-raise text-ui-success',
  answered: 'bg-ui-raise text-ui-ink',
  pushed_back: 'bg-ui-raise text-ui-warn',
  not_applicable: 'bg-ui-raise text-ui-ink',
  not_reported: 'bg-ui-raise text-ui-mute',
};

const COVERAGE_CLASS: Record<'met' | 'not_applicable' | 'open', string> = {
  met: 'bg-ui-raise text-ui-success',
  not_applicable: 'bg-ui-raise text-ui-mute',
  open: 'bg-ui-raise text-ui-warn',
};

const COVERAGE_WORDS: Record<'met' | 'not_applicable' | 'open', string> = {
  met: 'met',
  not_applicable: 'not applicable',
  open: 'open',
};

function errorOf(err: unknown): string | null {
  if (err == null) return null;
  return storyBuildErrorText(err instanceof ApiError ? err : { message: (err as Error).message });
}

export function ReviewLoopSection({ build }: { build: StoryBuild }): JSX.Element | null {
  const loop = build.loop;
  if (loop == null || !loop.on) return null;
  return (
    <StoryBuildSection
      title="Review rounds"
      testId="story-build-loop"
      info={
        <InfoButton title="Review rounds">
          <p>
            Each round, Limn reviews the pushed branch the way it reviews a pull request, and checks it against the ticket. The
            agent then fixes, answers or pushes back on every point, and each fix is pushed as a new commit.
          </p>
          <p className="mt-2">
            After {loop.rounds} {loop.rounds === 1 ? 'round' : 'rounds'}, or sooner when nothing is left, Limn opens the pull
            request. The review stays in Limn.
          </p>
        </InfoButton>
      }
      end={<LoopActions build={build} loop={loop} />}
    >
      <LoopStatus build={build} loop={loop} />
      <Coverage loop={loop} />
      <LoopPrs loop={loop} />
      {loop.history.length > 0 && (
        <ol data-testid="story-build-loop-rounds-list" className="mt-3 space-y-2">
          {[...loop.history].reverse().map((r, i) => (
            <RoundRow key={r.round} round={r} loop={loop} initiallyOpen={i === 0} />
          ))}
        </ol>
      )}
    </StoryBuildSection>
  );
}

/** Stop while it runs; Continue is in the status block (beside the pause line). */
function LoopActions({ build, loop }: { build: StoryBuild; loop: StoryBuildLoop }): JSX.Element | null {
  const stop = useStopStoryBuildLoop(build.workspaceId, build.ident);
  if (!loopRunning(build)) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={<CloseIcon size={11} />}
      data-story-build-action="loop-stop"
      disabled={stop.isPending}
      onClick={() => stop.mutate(build.id)}
      title={loop.state === 'fixing' ? 'Stop the agent and end the review rounds' : 'End the review rounds'}
    >
      Stop review loop
    </Button>
  );
}

function LoopStatus({ build, loop }: { build: StoryBuild; loop: StoryBuildLoop }): JSX.Element {
  const cont = useContinueStoryBuildLoop(build.workspaceId, build.ident);
  const stop = useStopStoryBuildLoop(build.workspaceId, build.ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  const words = loopStateWords(loop);
  const err = errorOf(cont.error) ?? errorOf(stop.error);
  // After BRANCH_EXISTS: the target whose branch is taken offers a new name, and Continue carries it.
  const taken = loop.pause === 'branch_exists' ? loop.targets.find((t) => t.pushErrorCode === BRANCH_EXISTS_CODE) ?? null : null;
  const takenBranch = taken == null ? null : (taken.branch ?? plannedBranchOf(build, taken));
  const pauseTone = loop.state === 'failed' || loop.state === 'stopped' ? 'text-ui-mute' : 'text-ui-warn';
  return (
    <div className="rounded-ui bg-ui-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {words != null && (
          <span data-testid="story-build-loop-state" data-state={loop.state ?? 'none'} className={`${REVIEW_CHIP} bg-ui-raise text-ui-ink`}>
            {words}
          </span>
        )}
        {loop.next != null && (
          <span data-testid="story-build-loop-next" className="text-body text-ui-ink">
            {loop.next}
          </span>
        )}
        {loop.state == null && loop.next == null && <span className="text-body text-ui-mute">Limn starts when the build finishes.</span>}
      </div>
      {loop.pauseLine != null && loop.pauseLine !== loop.next && (
        <p data-testid="story-build-loop-pause" className={`mt-1.5 text-body ${pauseTone}`}>
          {loop.pauseLine}
        </p>
      )}
      {loop.canContinue && taken != null && takenBranch != null && (
        <RenameBranch
          branch={takenBranch}
          taken={buildBranchNames(build)}
          draft={false}
          disabled={busy}
          actionId="loop-continue-renamed"
          buttonLabel="Continue"
          onPush={(name) => cont.mutate({ id: build.id, branch: { kind: taken.kind, id: taken.id, name } })}
        />
      )}
      {loop.canContinue && taken == null && (
        <div className="mt-2">
          <Button variant="primary" size="sm" data-story-build-action="loop-continue" disabled={busy} onClick={() => cont.mutate({ id: build.id })}>
            Continue
          </Button>
        </div>
      )}
      {err != null && <p className="mt-1.5 text-meta text-ui-danger">{err}</p>}
    </div>
  );
}

function plannedBranchOf(build: StoryBuild, t: StoryBuildLoopTarget): string | null {
  if (t.kind === 'repo') return build.repos.find((r) => r.id === t.id)?.branch ?? null;
  return (build.prs ?? []).find((p) => p.id === t.id)?.branch ?? null;
}

/** The latest story check's criteria: met / not applicable / open. */
function Coverage({ loop }: { loop: StoryBuildLoop }): JSX.Element | null {
  const rows = loopCoverage(loop);
  if (rows.length === 0) return null;
  const met = rows.filter((r) => r.state === 'met').length;
  const na = rows.filter((r) => r.state === 'not_applicable').length;
  return (
    <div data-testid="story-build-loop-coverage" className="mt-3">
      <div className="mb-1 flex items-center gap-1">
        <h4 className={REVIEW_SUBHEAD}>
          Acceptance criteria: {met} of {rows.length} met{na > 0 ? `, ${na} not applicable` : ''}
        </h4>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((r) => (
          <span key={r.ref} data-ref={r.ref} data-state={r.state} title={r.text} className={`${REVIEW_CHIP} ${COVERAGE_CLASS[r.state]}`}>
            {r.ref} · {COVERAGE_WORDS[r.state]}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The pull requests the loop opened (at the end). */
function LoopPrs({ loop }: { loop: StoryBuildLoop }): JSX.Element | null {
  const opened = loop.targets.filter((t) => t.prNumber != null);
  if (opened.length === 0) return null;
  return (
    <ul data-testid="story-build-loop-prs" className="mt-3 space-y-1">
      {opened.map((t) => {
        const url = safeExternalUrl(t.prUrl);
        return (
          <li key={`${t.kind}-${t.id}`} className="flex flex-wrap items-center gap-1.5 text-body text-ui-ink">
            <span>Pull request opened:</span>
            {url != null ? (
              <a href={url} target="_blank" rel="noreferrer noopener" className="hit inline-flex items-center gap-1 font-mono hover:underline">
                {t.fullName}#{t.prNumber}
                <ExternalLinkIcon size={11} />
              </a>
            ) : (
              <span className="font-mono">
                {t.fullName}#{t.prNumber}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RoundRow({ round, loop, initiallyOpen }: { round: StoryBuildLoopRound; loop: StoryBuildLoop; initiallyOpen: boolean }): JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  // A new round arrives on top: it opens, the older one closes (unless the reader toggled it).
  useEffect(() => setOpen(initiallyOpen), [initiallyOpen]);
  const fixLine = loopFixLine(round, loop.targets);
  const openCount = round.open.findings + round.open.followUps + round.open.criteria;
  return (
    <li data-testid="story-build-loop-round" data-round={round.round} data-closing={round.closing ? 'true' : 'false'} className="rounded-ui bg-ui-surface">
      <button
        type="button"
        className="hit flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronIcon dir={open ? 'down' : 'right'} />
        <span className="text-body font-semibold text-ui-ink">{loopRoundTitle(round)}</span>
        <span className="text-meta text-ui-mute">{openCount === 0 ? 'Nothing open' : `${openCount} open`}</span>
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3">
          {round.reviews.map((rv) => (
            <TargetReview key={`${rv.targetKind}-${rv.targetId}`} review={rv} target={loop.targets.find((t) => t.kind === rv.targetKind && t.id === rv.targetId) ?? null} />
          ))}
          <StoryCheck round={round} />
          {fixLine != null && (
            <p data-testid="story-build-loop-fix" className="text-meta text-ui-mute">
              {fixLine}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function TargetReview({ review, target }: { review: StoryBuildLoopTargetReview; target: StoryBuildLoopTarget | null }): JSX.Element {
  const name = target != null ? loopTargetName(target) : `#${review.targetId}`;
  const fullName = target?.fullName ?? '';
  const findings = loopFindingsShown(review.findings);
  const byId = new Map<number, ClaudeFinding>(review.findings.map((f) => [f.id, f] as const));
  const titleId = `loop-${review.targetKind}-${review.targetId}-${review.headSha.slice(0, 7)}`;
  const failed = review.runs.length > 0 && review.runs.every((r) => r.status === 'failed');
  return (
    <ul className="space-y-2">
      <PrCardFrame labelledBy={titleId}>
        <div data-testid="story-build-loop-target" data-target={fullName}>
          <PrCardTitle id={titleId} level={4}>
            {name}
          </PrCardTitle>
          <PrCardChips>
            {review.verdict != null && <VerdictBadge verdict={review.verdict} />}
            {failed && <span className={`${REVIEW_CHIP} bg-ui-danger/10 text-ui-danger`}>Review failed</span>}
          </PrCardChips>
          <PrCardMeta
            parts={[
              <span key="sha" className="font-mono">
                {review.headSha.slice(0, 7)}
              </span>,
              ...review.runs.map((r) => <AiRunLabel key={`run-${r.id}`} provider={r.provider} model={r.model} />),
            ]}
          />
          {review.summary != null && review.summary !== '' && <p className="mt-1.5 max-w-3xl text-body text-ui-ink">{review.summary}</p>}
          {findings.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {findings.map((f) => (
                <FindingRow
                  key={f.id}
                  prId={0}
                  finding={f}
                  editable={false}
                  actions={false}
                  prUrl={null}
                  repoFullName={fullName}
                  headSha={review.headSha}
                  posting={false}
                  postError={null}
                  inChangeset={false}
                  note={<ResponseNote finding={f} />}
                />
              ))}
            </ul>
          )}
          {findings.length === 0 && !failed && <p className="mt-1.5 text-meta text-ui-mute">No findings.</p>}
          {review.followUp.length > 0 && (
            <div className="mt-3">
              <h5 className={`${REVIEW_SUBHEAD} mb-1`}>The last round’s points</h5>
              <ul className="space-y-1.5">
                {review.followUp.map((it) => (
                  <FollowUpRow key={it.priorFindingId} item={it} muted={false} findingsById={byId} headMoved={false} changedPaths={EMPTY} actions={false} oneLine />
                ))}
              </ul>
            </div>
          )}
        </div>
      </PrCardFrame>
    </ul>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

/** The agent's response to one finding, at the card's foot. */
function ResponseNote({ finding }: { finding: StoryBuildLoopFinding }): JSX.Element | null {
  const r = finding.response;
  if (r == null) return null;
  return (
    <div data-testid="story-build-loop-response" data-action={r.action} className="mt-2">
      <span className={`${REVIEW_CHIP} ${RESPONSE_CLASS[r.action] ?? ''}`}>{LOOP_RESPONSE_WORDS[r.action]}</span>
      {r.text != null && r.text !== '' && (
        <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-ui-line pl-2 text-body text-ui-ink">{r.text}</blockquote>
      )}
    </div>
  );
}

function StoryCheck({ round }: { round: StoryBuildLoopRound }): JSX.Element | null {
  const check = round.storyCheck;
  if (check == null) return null;
  const a = check.assessment;
  const missing = check.items.filter((i) => i.status === 'missing');
  return (
    <div data-testid="story-build-loop-story-check" className="space-y-2">
      <h5 className={REVIEW_SUBHEAD}>Checked against the ticket</h5>
      {check.status === 'failed' && <p className="text-meta text-ui-danger">{check.error ?? 'The story check did not finish.'}</p>}
      {check.summary != null && check.summary !== '' && <p className="max-w-3xl text-body text-ui-ink">{check.summary}</p>}
      {a != null && a.criteria.length > 0 && (
        <ul className="space-y-1.5">
          {a.criteria.map((c) => (
            <CriterionRow
              key={c.ref}
              c={c}
              item={check.items.find((i) => i.ref === c.ref)}
              review={check}
              viewedPrId={null}
              changedPaths={EMPTY}
              actions={false}
            />
          ))}
        </ul>
      )}
      <MissingList items={missing} review={check} viewedPrId={null} changedPaths={EMPTY} />
      {round.claimVerdicts.length > 0 && (
        <div data-testid="story-build-loop-claims">
          <h5 className={`${REVIEW_SUBHEAD} mb-1`}>Not applicable, as the agent said</h5>
          <ul className="space-y-1">
            {round.claimVerdicts.map((v) => (
              <li key={v.ref} data-ref={v.ref} data-verdict={v.verdict} className="text-body text-ui-ink">
                <span className="font-mono">{v.ref}</span> · {v.verdict === 'accepted' ? 'Accepted' : 'Not accepted'}
                {v.why !== '' ? <span className="text-ui-mute">: {v.why}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {round.acResponses.length > 0 && (
        <div data-testid="story-build-loop-ac-answers">
          <h5 className={`${REVIEW_SUBHEAD} mb-1`}>The agent’s answers on the criteria</h5>
          <ul className="space-y-1">
            {round.acResponses.map((r) => (
              <li key={r.ref} data-ref={r.ref} data-response={r.response} className="flex flex-wrap items-baseline gap-1.5 text-body text-ui-ink">
                <span className="font-mono">{r.ref}</span>
                <span className={`${REVIEW_CHIP} ${RESPONSE_CLASS[r.response] ?? ''}`}>{LOOP_RESPONSE_WORDS[r.response]}</span>
                {r.text != null && r.text !== '' && <span className="min-w-0 break-words">{r.text}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
