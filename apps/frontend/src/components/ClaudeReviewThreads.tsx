// The Claude Review tab's "Review threads" section: what the run found about every OTHER reviewer's
// open thread (people and review bots). Limn's own posted findings are the follow-up's, not this.
//
// Rules (same as ClaudeReviewFollowUp.tsx):
//  - Every string from a comment or from Claude renders as PLAIN TEXT: no Markdown. The one href is
//    the thread's github.com link, through `safeExternalUrl`.
//  - Verdicts and counts come from the server's reconcile step, which never invents "addressed";
//    ordering and colours live in lib/claudeReviewFollowUp.ts.
//  - `draftReply` is a suggestion only. There is no route that posts it, so it offers Copy.
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  THREAD_ADDRESSED_LABEL,
  THREAD_VALIDITY_LABEL,
  isThreadToFix,
  threadAssessmentCounts,
} from '@pierre-review/shared';
import type { ClaudeThreadAssessment, ClaudeThreadAssessmentCounts } from '@pierre-review/shared';
import {
  THREAD_VALIDITY_CLASS,
  anchorLabel,
  partitionThreads,
  threadAddressedClass,
  threadCountPills,
  threadNotCheckedReason,
} from '../lib/claudeReviewFollowUp.js';
import { safeExternalUrl } from '../lib/ui.js';
import { CopyButton } from './CopyButton.js';
import { BotIcon, ChevronIcon, ExternalLinkIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection } from './ReviewSection.js';

const CHIP = 'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium';
const MUTED = 'text-gray-500 dark:text-gray-400';

function ThreadRow({
  t,
  muted,
  onOpenThread,
}: {
  t: ClaudeThreadAssessment;
  muted: boolean;
  onOpenThread?: (threadId: number) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const replyId = useId();
  const toFix = isThreadToFix(t);
  const href = safeExternalUrl(t.url);
  const label = anchorLabel(t.path, t.line);
  // The excerpt is clamped to three lines; More appears only when the clamp actually cut text.
  const excerptRef = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = excerptRef.current;
    if (el != null && !expanded) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [t.excerpt, expanded]);
  const judged = t.validity !== 'not_checked' || t.addressed !== 'not_checked';
  return (
    <li
      className={`rounded border px-3 py-2 text-sm ${
        toFix ? 'border-amber-300 dark:border-amber-700/60' : 'border-gray-200 dark:border-gray-800'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {t.validity !== 'not_checked' && (
          <span className={`${CHIP} ${THREAD_VALIDITY_CLASS[t.validity]}`}>
            {THREAD_VALIDITY_LABEL[t.validity]}
          </span>
        )}
        {t.addressed !== 'not_checked' && (
          <span className={`${CHIP} ${threadAddressedClass(t)}`}>
            {THREAD_ADDRESSED_LABEL[t.addressed]}
          </span>
        )}
        {!judged && (
          <span className={`${CHIP} ${THREAD_VALIDITY_CLASS.not_checked}`}>
            {THREAD_VALIDITY_LABEL.not_checked}
          </span>
        )}
        {t.authorLogin != null && (
          <span className={muted ? 'text-gray-600 dark:text-gray-400' : 'font-medium'}>
            @{t.authorLogin}
          </span>
        )}
        {t.authorIsBot && (
          <span className={`${CHIP} gap-1 bg-gray-500/10 text-gray-600 dark:text-gray-300`}>
            <BotIcon size={12} />
            Bot
          </span>
        )}
        {t.carried && (
          <span className={`text-xs ${MUTED}`}>
            Unchanged since <span className="font-mono">{t.assessedAtHead.slice(0, 7)}</span>
          </span>
        )}
        {href != null && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            GitHub
            <ExternalLinkIcon size={11} />
          </a>
        )}
      </div>
      <div className="mt-0.5">
        {onOpenThread != null ? (
          <button
            type="button"
            onClick={() => onOpenThread(t.threadId)}
            className="break-all text-left font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            {label}
          </button>
        ) : (
          <span className={`break-all font-mono text-xs ${MUTED}`}>{label}</span>
        )}
        {t.commentCount > 1 && (
          <span className={`ml-2 text-xs ${MUTED}`}>{t.commentCount} comments</span>
        )}
      </div>
      {t.excerpt !== '' && (
        <div className="mt-1">
          <p
            ref={excerptRef}
            className={`whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300 ${
              expanded ? '' : 'line-clamp-3'
            }`}
          >
            {t.excerpt}
          </p>
          {(clamped || expanded) && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              className={`text-xs ${MUTED} hover:text-gray-700 dark:hover:text-gray-200`}
            >
              {expanded ? 'Less' : 'More'}
            </button>
          )}
        </div>
      )}
      {t.explanation != null && t.explanation !== '' ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">
          <span className="font-medium">Claude: </span>
          {t.explanation}
        </p>
      ) : !judged ? (
        <p className={`mt-1 text-xs ${MUTED}`}>{threadNotCheckedReason(t)}</p>
      ) : null}
      {t.draftReply != null && t.draftReply !== '' && (
        <div className="mt-1">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setReplyOpen((o) => !o)}
              aria-expanded={replyOpen}
              aria-controls={replyId}
              className={`inline-flex items-center gap-1 text-xs ${MUTED} hover:text-gray-700 dark:hover:text-gray-200`}
            >
              <ChevronIcon dir={replyOpen ? 'down' : 'right'} size={11} />
              Suggested reply
            </button>
            <CopyButton text={t.draftReply} what="suggested reply" />
          </div>
          {replyOpen && (
            <p
              id={replyId}
              className="mt-0.5 whitespace-pre-wrap break-words rounded bg-gray-500/5 px-2 py-1 text-xs text-gray-700 dark:text-gray-300"
            >
              {t.draftReply}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Every other reviewer's open thread the run judged. Still to fix first; addressed and not-valid
 * ones behind "Show N more". null = the run did not assess threads → nothing.
 */
export function ClaudeReviewThreadsSection({
  items,
  counts,
  onOpenThread,
}: {
  items: readonly ClaudeThreadAssessment[] | null | undefined;
  counts: ClaudeThreadAssessmentCounts | null | undefined;
  // Opens the thread in the PR's Threads tab (PrDetail). Absent ⇒ path:line is plain text.
  onOpenThread?: (threadId: number) => void;
}): JSX.Element | null {
  const [moreOpen, setMoreOpen] = useState(false);
  const parts = useMemo(() => partitionThreads(items ?? []), [items]);
  if (items == null) return null;
  const pills = threadCountPills(counts ?? threadAssessmentCounts(items));
  return (
    <ReviewSection
      title="Review threads"
      pills={pills.map((p) => (
        <span key={p.key} className={`${CHIP} ${p.cls}`}>
          {p.label}
        </span>
      ))}
      info={
        <InfoButton title="Review threads">
          <p>
            Open comments from people and other review bots. Claude checks each one against the
            code: is it right, and has it been dealt with.
          </p>
          <p className="mt-2">
            &ldquo;Generate fix from this review&rdquo; includes the ones still to fix.
          </p>
        </InfoButton>
      }
    >
      {items.length === 0 ? (
        <p className={`text-xs ${MUTED}`}>No other review threads.</p>
      ) : (
        <>
          {parts.shown.length > 0 && (
            <ul className="space-y-1.5">
              {parts.shown.map((t) => (
                <ThreadRow key={t.threadId} t={t} muted={false} onOpenThread={onOpenThread} />
              ))}
            </ul>
          )}
          {parts.more.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setMoreOpen((o) => !o)}
                aria-expanded={moreOpen}
                className={`inline-flex items-center gap-1 text-xs ${MUTED} hover:text-gray-700 dark:hover:text-gray-200`}
              >
                <ChevronIcon dir={moreOpen ? 'down' : 'right'} size={11} />
                {moreOpen ? 'Show fewer' : `Show ${parts.more.length} more`}
              </button>
              {moreOpen && (
                <ul className="mt-1.5 space-y-1.5">
                  {parts.more.map((t) => (
                    <ThreadRow key={t.threadId} t={t} muted onOpenThread={onOpenThread} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </ReviewSection>
  );
}
