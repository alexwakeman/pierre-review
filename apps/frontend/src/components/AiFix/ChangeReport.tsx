import type { ReactNode } from 'react';
import type { AiFixChangeReport } from '@pierre-review/shared';
import { InfoButton } from '../InfoModal.js';

// THE CHANGE REPORT — what a write agent says it changed in each file, and why; the refs it left alone
// and why; the refs it never reported on. Drawn by AI Fix (`FixReport`, its refs are review items) and by
// the story build (`StoryBuild/BuildRepoCard.tsx`, its refs are acceptance criteria `AC1` and asks `M1`).
// The report is the agent's SELF-REPORT, validated server-side against the refs it was shown and the
// captured diff; the diff is the authoritative changeset. The CALLER draws each ref (`renderRef`), so a
// chip can jump wherever its feature keeps the ref.

export const CHANGE_REPORT_CHIP =
  'inline-flex max-w-full items-center gap-1 rounded-ui px-1.5 py-0.5 text-meta font-medium bg-ui-raise text-ui-ink';
export const CHANGE_REPORT_HEADING = 'mb-1 mt-3 flex items-center gap-1 text-meta font-medium text-ui-mute';

/** The Changes / Not addressed / No report sections (a fragment: the caller owns the wrapper). */
export function ChangeReportSections({
  report,
  filesChanged,
  by,
  refsInfo,
  renderRef,
}: {
  report: AiFixChangeReport | null;
  /** Every file the diff touched: one the report does not describe reads "No summary reported." */
  filesChanged: readonly string[];
  /** Who ran it ("Claude", "Codex"). */
  by: string;
  /** The ⓘ's line about the tags, when there are any. */
  refsInfo?: ReactNode;
  renderRef: (ref: string) => ReactNode;
}): JSX.Element | null {
  if (!report) return null;
  const described = new Set(report.changes.map((c) => c.path));
  const undescribed = filesChanged.filter((f) => !described.has(f));
  return (
    <>
      {(report.changes.length > 0 || undescribed.length > 0) && (
        <section>
          <div className={CHANGE_REPORT_HEADING}>
            Changes
            <InfoButton title="Changes">
              <p>What {by} says it changed in each file, and why.</p>
              {refsInfo}
              <p>The diff below is what actually changed.</p>
            </InfoButton>
          </div>
          <ul className="space-y-2">
            {report.changes.map((c) => (
              <li key={c.path}>
                <div className="break-all font-mono text-ui-ink">{c.path}</div>
                {c.summary && <p className="mt-0.5 text-ui-ink">{c.summary}</p>}
                {c.refs.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{c.refs.map((r) => renderRef(r))}</div>}
              </li>
            ))}
            {undescribed.map((p) => (
              <li key={p}>
                <div className="break-all font-mono text-ui-ink">{p}</div>
                <p className="mt-0.5 text-ui-mute">No summary reported.</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.unaddressed.length > 0 && (
        <section>
          <div className={CHANGE_REPORT_HEADING}>Not addressed</div>
          <ul className="space-y-1.5">
            {report.unaddressed.map((u) => (
              <li key={u.ref}>
                {renderRef(u.ref)}
                <p className="mt-0.5 text-ui-ink">{u.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.notReported.length > 0 && (
        <section>
          <div className={CHANGE_REPORT_HEADING}>No report</div>
          <div className="flex flex-wrap gap-1">{report.notReported.map((r) => renderRef(r))}</div>
        </section>
      )}
    </>
  );
}
