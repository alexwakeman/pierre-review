// ONE failing check and what Claude found about it — the row of the Claude Review tab's "CI check"
// section (CiCheckSection.tsx). It renders a CI review's item and, as history, an older code
// review's stored CI diagnosis (the same `ClaudeCiFailure` shape).
//
// Rules (same as ClaudeReviewThreads.tsx):
//  - Every string from a check or from Claude renders as PLAIN TEXT: no Markdown. The one href is
//    the check's details page, through `safeExternalUrl` — never a log download URL (the server
//    never sends one).
//  - Causes come from the server's reconcile step, which never invents one; ordering, pills and
//    sentences live in lib/claudeReviewCi.ts.
import { useId, useState } from 'react';
import type { ClaudeCiFailure, ClaudeFindingSide } from '@pierre-review/shared';
import { CI_CATEGORY_CLASS, CI_CATEGORY_LABEL, ciNotCheckedSentence } from '../lib/claudeReviewCi.js';
import { anchorLabel } from '../lib/claudeReviewFollowUp.js';
import { safeExternalUrl } from '../lib/ui.js';
import { ChevronIcon, ExternalLinkIcon } from './Icons.js';
import { PrRefText } from './ReviewPrRefs.js';
import { REVIEW_CHIP, REVIEW_ITEM_TITLE, REVIEW_PROSE } from '../lib/reviewStyles.js';

const CHIP = REVIEW_CHIP;
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

export function CiFailureRow({
  f,
  suggestion = null,
  changedPaths,
  onOpenInChanges,
}: {
  f: ClaudeCiFailure;
  // A CI review item's short description of the fix (null on history rows and when Claude has none).
  suggestion?: string | null;
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
        fixable ? 'border-amber-300 dark:border-amber-700/60' : 'border-gray-100 dark:border-gray-800'
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
        <span className={`break-all ${REVIEW_ITEM_TITLE}`}>{f.checkName}</span>
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
            <p className={`mt-1 ${REVIEW_PROSE}`}>
              <PrRefText text={f.cause} />
            </p>
          )}
          {suggestion != null && suggestion !== '' && (
            <p className={`mt-1 ${REVIEW_PROSE}`}>
              <span className="font-medium">Fix: </span>
              <PrRefText text={suggestion} />
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
                <p id={explanationId} className={`mt-0.5 ${REVIEW_PROSE}`}>
                  <PrRefText text={f.explanation} />
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
