import { useIsMutating, useQuery } from '@tanstack/react-query';
import { skipToken } from '@tanstack/react-query';
import {
  DEFAULT_AI_FIX_MODEL,
  STORY_MISSING_HEADING,
  TICKET_CRITERION_STATUS_LABEL,
  storyBuildGapsOf,
  storyBuildOffered,
  type StoryBuild,
  type StoryBuildGap,
} from '@pierre-review/shared';
import { api, ApiError } from '../../api/client.js';
import { useModelPick } from '../../hooks/useModelPick.js';
import { referenceDocsKey } from '../../hooks/useReferenceDocs.js';
import { storyBuildMutationKey, useStartStoryBuild } from '../../hooks/useStoryBuild.js';
import { useTicketReviewById } from '../../hooks/useTicketReview.js';
import { TICKET_CRITERION_STATUS_CLASS } from '../../lib/claudeReviewFollowUp.js';
import { REVIEW_CHIP, REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import { useSprintGraph } from '../../hooks/useSprintStories.js';
import { storyBuildErrorText, storyBuildStatusLine } from '../../lib/storyBuild.js';
import { AiRunGate } from '../AiSetup.js';
import { ModelPicker } from '../ModelPicker.js';
import { BuildIcon, FillGapsIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';
import { CheckboxBox } from '../ui/FormControls.js';

// THE START STATE (no open session): the model menu (kind `story_plan`, opening on the deep model —
// owner decision 7), "Draw a design", "Check against docs" (only when the workspace's library has a
// document), and Start inside the ONE `AiRunGate` (its `OverBudgetConfirm` asks before a run over the
// budget). A failed / cancelled / discarded session reads as one line above it.
//
// "FILL GAPS" (a started ticket whose current story check found gaps — shared `storyBuildOffered`): the
// same start, worded for the gaps, which are listed UP FRONT from that check (`check.reviewId`, one read
// of the run when the tab opens — never on the board). The backend builds only the gaps whenever the
// ticket has pull requests, re-checking first if the check went out of date.

export function StartPanel({
  workspaceId,
  ident,
  last,
  wantDiagram,
  setWantDiagram,
  wantDocs,
  setWantDocs,
}: {
  workspaceId: number;
  ident: string;
  /** The latest session when it is closed (failed / cancelled / discarded); null otherwise. */
  last: StoryBuild | null;
  wantDiagram: boolean;
  setWantDiagram: (v: boolean) => void;
  wantDocs: boolean;
  setWantDocs: (v: boolean) => void;
}): JSX.Element {
  // Deep by default for the plan (owner decision 7): the picker opens on each provider's deep model.
  const pick = useModelPick('story_plan', DEFAULT_AI_FIX_MODEL);
  const start = useStartStoryBuild(workspaceId, ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(ident) }) > 0;
  // The library list (DB only): "Check against docs" shows only when it holds a ready document.
  const docs = useQuery({
    queryKey: referenceDocsKey(workspaceId),
    queryFn: workspaceId != null ? () => api.referenceDocs(workspaceId) : skipToken,
    staleTime: 60_000,
  });
  const hasDocs = (docs.data?.docs ?? []).some((d) => d.status === 'ready');
  // THE ENTRY GATE holds here too (owner decision 4, shared `storyBuildOffered`): a tab rebuilt from a
  // URL may name any ticket, but a NEW session starts only for a sprint ticket that is Not started and
  // has no pull request. A closed session is no open session, so `build` is ignored. (The sprint graph
  // is the board's own DB-only query, usually cached.)
  const graph = useSprintGraph(workspaceId);
  const node = graph.data?.nodes.find((n) => n.ident === ident);
  const offered = node != null ? storyBuildOffered({ ...node, build: null }) : null;
  const fill = offered === 'fill_gaps';
  const go = (): void => {
    start.mutate({
      provider: pick.chosen.provider,
      model: pick.chosen.model,
      diagram: wantDiagram,
      docs: hasDocs && wantDocs,
    });
  };
  const err = start.error instanceof ApiError ? start.error : start.error != null ? { message: (start.error as Error).message } : null;
  return (
    <section data-testid="story-build-start" className="mt-5 rounded-ui bg-ui-surface p-4">
      {last != null && (
        <p data-testid="story-build-last" className="mb-3 text-meta text-ui-mute">
          The last build: {storyBuildStatusLine(last)}
        </p>
      )}
      {fill ? (
        <>
          <p className="text-body text-ui-ink">
            The AI reads the story, its pull requests and the code, then plans only what the story check found missing. Nothing is
            built until you accept the plan, and nothing is pushed until you press Push.
          </p>
          <StartGaps reviewId={node?.check?.reviewId ?? null} />
        </>
      ) : (
        <p className="text-body text-ui-ink">
          The AI reads the story and the code, then writes a plan. Nothing is built until you accept the plan, and nothing is pushed
          until you press Push.
        </p>
      )}
      <div className="mt-3 flex flex-col gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-meta text-ui-ink">
          <CheckboxBox checked={wantDiagram} disabled={busy} onChange={(e) => setWantDiagram(e.target.checked)} />
          Draw a design
        </label>
        {hasDocs && (
          <label className="flex cursor-pointer items-center gap-2 text-meta text-ui-ink">
            <CheckboxBox checked={wantDocs} disabled={busy} onChange={(e) => setWantDocs(e.target.checked)} />
            Check against docs
          </label>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {offered != null ? (
          <>
            <ModelPicker state={pick} onPick={pick.pick} disabled={busy} />
            <AiRunGate kind="story_plan" anyProvider provider={pick.chosen.provider}>
              <Button
                variant="primary"
                data-ai-run
                data-testid="story-build-start-button"
                icon={fill ? <FillGapsIcon size={13} /> : <BuildIcon size={13} />}
                busy={busy}
                busyLabel="Starting…"
                onClick={go}
              >
                {fill ? 'Fill gaps' : 'Start'}
              </Button>
            </AiRunGate>
          </>
        ) : graph.isLoading ? (
          <p className="text-meta text-ui-mute">Loading…</p>
        ) : (
          <p data-testid="story-build-not-offered" className="text-meta text-ui-mute">
            A build starts only from a This Sprint ticket that is not started and has no pull request, or a started one whose
            story check found gaps.
          </p>
        )}
      </div>
      {err != null && <p className="mt-2 text-meta text-ui-danger">{storyBuildErrorText(err)}</p>}
    </section>
  );
}

/** The gaps the story check found, listed before Start: criteria not met, then what it asks for outside
 *  them (shared `storyBuildGapsOf`, the gap fold's own rule). */
function StartGaps({ reviewId }: { reviewId: number | null }): JSX.Element | null {
  const run = useTicketReviewById(reviewId);
  if (reviewId == null) return null;
  if (run.isLoading) return <p className="mt-3 text-meta text-ui-mute">Loading the gaps…</p>;
  const gaps = storyBuildGapsOf(run.data?.assessment);
  if (gaps.length === 0) return null;
  const criteria = gaps.filter((g) => g.verdict != null);
  const missing = gaps.filter((g) => g.verdict == null);
  return (
    <div data-testid="story-build-start-gaps" className="mt-3">
      {criteria.length > 0 && (
        <>
          <h4 className={`${REVIEW_SUBHEAD} mb-1`}>Gaps from the story check ({criteria.length})</h4>
          <ul className="mb-3 space-y-1.5">
            {criteria.map((g) => (
              <GapLine key={g.ref} g={g} />
            ))}
          </ul>
        </>
      )}
      {missing.length > 0 && (
        <>
          <h4 className={`${REVIEW_SUBHEAD} mb-1`}>
            {STORY_MISSING_HEADING} ({missing.length})
          </h4>
          <ul className="space-y-1.5">
            {missing.map((g) => (
              <GapLine key={g.ref} g={g} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function GapLine({ g }: { g: StoryBuildGap }): JSX.Element {
  return (
    <li data-testid="story-build-start-gap" className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-body text-ui-ink">
      <span className="font-mono text-meta text-ui-mute">{g.ref}</span>
      {g.verdict != null && <span className={`${REVIEW_CHIP} ${TICKET_CRITERION_STATUS_CLASS[g.verdict]}`}>{TICKET_CRITERION_STATUS_LABEL[g.verdict]}</span>}
      <span className="min-w-0 flex-1">{g.text}</span>
    </li>
  );
}
