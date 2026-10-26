// The Claude Review tab's "Review threads" section: what the run found about every OTHER reviewer's
// open thread (people and review bots). Limn's own posted findings are the follow-up's, not this.
//
// Rules (same as ClaudeReviewFollowUp.tsx):
//  - Every string from a comment or from Claude renders as PLAIN TEXT: no Markdown. The one href is
//    the thread's github.com link, through `safeExternalUrl`.
//  - Verdicts and counts come from the server's reconcile step, which never invents "addressed";
//    ordering and colours live in lib/claudeReviewFollowUp.ts.
//  - `draftReply` is a suggestion only. There is no route that posts it, so it offers Copy.
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { THREAD_VALIDITY_LABEL, isThreadToFix, threadAssessmentCounts } from '@pierre-review/shared';
import type { AiProviderName, ClaudeThreadAssessment, ClaudeThreadAssessmentCounts } from '@pierre-review/shared';
import {
  THREAD_VALIDITY_CLASS,
  anchorLabel,
  partitionThreads,
  threadAddressedClass,
  threadCountPills,
  threadNotCheckedReason,
} from '../lib/claudeReviewFollowUp.js';
import {
  CLAUDE_STATE_LABEL,
  CLAUDE_VALIDITY_LABEL,
  claudeStatePill,
  claudeValidityPill,
} from '../lib/claudeThreadMarker.js';
import { safeExternalUrl } from '../lib/ui.js';
import { CopyButton } from './CopyButton.js';
import { BotIcon, ChevronIcon, ExternalLinkIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection } from './ReviewSection.js';
import { PrRefText } from './ReviewPrRefs.js';
import { REVIEW_CHIP, REVIEW_PROSE } from '../lib/reviewStyles.js';
import { useAiProviderName } from '../hooks/useAiCapabilities.js';

const CHIP = REVIEW_CHIP;
const MUTED = 'text-gray-500 dark:text-gray-400';

// EXPORTED FOR THE AI FIX PICKER (AiFix/FixPicker.tsx): the same card with `actions={false}` (no
// Copy on the suggested reply) and its tick box in `selection`.
export function ThreadRow({
  t,
  muted,
  onOpenThread,
  actions = true,
  selection = null,
  notCheckedNote,
  by,
}: {
  t: ClaudeThreadAssessment;
  muted: boolean;
  onOpenThread?: (threadId: number) => void;
  // false ⇒ no buttons. Default true.
  actions?: boolean;
  // A leading control in the card's header (the fix picker's tick box).
  selection?: ReactNode;
  // Replaces the not-checked sentence (a thread the review never looked at has its own reason).
  notCheckedNote?: string;
  // The provider that ran the review (absent ⇒ Claude).
  by?: AiProviderName;
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
  const validityPill = claudeValidityPill(t.validity);
  const statePill = claudeStatePill(t.addressed, t.resolved === true);
  // The one-line reason sits under the pills; the longer explanation opens on demand (or stands in
  // for the reason on an older judgement that has none).
  const reason = t.reason != null && t.reason.trim() !== '' ? t.reason.trim() : null;
  const explanation = t.explanation != null && t.explanation !== '' ? t.explanation : null;
  const [whyOpen, setWhyOpen] = useState(false);
  return (
    <li
      className={`rounded border px-3 py-2 text-sm ${
        toFix ? 'border-amber-300 dark:border-amber-700/60' : 'border-gray-100 dark:border-gray-800'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {selection}
        {/* The ONE thread vocabulary (lib/claudeThreadMarker.ts): validity, then state. */}
        {validityPill != null && (
          <span className={`${CHIP} ${THREAD_VALIDITY_CLASS[t.validity]}`}>
            {CLAUDE_VALIDITY_LABEL[validityPill]}
          </span>
        )}
        {judged && statePill != null && (
          <span
            className={`${CHIP} ${
              t.resolved === true
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : threadAddressedClass(t)
            }`}
          >
            {CLAUDE_STATE_LABEL[statePill]}
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
            className={`${REVIEW_PROSE} ${expanded ? '' : 'line-clamp-3'}`}
          >
            <PrRefText text={t.excerpt} />
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
      {reason != null ? (
        <div className="mt-1">
          <p className={REVIEW_PROSE}>
            <PrRefText text={reason} />
          </p>
          {explanation != null && explanation !== reason && (
            <>
              <button
                type="button"
                onClick={() => setWhyOpen((o) => !o)}
                aria-expanded={whyOpen}
                className={`text-xs ${MUTED} hover:text-gray-700 dark:hover:text-gray-200`}
              >
                {whyOpen ? 'Less' : 'More'}
              </button>
              {whyOpen && (
                <p className={`mt-0.5 ${REVIEW_PROSE}`}>
                  <PrRefText text={explanation} />
                </p>
              )}
            </>
          )}
        </div>
      ) : explanation != null ? (
        <p className={`mt-1 ${REVIEW_PROSE}`}>
          <PrRefText text={explanation} />
        </p>
      ) : !judged ? (
        <p className={`mt-1 text-xs ${MUTED}`}>{notCheckedNote ?? threadNotCheckedReason(t, by)}</p>
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
            {actions && <CopyButton text={t.draftReply} what="suggested reply" />}
          </div>
          {replyOpen && (
            <p
              id={replyId}
              className={`mt-0.5 rounded bg-gray-500/5 px-2 py-1 ${REVIEW_PROSE}`}
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
  actions,
  by,
}: {
  items: readonly ClaudeThreadAssessment[] | null | undefined;
  counts: ClaudeThreadAssessmentCounts | null | undefined;
  // Opens the thread in the PR's Threads tab (PrDetail). Absent ⇒ path:line is plain text.
  onOpenThread?: (threadId: number) => void;
  // Right-aligned header controls ("Check threads").
  actions?: ReactNode;
  // The provider that ran this review (`aiRunProviderName(review)`); absent ⇒ the active one.
  by?: AiProviderName;
}): JSX.Element | null {
  const [moreOpen, setMoreOpen] = useState(false);
  const activeName = useAiProviderName();
  const providerName = by ?? activeName;
  const parts = useMemo(() => partitionThreads(items ?? []), [items]);
  if (items == null) return null;
  const pills = threadCountPills(counts ?? threadAssessmentCounts(items));
  return (
    <ReviewSection
      title="Review threads"
      actions={actions}
      pills={pills.map((p) => (
        <span key={p.key} className={`${CHIP} ${p.cls}`}>
          {p.label}
        </span>
      ))}
      info={
        <InfoButton title="Review threads">
          <p>
            Comments from people and other review bots. {providerName} checks each one against the code:
            does the comment hold up, and where does the code stand. Each carries a one-line reason;
            More opens the longer one.
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
                <ThreadRow key={t.threadId} t={t} muted={false} onOpenThread={onOpenThread} by={by} />
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
                    <ThreadRow key={t.threadId} t={t} muted onOpenThread={onOpenThread} by={by} />
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
