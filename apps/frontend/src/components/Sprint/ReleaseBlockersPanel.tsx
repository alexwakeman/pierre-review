import {
  aiProviderOfModel,
  releaseBlockersRefLabel,
  releaseBlockersSegments,
  type ReleaseBlockersPrRef,
  type ReleaseBlockersRef,
  type ReleaseBlockersState,
  type ReleaseBlockersTicketRef,
  type ReleaseCheckResult,
} from '@pierre-review/shared';
import { useAiCapabilities, useAiProviderName } from '../../hooks/useAiCapabilities.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import { useExplainBlockers, useExplainingBlockers } from '../../hooks/useReleases.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { AiRunGate } from '../AiSetup.js';
import { AiStatusLine } from '../AiStatusLine.js';
import { ExternalLinkIcon, RefreshIcon, SparkleIcon } from '../Icons.js';
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
//   • The report: a headline, the steps in the plan's order, and one line per repository. Each text carries
//     `{id}`s, drawn INLINE (shared `releaseBlockersSegments`): a ticket opens its STORY view in the app
//     (`useOpenStory`; the tracker link is a small icon beside it), a pull request its PR tab (else GitHub),
//     a ticket only the tracker names its tracker page; a release point is plain text. Every data-derived
//     URL goes through `safeExternalUrl`.

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
            Ensemble works out from the release check which work unlocks which newer release, and the order to do it in.{' '}
            {aiName} then explains that plan in plain words.
          </p>
          <p>It reads nothing else and changes nothing. It names only tickets and pull requests that are in the check: anything else it names is left out.</p>
          <p>A ticket opens its story here; the small arrow beside it opens the tracker. A pull request opens its tab.</p>
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
          {report.headline != null && (
            <p className="text-body text-ui-ink">
              <RefText text={report.headline} refs={report.refs} check={check} />
            </p>
          )}
          {report.steps.length > 0 && (
            <ol className="list-decimal space-y-1.5 pl-5 text-body text-ui-ink">
              {report.steps.map((s, i) => (
                <li key={i}>
                  <RefText text={s.text} refs={report.refs} check={check} />
                </li>
              ))}
            </ol>
          )}
          {report.repos.length > 0 && (
            <ul className="space-y-0.5 text-meta">
              {report.repos.map((r) => (
                <li key={r.repoName}>
                  <span className="font-medium text-ui-ink">{r.repoName}</span>{' '}
                  <span className="text-ui-mute">
                    <RefText text={r.text} refs={report.refs} check={check} />
                  </span>
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

const LINK = `rounded-ui font-medium text-ui-ink underline underline-offset-2 hover:no-underline ${FOCUS_RING}`;

/** A report text with its `{id}`s drawn as INLINE links (shared `releaseBlockersSegments`). */
function RefText({ text, refs, check }: { text: string; refs: Record<string, ReleaseBlockersRef>; check: ReleaseCheckResult }): JSX.Element {
  return (
    <>
      {releaseBlockersSegments(text, refs).map((seg, i) =>
        seg.kind === 'text' ? (
          <span key={i}>{seg.text}</span>
        ) : seg.ref.kind === 'ticket' ? (
          <TicketLink key={i} t={seg.ref} />
        ) : seg.ref.kind === 'pr' ? (
          <PrLink key={i} p={seg.ref} check={check} />
        ) : (
          <span key={i} className="font-medium">
            {releaseBlockersRefLabel(seg.ref)}
          </span>
        ),
      )}
    </>
  );
}

/** A ticket: its STORY view in the app (`useOpenStory`), the tracker link a small icon beside it. A ticket
 *  only the tracker names (no `ident`: not in the check) links to the tracker. */
function TicketLink({ t }: { t: ReleaseBlockersTicketRef }): JSX.Element {
  const openStory = useOpenStory();
  const href = t.url != null ? safeExternalUrl(t.url) : null;
  if (t.ident == null) {
    return href != null ? (
      <a href={href} target="_blank" rel="noreferrer noopener" className={LINK} title={t.title ?? undefined}>
        {t.key}
      </a>
    ) : (
      <span className="font-medium" title={t.title ?? undefined}>
        {t.key}
      </span>
    );
  }
  const ident = t.ident;
  return (
    <span className="whitespace-nowrap">
      <button type="button" className={LINK} title={t.title ?? undefined} onClick={() => openStory({ ident, key: t.key, title: t.title })}>
        {t.key}
      </button>
      {href != null && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Open ${t.key} in the tracker`}
          title={`Open ${t.key} in the tracker`}
          className={`ml-0.5 inline-flex rounded-ui align-baseline text-ui-mute hover:text-ui-ink ${FOCUS_RING}`}
        >
          <ExternalLinkIcon size={11} />
        </a>
      )}
    </span>
  );
}

/** "web #518": the PR tab when the PR is stored, else GitHub. */
function PrLink({ p, check }: { p: ReleaseBlockersPrRef; check: ReleaseCheckResult }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const label = releaseBlockersRefLabel(p);
  const repoFullName = p.repoFullName ?? check.repos.find((r) => r.name === p.repoName)?.fullName ?? null;
  if (p.prId == null || repoFullName == null) {
    const href = p.url != null ? safeExternalUrl(p.url) : null;
    return href != null ? (
      <a href={href} target="_blank" rel="noreferrer noopener" className={LINK} title={p.title ?? undefined}>
        {label}
      </a>
    ) : (
      <span className="font-medium" title={p.title ?? undefined}>
        {label}
      </span>
    );
  }
  const prId = p.prId;
  return (
    <button
      type="button"
      title={p.title ?? undefined}
      onClick={() =>
        openPrDetailTab(
          { id: prId, number: p.number, title: p.title ?? '', repoFullName, authorLogin: null, authorDisplayName: null, authorAvatarUrl: null },
          { fromActivity: true },
        )
      }
      className={LINK}
    >
      {label}
    </button>
  );
}
