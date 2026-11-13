import { useEffect, useMemo, useState } from 'react';
import {
  STORY_CHAT_IDLE_MINUTES,
  STORY_CHAT_MAX_QUESTION,
  STORY_CHAT_PRESETS,
  type StoryChatLive,
  type StoryChatTurn,
} from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import {
  useStoryChat,
  useStoryChatAsk,
  useStoryChatDelete,
  useStoryChatKeepAlive,
  useStoryChats,
  useStoryChatStop,
} from '../../hooks/useStoryChat.js';
import { relativeTime } from '../../lib/ui.js';
import { AiRunGate } from '../AiSetup.js';
import { InfoButton } from '../InfoModal.js';
import { Markdown } from '../Markdown.js';
import { Select } from '../ui/index.js';

// STORY CHAT (docs/STORY-CHAT.md; docs/FRONTEND.md § The story view → Ask about this story). Quick
// READ-ONLY questions about one story — advice, integration, how to prove it is done — answered by an
// agent that reads the ticket, the story's PR diffs and code, and the reader's memory. The agent is PREPARED while this panel is mounted (keep-alive), so an
// answer starts at once; the server closes it after STORY_CHAT_IDLE_MINUTES without use. Chats are
// saved against the story and can be continued.

const NEW = 'new';
const BTN_ASK =
  'whitespace-nowrap rounded-ui bg-ui-accent-fill px-4 py-1.5 text-body font-semibold text-ui-on-accent disabled:bg-ui-raise disabled:text-ui-ink disabled:opacity-50';
const BTN_SMALL =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2.5 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-10 touch:px-3';
const CHIP =
  'rounded-full bg-ui-raise px-2.5 py-0.5 text-meta text-ui-ink hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50 touch:min-h-10';

/** The live agent's state as one short line. */
export function liveLine(live: StoryChatLive): string {
  switch (live.state) {
    case 'preparing':
      return 'Getting the pull requests ready…';
    case 'ready':
      return 'Ready.';
    case 'answering':
      return 'Answering…';
    case 'failed':
      return live.note ? `The chat could not start: ${live.note}` : 'The chat could not start.';
    default:
      return 'Starts when you ask.';
  }
}

export function StoryChat({ workspaceId, ident, warm }: { workspaceId: number; ident: string; warm: boolean }): JSX.Element | null {
  const ai = useAiCapabilities();
  const [chatId, setChatId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(warm);
  const listQ = useStoryChats(workspaceId, ident, ai.enabled);
  const chatQ = useStoryChat(chatId);
  useStoryChatKeepAlive(workspaceId, ident, chatId, ai.enabled && focused);
  const askM = useStoryChatAsk(workspaceId, ident);
  const stopM = useStoryChatStop();
  const deleteM = useStoryChatDelete(workspaceId, ident);
  const costText = useRunCostText();

  // A new story: a new chat.
  useEffect(() => {
    setChatId(null);
    setDraft('');
  }, [ident]);

  const chats = listQ.data?.chats ?? [];
  const live = chatQ.data?.live ?? listQ.data?.live ?? null;
  const turns: StoryChatTurn[] = chatId != null ? (chatQ.data?.turns ?? []) : [];
  const running = turns.some((t) => t.status === 'running') || (live?.state === 'answering' && live.chatId === chatId && chatId != null);
  const busyElsewhere = live?.state === 'answering' && live.chatId !== chatId;
  const question = draft.trim();
  const tooLong = question.length > STORY_CHAT_MAX_QUESTION;
  const canAsk = question !== '' && !tooLong && !running && !busyElsewhere && !askM.isPending;

  const options = useMemo(
    () => [
      { value: NEW, label: 'New chat' },
      ...chats.map((c) => ({ value: String(c.id), label: c.title, text: c.title, hint: relativeTime(c.updatedAt) })),
    ],
    [chats],
  );

  if (!ai.enabled) return null;

  const ask = (text: string): void => {
    const q = text.trim();
    if (q === '' || q.length > STORY_CHAT_MAX_QUESTION) return;
    askM.mutate(
      { chatId, question: q },
      {
        onSuccess: (res) => {
          setChatId(res.chatId);
          setDraft('');
        },
      },
    );
  };

  return (
    <section data-testid="story-chat" aria-labelledby="story-chat-heading" className="space-y-3 rounded-ui bg-ui-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="story-chat-heading" className="text-title font-semibold text-ui-ink">
          Ask about this story
        </h2>
        <InfoButton title="Ask about this story">
          <p>
            Ask for advice on the story: how to test it by hand once its pull requests are merged, what is still missing,
            how it fits with the rest of the system.
          </p>
          <p className="mt-2">
            An agent answers from the ticket, the pull requests’ changes and their code, checked out on this computer,
            with your Claude memory for these projects. It only reads: it runs nothing and changes nothing.
          </p>
          <p className="mt-2">
            The agent stays ready while the story is open and closes after {STORY_CHAT_IDLE_MINUTES} minutes without use;
            its checkouts are then removed. Chats are saved with the story.
          </p>
        </InfoButton>
        <div className="ml-auto flex items-center gap-2">
          {chats.length > 0 && (
            <Select
              size="sm"
              label="Chat"
              value={chatId == null ? NEW : String(chatId)}
              onChange={(v) => setChatId(v === NEW ? null : Number(v))}
              options={options}
            />
          )}
          {chatId != null && !running && (
            <button
              type="button"
              className={BTN_SMALL}
              disabled={deleteM.isPending}
              onClick={() => deleteM.mutate(chatId, { onSuccess: () => setChatId(null) })}
            >
              Delete chat
            </button>
          )}
        </div>
      </div>

      {live != null && (
        <p className="text-meta text-ui-mute" aria-live="polite">
          {liveLine(live)}
          {live.state !== 'failed' && live.note != null && ` ${live.note}`}
        </p>
      )}

      {turns.length > 0 && (
        <ol aria-label="Questions and answers" className="space-y-3">
          {turns.map((t) => (
            <li key={t.id} className="space-y-1.5">
              <p className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-ui bg-ui-sel px-3 py-1.5 text-body text-ui-ink">{t.question}</p>
              {t.status === 'running' ? (
                <RunningAnswer live={live} onStop={() => chatId != null && stopM.mutate(chatId)} stopping={stopM.isPending} />
              ) : (
                <div className="space-y-1">
                  {t.answer != null && (
                    <div className="text-body text-ui-ink">
                      <Markdown>{t.answer}</Markdown>
                    </div>
                  )}
                  {t.status === 'failed' && <p className="text-meta text-ui-danger">{t.error ?? 'The answer failed.'}</p>}
                  {t.status === 'stopped' && <p className="text-meta text-ui-mute">Stopped.</p>}
                  {costText(t.costUsd, (t.provider as 'claude' | 'codex' | null) ?? null) != null && (
                    <p className="text-meta text-ui-mute">{costText(t.costUsd, (t.provider as 'claude' | 'codex' | null) ?? null)}</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {!running && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Ready-made questions">
          {STORY_CHAT_PRESETS.map((p) => (
            <button key={p.label} type="button" className={CHIP} disabled={busyElsewhere || askM.isPending} onClick={() => setDraft(p.question)}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canAsk) {
            e.preventDefault();
            ask(draft);
          }
        }}
        rows={3}
        placeholder={chatId == null ? 'Ask how to test it, what is missing, or how it fits with the rest' : 'Ask a follow-up'}
        aria-label="Question about this story"
        className="w-full resize-y rounded-ui bg-ui-bg px-2.5 py-1.5 text-body leading-normal text-ui-ink"
      />
      <div className="flex flex-wrap items-center gap-3">
        <AiRunGate kind="story_chat">
          <button type="button" className={BTN_ASK} disabled={!canAsk} onClick={() => ask(draft)}>
            {askM.isPending ? 'Sending…' : 'Ask'}
          </button>
        </AiRunGate>
        {busyElsewhere && <span className="text-meta text-ui-mute">Another chat on this story is answering.</span>}
        {tooLong && <span className="text-meta text-ui-danger">Keep it under {STORY_CHAT_MAX_QUESTION.toLocaleString('en-US')} characters.</span>}
        {askM.isError && <span className="text-meta text-ui-danger">{askM.error instanceof Error ? askM.error.message : 'Could not ask.'}</span>}
      </div>
    </section>
  );
}

function RunningAnswer({ live, onStop, stopping }: { live: StoryChatLive | null; onStop: () => void; stopping: boolean }): JSX.Element {
  const lines = (live?.activity ?? []).slice(-6);
  return (
    <div className="space-y-1.5" aria-busy="true">
      {lines.length > 0 && (
        <ul aria-label="What the agent is doing" className="space-y-0.5 font-mono text-meta text-ui-mute">
          {lines.map((l, i) => (
            <li key={`${i}-${l}`} className="truncate">
              {l}
            </li>
          ))}
        </ul>
      )}
      {live?.partial ? (
        <div className="text-body text-ui-ink">
          <Markdown>{live.partial}</Markdown>
        </div>
      ) : (
        <p className="text-meta text-ui-mute motion-safe:animate-pulse">Working…</p>
      )}
      <button type="button" className={BTN_SMALL} onClick={onStop} disabled={stopping}>
        Stop
      </button>
    </div>
  );
}
