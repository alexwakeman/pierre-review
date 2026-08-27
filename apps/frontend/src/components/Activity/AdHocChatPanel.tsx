import { useEffect, useRef, useState } from 'react';
import {
  SPRINT_CHAT_MAX_TURNS,
  type DigestPrRef,
  type PinnedPrompt,
  type SprintChatHistoryItem,
  type SprintChatResponse,
} from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { workspaceKey } from '../../hooks/useActivity.js';
import { useFilters, type SprintChatTurn } from '../../store/filters.js';
import { describeAnswerWindow, INSIGHTS_RANGE_LABEL } from '../../lib/insightsRange.js';
import {
  useSprintChat,
  useSprintChatHistory,
  useScopeMentionCandidates,
  usePinnedPrompts,
  useCreatePinnedPrompt,
  useDeletePinnedPrompt,
  CHAT_HISTORY_PAGE_SIZE,
} from '../../hooks/useSprintChat.js';
import { reportModelLabel } from '../../hooks/usePeriodReports.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { MentionTextarea } from '../MentionTextarea.js';
import {
  BotIcon,
  ChartIcon,
  ChevronIcon,
  CloseIcon,
  CommentIcon,
  PinIcon,
  RefreshIcon,
} from '../Icons.js';
import { SummaryMarkdown } from './prRefTable.js';
import { AdHocChart } from './AdHocChart.js';
import { suggestionGroups } from './adHocChatModel.js';

// The ad-hoc "Ask about the sprint" box (Pro — answered by the account's configured report
// model; the optional chart is still a second Haiku pass). A free-text question — with
// @-mentions of people in the active Workspace — answered from the SAME data behind the Sprint
// summary, as a real CONVERSATION: completed turns render oldest→newest in a transcript above
// the input, each follow-up ask sends the prior turns as `history` so "the second one" resolves,
// and the model may propose ≤3 digit-free follow-up chips per answer (server-validated — D4).
// Depth is capped at SPRINT_CHAT_MAX_TURNS Q&A pairs; at the cap the input locks behind a
// "Start a new conversation" affordance (the server-side history rows persist — the thread is
// the live view, not the record). The current prompt can be pinned (server-stored per Workspace)
// and re-run later. Every answer is also persisted to the account's chat HISTORY (collapsible,
// paginated below) so past questions re-open for free; picking one seeds a fresh 1-turn
// transcript that the next ask continues from. The live draft + per-workspace threads are held
// in the STORE (not component state) so they survive the Insights panel unmounting (e.g.
// clicking a PR then returning) — including a turn still IN FLIGHT when that happens: the
// append (and the composer clear) run in useSprintChat's hook-level onSuccess, which outlives
// both this component and chat.reset(). Gated on the activityDigest capability exactly like the
// Sprint / preset surfaces — absent → nothing.

// Stable empty thread so the store selector returns an identical reference for workspaces with
// no conversation (a fresh [] per render would defeat zustand's equality check).
const EMPTY_THREAD: SprintChatTurn[] = [];

function refMeta(ref: DigestPrRef): PinnedPr {
  return {
    id: ref.prId as number,
    number: ref.prNumber,
    title: ref.title ?? `#${ref.prNumber}`,
    repoFullName: ref.repoFullName,
    authorLogin: ref.authorLogin,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

function ChatSkeleton(): JSX.Element {
  return (
    <div className="space-y-1.5 py-0.5" aria-hidden="true">
      <div className="digest-skeleton-line h-3.5" style={{ width: '42%' }} />
      {['94%', '88%', '72%'].map((w, i) => (
        <div key={i} className="digest-skeleton-line h-3" style={{ width: w }} />
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title: string;
}): JSX.Element {
  return (
    <label
      className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300"
      title={title}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-gray-300 text-ai-signal focus:ring-ai-signal dark:border-gray-600"
      />
      {label}
    </label>
  );
}

// The user's side of one transcript turn: a compact right-aligned row. Truncated — the full
// question is in the title — because the ANSWER is the content; the question is orientation.
function QuestionRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[85%] truncate rounded-md bg-ai-surface-2 px-2.5 py-1 text-xs text-ai-ink"
        title={text}
      >
        {text}
      </div>
    </div>
  );
}

// One completed turn: the question row + the answer card (markdown, chart, caption). The caption
// is PER TURN — window, generated time, answering model — so a transcript legitimately spanning
// two report periods (the reader switched reports mid-conversation) stays honest: every answer
// names what IT covered, not what the chips say now.
function TranscriptTurn({
  turn,
  onOpenPr,
}: {
  turn: SprintChatTurn;
  onOpenPr: (r: DigestPrRef) => void;
}): JSX.Element {
  const r = turn.response;
  const answerWindow = describeAnswerWindow(r.window);
  const caption = [
    answerWindow,
    r.generatedAt ? `Generated ${new Date(r.generatedAt).toLocaleString()}` : null,
    r.model != null ? reportModelLabel(r.model) : null,
  ]
    .filter((p): p is string => p != null)
    .join(' · ');
  const trimmed = r.trimmedTurns ?? 0;
  return (
    <div>
      <QuestionRow text={turn.question} />
      <div className="digest-fade-in mt-1.5 rounded-md border border-ai-hairline bg-white/60 p-3 dark:bg-gray-900/40">
        <SummaryMarkdown markdown={r.answer ?? ''} prRefs={r.prRefs ?? []} onOpenPr={onOpenPr} />
        {r.chart && (
          <div className="mt-3">
            <AdHocChart spec={r.chart} />
          </div>
        )}
        {caption !== '' && <div className="mt-1.5 text-[10px] text-gray-400">{caption}</div>}
        {/* The server dropped prior turns (depth cap and/or token budget) for THIS answer — say
            so, or a reference the model visibly missed reads as a model failure. */}
        {trimmed > 0 && (
          <div className="mt-0.5 text-[10px] italic text-gray-400">
            The model couldn&apos;t see the {trimmed} earliest turn{trimmed === 1 ? '' : 's'} for
            this answer.
          </div>
        )}
      </div>
    </div>
  );
}

// One past question in the history. Clicking the row seeds a FRESH 1-turn transcript from its
// STORED answer (+ chart) — free, no re-run — and the row is marked as the current selection.
// A secondary "↻ Reuse" reloads the question into the box for editing / re-asking.
function HistoryRow({
  item,
  selected,
  onSelect,
  onReuse,
}: {
  item: SprintChatHistoryItem;
  selected: boolean;
  onSelect: () => void;
  onReuse: () => void;
}): JSX.Element {
  return (
    <li
      className={`flex items-stretch overflow-hidden rounded border ${
        selected
          ? 'border-sky-400 bg-sky-50 ring-1 ring-sky-400 dark:border-sky-500 dark:bg-sky-950/30 dark:ring-sky-500'
          : 'border-gray-200 dark:border-gray-800'
      }`}
    >
      {/* No scope tooltip: the history query is keyed to the active Workspace (`ws:<id>`), so every
          row in this list was already grounded in it. The old `item.scope !== 'all'` title read the
          deleted 'all' sentinel and could only ever be noise here. */}
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-900/40"
        aria-current={selected}
      >
        <span className="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-200">
          {item.wantChart && <ChartIcon size={12} className="mr-1 inline-block align-[-0.1em]" />}
          {item.wantBots && <BotIcon size={12} className="mr-1 inline-block align-[-0.1em]" />}
          {item.question}
        </span>
        {/* The range this row was answered over. Once the range is selectable, two rows with the
            SAME question text can be answers about different periods — the transcript is ambiguous
            without it. Rows stored before ranges shipped carry no window and show nothing. */}
        {item.window && (
          <span
            className="shrink-0 rounded bg-gray-100 px-1 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400"
            title={describeAnswerWindow(item.window) ?? undefined}
          >
            {INSIGHTS_RANGE_LABEL[item.window.kind]}
          </span>
        )}
        <span
          className="shrink-0 text-[10px] text-gray-400"
          title={new Date(item.createdAt).toLocaleString()}
        >
          {new Date(item.createdAt).toLocaleDateString()}
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onReuse();
        }}
        className="shrink-0 border-l border-gray-200 px-2 text-[10px] font-medium text-ai-signal hover:bg-ai-signal/10 hover:underline dark:border-gray-800"
        title="Load this question back into the box to edit or re-ask"
      >
        <RefreshIcon size={10} className="mr-1 inline-block align-[-0.1em]" />
        Reuse
      </button>
    </li>
  );
}

// C5: the panel's ONE mount is now inside PeriodReportsPanel's "Ask about this period" section
// (the Insights Overview sub-tab is gone). The props exist for that mount:
//  • `periodWindow` — the VIEWED report's exact `[fromMs, toMs)`. Threaded into `useSprintChat`,
//    which sends it as `SprintChatBody.window`, so the grounding covers the period on screen
//    instead of a trailing window ending now (the FilterBar Range chips are then bypassed).
//  • `periodLabel` — the report's date-range title, used in the header copy so the panel says
//    which period it answers about.
//  • `suggestedQuestions` — extra pills the caller derives (client-side templated from the
//    report's own significant deltas; the numbers in them are computed, never model-authored).
//    Rendered as their own labelled "From this report" group ahead of the built-ins.
// All optional: with none of them the panel behaves exactly as the old standalone chat did.
export function AdHocChatPanel({
  periodWindow,
  periodLabel,
  suggestedQuestions,
}: {
  periodWindow?: { fromMs: number; toMs: number } | null;
  periodLabel?: string | null;
  suggestedQuestions?: { label: string; question: string }[];
} = {}): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  // The ACTIVE WORKSPACE is the whole scope — a plain id, no sentinel, nothing to canonicalise.
  // `scopeKey` (`ws:<id>`) is only ever a CLIENT-SIDE Record key (the per-workspace thread stashed
  // in the store); the wire scope is stamped by the hooks below, which take the id itself. It MUST
  // come from `workspaceKey`, not a hand-rolled `String(workspaceId)` — that is the same
  // vocabulary the plugin persists in `scope_key`, so a legacy '3' can never alias workspace 3.
  const workspaceId = useFilters((s) => s.workspaceId);
  const scopeKey = workspaceKey(workspaceId);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);

  // Live chat state lives in the STORE so it survives this panel unmounting/remounting.
  const draft = useFilters((s) => s.sprintChatDraft);
  const setDraft = useFilters((s) => s.setSprintChatDraft);
  const thread = useFilters((s) => s.sprintChatThreads[scopeKey]) ?? EMPTY_THREAD;
  // Turn APPENDS happen in useSprintChat's hook-level onSuccess (they must survive this panel
  // unmounting and chat.reset()); the panel only seeds/clears whole threads.
  const setThread = useFilters((s) => s.setSprintChatThread);
  const { question, wantChart, wantBots } = draft;

  // History panel (transient, session-local UI state — resets to collapsed on remount).
  const [historyOpen, setHistoryOpen] = useState(false);
  // Whether the built-in "Quick questions" group is expanded MID-CONVERSATION (it always renders
  // expanded while the thread is empty — the pills ARE the first-run invitation). Transient
  // local state, and the collapsed default is DERIVED per render from thread.length, never
  // written back.
  const [builtinsOpen, setBuiltinsOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  // Which past question seeded the current transcript (marks the row). Null = the transcript is
  // a live conversation, not a picked history item.
  const [selectedHistoryId, setSelectedHistoryId] = useState<number | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader is at (or near) the transcript's bottom, tracked CONTINUOUSLY via
  // onScroll — it must be read as it stood BEFORE new content grew scrollHeight, so it cannot
  // be computed inside the effect below.
  const stickToBottomRef = useRef(true);

  // Every hook here takes the WORKSPACE ID and stamps the wire scope itself — the panel cannot
  // forget it, and an unscoped generation (which the server would answer for the account's Default)
  // is unrepresentable rather than merely discouraged.
  const chat = useSprintChat(workspaceId, periodWindow);
  const { data: candidates } = useScopeMentionCandidates(workspaceId, activityDigest);
  const pinned = usePinnedPrompts(workspaceId, activityDigest);
  const createPin = useCreatePinnedPrompt(workspaceId);
  const deletePin = useDeletePinnedPrompt(workspaceId);
  const history = useSprintChatHistory(historyPage, workspaceId, activityDigest && historyOpen);

  // Everything in this panel is keyed to the active Workspace. When it changes: reset the history
  // page (so you don't land on an out-of-range page of the previous context), and clear the
  // transient mutation UI (a stale error / in-flight state) + the history-row selection — the
  // transcript itself is already per-workspace (sprintChatThreads[scopeKey]), so a switch shows
  // THIS Workspace's conversation or nothing, never the previous one's. reset() only detaches
  // the OBSERVER: an in-flight answer still completes into its ask-time workspace's thread via
  // the hook-level onSuccess, so switching mid-ask discards no billed turn.
  useEffect(() => {
    setHistoryPage(0);
    chat.reset();
    setSelectedHistoryId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;

  // Keep the newest turn (or the pending skeleton) in view: plain-DOM scroll of the transcript's
  // own container — the timeline scroll gate does not apply here. STICKY, not unconditional: it
  // pins only when the reader was already near the bottom, so scrolling up to re-read earlier
  // turns during a long (Sonnet-length) wait isn't yanked away when the answer lands. The ask
  // itself still scrolls — the container mounts pinned, and the programmatic scroll re-arms the
  // ref via its own scroll event.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [thread.length, chat.isPending]);

  // When a past question is picked, bring the (now-reseeded) transcript into view so the user
  // sees the content that replaced whatever was there. Keyed on the selection id so it fires
  // once per pick, after the store update has committed the transcript DOM.
  useEffect(() => {
    if (selectedHistoryId != null) {
      transcriptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedHistoryId]);

  // Absent the AI capability → render nothing (parity with the other Pro panels).
  if (!activityDigest) return null;

  const trimmed = question.trim();
  const atCap = thread.length >= SPRINT_CHAT_MAX_TURNS;
  // `workspaceId != null` is part of the gate, not a nicety: this is the BILLING path, and an
  // unscoped Ask would be grounded in the account's Default workspace and then stashed under the
  // `ws:pending` key — a plausible-looking answer about repos the user isn't looking at.
  const canAsk =
    trimmed !== '' && workspaceId != null && !chat.isPending && !outOfCredits && !atCap;

  const ask = (q: string, chart: boolean, bots: boolean): void => {
    const text = q.trim();
    if (text === '' || workspaceId == null || chat.isPending || outOfCredits || atCap) return;
    // A fresh Ask continues the LIVE conversation; any picked-history marking is superseded
    // (the seeded turn stays — the ask continues FROM it).
    setSelectedHistoryId(null);
    // A SEND always scrolls (chat convention — show the question + skeleton); only arrivals
    // respect where the reader has scrolled to.
    stickToBottomRef.current = true;
    // No `scope`/`history` here on purpose — `useSprintChat` stamps both (the scope from the
    // workspace id it was given, the history from this workspace's live thread at call time),
    // and the mutation variable's type makes that structural. NO mutate-level onSuccess either:
    // the completed turn is appended (and the draft cleared) by the HOOK's own onSuccess under
    // the ask-time workspace key — a mutate-scoped callback dies with the observer (chat.reset()
    // on a workspace switch, or this panel unmounting mid-flight), which would silently drop a
    // billed answer from the live transcript.
    chat.mutate({ question: text, wantChart: chart, wantBots: bots });
  };

  // Seed a FRESH 1-turn transcript from a past question's STORED answer (free — no re-run). It
  // REPLACES any live transcript — the same destructive semantics the single-answer replace had,
  // and every replaced turn is already individually in the server history. The next ask
  // CONTINUES from the seeded turn. No follow-up chips (they are never persisted). An answer
  // still in flight is NOT discarded: the hook-level onSuccess appends it when it lands (after
  // the seed / into the emptied thread) — a billed turn always reaches the live view.
  const selectHistory = (item: SprintChatHistoryItem): void => {
    const mapped: SprintChatResponse = {
      enabled: true,
      answer: item.answer,
      prRefs: item.prRefs,
      chart: item.chart,
      window: item.window,
      model: item.model ?? undefined,
      generatedAt: item.createdAt,
    };
    chat.reset();
    setThread(scopeKey, [{ question: item.question, response: mapped }]);
    setSelectedHistoryId(item.id);
  };

  // Clear the live thread + draft question (toggles kept — they are preferences). The server's
  // history rows are untouched: each turn was persisted at answer time, so the durable record
  // survives; only the live view resets.
  const newConversation = (): void => {
    chat.reset();
    setThread(scopeKey, []);
    setDraft({ question: '' });
    setSelectedHistoryId(null);
  };

  const runPinned = (p: PinnedPrompt): void => {
    setDraft({ question: p.text, wantChart: p.wantChart, wantBots: p.wantBots });
    ask(p.text, p.wantChart, p.wantBots);
  };

  // A suggestion / follow-up pill: fill the box AND fire the Ask immediately (respecting the
  // current chart/bots toggles), so clicking one submits as the next turn without a separate
  // Ask press.
  const runQuick = (qq: { question: string }): void => {
    setDraft({ question: qq.question });
    ask(qq.question, wantChart, wantBots);
  };

  const latest = thread[thread.length - 1];
  // The pinnable prompt: the box text — or, box empty (it clears when an answer lands), the
  // newest turn's question, so the natural ask-then-pin flow needs no retyping.
  const pinnable = trimmed !== '' ? trimmed : latest?.question.trim() ?? '';
  const pinCurrent = (): void => {
    if (pinnable === '') return;
    createPin.mutate({ text: pinnable, wantChart, wantBots });
  };

  const pins = pinned.data?.prompts ?? [];
  // Don't offer to pin a question that's already saved verbatim for this Workspace.
  const alreadyPinned = pinnable !== '' && pins.some((p) => p.text === pinnable);
  // Follow-up chips belong to the NEWEST answer only — an older turn's suggestions were asks
  // about a conversation state that no longer exists.
  const followUps = latest?.response.followUps ?? [];
  const pillsDisabled = chat.isPending || outOfCredits || atCap;

  const historyItems = history.data?.items ?? [];
  const historyTotal = history.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(historyTotal / CHAT_HISTORY_PAGE_SIZE));

  return (
    <div
      className="rounded-lg border border-ai-border bg-ai-surface p-4"
      data-testid="adhoc-chat-panel"
    >
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <CommentIcon size={15} className="inline-block align-[-0.1em]" />{' '}
          {periodLabel != null ? 'Ask about this period' : 'Ask about the sprint'}
        </span>
        <span className="shrink-0 rounded bg-ai-signal/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ai-signal">
          Pro
        </span>
        {thread.length > 0 && (
          <button
            type="button"
            onClick={newConversation}
            className="ml-auto shrink-0 text-[11px] font-medium text-gray-500 hover:text-gray-700 hover:underline dark:text-gray-400 dark:hover:text-gray-200"
            title="Clear this conversation and start over (your questions stay in History)"
          >
            New conversation
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {periodLabel != null ? (
          <>
            Pick a question below or type your own — answered from this Workspace&apos;s data over{' '}
            <span className="font-medium">{periodLabel}</span>, the period shown above (runs your
            configured report model). Follow-ups continue the conversation. Type{' '}
            <span className="font-mono">@</span> to mention someone.
          </>
        ) : (
          <>
            Pick a question below or type your own — answered from this Workspace&apos;s sprint
            data (runs your configured report model). Follow-ups continue the conversation. Type{' '}
            <span className="font-mono">@</span> to mention someone.
          </>
        )}
      </p>

      {/* The transcript — completed turns oldest→newest, so the newest sits adjacent to the
          input below. The pending ask renders as a provisional newest item. Scrolls in its own
          container (auto-pinned to the bottom); the follow-up chips ride inside it, under the
          last answer. */}
      {(thread.length > 0 || chat.isPending) && (
        <div
          ref={transcriptRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="mt-3 max-h-[28rem] space-y-3 overflow-y-auto pr-0.5"
          data-testid="chat-transcript"
        >
          {thread.map((turn, i) => (
            <TranscriptTurn
              key={`${i}:${turn.response.generatedAt ?? ''}`}
              turn={turn}
              onOpenPr={(r) => openPrDetailTab(refMeta(r), { fromActivity: true })}
            />
          ))}
          {chat.isPending && (
            <div>
              {chat.variables?.question != null && <QuestionRow text={chat.variables.question} />}
              <div className="mt-1.5 rounded-md border border-ai-hairline bg-white/60 p-3 dark:bg-gray-900/40">
                <ChatSkeleton />
              </div>
            </div>
          )}
          {/* Hidden while an ask is pending, for the same newest-answer-only reason: rendered
              below the skeleton they would read as suggestions for the INCOMING answer, and
              they are asks about a conversation state that is being superseded. */}
          {!chat.isPending && followUps.length > 0 && (
            <div data-testid="chat-follow-ups">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Follow up
              </div>
              <div className="flex flex-wrap gap-1.5">
                {/* Model-proposed, server-validated digit-free (D4) — filled pills so "continue
                    the thread" reads differently from the outlined suggestion groups below. */}
                {followUps.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => runQuick({ question: f })}
                    disabled={pillsDisabled}
                    className="rounded-full bg-ai-signal px-2.5 py-0.5 text-left text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50 dark:text-gray-950"
                    title={f}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Two labelled suggestion groups — the report's own delta pills (only when the caller
          passed some, i.e. a report is on screen) visually distinct from the generic built-ins.
          Clicking either fills the box AND fires the Ask as the next turn. Once a conversation
          exists the BUILT-INS collapse behind their caption: ~3-4 wrapped pill rows between the
          newest answer and the composer dilute the reply↔input adjacency, and mid-conversation
          the conversation-relevant sets are the report pills and the follow-up chips. */}
      {suggestionGroups(suggestedQuestions).map((g) => {
        const collapsible = g.key === 'builtin' && thread.length > 0;
        const open = !collapsible || builtinsOpen;
        return (
          <div
            key={g.key}
            className="mt-2"
            data-testid={g.key === 'report' ? 'chat-report-questions' : 'chat-quick-questions'}
          >
            {collapsible ? (
              <button
                type="button"
                onClick={() => setBuiltinsOpen((o) => !o)}
                className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                aria-expanded={open}
              >
                <ChevronIcon dir={open ? 'down' : 'right'} size={10} />
                {g.title}
              </button>
            ) : (
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                {g.title}
              </div>
            )}
            {open && (
              <div className="flex flex-wrap gap-1.5">
                {g.pills.map((qq) => (
                  <button
                    key={qq.label}
                    type="button"
                    onClick={() => runQuick(qq)}
                    disabled={pillsDisabled}
                    className={
                      g.key === 'report'
                        ? 'rounded-full border border-sky-300 bg-sky-50/80 px-2.5 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-200 dark:hover:bg-sky-950/50'
                        : 'rounded-full border border-ai-border bg-white/70 px-2.5 py-0.5 text-[11px] font-medium text-ai-signal hover:bg-ai-surface-2 disabled:opacity-50 dark:bg-gray-900/50'
                    }
                    title={qq.question}
                  >
                    {qq.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {chat.isError && (
        <div className="mt-2 text-[11px] text-red-500">
          {(chat.error as Error)?.message ?? 'Couldn’t answer that — try again.'}
        </div>
      )}
      {/* Throttle / credit shapes never enter the transcript — they render as transient notices
          off the mutation's own data (lost on remount, which is fine for a notice). */}
      {chat.data?.throttled && (
        <div className="mt-2 text-[11px] text-gray-400">
          A question is already running — try again in a moment.
        </div>
      )}
      {(chat.data?.creditsExhausted || outOfCredits) && (
        <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          Out of AI credits this month — questions resume on the 1st.
        </div>
      )}

      {/* The depth cap: the input locks rather than silently dropping oldest turns forever —
          past SPRINT_CHAT_MAX_TURNS pairs the oldest context is gone from every answer anyway,
          so a fresh start is the honest continuation. */}
      {atCap && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50/60 px-2.5 py-1.5 text-[11px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
          <span>
            This conversation is at its {SPRINT_CHAT_MAX_TURNS}-question limit.
          </span>
          <button
            type="button"
            onClick={newConversation}
            className="rounded border border-amber-400 px-2 py-0.5 font-semibold hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-950/40"
          >
            Start a new conversation
          </button>
        </div>
      )}

      <div className="mt-3">
        <MentionTextarea
          candidates={candidates}
          value={question}
          onChange={(v) => setDraft({ question: v })}
          rows={3}
          disabled={atCap}
          ariaLabel="Ask a question about the sprint"
          placeholder="e.g. What did @alex ship this sprint? Which reviews are stuck?"
          className="w-full resize-y rounded-md border border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-ai-signal focus:outline-none focus:ring-1 focus:ring-ai-signal disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter submits (the picker owns a bare Enter while open).
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canAsk) {
              e.preventDefault();
              ask(question, wantChart, wantBots);
            }
          }}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Toggle
          checked={wantChart}
          onChange={(v) => setDraft({ wantChart: v })}
          label="Add a chart"
          title="Also generate a chart for the answer when one fits (a second Haiku pass)"
        />
        <Toggle
          checked={wantBots}
          onChange={(v) => setDraft({ wantBots: v })}
          label="Include bot performance"
          title="Append Limn's review-bot performance data (volume, acted-on %, noise, verdict) to the question"
        />
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={pinCurrent}
            disabled={pinnable === '' || createPin.isPending || alreadyPinned}
            className="rounded border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-600 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
            title={
              alreadyPinned
                ? 'Already pinned'
                : trimmed === '' && pinnable !== ''
                  ? 'Pin the last question to re-run later'
                  : 'Pin this prompt to re-run later'
            }
          >
            <PinIcon size={11} className="mr-1 inline-block align-[-0.1em]" />
            {alreadyPinned ? 'Pinned' : 'Pin'}
          </button>
          <button
            type="button"
            onClick={() => ask(question, wantChart, wantBots)}
            disabled={!canAsk}
            className="rounded bg-ai-signal px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50 dark:text-gray-950"
            title={
              atCap
                ? `This conversation is at its ${SPRINT_CHAT_MAX_TURNS}-question limit — start a new one`
                : outOfCredits
                  ? 'Out of AI credits — resets next month'
                  : 'Ask (runs your configured report model)'
            }
          >
            {chat.isPending ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </div>

      {/* Saved prompts — click a chip to re-run it; ✕ removes it. */}
      {pins.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            Pinned
          </div>
          <div className="flex flex-wrap gap-1.5">
            {pins.map((p) => (
              <span
                key={p.id}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-ai-border bg-white/70 py-0.5 pl-2 pr-1 text-[11px] text-ai-ink dark:bg-gray-900/50"
              >
                <button
                  type="button"
                  onClick={() => runPinned(p)}
                  disabled={pillsDisabled}
                  className="max-w-[22rem] truncate text-left hover:underline disabled:opacity-50"
                  title={`Re-run: ${p.text}`}
                >
                  {p.wantChart && (
                    <ChartIcon size={11} className="mr-1 inline-block align-[-0.1em]" />
                  )}
                  {p.wantBots && <BotIcon size={11} className="mr-1 inline-block align-[-0.1em]" />}
                  {p.text}
                </button>
                <button
                  type="button"
                  onClick={() => deletePin.mutate(p.id)}
                  className="rounded-full px-1 text-gray-400 hover:text-red-500"
                  title="Remove this pinned prompt"
                  aria-label="Remove pinned prompt"
                >
                  <CloseIcon />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* History — collapsible, paginated (10/page). Stored answers re-open for free (no AI). */}
      <div className="mt-4 border-t border-ai-hairline pt-3">
        <button
          type="button"
          onClick={() => setHistoryOpen((o) => !o)}
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          aria-expanded={historyOpen}
        >
          <ChevronIcon dir={historyOpen ? 'down' : 'right'} />
          History
          {historyTotal > 0 && <span className="text-gray-400">· {historyTotal}</span>}
        </button>

        {historyOpen && (
          <div className="mt-2">
            {history.isLoading ? (
              <div className="py-1 text-[11px] text-gray-400">Loading…</div>
            ) : historyItems.length === 0 ? (
              <div className="py-1 text-[11px] text-gray-400">No past questions yet.</div>
            ) : (
              <ul className="space-y-1">
                {historyItems.map((it) => (
                  <HistoryRow
                    key={it.id}
                    item={it}
                    selected={selectedHistoryId === it.id}
                    onSelect={() => selectHistory(it)}
                    onReuse={() =>
                      setDraft({
                        question: it.question,
                        wantChart: it.wantChart,
                        wantBots: it.wantBots,
                      })
                    }
                  />
                ))}
              </ul>
            )}

            {historyTotal > CHAT_HISTORY_PAGE_SIZE && (
              <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400">
                <button
                  type="button"
                  onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}
                  disabled={historyPage === 0}
                  className="rounded border border-gray-300 px-2 py-0.5 font-medium hover:border-gray-400 disabled:opacity-40 dark:border-gray-700 dark:hover:border-gray-500"
                >
                  <ChevronIcon dir="left" size={11} className="mr-1 inline-block align-[-0.1em]" />
                  Newer
                </button>
                <span className="tabular-nums">
                  Page {historyPage + 1} of {pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setHistoryPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={historyPage + 1 >= pageCount}
                  className="rounded border border-gray-300 px-2 py-0.5 font-medium hover:border-gray-400 disabled:opacity-40 dark:border-gray-700 dark:hover:border-gray-500"
                >
                  Older
                  <ChevronIcon dir="right" size={11} className="ml-1 inline-block align-[-0.1em]" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
