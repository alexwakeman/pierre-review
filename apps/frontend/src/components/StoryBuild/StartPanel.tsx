import { useIsMutating, useQuery } from '@tanstack/react-query';
import { skipToken } from '@tanstack/react-query';
import { DEFAULT_AI_FIX_MODEL, storyBuildOffered, type StoryBuild } from '@pierre-review/shared';
import { api, ApiError } from '../../api/client.js';
import { useModelPick } from '../../hooks/useModelPick.js';
import { referenceDocsKey } from '../../hooks/useReferenceDocs.js';
import { storyBuildMutationKey, useStartStoryBuild } from '../../hooks/useStoryBuild.js';
import { useSprintGraph } from '../../hooks/useSprintStories.js';
import { storyBuildErrorText, storyBuildStatusLine } from '../../lib/storyBuild.js';
import { AiRunGate } from '../AiSetup.js';
import { ModelPicker } from '../ModelPicker.js';
import { BuildIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';
import { CheckboxBox } from '../ui/FormControls.js';

// THE START STATE (no open session): the model menu (kind `story_plan`, opening on the deep model —
// owner decision 7), "Draw a design", "Check against docs" (only when the workspace's library has a
// document), and Start inside the ONE `AiRunGate` (its `OverBudgetConfirm` asks before a run over the
// budget). A failed / cancelled / discarded session reads as one line above it.

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
  const offered = node != null && storyBuildOffered({ ...node, build: null });
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
      <p className="text-body text-ui-ink">
        The AI reads the story and the code, then writes a plan. Nothing is built until you accept the plan, and nothing is pushed
        until you press Push.
      </p>
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
        {offered ? (
          <>
            <ModelPicker state={pick} onPick={pick.pick} disabled={busy} />
            <AiRunGate kind="story_plan" anyProvider provider={pick.chosen.provider}>
              <Button
                variant="primary"
                data-ai-run
                data-testid="story-build-start-button"
                icon={<BuildIcon size={13} />}
                busy={busy}
                busyLabel="Starting…"
                onClick={go}
              >
                Start
              </Button>
            </AiRunGate>
          </>
        ) : graph.isLoading ? (
          <p className="text-meta text-ui-mute">Loading…</p>
        ) : (
          <p data-testid="story-build-not-offered" className="text-meta text-ui-mute">
            A build starts only from a This Sprint ticket that is not started and has no pull request.
          </p>
        )}
      </div>
      {err != null && <p className="mt-2 text-meta text-ui-danger">{storyBuildErrorText(err)}</p>}
    </section>
  );
}
