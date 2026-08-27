// The Bots "Advisor" inner tab (Pro `botAdvisor`) — the Bot Tuning Advisor's home. Findings
// arrive as deterministic INTENTS grouped per bot (evidence + retro-check + capability
// overlay); the outputs are a brief (the universal fallback, default until a tuning PR has
// merged), a config PR, or a GitHub issue against the bot's own repo. The Tune/Drop pills on
// the Bots table land here via `advisorFocus` (the panel's selected-bot filter — overwritten
// by the picker, never "corrected" back into the store).
//
// Like every non-Timeline Bots surface, this covers the WHOLE workspace — the repo picker
// never scopes it; the config-PR names its target repo explicitly.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type {
  AdvisorBotOverlay,
  AdvisorBotTotals,
  AdvisorIntentWire,
  AdvisorRecommendationWire,
  Repo,
} from '@pierre-review/shared';
import { useFilters } from '../../store/filters.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useRepos } from '../../hooks/useTimeline.js';
import {
  advisorConfigPrMutationKey,
  useAdvisorBrief,
  useAdvisorConfigPr,
  useAdvisorDismiss,
  useAdvisorEffect,
  useAdvisorFileIssue,
  useAdvisorFindings,
  useAdvisorPreview,
  useAdvisorPutProfile,
} from '../../hooks/useAdvisor.js';
import { automatedReviewerMeta } from '../../lib/ui.js';
import { BotIcon } from '../Icons.js';

const INTENT_LABEL: Record<string, string> = {
  SUPPRESS_PATH: 'Suppress path',
  QUIET_PATH_NITS: 'Quiet nits on path',
  SUPPRESS_CATEGORY: 'Suppress category',
  LOWER_VERBOSITY: 'Raise severity floor',
  SCOPE_OFF: 'Narrow overlap',
  AMPLIFY_PATH: 'Amplify path',
  ESCALATE: 'Escalate category',
  PROMOTE_TO_LINT: 'Promote to lint',
  BOOTSTRAP_CONFIG: 'Bootstrap config',
};

const STATUS_META: Record<string, { label: string; className: string }> = {
  dismissed: { label: 'Dismissed', className: 'bg-gray-500/10 text-gray-500 border border-gray-400/40' },
  pr_opened: { label: 'PR open', className: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/30' },
  pr_merged: { label: 'PR merged', className: 'bg-green-500/10 text-green-700 dark:text-green-300 border border-green-500/30' },
  issue_filed: { label: 'Issue filed', className: 'bg-ai-signal/10 text-ai-signal border border-ai-signal/30' },
  superseded: { label: 'Superseded', className: 'bg-gray-500/10 text-gray-500 border border-gray-400/40' },
};

function IntentCard({
  intent,
  rec,
  checked,
  onToggle,
  onDismiss,
}: {
  intent: AdvisorIntentWire;
  rec: AdvisorRecommendationWire | undefined;
  checked: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const e = intent.evidence;
  const status = rec ? STATUS_META[rec.status] : null;
  return (
    <div className="rounded-lg border border-gray-200 p-2.5 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={rec?.status === 'dismissed'}
          title="Include this recommendation in the output"
        />
        <span className="inline-block rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
          {INTENT_LABEL[intent.kind] ?? intent.kind}
        </span>
        <code className="text-[11px] text-gray-600 dark:text-gray-300">{intent.targetKey}</code>
        {status && (
          <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${status.className}`}>
            {status.label}
          </span>
        )}
        {rec?.prUrl && (
          <a
            href={rec.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-sky-600 hover:underline dark:text-sky-300"
          >
            PR #{rec.prNumber}
          </a>
        )}
        {rec?.issueUrl && (
          <a
            href={rec.issueUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-ai-signal hover:underline"
          >
            issue
          </a>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900/60"
          title="Record a dismissal — the recommendation stops resurfacing as new"
        >
          Dismiss
        </button>
      </div>
      <div className="mt-1.5 text-[11px] text-gray-600 dark:text-gray-300">{intent.rationale}</div>
      <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
        Evidence: {e.volume} {intent.kind === 'SUPPRESS_CATEGORY' || intent.kind === 'ESCALATE' ? 'findings' : 'threads'} ·{' '}
        {e.actedOn} acted on{e.threadLinked != null ? ` (of ${e.threadLinked} thread-linked)` : ''} · {e.untouched} untouched
        {(e.mergedUntouched ?? 0) > 0 ? ` (${e.mergedUntouched} merged past)` : ''} ·{' '}
        {e.overdueUntouched} overdue{e.dissent > 0 ? ` · ${e.dissent} pushback` : ''}
      </div>
      {intent.retro.applicable && (
        <div
          className={`mt-1 text-[11px] ${intent.retro.computable ? 'text-gray-500 dark:text-gray-400' : 'text-amber-700 dark:text-amber-300'}`}
          title={intent.retro.disclosure}
        >
          {intent.retro.computable
            ? `Retro-check: would also hide ${intent.retro.wouldHideActedOn} acted-on (${intent.retro.wouldHideActedOnHigh} high-severity) of ${intent.retro.wouldHideTotal}.`
            : 'Retro-check not computable — config PR blocked; use the brief.'}
        </div>
      )}
    </div>
  );
}

function EffectSection({ botUserId }: { botUserId: number }): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data, isLoading } = useAdvisorEffect(workspaceId, botUserId);
  if (isLoading) return <div className="text-[11px] text-gray-400">Loading effect panel…</div>;
  if (!data) return <div className="text-[11px] text-gray-400">No effect data.</div>;
  const { panel, anchors } = data;
  const fmt = (v: number | null): string => (v == null ? '—' : String(v));
  return (
    <div className="space-y-1.5 text-[11px] text-gray-600 dark:text-gray-300">
      {panel.anchor && panel.before && panel.after ? (
        <table className="border-collapse">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
              <th className="pr-3" />
              <th className="pr-3">Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className="pr-3">Volume / week</td><td className="pr-3">{fmt(panel.before.volumePerWeek)}</td><td>{fmt(panel.after.volumePerWeek)}</td></tr>
            <tr><td className="pr-3">Nit share %</td><td className="pr-3">{fmt(panel.before.nitSharePct)}</td><td>{fmt(panel.after.nitSharePct)}</td></tr>
            <tr><td className="pr-3">Acted-on %</td><td className="pr-3">{fmt(panel.before.actedOnPct)}</td><td>{fmt(panel.after.actedOnPct)}</td></tr>
            <tr><td className="pr-3">High-sev median (h)</td><td className="pr-3">{fmt(panel.before.highSeverityMedianHours)}</td><td>{fmt(panel.after.highSeverityMedianHours)}</td></tr>
          </tbody>
        </table>
      ) : panel.changepoints.length > 0 ? (
        <ul className="list-disc pl-4">
          {panel.changepoints.map((c) => (
            <li key={`${c.series}-${c.weekIndex}`}>
              {c.series}: {c.beforeMedian} → {c.afterMedian} around{' '}
              {panel.weekStarts[c.weekIndex]?.slice(0, 10)} ({c.direction}, unattributed — no
              recorded config change)
            </li>
          ))}
        </ul>
      ) : (
        <div>
          No anchor and no detected change — record a config change (or open a tuning PR) and
          this panel splits before/after around it.
        </div>
      )}
      {anchors.length > 0 && (
        <div className="text-[10px] text-gray-400">
          Anchors: {anchors.map((a) => `${new Date(a.ms).toISOString().slice(0, 10)} (${a.source})`).join(' · ')}
        </div>
      )}
    </div>
  );
}

function ProfileSection({
  bot,
  overlay,
}: {
  bot: AdvisorBotTotals;
  overlay: AdvisorBotOverlay | undefined;
}): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const put = useAdvisorPutProfile();
  const profile = overlay?.profile ?? null;
  const [configPath, setConfigPath] = useState(profile?.configPath ?? '');
  const [ownerRepo, setOwnerRepo] = useState(profile?.ownerRepo ?? '');
  const [notes, setNotes] = useState(profile?.notes ?? '');
  if (workspaceId == null) return <div />;
  return (
    <div className="space-y-1.5 text-[11px]">
      <div className="text-gray-500 dark:text-gray-400">
        Asked once, kept forever: where {bot.label} is configured and who owns it. The config
        path unlocks prose tuning for bots with no known adapter; the owner repo is where
        “File issue” sends the brief.
      </div>
      <label className="block">
        <span className="text-gray-500">Config file path (in your repo)</span>
        <input
          value={configPath}
          onChange={(e) => setConfigPath(e.target.value)}
          placeholder=".github/my-bot-prompt.md"
          className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-[11px] dark:border-gray-700 dark:bg-gray-950"
        />
      </label>
      <label className="block">
        <span className="text-gray-500">Bot's own repo (owner/name — the issue target)</span>
        <input
          value={ownerRepo}
          onChange={(e) => setOwnerRepo(e.target.value)}
          placeholder="acme/review-bot"
          className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-[11px] dark:border-gray-700 dark:bg-gray-950"
        />
      </label>
      <label className="block">
        <span className="text-gray-500">Notes</span>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-[11px] dark:border-gray-700 dark:bg-gray-950"
        />
      </label>
      <button
        type="button"
        disabled={put.isPending}
        onClick={() =>
          put.mutate({
            botUserId: bot.botUserId,
            body: {
              workspaceId,
              configPath: configPath.trim() || null,
              ownerRepo: ownerRepo.trim() || null,
              notes: notes.trim() || null,
            },
          })
        }
        className="rounded border border-sky-400 px-2 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-sky-50 dark:border-sky-600/70 dark:text-sky-300 dark:hover:bg-sky-950/40"
      >
        {put.isPending ? 'Saving…' : 'Save profile'}
      </button>
      {put.isError && (
        <div className="text-red-600 dark:text-red-400">{(put.error as Error).message}</div>
      )}
    </div>
  );
}

function BotSection({
  bot,
  overlay,
  intents,
  recsByKey,
  repos,
  firstPrMerged,
}: {
  bot: AdvisorBotTotals;
  overlay: AdvisorBotOverlay | undefined;
  intents: AdvisorIntentWire[];
  recsByKey: Map<string, AdvisorRecommendationWire>;
  repos: Repo[];
  firstPrMerged: boolean;
}): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const meta = automatedReviewerMeta(bot.kind);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  // Advisory-default-until-first-merged: the output selector defaults to Brief until a
  // pr_merged row exists in the workspace (client-side default, not a server block).
  const [output, setOutput] = useState<'brief' | 'pr' | 'issue'>(firstPrMerged ? 'pr' : 'brief');
  const [repoId, setRepoId] = useState<number | null>(repos[0]?.id ?? null);
  const [briefOpen, setBriefOpen] = useState(false);
  const dismiss = useAdvisorDismiss(workspaceId);
  const fileIssue = useAdvisorFileIssue(workspaceId);
  const configPr = useAdvisorConfigPr(workspaceId, bot.botUserId);
  const preview = useAdvisorPreview(workspaceId, bot.botUserId);
  const prRunning = useIsMutating({ mutationKey: advisorConfigPrMutationKey(bot.botUserId) }) > 0;

  const selectable = intents.filter((i) => recsByKey.get(i.dedupeKey)?.status !== 'dismissed');
  const selectedKeys = selectable
    .filter((i) => !excluded.has(i.dedupeKey))
    .map((i) => i.dedupeKey);

  // A rendered preview belongs to the exact (selection, repo) it was run with — clear it
  // when either changes rather than let a stale file view sit under new checkboxes.
  const previewSig = `${repoId ?? ''}|${[...selectedKeys].sort().join(',')}`;
  const previewSigRef = useRef(previewSig);
  const previewReset = preview.reset;
  useEffect(() => {
    if (previewSigRef.current !== previewSig) {
      previewSigRef.current = previewSig;
      previewReset();
    }
  }, [previewSig, previewReset]);
  const brief = useAdvisorBrief(
    workspaceId,
    bot.botUserId,
    selectedKeys,
    briefOpen && selectedKeys.length > 0,
  );
  const hasAdapter = overlay?.adapterKey != null;
  const ownerRepo = overlay?.profile?.ownerRepo ?? null;
  const prBlocked = selectable.some(
    (i) =>
      selectedKeys.includes(i.dedupeKey) && i.retro.applicable && !i.retro.computable,
  );
  const lastPr = configPr.data ?? null;

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium"
          style={{ color: meta.color, background: `${meta.color}1a` }}
        >
          <BotIcon size={11} />
          {bot.label}
        </span>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          {hasAdapter
            ? `${overlay!.adapterName} · ${overlay!.configTargets.map((t) => t.path).join(', ')}`
            : 'no config surface known — the brief is the output'}
        </span>
        {bot.pathCoveragePct != null && (
          <span
            className="text-[10px] text-gray-400"
            title="Only review-comment labels can carry a file path; path-keyed findings describe only this share of the bot's scored output."
          >
            path coverage {bot.pathCoveragePct}%
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        {intents.map((intent) => (
          <IntentCard
            key={intent.dedupeKey}
            intent={intent}
            rec={recsByKey.get(intent.dedupeKey)}
            checked={selectedKeys.includes(intent.dedupeKey)}
            onToggle={() =>
              setExcluded((prev) => {
                const next = new Set(prev);
                if (next.has(intent.dedupeKey)) next.delete(intent.dedupeKey);
                else next.add(intent.dedupeKey);
                return next;
              })
            }
            onDismiss={() => dismiss.mutate(intent.dedupeKey)}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2 dark:border-gray-800/60">
        <div role="tablist" className="flex gap-1">
          {(
            [
              { key: 'brief', label: 'Brief' },
              ...(hasAdapter ? [{ key: 'pr', label: 'Config PR' } as const] : []),
              { key: 'issue', label: 'File issue' },
            ] as const
          ).map((o) => (
            <button
              key={o.key}
              type="button"
              // Brief is the one output that costs nothing (a deterministic DB read), so
              // selecting it RENDERS it — a selector that only highlighted itself read as a
              // dead button, since Brief is also the default mode.
              onClick={() => {
                setOutput(o.key);
                if (o.key === 'brief') setBriefOpen(true);
              }}
              title={
                o.key === 'brief'
                  ? 'Render the selected recommendations as a markdown brief (nothing is stored or posted)'
                  : undefined
              }
              className={`rounded border px-2 py-0.5 text-[11px] font-medium ${
                output === o.key
                  ? 'border-sky-400 text-sky-700 dark:border-sky-600/70 dark:text-sky-300'
                  : 'border-gray-300 text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900/60'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {output === 'brief' && briefOpen && selectedKeys.length === 0 && (
          <span className="text-[11px] text-gray-400">
            Select at least one recommendation to render.
          </span>
        )}
        {output === 'brief' && briefOpen && brief.isFetching && (
          <span className="text-[11px] text-gray-400">Rendering…</span>
        )}

        {output === 'pr' && hasAdapter && (
          <>
            {repos.length > 1 && (
              <select
                value={repoId ?? ''}
                onChange={(e) => setRepoId(Number(e.target.value))}
                className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-gray-700 dark:bg-gray-950"
                title="The repo whose config the PR edits"
              >
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              disabled={preview.isPending || selectedKeys.length === 0 || repoId == null || prBlocked}
              title={
                prBlocked
                  ? 'A selected suppression has no computable retro-check — the config PR (and its preview) is blocked; use the brief.'
                  : 'Dry-run: show the exact config file(s) the PR would commit, without writing anything'
              }
              onClick={() => {
                if (repoId == null) return;
                preview.mutate({ repoId, botUserId: bot.botUserId, dedupeKeys: selectedKeys });
              }}
              className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 disabled:opacity-50 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900/60"
            >
              {preview.isPending ? 'Previewing…' : 'Preview changes'}
            </button>
            <button
              type="button"
              disabled={prRunning || selectedKeys.length === 0 || repoId == null || prBlocked}
              title={
                prBlocked
                  ? 'A selected suppression has no computable retro-check — the config PR is blocked; use the brief.'
                  : 'Open a PR with the additive config change (reviewed before merge — nothing auto-applies)'
              }
              onClick={() => {
                if (repoId == null) return;
                configPr.mutate({ repoId, botUserId: bot.botUserId, dedupeKeys: selectedKeys });
              }}
              className="rounded border border-sky-400 px-2 py-0.5 text-[11px] font-medium text-sky-700 disabled:opacity-50 dark:border-sky-600/70 dark:text-sky-300"
            >
              {prRunning ? 'Opening PR…' : 'Open config PR'}
            </button>
          </>
        )}

        {output === 'issue' && (
          <button
            type="button"
            disabled={fileIssue.isPending || selectedKeys.length === 0 || !ownerRepo}
            title={
              ownerRepo
                ? `Files the brief as an issue on ${ownerRepo}`
                : "Set the bot's own repo in its profile first"
            }
            onClick={() => {
              const key = selectedKeys[0];
              if (key) fileIssue.mutate(key);
            }}
            className="rounded border border-ai-border px-2 py-0.5 text-[11px] font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2 disabled:opacity-50"
          >
            {fileIssue.isPending ? 'Filing…' : `File issue${ownerRepo ? ` → ${ownerRepo}` : ''}`}
          </button>
        )}
      </div>

      {lastPr && (
        <div className="rounded border border-green-500/30 bg-green-500/5 px-2 py-1.5 text-[11px] text-green-700 dark:text-green-300">
          Opened{' '}
          <a href={lastPr.url} target="_blank" rel="noreferrer" className="underline">
            PR #{lastPr.prNumber}
          </a>
          {/* The visible/threadId copy contract: the PR IS on GitHub; a failed confirming
              sync must read as "shortly", never as an error, and never offer a retry. */}
          {lastPr.visible ? '.' : " — it'll show up here shortly."}
        </div>
      )}
      {configPr.isError && (
        <div className="text-[11px] text-red-600 dark:text-red-400">
          {(configPr.error as Error).message}
        </div>
      )}
      {output === 'pr' && preview.isError && (
        <div className="text-[11px] text-red-600 dark:text-red-400">
          Preview failed: {(preview.error as Error).message}
        </div>
      )}
      {output === 'pr' && preview.data && (
        <div className="space-y-2">
          <div className="text-[11px] text-gray-500 dark:text-gray-400">
            Would open <span className="font-medium">{preview.data.title}</span> on branch{' '}
            <code>{preview.data.branch}</code> — nothing has been written yet.
          </div>
          <div className="flex flex-wrap gap-1.5">
            {preview.data.applied.map((a, i) => (
              <span
                key={`${a.intentKind}-${a.targetKey}-${i}`}
                title={a.note}
                className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  a.status === 'applied'
                    ? 'bg-green-500/10 text-green-700 dark:text-green-300'
                    : a.status === 'degraded'
                      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      : 'bg-gray-500/10 text-gray-500'
                }`}
              >
                {INTENT_LABEL[a.intentKind] ?? a.intentKind} · {a.status}
              </span>
            ))}
          </div>
          {preview.data.files.map((f) => (
            <div key={f.path} className="space-y-1">
              <div className="flex items-center gap-2">
                <code className="text-[11px] font-medium text-gray-700 dark:text-gray-200">
                  {f.path}
                </code>
                <span className="text-[10px] text-gray-400">
                  {f.before == null
                    ? 'new file'
                    : 'edits the existing file — additive; nothing outside our entries changes'}
                </span>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(f.after)}
                  title="Copy the generated file content"
                  className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900/60"
                >
                  Copy
                </button>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-gray-50 p-2 text-[11px] text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
                {f.after}
              </pre>
            </div>
          ))}
        </div>
      )}
      {fileIssue.isError && (
        <div className="text-[11px] text-red-600 dark:text-red-400">
          {(fileIssue.error as Error).message}
        </div>
      )}
      {fileIssue.data && (
        <div className="text-[11px] text-ai-signal">
          Filed{' '}
          <a href={fileIssue.data.issueUrl} target="_blank" rel="noreferrer" className="underline">
            {fileIssue.data.issueUrl}
          </a>
        </div>
      )}

      {output === 'brief' && briefOpen && brief.isError && (
        <div className="text-[11px] text-red-600 dark:text-red-400">
          Brief failed: {(brief.error as Error).message}
        </div>
      )}
      {output === 'brief' && briefOpen && brief.data && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              Brief (markdown)
            </span>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(brief.data?.markdown ?? '')}
              title="Copy the markdown — paste it into a doc, a Slack thread, or the bot vendor's support form"
              className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900/60"
            >
              Copy
            </button>
          </div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-gray-50 p-2 text-[11px] text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
            {brief.data.markdown}
          </pre>
        </div>
      )}

      <details>
        <summary className="cursor-pointer text-[11px] text-gray-500 dark:text-gray-400">
          Effect panel (before/after a config change)
        </summary>
        <div className="mt-1.5">
          <EffectSection botUserId={bot.botUserId} />
        </div>
      </details>
      <details>
        <summary className="cursor-pointer text-[11px] text-gray-500 dark:text-gray-400">
          Profile{overlay?.profile ? '' : ' (unanswered)'}
        </summary>
        <div className="mt-1.5">
          <ProfileSection bot={bot} overlay={overlay} />
        </div>
      </details>
    </div>
  );
}

export function BotAdvisorPanel(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const advisorFocus = useFilters((s) => s.advisorFocus);
  const clearAdvisorFocus = useFilters((s) => s.clearAdvisorFocus);
  const { botAdvisor } = useProCapabilities();
  const { data, isLoading, error } = useAdvisorFindings(workspaceId, botAdvisor);
  const { data: allRepos } = useRepos();
  const repos = useMemo(
    () => (allRepos ?? []).filter((r) => r.workspaceId === workspaceId),
    [allRepos, workspaceId],
  );
  const [pickedBotKey, setPickedBotKey] = useState<string | null>(null);
  // Focus (from the Tune/Drop pills) wins until the user picks; picking clears the focus.
  const selectedBotKey = advisorFocus?.botKey ?? pickedBotKey;

  if (!botAdvisor) return <div />;
  if (isLoading) {
    return <div className="p-3 text-xs text-gray-400">Computing advisor findings…</div>;
  }
  if (error || !data) {
    return (
      <div className="p-3 text-xs text-red-600 dark:text-red-400">
        Advisor findings unavailable{error ? `: ${(error as Error).message}` : ''}.
      </div>
    );
  }

  const intentsByBot = new Map<number, AdvisorIntentWire[]>();
  for (const intent of data.intents) {
    const arr = intentsByBot.get(intent.botUserId) ?? [];
    arr.push(intent);
    intentsByBot.set(intent.botUserId, arr);
  }
  const recsByKey = new Map(data.recommendations.map((r) => [r.dedupeKey, r]));
  const overlayByBot = new Map(data.overlays.map((o) => [o.botUserId, o]));
  const botsWithIntents = data.payload.bots.filter((b) => intentsByBot.has(b.botUserId));
  const firstPrMerged = data.recommendations.some((r) => r.status === 'pr_merged');
  const visibleBots = selectedBotKey
    ? botsWithIntents.filter((b) => b.key === selectedBotKey)
    : botsWithIntents;
  const focusBot = advisorFocus
    ? data.payload.bots.find((b) => b.key === advisorFocus.botKey)
    : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Evidence-backed configuration changes per bot — deterministic findings over{' '}
          {data.payload.window.kind === 'rolling_30' ? 'the trailing 30 days' : 'the window'}.
          Nothing auto-applies.
        </div>
        <div className="ml-auto flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => {
              setPickedBotKey(null);
              clearAdvisorFocus();
            }}
            className={`rounded border px-2 py-0.5 text-[11px] ${
              selectedBotKey == null
                ? 'border-sky-400 text-sky-700 dark:border-sky-600/70 dark:text-sky-300'
                : 'border-gray-300 text-gray-500 dark:border-gray-700 dark:text-gray-400'
            }`}
          >
            All bots
          </button>
          {botsWithIntents.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => {
                setPickedBotKey(b.key);
                clearAdvisorFocus();
              }}
              className={`rounded border px-2 py-0.5 text-[11px] ${
                selectedBotKey === b.key
                  ? 'border-sky-400 text-sky-700 dark:border-sky-600/70 dark:text-sky-300'
                  : 'border-gray-300 text-gray-500 dark:border-gray-700 dark:text-gray-400'
              }`}
            >
              {b.label} · {intentsByBot.get(b.botUserId)?.length ?? 0}
            </button>
          ))}
        </div>
      </div>

      {advisorFocus?.intent === 'drop' && focusBot && (
        <div className="rounded-lg border border-red-300/60 bg-red-50/50 p-2.5 text-[11px] text-red-800 dark:border-red-800/60 dark:bg-red-950/20 dark:text-red-300">
          Considering dropping {focusBot.label}? Over this window: {focusBot.threads} threads,{' '}
          {focusBot.actedOn} acted on, {focusBot.untouched} untouched (
          {focusBot.overdueUntouched} overdue). The suppress and overlap findings below are
          the evidence — the brief is the deliverable to bring to that discussion.
        </div>
      )}

      {visibleBots.length === 0 && (
        <div className="rounded-lg border border-gray-200 p-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
          {selectedBotKey
            ? 'No advisor findings for this bot in the current window — its evidence is under the cell floors.'
            : 'No advisor findings in the current window. Findings appear once a bot crosses the evidence floors (5 threads per path cell, 20 scored findings per category cell).'}
        </div>
      )}

      {visibleBots.map((bot) => (
        <BotSection
          key={bot.key}
          bot={bot}
          overlay={overlayByBot.get(bot.botUserId)}
          intents={intentsByBot.get(bot.botUserId) ?? []}
          recsByKey={recsByKey}
          repos={repos}
          firstPrMerged={firstPrMerged}
        />
      ))}
    </div>
  );
}
