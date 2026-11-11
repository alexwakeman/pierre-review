import { useEffect, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { DEFAULT_CLAUDE_REVIEW_MODEL, STORY_MISSING_HEADING, TICKET_CRITERION_STATUS_LABEL, storyBuildGapsOf, storyBuildOffered, type StoryBuild, type StoryBuildGap } from '@pierre-review/shared';
import { ApiError } from '../../api/client.js';
import { useModelPick } from '../../hooks/useModelPick.js';
import {
  storyBuildMutationKey,
  useSandboxFolderCheck,
  useSandboxProjectSkills,
  useSandboxRuntime,
  useSandboxSettings,
  useStartStorySession,
} from '../../hooks/useStoryBuild.js';
import { sessionInherits, sessionInheritsText } from '../../lib/sessionInherits.js';
import { useSettingsModal } from '../../store/settingsModal.js';
import { useTicketReviewById } from '../../hooks/useTicketReview.js';
import { useStoryDocsAlignment } from '../../hooks/useStoryDocsAlignment.js';
import { TICKET_CRITERION_STATUS_CLASS } from '../../lib/claudeReviewFollowUp.js';
import { REVIEW_CHIP, REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import { sessionErrorText, sessionStatusLine } from '../../lib/sandboxSession.js';
import { useSprintGraph } from '../../hooks/useSprintStories.js';
import type { TabTicketMeta } from '../../store/pinnedTabs.js';
import { storyBuildStatusLine } from '../../lib/storyBuild.js';
import { AiRunGate } from '../AiSetup.js';
import { ModelPicker } from '../ModelPicker.js';
import { WrenchIcon, FillGapsIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';
import { CheckboxBox } from '../ui/FormControls.js';
import { InfoButton } from '../InfoModal.js';
import { SandboxRuntimeLine } from './SandboxSetupHelp.js';

// THE START STATE (no open session; docs/SANDBOX.md § Sessions): what a session does in two sentences
// (it PLANS FIRST: docs/STORY-BUILD.md § Plan first), the docs box ("Give the agent the reference
// documents", ticked when the story view's "… with docs" opened the tab; shown only while the library has
// a built document),
// the container runtime's ONE line (`GET /api/sandbox/runtime`; with none, what is wrong + "How to set
// up" — the button stays, owner decision Q2: there is no other path), the model menu (kind
// `story_build`, opening on the deep model) and Start inside the ONE `AiRunGate`. A failed / discarded
// session reads as one line above it.
//
// WHAT COMES IN BESIDE THE CODE (`InheritsLine`): how many Claude memories (and from how many projects),
// the reader's CLAUDE.md, their own skills (when the workspace opts in) and the repositories' own skills
// — counted before Start by the same rules the boot copies by (lib/sessionInherits.ts). Three local
// reads, asked only while this panel offers Start: the folder check (disk walks), the sandbox setting
// and the project skills (`git ls-tree` in Limn's clone cache). "Change" opens Settings → Sandbox.
//
// "FILL GAPS" (a started ticket whose current story check found gaps — shared `storyBuildOffered`): the
// same start, worded for the gaps, listed UP FRONT from that check (`check.reviewId`, one read of the
// run when the tab opens — never on the board). The session tells the agent those verdicts.

export function StartPanel({
  workspaceId,
  ident,
  last,
  offer = null,
}: {
  workspaceId: number;
  ident: string;
  /** The latest session when it is closed (failed / discarded, or a row of the old flow); null otherwise. */
  last: StoryBuild | null;
  /** What the story view offered when it opened this tab (`TabTicketMeta.buildOffer`); used only while
   *  the ticket is not a sprint board node (a story outside the sprint). */
  offer?: TabTicketMeta['buildOffer'];
}): JSX.Element {
  const pick = useModelPick('story_build', DEFAULT_CLAUDE_REVIEW_MODEL);
  const start = useStartStorySession(workspaceId, ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(ident) }) > 0;
  const runtime = useSandboxRuntime();
  // THE ENTRY GATE holds here too (owner decision 4, shared `storyBuildOffered`): a tab rebuilt from a
  // URL may name any ticket, but a NEW session starts only for a ticket the gate offers it on. A sprint
  // ticket is judged from its board node; a story outside the sprint by what its story view offered
  // when it opened this tab. A closed session is no open session, so `build` is ignored.
  const graph = useSprintGraph(workspaceId);
  const node = graph.data?.nodes.find((n) => n.ident === ident);
  const offered = node != null ? storyBuildOffered({ ...node, build: null }) : (offer?.action ?? null);
  const fill = offered === 'fill_gaps';
  // "… with docs" (the story view's menu ticks it): offered only while the library has a built document.
  // The Story section reads the same query, so it is usually in memory already.
  const docsQ = useStoryDocsAlignment(workspaceId, ident);
  const docsAvailable = docsQ.data?.available === true;
  const [docsPicked, setDocsPicked] = useState(offer?.docs === true);
  useEffect(() => setDocsPicked(offer?.docs === true), [offer?.docs]);
  const docs = docsAvailable && docsPicked;
  const go = (): void => {
    start.mutate({ action: fill ? 'fill_gaps' : 'implement', provider: pick.chosen.provider, model: pick.chosen.model, ...(docs ? { docs: true } : {}) });
  };
  const err = start.error instanceof ApiError ? start.error : start.error != null ? { message: (start.error as Error).message } : null;
  const lastLine = last == null ? null : last.session != null ? sessionStatusLine(last.session, last.error) : storyBuildStatusLine(last);
  return (
    <section data-testid="story-build-start" className="mt-5 rounded-ui bg-ui-surface p-4">
      {lastLine != null && (
        <p data-testid="story-build-last" className="mb-3 text-meta text-ui-mute">
          The last session: {lastLine}
        </p>
      )}
      {fill ? (
        <>
          <p className="text-body text-ui-ink">
            The AI gets a sandbox with every repository in this workspace, the ticket and what the story check found missing. It
            plans first. Nothing is built until you approve the plan, and nothing is pushed until you press Push.
          </p>
          <StartGaps reviewId={node?.check?.reviewId ?? offer?.reviewId ?? null} />
        </>
      ) : (
        <p className="text-body text-ui-ink">
          The AI gets a sandbox with every repository in this workspace and the ticket. It plans first. Nothing is built until you
          approve the plan, and nothing is pushed until you press Push.
        </p>
      )}
      <div className="mt-3">
        <SandboxRuntimeLine status={runtime.data} loading={runtime.isLoading} />
      </div>
      {offered != null && <InheritsLine workspaceId={workspaceId} />}
      {offered != null && docsAvailable && (
        <label data-testid="story-build-start-docs" className="mt-3 flex w-fit cursor-pointer items-center gap-1.5 text-body text-ui-ink">
          <CheckboxBox checked={docsPicked} disabled={busy} onChange={(e) => setDocsPicked(e.target.checked)} />
          Give the agent the reference documents
          <InfoButton title="Reference documents">
            <p>Limn copies the parts of this workspace's reference library that match the story into the sandbox, read only.</p>
            <p className="mt-2">The agent can then cite a document where the story does not match it.</p>
          </InfoButton>
        </label>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {offered != null ? (
          <>
            <ModelPicker state={pick} onPick={pick.pick} disabled={busy} />
            <AiRunGate kind="story_build" anyProvider provider={pick.chosen.provider}>
              <Button
                variant="primary"
                data-ai-run
                data-testid="story-build-start-button"
                icon={fill ? <FillGapsIcon size={13} /> : <WrenchIcon size={13} />}
                busy={busy}
                busyLabel="Starting…"
                onClick={go}
              >
                {fill ? (docs ? 'Fill gaps with docs' : 'Fill gaps') : docs ? 'Start with docs' : 'Start'}
              </Button>
            </AiRunGate>
          </>
        ) : graph.isLoading ? (
          <p className="text-meta text-ui-mute">Loading…</p>
        ) : (
          <p data-testid="story-build-not-offered" className="text-meta text-ui-mute">
            A session starts only for a story that is not started and has no pull request, or a started one whose story check
            found gaps.
          </p>
        )}
      </div>
      {err != null && (
        <p data-testid="story-build-start-error" className="mt-2 text-meta text-ui-danger">
          {sessionErrorText(err)}
        </p>
      )}
    </section>
  );
}

/** One line: what the agent gets beside the code, with the details behind ⓘ and Change → Settings → Sandbox. */
function InheritsLine({ workspaceId }: { workspaceId: number }): JSX.Element {
  const check = useSandboxFolderCheck(workspaceId, true);
  const settings = useSandboxSettings(workspaceId);
  const skills = useSandboxProjectSkills(workspaceId, true);
  const openSettings = useSettingsModal((s) => s.openSettings);
  const loading = check.isLoading || settings.isLoading || skills.isLoading;
  const counts = sessionInherits(check.data, settings.data, skills.data);
  const text = sessionInheritsText(counts);
  const ticked = (check.data?.memories ?? []).filter((m) => m.ticked && m.memoryCount > 0);
  const skillRows = (skills.data?.repos ?? []).filter((r) => r.skills.length > 0);
  return (
    <div data-testid="story-build-start-inherits" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-ui-mute">
      <span>
        {loading
          ? 'Counting your memories and skills…'
          : check.isError
            ? 'Limn could not count your memories.'
            : text != null
              ? `The agent also gets ${text}.`
              : 'The agent gets none of your Claude memories or skills.'}
      </span>
      {!loading && (
        <InfoButton title="Memories and skills">
          <p>Limn copies only your saved memories into the sandbox, never a past session.</p>
          {ticked.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {ticked.map((m) => (
                <li key={m.key}>
                  <span className="font-mono text-meta">{m.dir}</span>: {m.memoryCount} {m.memoryCount === 1 ? 'memory' : 'memories'}
                </li>
              ))}
            </ul>
          )}
          {skillRows.length > 0 && (
            <>
              <p className="mt-2">Skills the repositories keep in .claude/skills come with the code. The agent is told where each one is:</p>
              <ul className="mt-1 space-y-0.5">
                {skillRows.map((r) => (
                  <li key={r.repo}>
                    {r.repo}: {r.skills.map((k) => k.name).join(', ')}
                  </li>
                ))}
              </ul>
            </>
          )}
          {counts.userSkills > 0 && <p className="mt-2">Your own skills: {check.data?.userSkills.join(', ')}.</p>}
          <p className="mt-2">Choose the projects, your CLAUDE.md and your own skills in Settings → Sandbox.</p>
        </InfoButton>
      )}
      <button
        type="button"
        className="hit text-meta text-ui-ink underline"
        onClick={() => openSettings('sandbox')}
      >
        Change
      </button>
    </div>
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
