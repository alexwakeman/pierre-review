import type { ClaudeRepliesCheckState } from '@pierre-review/shared';
import { useRepliesCheck } from '../hooks/useClaudeReview.js';
import { repliesCheckFailedLine } from '../lib/repliesCheck.js';
import { AiStatusLine } from './AiStatusLine.js';

// THE REPLIES PASS on the AI Review tab (docs/CLAUDE-REVIEW.md § The replies pass). It starts by itself
// (auto review), so the tab shows only what the reader can act on or would otherwise miss: the status
// line with Cancel while a pass runs, and the newest pass's error when it failed. A finished pass is a
// row in "Reviews on this PR". Nothing otherwise (2026-11-10: the "Check replies" button and the
// newest pass's summary line were removed).
export function RepliesCheckLine({
  prId,
  state,
}: {
  prId: number;
  state: ClaudeRepliesCheckState | null | undefined;
}): JSX.Element | null {
  const { cancel } = useRepliesCheck(prId);
  if (state == null) return null;
  if (state.live != null) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
        <AiStatusLine stage={state.live === 'queued' ? 'Waiting for a free slot' : 'Checking replies'} since={state.latest?.createdAt ?? null}>
          <button
            type="button"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            className="hit rounded-ui px-1 text-meta text-ui-mute underline decoration-dotted underline-offset-2 hover:text-ui-ink disabled:opacity-50"
          >
            Cancel
          </button>
        </AiStatusLine>
      </div>
    );
  }
  const failed = repliesCheckFailedLine(state.latest);
  return failed != null ? <div className="text-meta text-ui-danger">{failed}</div> : null;
}
