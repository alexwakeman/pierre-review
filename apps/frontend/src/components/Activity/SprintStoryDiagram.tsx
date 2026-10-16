// THE WHOLE STORY'S SEQUENCE DIAGRAM in This Sprint's ticket drawer (docs/FRONTEND.md § Sequence
// diagrams): one diagram across every open and merged pull request on the ticket, in every repository
// involved. Drawn after a review of any of its pull requests; Redraw queues one now. The read is the
// STORED row (no model, no tracker call) and polls only while a run is queued or running.
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import {
  slotDrawing,
  useRedrawStoryDiagram,
  useRedrawingStory,
  useStorySequenceDiagram,
} from '../../hooks/useSequenceDiagrams.js';
import { DiagramSlotView, redrawRefusalText } from '../ClaudeReviewDiagrams.js';
import { InfoButton } from '../InfoModal.js';

const MUTED = 'text-gray-500 dark:text-gray-400';
const BTN =
  'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

export function StoryDiagramSection({ ident }: { ident: string }): JSX.Element | null {
  const ai = useAiCapabilities();
  const q = useStorySequenceDiagram(ident, ai.enabled);
  const redraw = useRedrawStoryDiagram(ident);
  const redrawing = useRedrawingStory(ident);
  const data = q.data;
  if (!ai.enabled || data == null) return null;
  // One pull request is not a story to draw; show nothing unless a diagram was stored before.
  if (data.memberCount < 2 && data.diagram == null) return null;
  const drawing = redrawing || slotDrawing(data);
  const refusal = redrawRefusalText(redraw.data);
  return (
    <section aria-label="Story diagram" className="space-y-2" data-testid="sprint-drawer-diagram">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Story diagram</h3>
        <InfoButton title="Story diagram">
          <p>
            Claude Sonnet reads every pull request on this ticket and the code around them, then draws the whole flow
            across the repositories involved, with what it depends on.
          </p>
          <p>It is drawn after a review of any of these pull requests, and again when one of them changes.</p>
          <p>Claude works the flow out from the code, so check it before relying on it.</p>
        </InfoButton>
        <span className={`text-xs ${MUTED}`}>{data.memberCount} pull requests</span>
        {data.memberCount >= 2 && (
          <button type="button" className={`ml-auto ${BTN}`} disabled={drawing} onClick={() => redraw.mutate()}>
            {drawing ? 'Drawing…' : data.diagram != null ? 'Redraw' : 'Draw'}
          </button>
        )}
      </div>
      <DiagramSlotView slot={data} redrawing={redrawing} label="Sequence diagram of the whole story" />
      {refusal != null && <p className={`text-xs ${MUTED}`}>{refusal}</p>}
      {redraw.isError && <p className="text-xs text-red-600 dark:text-red-400">{redraw.error.message}</p>}
    </section>
  );
}
