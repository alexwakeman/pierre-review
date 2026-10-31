// DESIGN DIAGRAMS in the Claude Review tab (docs/FRONTEND.md § Design diagrams): how data flows through
// the PR's change and, when the PR is on a ticket with more than one pull request, through the whole
// story. Drawn by a separate Sonnet run after each finished review; Redraw queues one now. A change with
// no data path gets none, said plainly ("No diagram: this change only edits copy."). `DiagramSlotView`
// is also what the story view shows for a story.
//
// Rules:
//  - Every string from the server renders as PLAIN TEXT; the flow renders through <FlowDiagram>. A row
//    drawn before the data-flow diagrams still holds the older grid: <DesignGrid> draws it, marked as
//    the earlier layout (Redraw draws the flow).
//  - A newer run that refused or failed NEVER hides the last good design: the slot carries both.
//  - Only the reads poll, and only while a run is queued or running (or just after a review).
//  - A card's click-through: THIS PR's file → `onOpenInChanges` (same pane); another PR's (a story
//    card) → `openPrChangesAt`, which opens that PR's pane on its Changes tab at the file.
import {
  aiModelWords,
  aiProviderName,
  type SequenceDiagramMember,
  type SequenceDiagramSlot,
  type StorySequenceDiagramSlot,
} from '@pierre-review/shared';
import { useAiCapabilities, useAiProvider } from '../hooks/useAiCapabilities.js';
import {
  diagramProgressPct,
  diagramProgressText,
  redrawRefusalText,
  slotDrawing,
  slotRunInFlight,
  slotStatusLine,
} from '../lib/sequenceDiagrams.js';
import { memberForRef } from '../lib/designGrid.js';
import {
  useRedrawStoryDiagram,
  useRedrawingStory,
  usePrSequenceDiagrams,
  useRedrawPrDiagram,
  useRedrawingPr,
} from '../hooks/useSequenceDiagrams.js';
import { useFilters } from '../store/filters.js';
import { REVIEW_ITEM_TITLE, REVIEW_META, REVIEW_PROSE } from '../lib/reviewStyles.js';
import { DesignGrid } from './DesignGrid.js';
import { PaneWide } from './Ticket/StoryLayout.js';
import { FlowDiagram, type OpenFlowFile } from './FlowDiagram.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection } from './ReviewSection.js';
import { aiRunLabel } from '@pierre-review/shared';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';
import { AiStatusLine } from './AiStatusLine.js';

export { redrawRefusalText };

const BTN =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2 text-meta text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-40 touch:h-10 touch:px-3';

type OpenInChanges = (path: string, line: number | null, side: 'LEFT' | 'RIGHT') => void;

/** How the diagram reads — the ONE legend, behind the ⓘ of every Design heading. */
export function DesignLegend({ story }: { story: boolean }): JSX.Element {
  const provider = useAiProvider();
  return (
    <div className="space-y-2">
      <p>
        {aiModelWords(provider, 'Sonnet')} reads the change and the code around it, then draws how data moves through it: what
        touches the data across the top, and each step down the page in the order it happens.
      </p>
      <p>
        Each arrow names the data that passes. A dotted line is a check, a heavy line a write to where data is kept, and
        a dashed line a result going back. The keys under the diagram name the lines and box borders.
      </p>
      {story && <p>Each box and step names the pull request that does it.</p>}
      <p>Click a step to open its file in the Changes tab.</p>
      <p>
        It is drawn again after a review of a new commit, unless that is turned off in Settings. A change with no data
        path gets none: one that edits only copy or tests, changes a few lines, or that {aiProviderName(provider)} finds
        moves no data. Draw asks for one anyway.
      </p>
      <p>{aiProviderName(provider)} works the flow out from the code, so check it before relying on it.</p>
    </div>
  );
}

/**
 * THE DRAWING'S PROGRESS: the shared AI bar (determinate from the server's phase, else easing) and the
 * one status line with the time since the run was queued — both from the stored run, so a reload
 * shows them again. Gone (the bar fills and fades) once the run is done; the slot's line then says
 * how it ended.
 */
function DiagramProgress({
  slot,
  drawing,
  redrawing,
}: {
  slot: SequenceDiagramSlot;
  drawing: boolean;
  redrawing: boolean;
}): JSX.Element {
  const run = slotRunInFlight(slot);
  // A fragment: nothing is left in the slot's spacing once the bar has faded.
  return (
    <>
      <RegenProgressBar
        active={drawing}
        label="Drawing the design"
        value={drawing ? diagramProgressPct(run?.progress) : null}
        timeConstantSec={40}
      />
      {drawing && (
        <p data-testid="diagram-progress" className="m-0">
          <AiStatusLine stage={diagramProgressText(run, redrawing)} since={run?.createdAt ?? null} />
        </p>
      )}
    </>
  );
}

/** One subject's design: its title, caption, the grid itself and the status line. */
export function DiagramSlotView({
  slot,
  redrawing,
  label,
  openFile,
  stickyClassName,
}: {
  slot: SequenceDiagramSlot;
  redrawing: boolean;
  // What the design shows, for assistive tech ("Design of this pull request").
  label: string;
  openFile?: OpenFlowFile;
  // The ground the flow's sticky lane cards are painted on (the tone the figure sits on).
  stickyClassName?: string;
}): JSX.Element {
  const d = slot.diagram;
  const drawing = redrawing || slotDrawing(slot);
  // While it draws, the bar and its words take the status line's place.
  const line = drawing ? null : slotStatusLine(slot, redrawing);
  const drawn = d != null && (d.flow != null || d.design != null);
  const name = d?.title != null ? `${label}: ${d.title}` : label;
  return (
    <div className="space-y-1.5">
      {/* Above the design, so a long one never hides that it is being redrawn. */}
      <DiagramProgress slot={slot} drawing={drawing} redrawing={redrawing} />
      {d != null && drawn && (
        <>
          {d.title != null && <p className={REVIEW_ITEM_TITLE}>{d.title}</p>}
          {d.caption != null && <p className={REVIEW_PROSE}>{d.caption}</p>}
          {!d.current && <p className={REVIEW_META}>Drawn for an earlier commit.</p>}
          {d.model && <p className={REVIEW_META}>{aiRunLabel(d.provider, d.model)}</p>}
          {d.flow != null ? (
            <FlowDiagram
              flow={d.flow}
              members={d.kind === 'story' ? d.members : []}
              label={name}
              openFile={openFile}
              {...(stickyClassName != null ? { stickyClassName } : {})}
            />
          ) : (
            d.design != null && (
              <>
                <p className={REVIEW_META} data-testid="design-old-layout">
                  Drawn in the earlier layout. Redraw it to see how data flows.
                </p>
                <DesignGrid design={d.design} members={d.kind === 'story' ? d.members : []} label={name} openFile={openFile} />
              </>
            )
          )}
        </>
      )}
      {line != null && <p className={REVIEW_META}>{line}</p>}
    </div>
  );
}

/** Opens a story member's Changes tab at a file (another PR's pane). */
export function useOpenMemberFile(): (m: SequenceDiagramMember, path: string, fromActivity?: boolean) => void {
  const openPrChangesAt = useFilters((s) => s.openPrChangesAt);
  return (m, path, fromActivity) =>
    openPrChangesAt(
      {
        id: m.prId,
        number: m.number,
        title: m.title,
        repoFullName: m.repo,
        authorLogin: null,
        authorDisplayName: null,
        authorAvatarUrl: null,
      },
      path,
      fromActivity ? { fromActivity: true } : undefined,
    );
}

/** The review tab's section. Absent where agentic AI does not run. */
export function ClaudeReviewDiagramsSection({
  prId,
  reviewFinishedAt,
  onOpenInChanges,
}: {
  prId: number;
  // The shown review's finish time: the read waits a short while for the design it queues.
  reviewFinishedAt: string | null;
  // This pane's own "show in Changes" (PrDetail owns the tab state).
  onOpenInChanges?: OpenInChanges;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  const finishedMs = reviewFinishedAt != null ? Date.parse(reviewFinishedAt) : NaN;
  const q = usePrSequenceDiagrams(prId, ai.enabled, Number.isFinite(finishedMs) ? finishedMs : null);
  const redraw = useRedrawPrDiagram(prId);
  const redrawing = useRedrawingPr(prId);
  const openMember = useOpenMemberFile();
  if (!ai.enabled || q.data == null) return null;
  const data = q.data;
  const drawing = redrawing || slotDrawing(data.pr);
  const refusal = redrawRefusalText(redraw.data);
  const openOwn: OpenFlowFile | undefined =
    onOpenInChanges != null ? (_cell, path) => onOpenInChanges(path, null, 'RIGHT') : undefined;

  return (
    <ReviewSection
      title="Design"
      section="design"
      info={
        <InfoButton title="Design">
          <DesignLegend story={data.stories.length > 0} />
        </InfoButton>
      }
      actions={
        <button type="button" className={BTN} disabled={drawing} onClick={() => redraw.mutate()}>
          {drawing ? 'Drawing…' : data.pr.diagram != null ? 'Redraw' : 'Draw'}
        </button>
      }
    >
      {/* Wide content: past the tab's reading column, to the pane's edge (PaneWide). */}
      <PaneWide>
        <DiagramSlotView slot={data.pr} redrawing={redrawing} label="Design of this pull request" openFile={openOwn} stickyClassName="bg-ui-bg" />
      </PaneWide>
      {refusal != null && <p className={REVIEW_META}>{refusal}</p>}
      {redraw.isError && <p className="text-meta text-ui-danger">{redraw.error.message}</p>}
      {data.stories.map((s) => (
        <StorySlotBlock
          key={s.ident}
          slot={s}
          openFile={(cell, path) => {
            const m = memberForRef(cell.pr, s.diagram?.members ?? []);
            if (m == null) return;
            if (m.prId === prId && onOpenInChanges != null) onOpenInChanges(path, null, 'RIGHT');
            else openMember(m, path);
          }}
        />
      ))}
    </ReviewSection>
  );
}

/** One ticket's whole-story design inside the review section, with its own Redraw. */
function StorySlotBlock({
  slot,
  openFile,
}: {
  slot: StorySequenceDiagramSlot;
  openFile: OpenFlowFile;
}): JSX.Element {
  const redraw = useRedrawStoryDiagram(slot.ident);
  const redrawing = useRedrawingStory(slot.ident);
  const drawing = redrawing || slotDrawing(slot);
  const refusal = redrawRefusalText(redraw.data);
  return (
    <div className="space-y-1.5 border-t border-ui-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-meta font-semibold text-ui-ink">
          Story design{slot.ticketKey != null ? ` · ${slot.ticketKey}` : ''} · {slot.memberCount} pull requests
        </h4>
        {slot.memberCount >= 2 && (
          <button type="button" className={`ml-auto ${BTN}`} disabled={drawing} onClick={() => redraw.mutate()}>
            {drawing ? 'Drawing…' : slot.diagram != null ? 'Redraw' : 'Draw'}
          </button>
        )}
      </div>
      <PaneWide>
        <DiagramSlotView slot={slot} redrawing={redrawing} label="Design of the whole story" openFile={openFile} stickyClassName="bg-ui-bg" />
      </PaneWide>
      {refusal != null && <p className={REVIEW_META}>{refusal}</p>}
      {redraw.isError && <p className="text-meta text-ui-danger">{redraw.error.message}</p>}
    </div>
  );
}
