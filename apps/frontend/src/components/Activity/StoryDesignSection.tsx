// THE WHOLE STORY'S DESIGN — the last part of the Story section (TicketStorySection.tsx), in the story
// view only (docs/FRONTEND.md § Design diagrams): one data-flow sequence across every open and merged
// pull request on the ticket, in every repository involved. Only where agentic AI runs and the ticket has a
// PR. Drawn after a review of any of its pull requests. The read is the STORED row (no model, no tracker
// call) and polls only while a run is queued or running. A step opens its pull request's Changes tab at
// the file.
//
// The Draw / Redraw button is one of the STORY'S ACTIONS, in the Story section's heading row
// (`StoryDesignButton`), not in this block. The section owns ONE `useStoryDesign` (the read + the redraw
// mutation) and hands it to both, so a refusal or error from the heading click shows here.
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import {
  slotDrawing,
  useRedrawStoryDiagram,
  useRedrawingStory,
  useStorySequenceDiagram,
} from '../../hooks/useSequenceDiagrams.js';
import { memberForRef } from '../../lib/designGrid.js';
import { DesignLegend, DiagramSlotView, redrawRefusalText, useOpenMemberFile } from '../ClaudeReviewDiagrams.js';
import { InfoButton } from '../InfoModal.js';

const MUTED = 'text-ui-mute';
const BTN =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2 text-meta text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-40 touch:h-10 touch:px-3';

/** The story design's read and its redraw mutation — ONE per Story section, shared by the heading's
 *  button and the block. `enabled` = `storyDesignOffered(ai.enabled, prCount)`. */
export interface StoryDesign {
  enabled: boolean;
  q: ReturnType<typeof useStorySequenceDiagram>;
  redraw: ReturnType<typeof useRedrawStoryDiagram>;
  redrawing: boolean;
}

export function useStoryDesign(ident: string, enabled: boolean): StoryDesign {
  const q = useStorySequenceDiagram(ident, enabled);
  const redraw = useRedrawStoryDiagram(ident);
  const redrawing = useRedrawingStory(ident);
  return { enabled, q, redraw, redrawing };
}

/** "Draw design" / "Redraw design" / "Drawing design…" — the Story heading's design action. */
export function StoryDesignButton({ design }: { design: StoryDesign }): JSX.Element | null {
  const ai = useAiCapabilities();
  const data = design.q.data;
  if (!design.enabled || !ai.enabled || data == null || data.memberCount < 2) return null;
  const drawing = design.redrawing || slotDrawing(data);
  // Named by what it draws: beside "Check against docs" a bare "Redraw" says nothing.
  const label = drawing ? 'Drawing design…' : data.diagram != null ? 'Redraw design' : 'Draw design';
  return (
    <button type="button" className={BTN} disabled={drawing} onClick={() => design.redraw.mutate()}>
      {label}
    </button>
  );
}

export function StoryDesignSection({ design }: { design: StoryDesign }): JSX.Element | null {
  const ai = useAiCapabilities();
  const openMember = useOpenMemberFile();
  const { q, redraw, redrawing } = design;
  const data = q.data;
  if (!design.enabled || !ai.enabled || data == null) return null;
  // One pull request is not a story to draw; show nothing unless a design was stored before.
  if (data.memberCount < 2 && data.diagram == null) return null;
  const refusal = redrawRefusalText(redraw.data);
  return (
    <section aria-label="Story design" className="space-y-2" data-testid="story-design">
      <div className="flex items-center gap-1.5">
        <h4 className="text-meta font-semibold text-ui-ink">Story design</h4>
        <InfoButton title="Story design">
          <DesignLegend story />
        </InfoButton>
        <span className={`text-meta ${MUTED}`}>{data.memberCount} pull requests</span>
      </div>
      <DiagramSlotView
        slot={data}
        redrawing={redrawing}
        label="Design of the whole story"
        openFile={(cell, path) => {
          const m = memberForRef(cell.pr, data.diagram?.members ?? []);
          if (m != null) openMember(m, path, true);
        }}
      />
      {refusal != null && <p className={`text-meta ${MUTED}`}>{refusal}</p>}
      {redraw.isError && <p className="text-meta text-ui-danger">{redraw.error.message}</p>}
    </section>
  );
}
