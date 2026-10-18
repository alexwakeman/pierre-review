import { useEffect, useRef, useState } from 'react';
import { REFERENCE_DOCS_CHAT_MAX_QUESTION_CHARS, type ReferenceDocsChatMessage } from '@pierre-review/shared';
import {
  useAskDocs,
  useDeleteDocsConversation,
  useDocsChatBusy,
  useDocsChatPendingQuestion,
  useDocsConversation,
  useDocsConversations,
} from '../../hooks/useReferenceDocs.js';
import { LIBRARY_INDEX_PATH, citationLabel } from '../../lib/referenceDocs.js';
import { formatUsd } from '../../lib/ui.js';
import { useDocsView } from '../../store/docsView.js';
import { AiRunGate } from '../AiSetup.js';
import { BookIcon, SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Markdown } from '../Markdown.js';
import { useDocLinkRenderer } from './DocsViewer.js';

// Activity → Docs, the chat: ad hoc questions about this workspace's library, answered by Sonnet 5
// reading the library's files (POST /api/docs/chat). Multi-turn; the server rebuilds the transcript
// from its own stored rows, so only the new question is sent. ⚠ The completed turn is written into
// the cache in `useAskDocs`' HOOK-level onSuccess, never a mutate() callback.
// Citations are the answer's links that name a real file of this library (the server checks); each
// opens that section in the viewer, and so does any library link inside the answer's text.

const MUTED = 'text-gray-500 dark:text-gray-400';

function Answer({
  message,
  onOpen,
}: {
  message: ReferenceDocsChatMessage;
  onOpen: (path: string, anchor: string | null) => void;
}): JSX.Element {
  // A chat answer speaks from the library root (`<slug>/sections/…`).
  const renderLink = useDocLinkRenderer(LIBRARY_INDEX_PATH, onOpen);
  return (
    <div className="space-y-1.5">
      <div className="text-[13px] text-gray-800 dark:text-gray-100">
        <Markdown renderLink={renderLink} wideTables>{message.text}</Markdown>
      </div>
      {message.citations.length > 0 && (
        <div className="space-y-0.5">
          <p className={`text-[11px] font-medium ${MUTED}`}>Sources</p>
          <ul className="space-y-0.5">
            {message.citations.map((c) => (
              <li key={`${c.path}#${c.anchor ?? ''}`}>
                <button
                  type="button"
                  onClick={() => onOpen(c.path, c.anchor)}
                  className="inline-flex items-start gap-1 text-left text-xs text-sky-700 hover:underline dark:text-sky-300"
                >
                  <BookIcon size={12} className="mt-0.5 shrink-0" />
                  <span>{citationLabel(c)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className={`text-[11px] ${MUTED}`}>{message.costUsd != null ? formatUsd(message.costUsd) : 'Cost not reported'}</p>
    </div>
  );
}

export function DocsChat({
  workspaceId,
  canAsk,
  onOpen,
}: {
  workspaceId: number;
  /** False while the library has no built document (the server would refuse). */
  canAsk: boolean;
  onOpen: (path: string, anchor: string | null) => void;
}): JSX.Element {
  const active = useDocsView((s) => s.conversation[workspaceId] ?? null);
  const setConversation = useDocsView((s) => s.setConversation);
  const conversations = useDocsConversations(workspaceId);
  const conversation = useDocsConversation(workspaceId, active);
  const ask = useAskDocs(workspaceId);
  const remove = useDeleteDocsConversation(workspaceId);
  const busy = useDocsChatBusy(workspaceId);
  const pending = useDocsChatPendingQuestion(workspaceId, active);
  const [question, setQuestion] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const messages = active != null ? (conversation.data?.messages ?? []) : [];
  const list = conversations.data?.conversations ?? [];

  useEffect(() => {
    const el = listRef.current;
    if (el != null) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);
  useEffect(() => setConfirmDelete(false), [active]);

  const submit = (): void => {
    const q = question.trim();
    if (q === '' || busy || !canAsk) return;
    setQuestion('');
    ask.mutate({ question: q, conversationId: active });
  };

  return (
    <section
      aria-label="Ask about these docs"
      className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-ai-border xl:w-96 xl:flex-none"
      data-testid="docs-chat"
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <SparkleIcon size={12} className="text-ai-signal" />
        <h3 className="text-xs font-semibold text-gray-800 dark:text-gray-100">Ask about these docs</h3>
        <InfoButton title="Ask about these docs">
          <p>
            Claude Sonnet answers from this workspace&rsquo;s documents only. It starts at the library&rsquo;s contents, opens the
            documents that matter, and reads only the sections it needs.
          </p>
          <p>Each point links to the section it came from. When two documents disagree, it cites both.</p>
          <p>It remembers the earlier questions in a conversation, up to a limit. It changes nothing.</p>
          <p>Each answer runs on your own Claude Code or Anthropic API key; its cost is shown under it.</p>
        </InfoButton>
        <span className="ml-auto" />
        {list.length > 0 && (
          <select
            aria-label="Conversation"
            value={active ?? ''}
            onChange={(e) => setConversation(workspaceId, e.target.value === '' ? null : e.target.value)}
            className="max-w-[12rem] rounded border border-gray-300 bg-white px-1 py-0.5 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">New conversation</option>
            {list.map((c) => (
              <option key={c.conversationId} value={c.conversationId}>
                {c.title}
              </option>
            ))}
          </select>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2" aria-live="polite">
        {messages.length === 0 && pending == null && (
          <p className={`text-xs ${MUTED}`}>
            {canAsk ? 'For example: what do the docs say about refunds?' : 'Add a document first.'}
          </p>
        )}
        {active != null && conversation.isError && (
          <p className="text-xs text-rose-700 dark:text-rose-400">This conversation could not be loaded.</p>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <p key={m.id} className="ml-6 whitespace-pre-wrap rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-100">
              {m.text}
            </p>
          ) : (
            <Answer key={m.id} message={m} onOpen={onOpen} />
          ),
        )}
        {pending != null && (
          <div className="space-y-1">
            <p className="ml-6 whitespace-pre-wrap rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-100">
              {pending}
            </p>
            <p className={`text-xs ${MUTED}`}>Reading the docs…</p>
          </div>
        )}
        {ask.isError && !busy && <p className="text-xs text-rose-700 dark:text-rose-400">{ask.error.message}</p>}
      </div>

      <div className="space-y-1.5 border-t border-gray-200 px-3 py-2 dark:border-gray-800">
        <AiRunGate>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              maxLength={REFERENCE_DOCS_CHAT_MAX_QUESTION_CHARS}
              rows={2}
              disabled={!canAsk}
              aria-label="Your question"
              placeholder="Ask about these docs"
              className="min-w-0 flex-1 resize-none rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 placeholder:text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-400"
            />
            <button
              type="submit"
              disabled={busy || !canAsk || question.trim() === ''}
              className="inline-flex items-center gap-1 rounded border border-ai-border px-2 py-1 text-xs font-medium text-ai-ink hover:bg-ai-surface-2 disabled:opacity-50"
            >
              Ask
            </button>
          </form>
        </AiRunGate>
        {active != null && (
          <div className="flex items-center gap-2 text-xs">
            <button type="button" onClick={() => setConversation(workspaceId, null)} className="text-sky-700 hover:underline dark:text-sky-300">
              New conversation
            </button>
            {confirmDelete ? (
              <>
                <span className="text-gray-700 dark:text-gray-200">Delete this conversation?</span>
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(active)}
                  className="font-medium text-rose-700 hover:underline disabled:opacity-50 dark:text-rose-400"
                >
                  Delete
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="text-sky-700 hover:underline dark:text-sky-300">
                  Keep
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="text-sky-700 hover:underline dark:text-sky-300">
                Delete conversation
              </button>
            )}
            {remove.isError && <span className="text-rose-700 dark:text-rose-400">{remove.error.message}</span>}
          </div>
        )}
      </div>
    </section>
  );
}
