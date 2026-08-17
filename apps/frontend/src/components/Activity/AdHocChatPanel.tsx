import { useEffect, useRef, useState } from 'react';
import {
  PRESET_PROMPTS,
  type DigestPrRef,
  type PinnedPrompt,
  type SprintChatHistoryItem,
  type SprintChatResponse,
} from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { workspaceKey } from '../../hooks/useActivity.js';
import { useFilters } from '../../store/filters.js';
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
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { MentionTextarea } from '../MentionTextarea.js';
import { SummaryMarkdown } from './prRefTable.js';
import { AdHocChart } from './AdHocChart.js';

// The ad-hoc "Ask about the sprint" box (Pro Haiku). A free-text question — with @-mentions of
// people in the active Workspace — answered from the SAME data behind the Sprint summary. Two opt-in
// toggles: add a chart (a second, best-effort Haiku pass) and include bot-performance data. The
// current prompt can be pinned (server-stored per Workspace) and re-run later. Every answer is also
// persisted to the account's chat HISTORY (collapsible, paginated below) so past questions re-open
// for free. The live question + answer are held in the STORE (not component state) so they survive
// the Insights panel unmounting (e.g. clicking a PR then returning). Gated on the activityDigest
// capability exactly like the Sprint / preset surfaces — absent → nothing.

// Quick-question pills — the former "Sprint questions" presets plus two catch-alls (sprint report,
// retro), folded into this one panel. So the four old surfaces (Sprint report card, preset carousel,
// the Retro sub-tab, chat) collapse to one, and every answer comes from the single grounded chat
// endpoint. `label` is the pill caption, `question` the text loaded into the box.
const SPRINT_REPORT_PROMPT =
  'Give me a sprint status report: overall flow health, what needs attention now, the biggest changes shipped this sprint, and any blockers.';
// The retrospective catch-all — this REPLACES the deleted Insights "Retro" sub-tab, its route and
// its own `retro_reports` cache. Paired with the sprint report as the two catch-alls: that one is
// forward-looking ("what needs attention now"), this one backward-looking ("what just happened").
//
// It asks for a short narrative followed by ONE GFM pipe table of the retro items — the renderer
// (SummaryMarkdown/parseBlocks) parses pipe tables into a real table in PrTable's visual shell,
// with owner/name#N refs in cells still linkifying. The Category vocabulary is pinned in the
// prompt (shipped / went well / dragged / CI) so rows stay scannable across runs.
//
// It deliberately asks ONLY for what the chat's grounding payload actually holds — merged PRs,
// flow metrics, CI failure reasons, attention items. NOT themes or sentiment: those needed the
// retro's own 50-item corpus of raw comment/review bodies, which buildChatPayload has no
// equivalent of, so asking would just trip CHAT_SYSTEM's "the JSON doesn't hold the answer"
// decline and burn a third of a ~200-word answer. Discussion themes live in the Feed's Pro
// "Themes" tab instead.
//
// Frontend-LOCAL const, exactly like SPRINT_REPORT_PROMPT and for the same reason — NOT an entry
// in shared's PRESET_PROMPTS. A new PresetPromptKey is consumed by the plugin as two EXHAUSTIVE
// Record<PresetPromptKey, string> maps (PRESET_QUESTIONS + a bespoke per-key system prompt), so
// it would be an immediate compile error in packages/pro plus a new cache-row kind and a new
// independent throttle/billing path — for a pill that only needs to prefill the chat box.
// ⚠ Every pill prompt must stay ≤500 chars — the server's MAX_QUESTION truncates SILENTLY, and a
// mid-sentence cut would ship a live mispowered pill with no error anywhere.
const RETRO_PROMPT =
  'Give me a retrospective of this sprint: start with a short narrative summary (2-3 sentences), then ONE GitHub-flavoured markdown pipe table of the retro items with columns Item | Category | PRs | Note. Category is one of: shipped, went well, dragged, CI. Put PR references in the PRs column as plain owner/name#N.';
// The workspace-orientation catch-all: what is this set of repos FOR, and what is it busy with
// right now. Grounded in the payload's `repos` map (each repo's GitHub "About" description — the
// only real purpose text the payload carries) plus the merged/open PR activity.
const WORKSPACE_ABOUT_PROMPT =
  'What does this workspace do, and what are its latest priorities? Using the repo descriptions and recent PR activity in the JSON, give one line per repository on its purpose, then a short list of the current priorities and themes across the workspace.';
const QUICK_QUESTIONS: { label: string; question: string }[] = [
  { label: 'Sprint report', question: SPRINT_REPORT_PROMPT },
  { label: 'Retro', question: RETRO_PROMPT },
  { label: 'About this Workspace', question: WORKSPACE_ABOUT_PROMPT },
  ...PRESET_PROMPTS.map((p) => ({ label: p.label, question: p.question })),
];

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
        className="h-3.5 w-3.5 rounded border-gray-300 text-violet-600 focus:ring-violet-400 dark:border-gray-600"
      />
      {label}
    </label>
  );
}

// One past question in the history. Clicking the row loads its STORED answer (+ chart) into the
// main answer panel at the TOP of this component (free — no re-run), and the row is marked as the
// current selection. A secondary "↻ Reuse" reloads the question into the box for editing / re-asking.
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
          {item.wantChart && <span aria-hidden="true">📊 </span>}
          {item.wantBots && <span aria-hidden="true">🤖 </span>}
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
        className="shrink-0 border-l border-gray-200 px-2 text-[10px] font-medium text-violet-600 hover:bg-violet-50 hover:underline dark:border-gray-800 dark:text-violet-300 dark:hover:bg-violet-950/30"
        title="Load this question back into the box to edit or re-ask"
      >
        ↻ Reuse
      </button>
    </li>
  );
}

export function AdHocChatPanel(): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  // The ACTIVE WORKSPACE is the whole scope — a plain id, no sentinel, nothing to canonicalise.
  // `scopeKey` (`ws:<id>`) is only ever a CLIENT-SIDE Record key (the per-workspace answer stashed
  // in the store); the wire scope is stamped by the hooks below, which take the id itself. It MUST
  // come from `workspaceKey`, not a hand-rolled `String(workspaceId)` — that is the same
  // vocabulary the plugin persists in `scope_key`, so a legacy '3' can never alias workspace 3.
  const workspaceId = useFilters((s) => s.workspaceId);
  const scopeKey = workspaceKey(workspaceId);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);

  // Live chat state lives in the STORE so it survives this panel unmounting/remounting.
  const draft = useFilters((s) => s.sprintChatDraft);
  const setDraft = useFilters((s) => s.setSprintChatDraft);
  const storedResult = useFilters((s) => s.sprintChatResults[scopeKey] ?? null);
  const setStoredResult = useFilters((s) => s.setSprintChatResult);
  const { question, wantChart, wantBots } = draft;

  // History panel (transient, session-local UI state — resets to collapsed on remount).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  // Which past question is currently loaded into the TOP answer panel (marks the row). Null = the
  // top panel is showing a live/last Ask, not a picked history item.
  const [selectedHistoryId, setSelectedHistoryId] = useState<number | null>(null);
  const answerRef = useRef<HTMLDivElement | null>(null);

  // Every hook here takes the WORKSPACE ID and stamps the wire scope itself — the panel cannot
  // forget it, and an unscoped generation (which the server would answer for the account's Default)
  // is unrepresentable rather than merely discouraged.
  const chat = useSprintChat(workspaceId);
  const { data: candidates } = useScopeMentionCandidates(workspaceId, activityDigest);
  const pinned = usePinnedPrompts(workspaceId, activityDigest);
  const createPin = useCreatePinnedPrompt(workspaceId);
  const deletePin = useDeletePinnedPrompt(workspaceId);
  const history = useSprintChatHistory(historyPage, workspaceId, activityDigest && historyOpen);

  // Everything in this panel is keyed to the active Workspace. When it changes: reset the history
  // page (so you don't land on an out-of-range page of the previous context), and clear the
  // transient mutation UI (a stale error / in-flight state) + the history-row selection — the
  // answer itself is already per-workspace (sprintChatResults[scopeKey]), so a switch shows THIS
  // Workspace's answer or nothing, never the previous one's.
  useEffect(() => {
    setHistoryPage(0);
    chat.reset();
    setSelectedHistoryId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;

  // When a past question is picked, scroll the (now-replaced) top answer panel into view so the
  // user sees the content that replaced whatever was there. Keyed on the selection id so it fires
  // once per pick, after the store update has committed the answer DOM.
  useEffect(() => {
    if (selectedHistoryId != null) {
      answerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedHistoryId]);

  // Absent the AI capability → render nothing (parity with the other Pro panels).
  if (!activityDigest) return null;

  const trimmed = question.trim();
  // `workspaceId != null` is part of the gate, not a nicety: this is the BILLING path, and an
  // unscoped Ask would be grounded in the account's Default workspace and then stashed under the
  // `ws:pending` key — a plausible-looking answer about repos the user isn't looking at.
  const canAsk = trimmed !== '' && workspaceId != null && !chat.isPending && !outOfCredits;

  const ask = (q: string, chart: boolean, bots: boolean): void => {
    const text = q.trim();
    if (text === '' || workspaceId == null || outOfCredits) return;
    // A fresh Ask supersedes any picked history item, so the top panel shows the live answer.
    setSelectedHistoryId(null);
    // Persist the answer into the store on success so it survives a remount; the mutation's own
    // data is component-local and would be lost when the panel unmounts.
    chat.mutate(
      // No `scope` here on purpose — `useSprintChat` stamps it from the workspace id it was given,
      // and the mutation variable's type (`Omit<SprintChatBody,'scope'>`) makes that structural.
      { question: text, wantChart: chart, wantBots: bots },
      // Mirror the answer into the per-workspace store so it survives a remount AND is the single
      // source the panel reads (keyed to the Workspace it was asked in).
      { onSuccess: (data) => setStoredResult(scopeKey, data) },
    );
  };

  // Load a past question's STORED answer into the TOP answer panel (free — no re-run). Map the
  // history item to the response shape and stash it under the current Workspace; reset() clears any
  // stale error/in-flight banner from a prior Ask.
  const selectHistory = (item: SprintChatHistoryItem): void => {
    const mapped: SprintChatResponse = {
      enabled: true,
      answer: item.answer,
      prRefs: item.prRefs,
      chart: item.chart,
      model: item.model ?? undefined,
      generatedAt: item.createdAt,
    };
    chat.reset();
    setStoredResult(scopeKey, mapped);
    setSelectedHistoryId(item.id);
  };

  const runPinned = (p: PinnedPrompt): void => {
    setDraft({ question: p.text, wantChart: p.wantChart, wantBots: p.wantBots });
    ask(p.text, p.wantChart, p.wantBots);
  };

  // A quick-question pill: fill the box AND fire the Ask immediately (respecting the current
  // chart/bots toggles), so clicking a preset submits without a separate Ask press.
  const runQuick = (qq: { question: string }): void => {
    setDraft({ question: qq.question });
    ask(qq.question, wantChart, wantBots);
  };

  const pinCurrent = (): void => {
    if (trimmed === '') return;
    createPin.mutate({ text: trimmed, wantChart, wantBots });
  };

  // The visible answer for THIS Workspace. onSuccess mirrors each answer into
  // sprintChatResults[scopeKey], so the per-workspace store entry is the single source — a switch
  // shows that Workspace's answer (or nothing), never the previous one's, and there is no stale
  // mutation-data flash.
  const result = storedResult;
  const answer = result?.answer ?? null;
  // null for an answer that predates ranges (or a stale persisted one) — the caption is then simply
  // absent rather than captioned with a window nobody chose.
  const answerWindow = describeAnswerWindow(result?.window);
  const pins = pinned.data?.prompts ?? [];
  // Don't offer to pin a question that's already saved verbatim for this Workspace.
  const alreadyPinned = pins.some((p) => p.text === trimmed);

  const historyItems = history.data?.items ?? [];
  const historyTotal = history.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(historyTotal / CHAT_HISTORY_PAGE_SIZE));

  return (
    <div
      className="rounded-lg border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-900/60 dark:bg-violet-950/20"
      data-testid="adhoc-chat-panel"
    >
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <span aria-hidden="true">💬</span> Ask about the sprint
        </span>
        <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Pick a question below or type your own — answered from this Workspace&apos;s sprint data
        (runs the Haiku model). Type <span className="font-mono">@</span> to mention someone.
      </p>

      {/* Quick-question pills — clicking one fills the box AND fires the Ask immediately. These
          replace the separate Sprint report card + "Sprint questions" carousel. */}
      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="chat-quick-questions">
        {QUICK_QUESTIONS.map((qq) => (
          <button
            key={qq.label}
            type="button"
            onClick={() => runQuick(qq)}
            className="rounded-full border border-violet-300 bg-white/70 px-2.5 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-800 dark:bg-gray-900/50 dark:text-violet-200 dark:hover:bg-violet-950/40"
            title={qq.question}
          >
            {qq.label}
          </button>
        ))}
      </div>

      <div className="mt-3">
        <MentionTextarea
          candidates={candidates}
          value={question}
          onChange={(v) => setDraft({ question: v })}
          rows={3}
          ariaLabel="Ask a question about the sprint"
          placeholder="e.g. What did @alex ship this sprint? Which reviews are stuck?"
          className="w-full resize-y rounded-md border border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
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
            disabled={trimmed === '' || createPin.isPending || alreadyPinned}
            className="rounded border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-600 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
            title={alreadyPinned ? 'Already pinned' : 'Pin this prompt to re-run later'}
          >
            <span aria-hidden="true">📌</span> {alreadyPinned ? 'Pinned' : 'Pin'}
          </button>
          <button
            type="button"
            onClick={() => ask(question, wantChart, wantBots)}
            disabled={!canAsk}
            className="rounded bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            title={outOfCredits ? 'Out of AI credits — resets next month' : 'Ask (runs the Haiku model)'}
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
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-violet-300 bg-white/70 py-0.5 pl-2 pr-1 text-[11px] text-violet-700 dark:border-violet-800 dark:bg-gray-900/50 dark:text-violet-200"
              >
                <button
                  type="button"
                  onClick={() => runPinned(p)}
                  disabled={chat.isPending || outOfCredits}
                  className="max-w-[22rem] truncate text-left hover:underline disabled:opacity-50"
                  title={`Re-run: ${p.text}`}
                >
                  {p.wantChart && <span aria-hidden="true">📊 </span>}
                  {p.wantBots && <span aria-hidden="true">🤖 </span>}
                  {p.text}
                </button>
                <button
                  type="button"
                  onClick={() => deletePin.mutate(p.id)}
                  className="rounded-full px-1 text-gray-400 hover:text-red-500"
                  title="Remove this pinned prompt"
                  aria-label="Remove pinned prompt"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {chat.isError && (
        <div className="mt-2 text-[11px] text-red-500">
          {(chat.error as Error)?.message ?? 'Couldn’t answer that — try again.'}
        </div>
      )}
      {result?.throttled && (
        <div className="mt-2 text-[11px] text-gray-400">
          A question is already running — try again in a moment.
        </div>
      )}
      {(result?.creditsExhausted || outOfCredits) && (
        <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          Out of AI credits this month — questions resume on the 1st.
        </div>
      )}

      {/* The answer. */}
      {chat.isPending ? (
        <div className="mt-3 rounded-md border border-violet-200/70 bg-white/60 p-3 dark:border-violet-900/50 dark:bg-gray-900/40">
          <ChatSkeleton />
        </div>
      ) : answer != null ? (
        <div
          ref={answerRef}
          key={result?.generatedAt}
          className="digest-fade-in mt-3 rounded-md border border-violet-200/70 bg-white/60 p-3 dark:border-violet-900/50 dark:bg-gray-900/40"
        >
          <SummaryMarkdown
            markdown={answer}
            prRefs={result?.prRefs ?? []}
            onOpenPr={(r) => openPrDetailTab(refMeta(r), { fromActivity: true })}
          />
          {result?.chart && (
            <div className="mt-3">
              <AdHocChart spec={result.chart} />
            </div>
          )}
          {/* The window this answer COVERED — not the chips' current position. The two diverge the
              moment someone changes the range without re-asking, and the answer on screen is still
              about its own period. */}
          {(result?.generatedAt || answerWindow) && (
            <div className="mt-1.5 text-[10px] text-gray-400">
              {answerWindow}
              {answerWindow && result?.generatedAt && ' · '}
              {result?.generatedAt && `Generated ${new Date(result.generatedAt).toLocaleString()}`}
            </div>
          )}
        </div>
      ) : null}

      {/* History — collapsible, paginated (10/page). Stored answers re-open for free (no AI). */}
      <div className="mt-4 border-t border-violet-200/60 pt-3 dark:border-violet-900/40">
        <button
          type="button"
          onClick={() => setHistoryOpen((o) => !o)}
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          aria-expanded={historyOpen}
        >
          <span aria-hidden="true">{historyOpen ? '▾' : '▸'}</span>
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
                  ← Newer
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
                  Older →
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
