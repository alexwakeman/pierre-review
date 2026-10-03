// The Claude Review tab's "CI failures" section: what the run found about every check that was
// failing on the reviewed commit.
//
// Rules (same as ClaudeReviewThreads.tsx):
//  - Every string from a check or from Claude renders as PLAIN TEXT: no Markdown. The one href is
//    the check's details page, through `safeExternalUrl` — never a log download URL (the server
//    never sends one).
//  - Causes come from the server's reconcile step, which never invents one; ordering, pills and
//    sentences live in lib/claudeReviewCi.ts.
import { useId, useMemo, useState } from 'react';
import type { ClaudeCiFailure, ClaudeFindingSide, ClaudeReview } from '@pierre-review/shared';
import {
  CI_CATEGORY_CLASS,
  CI_CATEGORY_LABEL,
  CI_PASSING_CLASS,
  ciCountPills,
  ciFailingLabel,
  ciNotCheckedSentence,
  ciSectionMode,
  orderCiFailures,
} from '../lib/claudeReviewCi.js';
import { anchorLabel } from '../lib/claudeReviewFollowUp.js';
import { safeExternalUrl } from '../lib/ui.js';
import { CheckIcon, ChevronIcon, ExternalLinkIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection } from './ReviewSection.js';

const CHIP = 'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium';
const MUTED = 'text-gray-500 dark:text-gray-400';

type OpenInChanges = (path: string, line: number | null, side: ClaudeFindingSide) => void;

function FileRef({
  path,
  line,
  changedPaths,
  onOpenInChanges,
}: {
  path: string;
  line: number | null;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const label = anchorLabel(path, line);
  // A BUTTON into the Changes tab only for a file the PR touches; otherwise plain text.
  if (onOpenInChanges != null && changedPaths.has(path)) {
    return (
      <button
        type="button"
        onClick={() => onOpenInChanges(path, line, 'RIGHT')}
        className="break-all text-left font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
      >
        {label}
      </button>
    );
  }
  return <span className={`break-all font-mono text-xs ${MUTED}`}>{label}</span>;
}

function CiFailureRow({
  f,
  changedPaths,
  onOpenInChanges,
}: {
  f: ClaudeCiFailure;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const explanationId = useId();
  const href = safeExternalUrl(f.url);
  const diagnosed = f.status === 'diagnosed';
  const fixable = diagnosed && f.fixableInPr === true;
  return (
    <li
      className={`rounded border px-3 py-2 text-sm ${
        fixable ? 'border-amber-300 dark:border-amber-700/60' : 'border-gray-200 dark:border-gray-800'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {diagnosed && f.category != null ? (
          <span className={`${CHIP} ${CI_CATEGORY_CLASS[f.category]}`}>
            {CI_CATEGORY_LABEL[f.category]}
          </span>
        ) : (
          <span className={`${CHIP} ${CI_CATEGORY_CLASS.unclear}`}>Not checked</span>
        )}
        <span className="break-all font-medium">{f.checkName}</span>
        {f.step != null && <span className={`break-all text-xs ${MUTED}`}>Step: {f.step}</span>}
        {diagnosed && f.fixableInPr === false && (
          <span className={`text-xs ${MUTED}`}>Not from this change</span>
        )}
        {f.carried && (
          <span className={`text-xs ${MUTED}`}>
            Unchanged since <span className="font-mono">{f.assessedAtHead.slice(0, 7)}</span>
          </span>
        )}
        {href != null && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            Details
            <ExternalLinkIcon size={11} />
          </a>
        )}
      </div>
      {diagnosed ? (
        <>
          {f.cause != null && (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">
              <span className="font-medium">Claude: </span>
              {f.cause}
            </p>
          )}
          {f.explanation != null && f.explanation !== '' && (
            <div className="mt-0.5">
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-controls={explanationId}
                className={`inline-flex items-center gap-1 text-xs ${MUTED} hover:text-gray-700 dark:hover:text-gray-200`}
              >
                <ChevronIcon dir={open ? 'down' : 'right'} size={11} />
                Why
              </button>
              {open && (
                <p
                  id={explanationId}
                  className="mt-0.5 whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300"
                >
                  {f.explanation}
                </p>
              )}
            </div>
          )}
          {f.relatedFiles.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
              {f.relatedFiles.map((r) => (
                <FileRef
                  key={`${r.path}:${r.line ?? ''}`}
                  path={r.path}
                  line={r.line}
                  changedPaths={changedPaths}
                  onOpenInChanges={onOpenInChanges}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <p className={`mt-1 text-xs ${MUTED}`}>{ciNotCheckedSentence(f.notCheckedReason)}</p>
      )}
    </li>
  );
}

/**
 * CI on the reviewed commit when nothing failed: a "CI passing" pill, or a line saying it was still
 * running. null when CI failed (the CI failures section says so) or the run did not look.
 */
export function ClaudeReviewCiStatus({
  review,
}: {
  review: Pick<ClaudeReview, 'ciFailures' | 'ciState'>;
}): JSX.Element | null {
  const mode = ciSectionMode(review);
  if (mode === 'passing') {
    return (
      <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${CI_PASSING_CLASS}`}>
        <CheckIcon size={12} />
        CI passing
      </span>
    );
  }
  if (mode === 'pending') {
    return <span className={`text-xs ${MUTED}`}>CI was still running when Claude reviewed.</span>;
  }
  return null;
}

/**
 * The checks that were failing on the reviewed commit and what Claude found. null (the run did not
 * look at CI) → nothing; nothing failing on a green head → one short line.
 */
export function ClaudeReviewCiFailuresSection({
  review,
  changedPaths,
  onOpenInChanges,
}: {
  review: Pick<ClaudeReview, 'ciFailures' | 'ciState'>;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element | null {
  const mode = ciSectionMode(review);
  const items = useMemo(() => orderCiFailures(review.ciFailures ?? []), [review.ciFailures]);
  // Passing / still running is a one-line fact, not a section: `ClaudeReviewCiStatus` prints it in
  // Claude's review section instead.
  if (mode !== 'list') return null;
  const pills = ciCountPills(items);
  return (
    <ReviewSection
      title="CI failures"
      pills={
        <>
          <span className={`text-xs ${MUTED}`}>{ciFailingLabel(items.length)}</span>
          {pills.map((p) => (
            <span key={p.key} className={`${CHIP} ${p.cls}`}>
              {p.label}
            </span>
          ))}
        </>
      }
      info={
        <InfoButton title="CI failures">
          <p>
            Checks that failed on the reviewed commit. Claude reads the end of each GitHub Actions
            log and the code, and says why it failed.
          </p>
          <p className="mt-2">Checks outside GitHub Actions have no log to read, so they are listed only.</p>
        </InfoButton>
      }
    >
      <ul className="space-y-1.5">
        {items.map((f) => (
          <CiFailureRow
            key={`${f.checkName}:${f.jobId ?? ''}`}
            f={f}
            changedPaths={changedPaths}
            onOpenInChanges={onOpenInChanges}
          />
        ))}
      </ul>
    </ReviewSection>
  );
}
