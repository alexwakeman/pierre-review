import { useEffect, useRef, useState } from 'react';
import { ReviewSection } from './ReviewSection.js';
import {
  CLAUDE_REVIEW_CHAT_EXPLAIN_DEFAULT_QUESTION,
  CLAUDE_REVIEW_CHAT_MAX_PINS,
  CLAUDE_REVIEW_CHAT_MAX_QUESTION_CHARS,
  type ClaudeReviewChatExplanation,
  type ClaudeReviewChatHistoryRun,
  type ClaudeReviewChatMessage,
  type ClaudeReviewChatPinRef,
} from '@pierre-review/shared';
import {
  useAskClaudeReviewChat,
  useClaudeReviewChat,
  useClaudeReviewChatBusy,
  useClaudeReviewChatHistory,
  useClaudeReviewChatPendingQuestion,
} from '../hooks/useClaudeReviewChat.js';
import {
  chatPinKey,
  pinsForChat,
  useReviewChatPins,
  type ChatPinEntry,
} from '../store/reviewChatPins.js';
import { Markdown } from './Markdown.js';
import { CheckIcon, ChevronIcon, CloseIcon, CommentIcon } from './Icons.js';
import { AiRunGate } from './AiSetup.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';
import { REVIEW_ANCHOR_MUTED, REVIEW_ITEM_CARD, REVIEW_SUBHEAD } from '../lib/reviewStyles.js';

// Claude Review chat: ONE thread per review, about the whole review and any of its findings. The
// per-finding "Ask Claude" threads were removed from the screen (the review thread covers them);
// `findingId` stays on the component because the route still serves those older threads.
// The review's thread opens EXPANDED (it sits under Story check), so its one DB read runs on mount;
// Hide collapses it and nothing more is fetched while it is shut.
//
// SEND TO CHAT: every finding card and every not-done story item carries a "Send to chat" button
// (`SendToChatButton`) that pins it here as a pill (store/reviewChatPins.ts — in memory, per PR).
// Ask with pins sends their REFERENCES; the server reads each item itself and ONE agent run answers
// with one card per pin. Earlier review runs' chats sit under a collapsed "Earlier reviews' chats",
// fetched only once opened.

export const CHAT_HEAD_MOVED_LINE = 'Answers are about the reviewed commit; the PR has moved on.';
const ANSWERING_LINE = 'Claude is reading the code…';

const BTN_SMALL =
  'inline-flex items-center gap-1 whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';
const BTN_ASK =
  'whitespace-nowrap rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-400 dark:text-gray-950';
const MUTED = 'text-gray-500 dark:text-gray-400';
const PILL =
  'inline-flex max-w-full items-center gap-1 rounded-full border border-blue-300 bg-blue-50 px-2.5 py-0.5 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200';

const sameRef = (a: ClaudeReviewChatPinRef, b: ClaudeReviewChatPinRef): boolean => chatPinKey(a) === chatPinKey(b);

/**
 * "Send to chat" on a finding or story-item card. Renders only while this PR's Review chat is on
 * screen — and, for a finding, only when that chat is about the finding's own review run. A second
 * press scrolls to the chat; pinning twice adds nothing.
 */
export function SendToChatButton({
  prId,
  reviewId,
  pinRef,
  label,
}: {
  prId: number;
  // The finding's review run; null for a story item (it belongs to a ticket review).
  reviewId: number | null;
  pinRef: ClaudeReviewChatPinRef;
  label: string;
}): JSX.Element | null {
  const chatReview = useReviewChatPins((s) => s.chats[prId]);
  const key = chatPinKey(pinRef);
  const pinned = useReviewChatPins((s) => (s.byPr[prId] ?? []).some((e) => e.key === key));
  const pin = useReviewChatPins((s) => s.pin);
  const [full, setFull] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current != null) clearTimeout(timer.current);
  }, []);
  if (chatReview == null) return null;
  if (reviewId != null && chatReview !== reviewId) return null;
  const onClick = (): void => {
    const out = pin(prId, { ref: pinRef, label, reviewId });
    if (out === 'full') {
      setFull(true);
      if (timer.current != null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFull(false), 4000);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        className={BTN_SMALL}
        aria-label={pinned ? `In the review chat: ${label}. Show the chat` : `Send to the review chat: ${label}`}
      >
        {pinned ? <CheckIcon size={11} /> : <CommentIcon size={11} />}
        {pinned ? 'In chat' : 'Send to chat'}
      </button>
      {full && (
        <span className="text-xs text-amber-700 dark:text-amber-300">
          The chat holds {CLAUDE_REVIEW_CHAT_MAX_PINS} items. Remove one first.
        </span>
      )}
    </span>
  );
}

function PinPill({ label, onRemove }: { label: string; onRemove?: () => void }): JSX.Element {
  return (
    <li className={PILL}>
      <span className="min-w-0 break-words">{label}</span>
      {onRemove != null && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label} from the chat`}
          className="-mr-1 shrink-0 rounded-full p-0.5 hover:bg-blue-200/60 dark:hover:bg-blue-800/60"
        >
          <CloseIcon size={10} />
        </button>
      )}
    </li>
  );
}

function CardField({ title, text }: { title: string; text: string }): JSX.Element | null {
  if (text.trim() === '') return null;
  return (
    <div className="mt-1.5">
      <h6 className={REVIEW_SUBHEAD}>{title}</h6>
      <Markdown prRefs>{text}</Markdown>
    </div>
  );
}

/** One explain answer: a card per pin, in the order they were sent. */
function ExplanationCards({
  cards,
  pins,
}: {
  cards: readonly ClaudeReviewChatExplanation[];
  pins: readonly { ref: ClaudeReviewChatPinRef; label: string }[];
}): JSX.Element {
  const missing = pins.filter((p) => !cards.some((c) => sameRef(c.ref, p.ref)));
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {cards.map((c) => (
          <li key={chatPinKey(c.ref)} className={REVIEW_ITEM_CARD}>
            <div className="font-semibold">{c.label}</div>
            <CardField title="What it means" text={c.meaning} />
            <CardField title="Why it matters" text={c.whyItMatters} />
            {c.where.length > 0 && (
              <div className="mt-1.5">
                <h6 className={REVIEW_SUBHEAD}>Where</h6>
                <ul className="flex flex-wrap gap-x-3">
                  {c.where.map((w, i) => (
                    <li key={i} className={REVIEW_ANCHOR_MUTED}>
                      {w.line != null ? `${w.path}:${w.line}` : w.path}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <CardField title="What would fix it" text={c.fix} />
          </li>
        ))}
      </ul>
      {missing.length > 0 && (
        <p className={`text-xs ${MUTED}`}>
          No explanation came back for: {missing.map((p) => p.label).join('; ')}.
        </p>
      )}
    </div>
  );
}

/** A thread's stored turns (live or read-only history). */
function ChatMessages({ messages }: { messages: readonly ClaudeReviewChatMessage[] }): JSX.Element | null {
  if (messages.length === 0) return null;
  return (
    <ol className="space-y-3">
      {messages.map((m, i) => {
        if (m.role === 'user') {
          return (
            <li key={m.id} className="text-sm">
              <div className={`text-xs font-medium ${MUTED}`}>You</div>
              <div className="whitespace-pre-wrap">{m.content}</div>
              {m.pins != null && m.pins.length > 0 && (
                <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Items sent">
                  {m.pins.map((p) => (
                    <PinPill key={chatPinKey(p.ref)} label={p.label} />
                  ))}
                </ul>
              )}
            </li>
          );
        }
        const question = messages[i - 1];
        return (
          <li key={m.id} className="text-sm">
            <div className={`text-xs font-medium ${MUTED}`}>Claude</div>
            {m.explanations != null ? (
              <ExplanationCards cards={m.explanations} pins={question?.role === 'user' ? (question.pins ?? []) : []} />
            ) : (
              <Markdown prRefs>{m.content}</Markdown>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** One open thread: its stored turns, the question being answered, the pins and the composer. */
export function ReviewChatThread({
  reviewId,
  findingId,
  prId = null,
}: {
  reviewId: number;
  findingId: number | null;
  // The review's PR: the pins live per PR. null ⇒ no pins (a finding thread).
  prId?: number | null;
}): JSX.Element {
  const thread = useClaudeReviewChat(reviewId, findingId, true);
  const ask = useAskClaudeReviewChat(reviewId);
  const busy = useClaudeReviewChatBusy(reviewId);
  const pendingHere = useClaudeReviewChatPendingQuestion(reviewId, findingId);
  const allPins = useReviewChatPins((s) => (prId != null ? s.byPr[prId] : undefined));
  const unpin = useReviewChatPins((s) => s.unpin);
  const removePins = useReviewChatPins((s) => s.remove);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pins: ChatPinEntry[] = prId != null && findingId == null ? pinsForChat(allPins ?? [], reviewId) : [];
  const messages = thread.data?.messages ?? [];
  // Answering on the server but not from this tab's mutation (the pane was reopened mid-answer).
  const answeringElsewhere = thread.data?.answering === true && !busy;
  const answering = pendingHere != null || answeringElsewhere;
  const tooLong = draft.trim().length > CLAUDE_REVIEW_CHAT_MAX_QUESTION_CHARS;
  const canSend =
    (draft.trim() !== '' || pins.length > 0) &&
    pins.length <= CLAUDE_REVIEW_CHAT_MAX_PINS &&
    !tooLong &&
    !busy &&
    !answeringElsewhere;

  const send = (): void => {
    if (!canSend) return;
    const question = draft.trim();
    const sent = pins;
    setError(null);
    // The box empties AT ONCE; the question shows in the thread as the pending turn. The pins leave
    // the composer too (a failed send puts them back — at the hook level, see useAskClaudeReviewChat).
    setDraft('');
    if (prId != null && sent.length > 0) removePins(prId, sent.map((p) => p.key));
    ask.mutate(
      {
        question,
        findingId,
        ...(sent.length > 0 ? { pins: sent.map((p) => p.ref), prId: prId ?? undefined, pinEntries: sent } : {}),
      },
      {
        // Display only: give the reader their words back if the box is still empty.
        onError: (e) => {
          setError(e.message);
          setDraft((d) => (d === '' ? question : d));
        },
      },
    );
  };

  const pendingQuestion =
    pendingHere == null
      ? null
      : pendingHere.question !== ''
        ? pendingHere.question
        : CLAUDE_REVIEW_CHAT_EXPLAIN_DEFAULT_QUESTION;
  const explaining = (pendingHere?.pins.length ?? 0) > 0;

  return (
    <div className="mt-2 space-y-3 rounded border border-gray-200 bg-gray-50/60 p-3 dark:border-gray-800 dark:bg-gray-900/40">
      {thread.data?.headMoved && (
        <div className="text-xs text-amber-700 dark:text-amber-400">{CHAT_HEAD_MOVED_LINE}</div>
      )}
      {thread.isLoading && <div className={`text-xs ${MUTED}`}>Loading…</div>}
      {thread.isError && (
        <div className="text-xs text-red-600 dark:text-red-400">Could not load this conversation.</div>
      )}
      <ChatMessages messages={messages} />
      {pendingQuestion != null && (
        <div className="text-sm">
          <div className={`text-xs font-medium ${MUTED}`}>You</div>
          <div className="whitespace-pre-wrap">{pendingQuestion}</div>
          {pendingHere != null && pendingHere.pins.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Items sent">
              {pendingHere.pins.map((p) => (
                <PinPill key={p.key} label={p.label} />
              ))}
            </ul>
          )}
        </div>
      )}
      {answering && (
        <div className="space-y-1">
          <div className="text-xs text-ai-signal">{ANSWERING_LINE}</div>
          <RegenProgressBar active label={ANSWERING_LINE} timeConstantSec={explaining ? 40 : 20} />
        </div>
      )}
      <div className="space-y-2">
        {pins.length > 0 && (
          <div className="space-y-1">
            <div className={`text-xs ${MUTED}`}>
              {pins.length === 1 ? '1 item' : `${pins.length} items`} to explain
              {pins.length >= CLAUDE_REVIEW_CHAT_MAX_PINS ? ` (the most one question can take)` : ''}
            </div>
            <ul className="flex flex-wrap gap-1.5" aria-label="Items to explain">
              {pins.map((p) => (
                <PinPill key={p.key} label={p.label} onRemove={() => prId != null && unpin(prId, p.key)} />
              ))}
            </ul>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          rows={3}
          placeholder={
            pins.length > 0
              ? 'Add a question, or just press Ask to explain these'
              : findingId != null
                ? 'Ask about this finding'
                : 'Ask about this review'
          }
          aria-label={findingId != null ? 'Question about this finding' : 'Question about this review'}
          className="w-full resize-y rounded border border-gray-300 bg-white px-2.5 py-1.5 text-[15px] leading-normal dark:border-gray-700 dark:bg-gray-950"
        />
        <div className="flex flex-wrap items-center gap-3">
          <AiRunGate>
            <button type="button" onClick={send} disabled={!canSend} className={BTN_ASK}>
              {busy ? 'Answering…' : 'Ask'}
            </button>
          </AiRunGate>
          {busy && pendingHere == null && (
            <span className={`text-xs ${MUTED}`}>Answering another question…</span>
          )}
          {tooLong && (
            <span className="text-xs text-red-600 dark:text-red-400">
              Keep it under {CLAUDE_REVIEW_CHAT_MAX_QUESTION_CHARS.toLocaleString('en-US')} characters.
            </span>
          )}
          {error != null && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </div>
      </div>
    </div>
  );
}

const MODE_WORD: Record<string, string> = { diff_only: 'Quick review', worktree: 'Deep review', skip: 'Skipped' };

export function historyRunLabel(run: Pick<ClaudeReviewChatHistoryRun, 'headSha' | 'at' | 'reviewMode'>): string {
  const sha = run.headSha ? run.headSha.slice(0, 7) : 'unknown commit';
  const when = new Date(run.at).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const mode = run.reviewMode != null ? MODE_WORD[run.reviewMode] : null;
  return [sha, when, mode].filter(Boolean).join(' · ');
}

/** "Earlier reviews' chats": collapsed by default, fetched only once opened, read-only. */
function EarlierChats({ prId, reviewId }: { prId: number; reviewId: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const history = useClaudeReviewChatHistory(prId, open);
  const runs = (history.data?.runs ?? []).filter((r) => r.reviewId !== reviewId);
  const [picked, setPicked] = useState<number | null>(null);
  const run = runs.find((r) => r.reviewId === picked) ?? runs[0] ?? null;
  return (
    <div className="mt-3 border-t border-gray-200 pt-2 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 hover:underline dark:text-gray-200"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={11} />
        Earlier reviews&apos; chats
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {history.isLoading && <div className={`text-xs ${MUTED}`}>Loading…</div>}
          {history.isError && (
            <div className="text-xs text-red-600 dark:text-red-400">Could not load earlier chats.</div>
          )}
          {history.data != null && runs.length === 0 && (
            <div className={`text-xs ${MUTED}`}>No earlier review of this PR has a chat.</div>
          )}
          {run != null && (
            <>
              <label className="flex flex-wrap items-center gap-2 text-xs">
                <span className={MUTED}>Review</span>
                <select
                  value={run.reviewId}
                  onChange={(e) => setPicked(Number(e.target.value))}
                  className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-950"
                >
                  {runs.map((r) => (
                    <option key={r.reviewId} value={r.reviewId}>
                      {historyRunLabel(r)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rounded border border-gray-200 p-2 dark:border-gray-800">
                <ChatMessages messages={run.messages} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The whole review's thread, open by default. Pinning an item opens it and scrolls to it. */
export function ReviewChatSection({ reviewId, prId }: { reviewId: number; prId: number }): JSX.Element {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement | null>(null);
  const registerChat = useReviewChatPins((s) => s.registerChat);
  const unregisterChat = useReviewChatPins((s) => s.unregisterChat);
  const focusTick = useReviewChatPins((s) => (s.focus?.prId === prId ? s.focus.tick : null));
  const lastTick = useRef<number | null>(focusTick);

  useEffect(() => {
    registerChat(prId, reviewId);
    return () => unregisterChat(prId, reviewId);
  }, [prId, reviewId, registerChat, unregisterChat]);

  useEffect(() => {
    if (focusTick == null || focusTick === lastTick.current) return;
    lastTick.current = focusTick;
    setOpen(true);
    // After the open renders.
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }, [focusTick]);

  return (
    <div ref={ref}>
      <ReviewSection
        title="Review chat"
        actions={
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            <CommentIcon size={13} />
            {open ? 'Hide' : 'Ask Claude about this review'}
            <ChevronIcon dir={open ? 'down' : 'right'} size={12} />
          </button>
        }
      >
        {open && (
          <>
            <ReviewChatThread reviewId={reviewId} findingId={null} prId={prId} />
            <EarlierChats prId={prId} reviewId={reviewId} />
          </>
        )}
      </ReviewSection>
    </div>
  );
}
