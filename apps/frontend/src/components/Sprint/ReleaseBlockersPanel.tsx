import { aiProviderOfModel, type ReleaseBlockersPrRef, type ReleaseBlockersState, type ReleaseBlockersTicketRef, type ReleaseCheckResult } from '@pierre-review/shared';
import { useAiCapabilities, useAiProviderName } from '../../hooks/useAiCapabilities.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import { useExplainBlockers, useExplainingBlockers } from '../../hooks/useReleases.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { AiRunGate } from '../AiSetup.js';
import { AiStatusLine } from '../AiStatusLine.js';
import { RefreshIcon, SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { FOCUS_RING } from '../ui/cx.js';
import { blockersPanelShown, blockersReportMeta } from './releasesModel.js';

// "EXPLAIN WHAT'S BLOCKING" on This Sprint → Releases (docs/RELEASES.md § Explain what's blocking).
//
//   • An AI surface: VISIBLE only while `me.ai.enabled` (and the check carries its state); the run button
//     sits inside the ONE `AiRunGate kind="complete"` (a one-shot completion; the gate asks before a
//     run over the spend budget, a reader's press is never refused).
//   • The button shows only while something newer is blocked (HIDE, never disable). Nothing runs on mount
//     or on its own: the stored report arrives with GET /api/releases, "Out of date" when the check changed.
//   • The report: a headline, the steps in order (each with what it unlocks and its tickets and PRs as
//     links — every data-derived URL through `safeExternalUrl`), and one line per repository.

export function ReleaseBlockersPanel({
  workspaceId,
  state,
  check,
}: {
  workspaceId: number;
  state: ReleaseBlockersState | null | undefined;
  check: ReleaseCheckResult;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  const aiName = useAiProviderName();
  const costText = useRunCostText();
  const run = useExplainBlockers(workspaceId);
  const busy = useExplainingBlockers(workspaceId);
  if (!blockersPanelShown(ai.enabled, state)) return null;
  const report = state!.report;
  const meta = report != null ? blockersReportMeta(report, costText(report.costUsd, report.model != null ? aiProviderOfModel(report.model) : report.provider)) : null;

  return (
    <section aria-label="What's blocking" data-testid="release-blockers" className="space-y-2 rounded-ui bg-ai-surface p-3 ring-1 ring-ai-border">
      <div className="flex flex-wrap items-center gap-2">
        <SparkleIcon size={12} className="text-ai-signal" />
        <h3 className="text-body font-semibold text-ui-ink">What&rsquo;s blocking</h3>
        <InfoButton title="Explain what's blocking">
          <p>
            {aiName} reads the release check on this page — the tags that cannot be released, the tickets that hold them and
            their pull requests — and writes the order to do things in to reach a newer release.
          </p>
          <p>It reads nothing else and changes nothing. It names only tickets and pull requests that are in the check: anything else it names is left out.</p>
          <p>It runs only when you press the button. “Out of date” means the check changed since it was written.</p>
        </InfoButton>
        {report != null && state!.stale && (
          <span className="rounded-ui bg-ui-raise px-1.5 py-0.5 text-meta font-medium text-ui-warn" data-testid="release-blockers-stale">
            Out of date
          </span>
        )}
        {state!.explainable && (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <AiRunGate kind="complete">
              <Button
                size="sm"
                variant="secondary"
                icon={report != null ? <RefreshIcon size={12} /> : <SparkleIcon size={12} />}
                busy={busy}
                busyLabel="Explaining…"
                onClick={() => run.mutate()}
                data-testid="release-blockers-run"
              >
                {report != null ? 'Explain again' : 'Explain what’s blocking'}
              </Button>
            </AiRunGate>
          </span>
        )}
      </div>
      {busy && <AiStatusLine stage="Reading the release check" />}
      {run.isError && !busy && <p className="text-meta text-ui-danger">{run.error.message}</p>}
      {report != null && (
        <div className="space-y-2" data-testid="release-blockers-report">
          <p className="text-body text-ui-ink">{report.headline}</p>
          {report.steps.length > 0 && (
            <ol className="list-decimal space-y-1.5 pl-5 text-body text-ui-ink">
              {report.steps.map((s, i) => (
                <li key={i}>
                  <span>{s.text}</span>
                  {s.unlocks != null && <span className="text-ui-mute"> Unlocks {s.unlocks}.</span>}
                  {(s.tickets.length > 0 || s.prs.length > 0) && (
                    <span className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-meta">
                      {s.tickets.map((t) => (
                        <TicketRef key={t.key} t={t} />
                      ))}
                      {s.prs.map((p) => (
                        <PrRef key={`${p.repoName}#${p.number}`} p={p} check={check} />
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
          {report.repos.length > 0 && (
            <ul className="space-y-0.5 text-meta">
              {report.repos.map((r) => (
                <li key={r.repoName}>
                  <span className="font-medium text-ui-ink">{r.repoName}</span> <span className="text-ui-mute">{r.text}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-meta text-ui-mute">{meta}</p>
        </div>
      )}
    </section>
  );
}

const LINK = `rounded-ui font-medium text-ui-ink hover:underline ${FOCUS_RING}`;

function TicketRef({ t }: { t: ReleaseBlockersTicketRef }): JSX.Element {
  const href = t.url != null ? safeExternalUrl(t.url) : null;
  if (href == null) return <span className="font-medium text-ui-ink">{t.key}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={LINK} title={t.title ?? undefined}>
      {t.key}
    </a>
  );
}

/** "web #518": the PR tab when the PR is stored, else GitHub. */
function PrRef({ p, check }: { p: ReleaseBlockersPrRef; check: ReleaseCheckResult }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const label = `${p.repoName} #${p.number}`;
  const repo = check.repos.find((r) => r.name === p.repoName);
  if (p.prId == null || repo == null) {
    const href = safeExternalUrl(p.url);
    return href != null ? (
      <a href={href} target="_blank" rel="noreferrer noopener" className={LINK} title={p.title ?? undefined}>
        {label}
      </a>
    ) : (
      <span className="font-medium text-ui-ink">{label}</span>
    );
  }
  const prId = p.prId;
  return (
    <button
      type="button"
      title={p.title ?? undefined}
      onClick={() =>
        openPrDetailTab(
          { id: prId, number: p.number, title: p.title ?? '', repoFullName: repo.fullName, authorLogin: null, authorDisplayName: null, authorAvatarUrl: null },
          { fromActivity: true },
        )
      }
      className={LINK}
    >
      {label}
    </button>
  );
}

