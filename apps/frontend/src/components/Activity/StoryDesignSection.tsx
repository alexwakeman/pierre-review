// THE WHOLE STORY'S DESIGN — the last part of the Story section (TicketStorySection.tsx), in the story
// view only (docs/FRONTEND.md § Design diagrams): one data-flow sequence across every open and merged
// pull request on the ticket, in every repository involved. Only where agentic AI runs and the ticket has a
// PR. Drawn after a review of any of its pull requests. The read is the STORED row (no model, no tracker
// call) and polls only while a run is queued or running. A step opens its pull request's Changes tab at
// the file.
//
// ONE PULL REQUEST (2026-11-15): a story design needs two (`too_few_prs`), so a ticket with exactly one
// open or merged PR shows THAT PR's own design here instead (the story read's `soloPr`; its newest
// succeeded 'pr' row through the PR read, the same "Drawn for an earlier commit" rule), headed as that
// pull request's design, and the heading's button draws or redraws THAT PR's design. No second model
// run, no change to the story fingerprint or the caps.
//
// The Draw / Redraw button is one of the STORY'S ACTIONS, in the Story section's heading row
// (`StoryDesignButton`), not in this block. The section owns ONE `useStoryDesign` (the read + the redraw
// mutation) and hands it to both, so a refusal or error from the heading click shows here.
import type { SequenceDiagramMember } from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import {
  slotDrawing,
  usePrSequenceDiagrams,
  useRedrawPrDiagram,
  useRedrawStoryDiagram,
  useRedrawingPr,
  useRedrawingStory,
  useStorySequenceDiagram,
} from '../../hooks/useSequenceDiagrams.js';
import { memberLabel } from '../../lib/ticketReview.js';
import { soloDesignPr } from '../../lib/sequenceDiagrams.js';
import { memberForRef } from '../../lib/designGrid.js';
import { DesignLegend, DiagramSlotView, redrawRefusalText, useOpenMemberFile } from '../ClaudeReviewDiagrams.js';
import { InfoButton } from '../InfoModal.js';
import { StoryWide, useStorySectionLook } from '../Ticket/StoryLayout.js';
import { RailWideToggle } from '../RailLayout.js';

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
  /** The ticket's ONE pull request and ITS design (read + redraw), when the story read says it has
   *  exactly one; null otherwise. */
  solo: SoloDesign | null;
}

export interface SoloDesign {
  pr: SequenceDiagramMember;
  q: ReturnType<typeof usePrSequenceDiagrams>;
  redraw: ReturnType<typeof useRedrawPrDiagram>;
  redrawing: boolean;
}

export function useStoryDesign(ident: string, enabled: boolean): StoryDesign {
  const q = useStorySequenceDiagram(ident, enabled);
  const redraw = useRedrawStoryDiagram(ident);
  const redrawing = useRedrawingStory(ident);
  // Hooks run every render; with no solo PR the PR read stays idle (`enabled` false) on id 0.
  const soloPr = soloDesignPr(q.data);
  const soloId = soloPr?.prId ?? 0;
  const soloQ = usePrSequenceDiagrams(soloId, enabled && soloPr != null, null);
  const soloRedraw = useRedrawPrDiagram(soloId);
  const soloRedrawing = useRedrawingPr(soloId);
  const solo = soloPr != null ? { pr: soloPr, q: soloQ, redraw: soloRedraw, redrawing: soloRedrawing } : null;
  return { enabled, q, redraw, redrawing, solo };
}

/** "Draw design" / "Redraw design" / "Drawing design…" — the Story heading's design action. With one
 *  pull request it draws THAT pull request's design. */
export function StoryDesignButton({ design }: { design: StoryDesign }): JSX.Element | null {
  const ai = useAiCapabilities();
  const data = design.q.data;
  if (!design.enabled || !ai.enabled || data == null) return null;
  const solo = design.solo;
  if (solo != null) {
    const slot = solo.q.data?.pr;
    if (slot == null) return null;
    const drawing = solo.redrawing || slotDrawing(slot);
    const label = drawing ? 'Drawing design…' : slot.diagram != null ? 'Redraw design' : 'Draw design';
    return (
      <button type="button" className={BTN} disabled={drawing} onClick={() => solo.redraw.mutate()}>
        {label}
      </button>
    );
  }
  if (data.memberCount < 2) return null;
  const drawing = design.redrawing || slotDrawing(data);
  // Named by what it draws: beside "Check against docs" a bare "Redraw" says nothing.
  const label = drawing ? 'Drawing design…' : data.diagram != null ? 'Redraw design' : 'Draw design';
  return (
    <button type="button" className={BTN} disabled={drawing} onClick={() => design.redraw.mutate()}>
      {label}
    </button>
  );
}

/** The one pull request's own design, in the story design's place. */
function SoloDesignSection({ solo }: { solo: SoloDesign }): JSX.Element | null {
  const openMember = useOpenMemberFile();
  const look = useStorySectionLook();
  const slot = solo.q.data?.pr;
  if (slot == null) return null;
  const name = memberLabel(solo.pr);
  const refusal = redrawRefusalText(solo.redraw.data);
  return (
    <StoryWide>
      <section
        aria-label={`Design of ${name}`}
        className={`scroll-mt-4 space-y-2 focus:outline-none ${look?.section ?? ''}`}
        data-testid="story-design"
        data-story-design="pr"
        data-story-section="design"
      >
        <div className="flex items-center gap-1.5">
          <h4 className={look?.heading ?? 'text-meta font-semibold text-ui-ink'}>Pull request design</h4>
          <InfoButton title="Pull request design">
            <p>This ticket has one pull request, so its design is that pull request’s.</p>
            <DesignLegend story={false} />
          </InfoButton>
          <span className={`font-mono text-meta ${MUTED}`} title={solo.pr.title}>
            {name}
          </span>
          {slot.diagram != null && <RailWideToggle className="ml-auto" />}
        </div>
        <DiagramSlotView
          slot={slot}
          redrawing={solo.redrawing}
          label={`Design of ${name}`}
          openFile={(_cell, path) => openMember(solo.pr, path, true)}
        />
        {refusal != null && <p className={`text-meta ${MUTED}`}>{refusal}</p>}
        {solo.redraw.isError && <p className="text-meta text-ui-danger">{solo.redraw.error.message}</p>}
      </section>
    </StoryWide>
  );
}

export function StoryDesignSection({ design }: { design: StoryDesign }): JSX.Element | null {
  const ai = useAiCapabilities();
  const openMember = useOpenMemberFile();
  const look = useStorySectionLook();
  const { q, redraw, redrawing } = design;
  const data = q.data;
  if (!design.enabled || !ai.enabled || data == null) return null;
  if (design.solo != null) return <SoloDesignSection solo={design.solo} />;
  // One pull request is not a story to draw; show nothing unless a design was stored before.
  if (data.memberCount < 2 && data.diagram == null) return null;
  const refusal = redrawRefusalText(redraw.data);
  return (
    // Wide content: in the two-column layout its Expand lays it over the rail (StoryWide).
    <StoryWide>
    <section
      aria-label="Ticket design"
      className={`scroll-mt-4 space-y-2 focus:outline-none ${look?.section ?? ''}`}
      data-testid="story-design"
      data-story-section="design"
    >
      <div className="flex items-center gap-1.5">
        <h4 className={look?.heading ?? 'text-meta font-semibold text-ui-ink'}>Ticket design</h4>
        <InfoButton title="Ticket design">
          <DesignLegend story />
        </InfoButton>
        <span className={`text-meta ${MUTED}`}>{data.memberCount} pull requests</span>
        <RailWideToggle className="ml-auto" />
      </div>
      <DiagramSlotView
        slot={data}
        redrawing={redrawing}
        label="Design of the whole ticket"
        openFile={(cell, path) => {
          const m = memberForRef(cell.pr, data.diagram?.members ?? []);
          if (m != null) openMember(m, path, true);
        }}
      />
      {refusal != null && <p className={`text-meta ${MUTED}`}>{refusal}</p>}
      {redraw.isError && <p className="text-meta text-ui-danger">{redraw.error.message}</p>}
    </section>
    </StoryWide>
  );
}
