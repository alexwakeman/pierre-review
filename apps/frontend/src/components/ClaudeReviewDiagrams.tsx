// SEQUENCE DIAGRAMS in the Claude Review tab (docs/FRONTEND.md § Sequence diagrams): the PR's own
// diagram and, when the PR is on a ticket with more than one pull request, the whole story's. Drawn
// by a separate Sonnet run after each finished review; Redraw queues one now. `DiagramSlotView` is
// also what This Sprint's ticket drawer shows for a story.
//
// Rules:
//  - Every string from the server renders as PLAIN TEXT; the diagram renders through <SequenceDiagram>
//    (Mermaid, securityLevel 'strict', source validated server-side).
//  - A newer run that refused or failed NEVER hides the last good diagram: the slot carries both.
//  - Only the reads poll, and only while a run is queued or running (or just after a review).
import type { SequenceDiagramSlot, StorySequenceDiagramSlot } from '@pierre-review/shared';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { redrawRefusalText, slotDrawing, slotStatusLine } from '../lib/sequenceDiagrams.js';
import {
  useRedrawStoryDiagram,
  useRedrawingStory,
  usePrSequenceDiagrams,
  useRedrawPrDiagram,
  useRedrawingPr,
} from '../hooks/useSequenceDiagrams.js';
import { REVIEW_ITEM_TITLE, REVIEW_META, REVIEW_PROSE } from '../lib/reviewStyles.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection } from './ReviewSection.js';
import { SequenceDiagram } from './SequenceDiagram.js';

export { redrawRefusalText };

const BTN =
  'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

/** One subject's diagram: its title, caption, the diagram itself and the status line. */
export function DiagramSlotView({
  slot,
  redrawing,
  label,
}: {
  slot: SequenceDiagramSlot;
  redrawing: boolean;
  // What the diagram shows, for assistive tech ("Sequence diagram of this pull request").
  label: string;
}): JSX.Element {
  const d = slot.diagram;
  const line = slotStatusLine(slot, redrawing);
  return (
    <div className="space-y-1.5">
      {d != null && d.source != null && (
        <>
          {d.title != null && <p className={REVIEW_ITEM_TITLE}>{d.title}</p>}
          {d.caption != null && <p className={REVIEW_PROSE}>{d.caption}</p>}
          {!d.current && <p className={REVIEW_META}>Drawn for an earlier commit.</p>}
          <SequenceDiagram source={d.source} label={d.title != null ? `${label}: ${d.title}` : label} />
        </>
      )}
      {line != null && <p className={REVIEW_META}>{line}</p>}
    </div>
  );
}

/** The review tab's section. Absent where agentic AI does not run. */
export function ClaudeReviewDiagramsSection({
  prId,
  reviewFinishedAt,
}: {
  prId: number;
  // The shown review's finish time: the read waits a short while for the diagram it queues.
  reviewFinishedAt: string | null;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  const finishedMs = reviewFinishedAt != null ? Date.parse(reviewFinishedAt) : NaN;
  const q = usePrSequenceDiagrams(prId, ai.enabled, Number.isFinite(finishedMs) ? finishedMs : null);
  const redraw = useRedrawPrDiagram(prId);
  const redrawing = useRedrawingPr(prId);
  if (!ai.enabled || q.data == null) return null;
  const data = q.data;
  const drawing = redrawing || slotDrawing(data.pr);
  const refusal = redrawRefusalText(redraw.data);

  return (
    <ReviewSection
      title="Sequence diagram"
      info={
        <InfoButton title="Sequence diagram">
          <div className="space-y-2">
            <p>
              After each review, Claude Sonnet reads the change and the code around it and draws the flow it touches:
              who calls what, and the services, tables, queues and APIs it depends on.
            </p>
            <p>It is drawn again when a review runs on a new commit. Pull requests that change no code get none.</p>
            <p>
              When the pull request is part of a ticket with other pull requests, a second diagram shows the whole
              story across every repository involved.
            </p>
            <p>Claude works the flow out from the code, so check it before relying on it.</p>
          </div>
        </InfoButton>
      }
      actions={
        <button type="button" className={BTN} disabled={drawing} onClick={() => redraw.mutate()}>
          {drawing ? 'Drawing…' : data.pr.diagram != null ? 'Redraw' : 'Draw'}
        </button>
      }
    >
      <DiagramSlotView slot={data.pr} redrawing={redrawing} label="Sequence diagram of this pull request" />
      {refusal != null && <p className={REVIEW_META}>{refusal}</p>}
      {redraw.isError && <p className="text-xs text-red-600 dark:text-red-400">{redraw.error.message}</p>}
      {data.stories.map((s) => (
        <StorySlotBlock key={s.ident} slot={s} />
      ))}
    </ReviewSection>
  );
}

/** One ticket's whole-story diagram inside the review section, with its own Redraw. */
function StorySlotBlock({ slot }: { slot: StorySequenceDiagramSlot }): JSX.Element {
  const redraw = useRedrawStoryDiagram(slot.ident);
  const redrawing = useRedrawingStory(slot.ident);
  const drawing = redrawing || slotDrawing(slot);
  const refusal = redrawRefusalText(redraw.data);
  return (
    <div className="space-y-1.5 border-t border-gray-200 pt-3 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
          Whole story{slot.ticketKey != null ? ` · ${slot.ticketKey}` : ''} · {slot.memberCount} pull requests
        </h4>
        {slot.memberCount >= 2 && (
          <button type="button" className={`ml-auto ${BTN}`} disabled={drawing} onClick={() => redraw.mutate()}>
            {drawing ? 'Drawing…' : slot.diagram != null ? 'Redraw' : 'Draw'}
          </button>
        )}
      </div>
      <DiagramSlotView slot={slot} redrawing={redrawing} label="Sequence diagram of the whole story" />
      {refusal != null && <p className={REVIEW_META}>{refusal}</p>}
      {redraw.isError && <p className="text-xs text-red-600 dark:text-red-400">{redraw.error.message}</p>}
    </div>
  );
}
