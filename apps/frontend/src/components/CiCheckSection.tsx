// THE CI REVIEW in the PR pane — the "CI check" section of the Claude Review tab, after Story check
// and before Review chat, drawn through the same ReviewSection shell.
//
// The CI review is its OWN Claude run (docs/CLAUDE-REVIEW.md § CI review), not part of the code
// review: one run per (PR, head commit, failing-check set). This section shows the latest
// SUCCEEDED run (read by id while a newer one runs, failed or was refused), its currency, how long
// ago it ran, Check CI / Re-check (mutation key `['ci-review-start', prId]`), live progress, and one
// row per failing check. With no CI review at all, an older code review's stored CI diagnosis is
// shown as history.
//
// Rules: every string from a check or from Claude in a ROW renders as plain text (CiFailureRow);
// the run's summary is markdown through the sanitizing <Markdown>. The one href per row is the
// check's details page — the signed log URL never reaches the client. Pure half: lib/ciReview.ts.
import { useMemo } from 'react';
import type { ClaudeFindingSide, ClaudeReview, PrDetail } from '@pierre-review/shared';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import {
  useCiReview,
  useCiReviewById,
  useCiReviewStarting,
  useCiReviewStream,
  useStartCiReview,
} from '../hooks/useCiReview.js';
import {
  CI_CURRENCY_CLASS,
  CI_PHASE_LABEL,
  ciCheckButtonLabel,
  ciCurrency,
  ciProgressPct,
  ciRefusalSentence,
  ciSectionShow,
  type CiCurrency,
} from '../lib/ciReview.js';
import { ciCountPills, ciFailingLabel, orderCiFailures } from '../lib/claudeReviewCi.js';
import { REVIEW_CHIP, REVIEW_META } from '../lib/reviewStyles.js';
import { AiRunGate } from './AiSetup.js';
import { CiFailureRow } from './ClaudeReviewCiFailures.js';
import { CheckIcon, WarningIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { Markdown } from './Markdown.js';
import { ReviewSection } from './ReviewSection.js';
import { ReviewedAgo } from './ReviewedAgo.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';
import { AUTO_REVIEW_LABEL } from './Activity/pendingLabels.js';

type OpenInChanges = (path: string, line: number | null, side: ClaudeFindingSide) => void;

const MUTED = 'text-gray-500 dark:text-gray-400';
const ERROR_TEXT = 'text-red-600 dark:text-red-400';
const BTN =
  'whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';
const BTN_PRIMARY =
  'whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';

function CurrencyPill({ currency }: { currency: CiCurrency }): JSX.Element {
  return (
    <span className={`${REVIEW_CHIP} ${CI_CURRENCY_CLASS[currency.tone]}`} title={currency.title}>
      {currency.tone === 'current' ? (
        <CheckIcon size={11} />
      ) : currency.tone === 'stale' ? (
        <WarningIcon size={11} />
      ) : (
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
      )}
      {currency.label}
    </span>
  );
}

/** The "CI check" section. Local only (`me.ai`); null when there is nothing to say. */
export function CiCheckSection({
  pr,
  legacy = null,
  changedPaths,
  onOpenInChanges,
}: {
  pr: PrDetail;
  // The shown code review: its stored CI diagnosis is history, shown only when no CI review exists.
  legacy?: Pick<ClaudeReview, 'ciFailures' | 'headSha'> | null;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  const { data, isLoading, isError } = useCiReview(pr.id, ai.enabled);
  const start = useStartCiReview(pr.id);
  const starting = useCiReviewStarting(pr.id);
  const state = data?.state ?? null;
  const review = data?.review ?? null;
  const running = state?.status === 'running';
  const stream = useCiReviewStream(state?.runningRunId ?? null, running);
  // The result shown is the latest SUCCEEDED run: `review` when it is that run, else read by id.
  const latestOk = review?.status === 'succeeded' ? review : null;
  const { data: earlier } = useCiReviewById(
    latestOk == null && state?.latestRunId != null ? state.latestRunId : null,
  );
  const shown = latestOk ?? (earlier?.status === 'succeeded' ? earlier : null);
  const items = useMemo(() => orderCiFailures(shown?.items ?? []), [shown]);
  const legacyItems = useMemo(() => orderCiFailures(legacy?.ciFailures ?? []), [legacy]);

  if (!ai.enabled || isLoading) return null;
  const show = isError
    ? 'offer'
    : ciSectionShow({ review, state, legacyFailures: legacy?.ciFailures, prCiStatus: pr.ciStatus });
  if (show === 'hidden') return null;

  const currency = state != null && (shown != null || running) ? ciCurrency(state) : null;
  // A refusal of the newest attempt at the PR's current head (the server says which), and a run
  // that failed outright — only while it is the latest.
  const refused = !running ? (state?.refused ?? null) : null;
  const failed =
    !running && review?.status === 'failed' && review.refused == null ? (review.error ?? 'The check failed.') : null;
  const rows = show === 'legacy' ? legacyItems : items;
  const countPills = ciCountPills(rows);

  return (
    <ReviewSection
      title="CI check"
      pills={
        <>
          {currency != null && <CurrencyPill currency={currency} />}
          {shown != null && <ReviewedAgo at={shown.completedAt} />}
          {shown?.trigger === 'auto' && (
            <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300">
              {AUTO_REVIEW_LABEL}
            </span>
          )}
          {rows.length > 0 && <span className={`text-xs ${MUTED}`}>{ciFailingLabel(rows.length)}</span>}
          {countPills.map((p) => (
            <span key={p.key} className={`${REVIEW_CHIP} ${p.cls}`}>
              {p.label}
            </span>
          ))}
        </>
      }
      info={
        <InfoButton title="CI check">
          <p>
            Claude reads the end of each failing GitHub Actions job’s log and the code, and says why
            it failed and whether this PR can fix it.
          </p>
          <p className="mt-2">Checks outside GitHub Actions have no log to read, so they are listed only.</p>
          <p className="mt-2">When auto review is on, a check that fails is looked at on its own.</p>
        </InfoButton>
      }
      actions={
        !running ? (
          <AiRunGate>
            <button
              type="button"
              disabled={starting}
              onClick={() => start.mutate()}
              className={state?.status === 'stale' ? BTN_PRIMARY : BTN}
            >
              {ciCheckButtonLabel(shown != null, starting)}
            </button>
          </AiRunGate>
        ) : null
      }
    >
      <div className="empty:hidden">
        <RegenProgressBar
          active={running}
          label="Checking CI"
          value={ciProgressPct(stream.progress)}
          timeConstantSec={30}
        />
      </div>
      {running && (
        <p className={`text-xs ${MUTED}`}>
          {stream.progress != null ? CI_PHASE_LABEL[stream.progress.phase] : 'Starting'}…
        </p>
      )}
      {start.isError && <p className={`text-xs ${ERROR_TEXT}`}>{start.error.message || 'Could not start the check.'}</p>}
      {isError && <p className={`text-xs ${ERROR_TEXT}`}>Could not load the CI check.</p>}
      {refused != null && <p className={`text-xs ${MUTED}`}>{ciRefusalSentence(refused)}</p>}
      {failed != null && <p className={`text-xs ${ERROR_TEXT}`}>{failed}</p>}
      {show === 'legacy' && (
        <p className={REVIEW_META}>
          From an earlier Claude review
          {legacy?.headSha != null && legacy.headSha !== '' ? (
            <>
              {' '}of <span className="font-mono">{legacy.headSha.slice(0, 7)}</span>
            </>
          ) : null}
          .
        </p>
      )}
      {show === 'ci' && shown?.summary != null && shown.summary !== '' && <Markdown prRefs>{shown.summary}</Markdown>}
      {rows.length > 0 && (
        <ul className="space-y-1.5">
          {show === 'legacy'
            ? legacyItems.map((f) => (
                <CiFailureRow
                  key={`${f.checkName}:${f.jobId ?? ''}`}
                  f={f}
                  changedPaths={changedPaths}
                  onOpenInChanges={onOpenInChanges}
                />
              ))
            : items.map((f) => (
                <CiFailureRow
                  key={f.id}
                  f={f}
                  suggestion={f.suggestion}
                  changedPaths={changedPaths}
                  onOpenInChanges={onOpenInChanges}
                />
              ))}
        </ul>
      )}
      {show !== 'legacy' && shown == null && !running && refused == null && failed == null && (
        <p className={`text-xs ${MUTED}`}>Not checked yet.</p>
      )}
    </ReviewSection>
  );
}
