import type { AiFixPlanMessage } from '@pierre-review/shared';

// THE PLAN CHAT — shared by AI Fix's "Plan first" (`PlanPanel.tsx`) and the story build's plan
// (`StoryBuild/PlanSection.tsx`). The reader steers a READ-ONLY planning pass by message; each message
// runs a fresh pass with the whole conversation. Two pieces, because each host puts its progress bar
// between them: the transcript, and the message box with its "Update plan" button. The host wraps the
// box in its own `AiRunGate` (the pass's kind and provider) and owns the mutation.

const BTN_SECONDARY =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2.5 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-10 touch:px-3';

/** The conversation so far: "You: …" / "<who planned>: …". Nothing when it is empty. */
export function PlanTranscript({ transcript, plannedBy }: { transcript: readonly AiFixPlanMessage[]; plannedBy: string }): JSX.Element | null {
  if (transcript.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1.5 border-t border-ui-line pt-2 text-meta">
      {transcript.map((m, i) => (
        <li key={i} className="whitespace-pre-wrap text-ui-ink">
          <span className="font-semibold">{m.role === 'reader' ? 'You' : plannedBy}: </span>
          {m.text}
        </li>
      ))}
    </ul>
  );
}

/** The message box and "Update plan". ⌘/Ctrl+Enter sends too. */
export function PlanMessageBox({
  name,
  draft,
  setDraft,
  busy,
  maxChars,
  onSend,
}: {
  /** Who rewrites the plan ("Claude", "Codex"). */
  name: string;
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  maxChars: number;
  onSend: () => void;
}): JSX.Element {
  const text = draft.trim();
  const tooLong = text.length > maxChars;
  return (
    <>
      <textarea
        aria-label="Change the plan"
        className="w-full rounded-ui bg-ui-raise px-2 py-1 text-body ring-1 ring-inset ring-ui-line focus:outline-none focus:ring-2 focus:ring-ui-accent"
        rows={2}
        placeholder={`Tell ${name} what to change in the plan`}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      {tooLong && <p className="text-meta text-ui-danger">Keep it under {maxChars.toLocaleString('en-US')} characters.</p>}
      <div className="mt-2">
        <button type="button" data-ai-run className={BTN_SECONDARY} disabled={busy || text === '' || tooLong} onClick={onSend}>
          Update plan
        </button>
      </div>
    </>
  );
}
