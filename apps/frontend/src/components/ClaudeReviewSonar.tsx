// SONARCLOUD in the Claude Review tab (docs/SONARCLOUD.md § The review tab): the head's quality gate
// and issue cards, a Refresh and the one "Post SonarCloud findings" review. The CARD
// (`SonarIssueRow`) is also what the AI Fix picker draws for a SonarCloud item, with a tick box in
// `selection` and no buttons (it has none of its own).
//
// Rules:
//  - Every string from SonarCloud renders as PLAIN TEXT. The one href is SonarCloud's own page for
//    the issue, through `safeExternalUrl`.
//  - The section reads the STORED snapshot (no SonarCloud call on mount); Refresh is a button.
//  - The section is absent when the workspace has no SonarCloud set up and nothing was ever stored.
import { useId, useState, type ReactNode } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  SONAR_SEVERITY_LABEL,
  sonarGateItems,
  sonarMetricLabel,
  sonarMetricValue,
  type ClaudeFindingSide,
  type SonarIssue,
  type SonarSeverity,
  type SonarSnapshot,
} from '@pierre-review/shared';
import { safeExternalUrl } from '../lib/ui.js';
import { REVIEW_CHIP, REVIEW_ITEM_TITLE, REVIEW_META, REVIEW_PROSE } from '../lib/reviewStyles.js';
import { usePostPrSonar, usePrSonar, useRefreshPrSonar } from '../hooks/useSonar.js';
import { ChevronIcon, ExternalLinkIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection, SectionCount } from './ReviewSection.js';

const MUTED = 'text-ui-mute';
const SEVERITY_TONE: Record<SonarSeverity, string> = {
  blocker: 'bg-ui-danger/10 text-ui-danger',
  critical: 'bg-ui-danger/10 text-ui-danger',
  major: 'bg-ui-raise text-ui-warn',
  minor: 'bg-ui-raise text-ui-warn',
  info: 'bg-ui-raise text-ui-mute',
};
const TYPE_LABEL: Record<string, string> = {
  BUG: 'Bug',
  VULNERABILITY: 'Vulnerability',
  CODE_SMELL: 'Code smell',
  SECURITY_HOTSPOT: 'Security hotspot',
  QUALITY_GATE: 'Quality gate',
};
const BTN =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2 text-meta text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-40 touch:h-10 touch:px-3';

type OpenInChanges = (path: string, line: number | null, side: ClaudeFindingSide) => void;

function where(it: SonarIssue): string | null {
  if (!it.path) return null;
  if (it.line == null) return it.path;
  return it.endLine != null && it.endLine !== it.line ? `${it.path}:${it.line}-${it.endLine}` : `${it.path}:${it.line}`;
}

/** One SonarCloud issue or hotspot. */
export function SonarIssueRow({
  issue: it,
  changedPaths,
  onOpenInChanges,
  selection = null,
}: {
  issue: SonarIssue;
  changedPaths?: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
  // A leading control in the card's header (the AI Fix picker's tick box).
  selection?: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const fixId = useId();
  const href = safeExternalUrl(it.url);
  const loc = where(it);
  const type = it.type ? TYPE_LABEL[it.type] ?? it.type : null;
  const guidance = it.howToFix ?? it.whyIsThisAnIssue;
  return (
    <li className="rounded-ui border border-ui-line px-3 py-2 text-body">
      <div className="flex flex-wrap items-center gap-2">
        {selection}
        <span className={`${REVIEW_CHIP} ${SEVERITY_TONE[it.severity]}`}>{SONAR_SEVERITY_LABEL[it.severity]}</span>
        {type != null && <span className={`text-meta ${MUTED}`}>{type}</span>}
        <span className={`break-all text-meta ${MUTED}`}>{it.ruleName ?? it.rule}</span>
        {it.effort != null && <span className={`text-meta ${MUTED}`}>{it.effort} to fix</span>}
        {href != null && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="hit ml-auto inline-flex items-center gap-1 text-meta text-ui-ink hover:underline"
          >
            SonarCloud
            <ExternalLinkIcon size={11} />
          </a>
        )}
      </div>
      <p className={`mt-1 ${REVIEW_ITEM_TITLE} ${REVIEW_PROSE}`}>{it.message}</p>
      {loc != null &&
        (onOpenInChanges != null && it.path != null && changedPaths?.has(it.path) ? (
          <button
            type="button"
            onClick={() => onOpenInChanges(it.path!, it.line, 'RIGHT')}
            className="hit mt-0.5 break-all text-left font-mono text-meta text-ui-ink hover:underline"
          >
            {loc}
          </button>
        ) : (
          <div className={`mt-0.5 break-all font-mono text-meta ${MUTED}`}>{loc}</div>
        ))}
      {it.code.length > 0 && (
        <pre className="mt-1 overflow-x-auto rounded-ui bg-ui-surface px-2 py-1 font-mono text-meta leading-snug">
          {it.code.map((c) => (
            <div
              key={c.line}
              className={c.flagged ? 'bg-ui-raise text-ui-ink' : 'text-ui-mute'}
            >
              <span className="mr-2 inline-block w-8 select-none text-right text-ui-mute">{c.line}</span>
              {c.code}
            </div>
          ))}
        </pre>
      )}
      {guidance != null && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={fixId}
            className={`inline-flex items-center gap-1 text-meta ${MUTED} hover:text-ui-ink`}
          >
            <ChevronIcon dir={open ? 'down' : 'right'} size={11} />
            {it.howToFix != null ? 'How to fix' : 'Why it matters'}
          </button>
          {open && (
            <p id={fixId} className={`mt-0.5 ${REVIEW_PROSE}`}>
              {guidance}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function gatePill(s: SonarSnapshot): JSX.Element | null {
  const g = s.qualityGate;
  if (!g || g.status === 'NONE') return null;
  const tone = g.status === 'OK' ? 'bg-ui-raise text-ui-success' : g.status === 'WARN' ? SEVERITY_TONE.major : SEVERITY_TONE.blocker;
  const word = g.status === 'OK' ? 'Quality gate passed' : g.status === 'WARN' ? 'Quality gate warning' : 'Quality gate failed';
  return <span className={`${REVIEW_CHIP} ${tone}`}>{word}</span>;
}

/** "New code: Coverage 42.1% · New lines 120" — SonarCloud's measures, when read. */
function measuresText(s: SonarSnapshot): string | null {
  const ms = s.qualityGate?.measures ?? [];
  if (ms.length === 0) return null;
  return `New code: ${ms.map((m) => `${sonarMetricLabel(m.metric).replace(/ on new code$/, '')} ${sonarMetricValue(m.metric, m.value)}`).join(' · ')}`;
}

function countLabel(s: SonarSnapshot): string {
  const total = s.totalIssues + s.totalHotspots;
  if (s.issues.length < total) return `${s.issues.length} of ${total} issues`;
  return `${total} ${total === 1 ? 'issue' : 'issues'}`;
}

function postLine(s: SonarSnapshot, visible: boolean | null): string | null {
  const p = s.post;
  if (!p) return null;
  if (p.status === 'posting') return 'Posting to GitHub…';
  if (p.status === 'failed') return `Posting failed: ${p.error ?? 'GitHub refused it.'}`;
  const who = p.trigger === 'auto' ? 'Posted automatically' : 'Posted';
  const later = visible === false ? ' It’ll show up here shortly.' : '';
  // A review (since 2026-10-22): threads on the changed lines + a summary. Older rows were one comment.
  if (p.inline != null) {
    const parts: string[] = [];
    if (p.inline.length > 0) parts.push(`${p.inline.length} on the changed lines`);
    parts.push(`${p.summaryCount ?? 0} in the summary${p.truncated ? ' (the rest did not fit)' : ''}`);
    if ((p.alreadyCount ?? 0) > 0) parts.push(`${p.alreadyCount} already there from an earlier commit`);
    return `${who} to GitHub: ${parts.join(', ')}.${later}`;
  }
  const cut = p.truncated ? ` (${p.issueCount} issues fitted in one comment)` : '';
  return `${who} to GitHub${cut}.${later}`;
}

/** The review tab's SonarCloud section, for the reviewed head. */
export function ClaudeReviewSonarSection({
  prId,
  headSha,
  canPost,
  changedPaths,
  onOpenInChanges,
}: {
  prId: number;
  headSha: string | null;
  // Posting rides the local `gh` session.
  canPost: boolean;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element | null {
  const q = usePrSonar(prId, headSha);
  const refresh = useRefreshPrSonar(prId, headSha);
  const post = usePostPrSonar(prId, headSha);
  // Shared across mounts: a second copy of this section shows the same "Posting…".
  const posting = useIsMutating({ mutationKey: ['pr-sonar-post', prId, headSha ?? 'head'] }) > 0;
  const refreshing = useIsMutating({ mutationKey: ['pr-sonar-refresh', prId, headSha ?? 'head'] }) > 0;
  const data = q.data;
  const snap = data?.snapshot ?? null;
  if (!data || (!data.configured && snap == null)) return null;

  const canPostNow =
    canPost && snap != null && snap.state === 'ok' && snap.post == null && (snap.issues.length > 0 || snap.qualityGate?.status === 'ERROR');
  const visible = post.data?.visible ?? null;
  const line = snap ? postLine(snap, visible) : null;
  // A failing coverage / duplication gate condition draws as a card of its own (the same card AI
  // Fix's picker draws for it).
  const gateItems = snap?.state === 'ok' ? sonarGateItems(snap.qualityGate, snap.dashboardUrl) : [];

  return (
    <ReviewSection
      title="SonarCloud"
      pills={
        snap?.state === 'ok' ? (
          <>
            {gatePill(snap)}
            <SectionCount>{countLabel(snap)}</SectionCount>
          </>
        ) : undefined
      }
      info={
        <InfoButton title="SonarCloud">
          <div className="space-y-2">
            <p>
              Limn reads this commit’s SonarCloud analysis: open issues, security hotspots to review, the
              quality gate with the files behind a coverage or duplication shortfall, and each rule’s advice
              on how to fix it.
            </p>
            <p>Only an analysis of this exact commit is used. Until SonarCloud has analysed it, nothing shows.</p>
            <p>
              The 50 most severe are kept. AI Review sees them as evidence and AI Fix can take them on.
            </p>
            <p>
              “Post SonarCloud findings” adds one review to the PR, once per commit: a comment on each issue
              that sits on a changed line, and a summary with everything else. An issue already commented on
              for an earlier commit is only named in the summary.
            </p>
          </div>
        </InfoButton>
      }
      actions={
        <>
          {snap?.dashboardUrl != null && safeExternalUrl(snap.dashboardUrl) != null && (
            <a
              href={safeExternalUrl(snap.dashboardUrl)!}
              target="_blank"
              rel="noreferrer noopener"
              className="hit inline-flex items-center gap-1 text-meta text-ui-ink hover:underline"
            >
              Open in SonarCloud
              <ExternalLinkIcon size={11} />
            </a>
          )}
          {data.configured && (
            <button type="button" className={BTN} disabled={refreshing} onClick={() => refresh.mutate()}>
              {refreshing ? 'Reading…' : 'Refresh'}
            </button>
          )}
          {canPostNow && (
            <button
              type="button"
              className="hit rounded-ui bg-ui-accent-fill disabled:bg-ui-raise disabled:text-ui-ink px-2 py-0.5 text-meta font-medium text-ui-on-accent hover:bg-ui-accent-fill disabled:cursor-not-allowed disabled:opacity-50"
              disabled={posting}
              onClick={() => post.mutate()}
            >
              {posting ? 'Posting…' : 'Post SonarCloud findings'}
            </button>
          )}
        </>
      }
    >
      {snap == null ? (
        <p className={REVIEW_META}>Not read for this commit yet.</p>
      ) : snap.state !== 'ok' ? (
        <p className={REVIEW_META}>{snap.message ?? 'SonarCloud could not be read.'}</p>
      ) : (
        <>
          {measuresText(snap) != null && <p className={REVIEW_META}>{measuresText(snap)}</p>}
          {gateItems.length + snap.issues.length === 0 ? (
            <p className={REVIEW_META}>No open issues on this commit.</p>
          ) : (
            <ul className="space-y-2">
              {[...gateItems, ...snap.issues].map((it) => (
                <SonarIssueRow key={it.key} issue={it} changedPaths={changedPaths} onOpenInChanges={onOpenInChanges} />
              ))}
            </ul>
          )}
        </>
      )}
      {line != null && <p className={REVIEW_META}>{line}</p>}
      {refresh.isError && <p className="text-meta text-ui-danger">{refresh.error.message}</p>}
      {post.isError && <p className="text-meta text-ui-danger">{post.error.message}</p>}
    </ReviewSection>
  );
}
