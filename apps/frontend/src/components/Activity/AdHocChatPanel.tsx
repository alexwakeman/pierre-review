import { useState } from 'react';
import {
  PRESET_PROMPTS,
  type DigestPrRef,
  type PinnedPrompt,
  type SprintChatHistoryItem,
} from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
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
// teammates in the scope — answered from the SAME data behind the Sprint summary. Two opt-in
// toggles: add a chart (a second, best-effort Haiku pass) and include bot-performance data. The
// current prompt can be pinned (server-stored per scope) and re-run later. Every answer is also
// persisted to the account's chat HISTORY (collapsible, paginated below) so past questions re-open
// for free. The live question + answer are held in the STORE (not component state) so they survive
// the Insights panel unmounting (e.g. clicking a PR then returning). Gated on the activityDigest
// capability exactly like the Sprint / preset surfaces — absent → nothing.

// Quick-question pills — the former "Sprint questions" presets + a sprint-report catch-all, folded
// into this one panel. Clicking a pill only PRE-FILLS the chat box (setDraft); the user presses Ask.
// So the three old surfaces (Sprint report card, preset carousel, chat) collapse to one, and the
// answers come from the single grounded chat endpoint. `label` is the pill caption, `question` the
// text loaded into the box.
const SPRINT_REPORT_PROMPT =
  'Give me a sprint status report: overall flow health, what needs attention now, the biggest changes shipped this sprint, and any blockers.';
const QUICK_QUESTIONS: { label: string; question: string }[] = [
  { label: 'Sprint report', question: SPRINT_REPORT_PROMPT },
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

// One past question in the collapsible history. Collapsed = the question + date; expanding shows
// the STORED answer (+ chart) with no re-run (free), plus a "Reuse question" that reloads it into
// the box for editing / re-asking.
function HistoryRow({
  item,
  expanded,
  onToggle,
  onOpenPr,
  onReuse,
}: {
  item: SprintChatHistoryItem;
  expanded: boolean;
  onToggle: () => void;
  onOpenPr: (r: DigestPrRef) => void;
  onReuse: () => void;
}): JSX.Element {
  return (
    <li className="rounded border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-2 px-2 py-1.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-900/40"
        aria-expanded={expanded}
      >
        <span className="mt-0.5 shrink-0 text-gray-400" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-200">
          {item.wantChart && <span aria-hidden="true">📊 </span>}
          {item.wantBots && <span aria-hidden="true">🤖 </span>}
          {item.question}
        </span>
        <span
          className="shrink-0 text-[10px] text-gray-400"
          title={new Date(item.createdAt).toLocaleString()}
        >
          {new Date(item.createdAt).toLocaleDateString()}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 px-3 py-2 dark:border-gray-800">
          <SummaryMarkdown markdown={item.answer} prRefs={item.prRefs} onOpenPr={onOpenPr} />
          {item.chart && (
            <div className="mt-2">
              <AdHocChart spec={item.chart} />
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onReuse}
              className="text-[10px] font-medium text-violet-600 hover:underline dark:text-violet-300"
              title="Load this question back into the box to edit or re-ask"
            >
              ↻ Reuse question
            </button>
            <span className="text-[10px] text-gray-400">
              {new Date(item.createdAt).toLocaleString()}
              {item.scope !== 'all' && ` · scope ${item.scope}`}
            </span>
          </div>
        </div>
      )}
    </li>
  );
}

export function AdHocChatPanel(): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const teamScope = useFilters((s) => s.teamScope);
  const scope = scopeToParam(teamScope);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);

  // Live chat state lives in the STORE so it survives this panel unmounting/remounting.
  const draft = useFilters((s) => s.sprintChatDraft);
  const setDraft = useFilters((s) => s.setSprintChatDraft);
  const storedResult = useFilters((s) => s.sprintChatResult);
  const setStoredResult = useFilters((s) => s.setSprintChatResult);
  const { question, wantChart, wantBots } = draft;

  // History panel (transient, session-local UI state — resets to collapsed on remount).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const chat = useSprintChat();
  const { data: candidates } = useScopeMentionCandidates(scope, activityDigest);
  const pinned = usePinnedPrompts(scope, activityDigest);
  const createPin = useCreatePinnedPrompt(scope);
  const deletePin = useDeletePinnedPrompt(scope);
  const history = useSprintChatHistory(historyPage, activityDigest && historyOpen);

  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.allowanceCredits != null && (usage.data.remainingCredits ?? 0) <= 0;

  // Absent the AI capability → render nothing (parity with RetroView).
  if (!activityDigest) return null;

  const trimmed = question.trim();
  const canAsk = trimmed !== '' && !chat.isPending && !outOfCredits;

  const ask = (q: string, chart: boolean, bots: boolean): void => {
    const text = q.trim();
    if (text === '' || outOfCredits) return;
    // Persist the answer into the store on success so it survives a remount; the mutation's own
    // data is component-local and would be lost when the panel unmounts.
    chat.mutate(
      { question: text, scope, wantChart: chart, wantBots: bots },
      { onSuccess: (data) => setStoredResult(data) },
    );
  };

  const runPinned = (p: PinnedPrompt): void => {
    setDraft({ question: p.text, wantChart: p.wantChart, wantBots: p.wantBots });
    ask(p.text, p.wantChart, p.wantBots);
  };

  const pinCurrent = (): void => {
    if (trimmed === '') return;
    createPin.mutate({ text: trimmed, wantChart, wantBots });
  };

  // The visible answer: the just-run mutation's data, else the last result kept in the store.
  const result = chat.data ?? storedResult;
  const answer = result?.answer ?? null;
  const pins = pinned.data?.prompts ?? [];
  // Don't offer to pin a question that's already saved verbatim for this scope.
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
        Pick a question below or type your own — answered from this scope&apos;s sprint data (runs
        the Haiku model). Type <span className="font-mono">@</span> to mention a teammate.
      </p>

      {/* Quick-question pills — pre-fill the box, then press Ask. These replace the separate Sprint
          report card + "Sprint questions" carousel. */}
      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="chat-quick-questions">
        {QUICK_QUESTIONS.map((qq) => (
          <button
            key={qq.label}
            type="button"
            onClick={() => setDraft({ question: qq.question })}
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
          title="Append Pierre's review-bot performance data (volume, acted-on %, noise, verdict) to the question"
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
          {result?.generatedAt && (
            <div className="mt-1.5 text-[10px] text-gray-400">
              Generated {new Date(result.generatedAt).toLocaleString()}
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
                    expanded={expandedId === it.id}
                    onToggle={() => setExpandedId((id) => (id === it.id ? null : it.id))}
                    onOpenPr={(r) => openPrDetailTab(refMeta(r), { fromActivity: true })}
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
