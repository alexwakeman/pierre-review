import { useEffect, useMemo, useRef, useState } from 'react';
import { SPRINT_ASK_QUESTION_MAX, type SprintGraphNode } from '@pierre-review/shared';
import { useSprintAsk, useSprintAsking, useSprintAskTranscript, type SprintAskShownTurn } from '../../hooks/useSprintStories.js';
import { rehypeTicketLinks } from '../../lib/ticketLinks.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import { AiRunGate } from '../AiSetup.js';
import { CloseIcon, SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { AiStatusLine } from '../AiStatusLine.js';
import { Markdown, type RehypePlugins } from '../Markdown.js';
import { sprintTicketSite } from './sprintModel.js';

// "Ask Claude about this sprint" (Activity → This Sprint): a compact chat under the page's toolbar,
// above the board. LOCAL ONLY and free (gated on me.ai), like the route (the caller mounts it only where agentic AI
// runs). One Haiku answer per question, grounded in the stored sprint; the conversation is kept for the
// visit in a module store, and the completed turn is appended in `useSprintAsk`'s HOOK-level onSuccess
// (never a `mutate()` callback — closing the panel mid-answer must not lose a billed answer).
// Ticket keys in an answer are links: each opens its story in the page's TRAY (TicketRefLink reads
// SprintView's `StoryOpenOverride`).

const MUTED = 'text-gray-500 dark:text-gray-400';
const EMPTY: SprintAskShownTurn[] = [];

export function SprintAskPanel({
  workspaceId,
  nodes,
  onClose,
}: {
  workspaceId: number;
  nodes: SprintGraphNode[];
  onClose: () => void;
}): JSX.Element {
  const turns = useSprintAskTranscript((s) => s.turns[workspaceId] ?? EMPTY);
  // US$ on an API key, the share of the week on a Claude subscription (lib/aiBudget.ts `runCostText`).
  const costText = useRunCostText();
  const clear = useSprintAskTranscript((s) => s.clear);
  const ask = useSprintAsk(workspaceId);
  const asking = useSprintAsking(workspaceId);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Ticket keys in an answer → links (the sprint's keys only: a key's shape alone is not enough).
  const rehype = useMemo<RehypePlugins>(() => {
    const first = nodes[0];
    const site = first != null ? sprintTicketSite(first) : null;
    if (site == null) return [];
    return [[rehypeTicketLinks, { site, selfKey: '', related: nodes.map((n) => ({ key: n.key, title: n.title !== '' ? n.title : null })) }]];
  }, [nodes]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (el != null) el.scrollTop = el.scrollHeight;
  }, [turns.length, asking]);
  useEffect(() => {
    if (!asking) setPending(null);
  }, [asking]);

  const submit = (): void => {
    const q = question.trim();
    if (q === '' || asking) return;
    setPending(q);
    setQuestion('');
    ask.mutate({ question: q, history: turns.map((t) => ({ question: t.question, answer: t.answer })) });
  };

  return (
    <section
      aria-label="Ask Claude about this sprint"
      className="flex max-h-[28rem] w-full max-w-2xl flex-col rounded-lg border border-ai-border bg-white shadow-sm dark:bg-gray-950"
      data-testid="sprint-ask"
    >
      <div className="flex items-center gap-1.5 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <SparkleIcon size={12} className="text-ai-signal" />
        <h3 className="text-xs font-semibold text-gray-800 dark:text-gray-100">Ask Claude about this sprint</h3>
        <InfoButton title="Ask Claude about this sprint">
          <p>
            Claude Haiku answers from what this page holds: the tickets, their statuses, summaries and links, and their pull
            requests. It reads nothing else and changes nothing.
          </p>
          <p>It remembers this conversation&rsquo;s earlier questions, up to a limit. The conversation is gone when you leave the page.</p>
          <p>Each answer runs on your own Claude Code login or Anthropic API key; what it used is shown under it.</p>
        </InfoButton>
        <span className="ml-auto" />
        {turns.length > 0 && (
          <button type="button" onClick={() => clear(workspaceId)} className="text-xs text-sky-700 hover:underline dark:text-sky-300">
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
        >
          <CloseIcon size={12} />
        </button>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2" aria-live="polite">
        {turns.length === 0 && pending == null && (
          <p className={`text-xs ${MUTED}`}>For example: what is blocking the work in review?</p>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-1">
            <p className="ml-6 rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-100">{t.question}</p>
            <div className="text-[13px] text-gray-800 dark:text-gray-100">
              <Markdown ticketLinks rehypeExtra={rehype}>
                {t.answer}
              </Markdown>
            </div>
            <p className={`text-[11px] ${MUTED}`}>
              {[
                costText(t.costUsd) ?? (t.costUsd == null ? 'Cost not reported' : null),
                t.trimmedTurns > 0
                  ? `the oldest ${t.trimmedTurns === 1 ? 'question was' : `${t.trimmedTurns} questions were`} not read`
                  : null,
              ]
                .filter((x): x is string => x != null)
                .join(' · ')}
            </p>
          </div>
        ))}
        {pending != null && (
          <div className="space-y-1">
            <p className="ml-6 rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-100">{pending}</p>
            <AiStatusLine stage="Thinking" />
          </div>
        )}
        {ask.isError && !asking && <p className="text-xs text-rose-700 dark:text-rose-400">{ask.error.message}</p>}
      </div>
      <div className="border-t border-gray-200 px-3 py-2 dark:border-gray-800">
        <AiRunGate kind="complete">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <textarea
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              maxLength={SPRINT_ASK_QUESTION_MAX}
              rows={2}
              aria-label="Your question"
              placeholder="Ask about this sprint"
              className="min-w-0 flex-1 resize-none rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 placeholder:text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-400"
            />
            <button
              type="submit"
              disabled={asking || question.trim() === ''}
              className="inline-flex items-center gap-1 rounded border border-ai-border px-2 py-1 text-xs font-medium text-ai-ink hover:bg-ai-surface-2 disabled:opacity-50"
            >
              Ask
            </button>
          </form>
        </AiRunGate>
      </div>
    </section>
  );
}
