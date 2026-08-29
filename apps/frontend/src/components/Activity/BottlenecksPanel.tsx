import { useMemo } from 'react';
import type { User } from '@pierre-review/shared';
import { useFlowFindings } from '../../hooks/useFlowFindings.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import {
  CheckCircleIcon,
  ExternalLinkIcon,
  InfoIcon,
  PartialCircleIcon,
  PullRequestIcon,
  ThinSampleIcon,
} from '../Icons.js';
import { metaFor } from './AttentionCards.js';
import {
  buildBottlenecksModel,
  type BottleneckRow,
  type BottleneckSection,
} from './bottlenecksModel.js';

// ── BOTTLENECKS — the human layer of the Reports pane ─────────────────────────────────────────
//
// The Bots rail answers "is this bot worth its seat". This answers the twin question: WHERE DOES
// HUMAN REVIEW TIME GO, and what keeps costing it. The header says so out loud and points at the
// twin, because the two surfaces measure different populations with deliberately similar
// machinery and a reader who confuses them draws the wrong conclusion from both.
//
// CORE and FREE ON EVERY TIER — no `useProCapabilities`, no nudge, no wall. It renders identically
// under `npx pierre-review` with no plugin present, which is why the Reports rail entry being
// un-gated matters: this is the second free surface behind it.
//
// ⚠ EVERY SENTENCE ON SCREEN IS THE SERVER'S TEMPLATED PROSE, rendered verbatim. There is no
// narration seam here and there must not be one: an EM makes staffing decisions off this screen,
// and a generated headline would launder an unverified figure into it (`db/flow-findings.ts`
// carries the same note at the other end of the wire).
//
// ── WHAT THIS FILE MAY NOT BECOME ────────────────────────────────────────────────────────────
// ⚠ THE SUBJECT OF A ROW IS THE FLOW, NEVER A PERSON. Every row leads with `subject` — a
// directory, a repo, a size band — and people appear ONLY as chips INSIDE a row, under a caption
// saying what they are evidence of. No sort by person, no group by person, no person-vs-person
// column, no leaderboard. The moment a row's subject becomes an engineer this is a performance
// dashboard, which is a different product with a much worse reason to exist.
// ⚠ REFUSALS RENDER. A kind that could not clear its sample floor gets a NAMED "not enough data
// to say X" line. Dropping it would make the panel claim it checked and found nothing, which is a
// far stronger statement than the one the data supports.
// ⚠ VALUE AND BASELINE ALWAYS RENDER TOGETHER, and `sampleSize` on every row — it is the reader's
// only defence against a confident number computed from four threads.

/**
 * The window, in days. Sent EXPLICITLY rather than relying on the route's default so the query
 * key names the window it actually measured — a server-side default change would otherwise move
 * every cached answer without moving its key. The server clamps to [7, 90] regardless, and the
 * response echoes `windowDays`, which is what the coverage line renders.
 */
const FLOW_WINDOW_DAYS = 30;

/** `FlowFindingPrRef` carries no `authorId` — a finding's evidence is a PR the CLAIM rests on,
 *  not a PR whose author is part of the claim — so there is nothing to resolve an author against.
 *  A named empty map says that, where a bare `new Map()` at the call site would read as an
 *  oversight (and allocate per row per render). */
const NO_AUTHOR_LOOKUP: Map<number, User> = new Map();

function SubjectChip({ label }: { label: string }): JSX.Element {
  return (
    <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {label}
    </span>
  );
}

/** A person implicated by a finding — INSIDE a row, never a row. */
function ActorChip({ id, user }: { id: number; user: User | undefined }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px]">
      <Avatar user={user} size={13} />
      <UserName user={user} fallbackId={id} />
    </span>
  );
}

function EvidenceLinks({ row }: { row: BottleneckRow }): JSX.Element | null {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  if (row.evidence.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-[11px] text-gray-400">Behind this:</span>
      {row.evidence.map((pr) => {
        const label = `${pr.repoFullName}#${pr.prNumber}`;
        // Opened through the SAME path every other Activity card uses (AttentionCards' metaFor +
        // openPrDetailTab with `fromActivity`), so the tab, its chrome and the Back-to-Activity
        // arming are identical to a click from the Pending board — rather than a `PinnedPr`
        // literal built beside it that drifts. The author chrome backfills when PrDetail loads
        // and calls syncMeta.
        const meta = metaFor(
          {
            prId: pr.prId,
            prNumber: pr.prNumber,
            prTitle: pr.prTitle,
            repoFullName: pr.repoFullName,
          },
          NO_AUTHOR_LOOKUP,
        );
        const href = safeExternalUrl(pr.githubUrl);
        return (
          <span key={pr.prId} className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => openPrDetailTab(meta, { fromActivity: true })}
              title={pr.prTitle}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
            >
              <PullRequestIcon size={11} />
              {label}
            </button>
            {href != null && (
              // ⚠ `githubUrl` is data-derived, so it goes through safeExternalUrl — React renders
              // a `javascript:` href with nothing but a console warning.
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                <ExternalLinkIcon size={10} title={`Open ${label} on GitHub`} />
              </a>
            )}
          </span>
        );
      })}
    </div>
  );
}

function FindingRow({ row }: { row: BottleneckRow }): JSX.Element {
  return (
    <li
      data-testid="bottleneck-row"
      className="rounded-lg border border-gray-200 p-3 dark:border-gray-800"
    >
      {/* THE SUBJECT LEADS. A kind chip, then the flow itself, verbatim and monospaced — a
          directory, a repo or a size band reads as a thing you can change. */}
      <div className="flex flex-wrap items-baseline gap-2">
        <SubjectChip label={row.subjectKindLabel} />
        <span
          data-testid="bottleneck-subject"
          className="font-mono text-[12px] font-semibold text-gray-800 dark:text-gray-100"
        >
          {row.subject}
        </span>
        {/* Value AND baseline, in the same unit, in one breath. A magnitude with no comparison
            is not a finding, so these never render apart. */}
        <span className="ml-auto whitespace-nowrap text-[11px] text-gray-500 dark:text-gray-400">
          <strong className="text-[13px] font-semibold text-gray-800 dark:text-gray-100">
            {row.value}
          </strong>{' '}
          vs {row.baseline} {row.baselineLabel}
        </span>
      </div>

      {/* Templated, code-written, verbatim. */}
      <p className="mt-1.5 text-[12px] text-gray-700 dark:text-gray-200">{row.headline}</p>
      <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">{row.detail}</p>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-gray-100 pt-2 dark:border-gray-800/60">
        {/* ON EVERY ROW, never behind a hover: how many observations the figure rests on. */}
        <span
          className="inline-flex items-center gap-1 text-[11px] text-gray-400"
          title="How many observations this figure was computed from"
        >
          <ThinSampleIcon size={10} />
          from {row.sample}
        </span>
        <EvidenceLinks row={row} />
      </div>

      {row.actors.length > 0 && (
        // People, INSIDE the row, under a caption naming what they are evidence OF. This block is
        // never the row's heading, never sorted on, and never counted across rows.
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[11px] text-gray-400">{row.actorCaption}:</span>
          {row.actors.map((a) => (
            <ActorChip key={a.id} id={a.id} user={a.user} />
          ))}
        </div>
      )}
    </li>
  );
}

function Section({
  section,
  windowDays,
}: {
  section: BottleneckSection;
  windowDays: number;
}): JSX.Element {
  return (
    <section className="space-y-1.5" data-testid={`bottleneck-section-${section.kind}`}>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        {section.label}
      </h4>
      {section.state === 'findings' ? (
        <ul className="space-y-2">
          {section.rows.map((r) => (
            <FindingRow key={r.id} row={r} />
          ))}
        </ul>
      ) : section.state === 'refused' ? (
        // ⚠ THE REFUSAL IS THE OUTPUT. Named, with the server's reason verbatim — "we could not
        // say this" is information, and hiding it would upgrade it to "there is nothing here".
        <p
          data-testid="bottleneck-refusal"
          className="flex items-start gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400"
        >
          <InfoIcon size={12} className="mt-0.5 shrink-0" />
          <span>
            <strong className="font-medium">Not enough data to say.</strong>{' '}
            {section.refusalReason}
          </span>
        </p>
      ) : (
        // Floors cleared, nothing crossed a threshold. This is the ONLY state entitled to say
        // "nothing stands out", and it says so in its own words rather than borrowing the
        // refusal's.
        <p className="flex items-start gap-1.5 rounded-lg border border-dashed border-gray-200 px-3 py-2 text-[11px] text-gray-400 dark:border-gray-800">
          <CheckCircleIcon size={12} className="mt-0.5 shrink-0" />
          {/* The server's own sentence names WHAT was measured ("Measured 10 directories … none
              combined a single dominant reviewer with a slower first read"), which is the useful
              half. The generic line stays as the fallback for the case where a kind emitted no
              refusal at all — an older backend, or a future kind that forgets to account for
              itself. */}
          <span>
            {section.refusalReason ??
              `Measured over the last ${windowDays} days — nothing here stands out.`}
          </span>
        </p>
      )}
    </section>
  );
}

export function BottlenecksPanel(): JSX.Element {
  // `workspaceId === null` means "not resolved yet" — the hook holds itself idle on skipToken
  // until it lands, so nothing workspace-scoped renders against another workspace's numbers.
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data, isPending, isError } = useFlowFindings(workspaceId, FLOW_WINDOW_DAYS);
  const model = useMemo(() => buildBottlenecksModel(data), [data]);
  // The panel covers the WHOLE workspace: the repo picker is Timeline-only, so there is no
  // `repoIds` here and nothing on this screen scopes it.

  return (
    <div className="space-y-3" data-testid="bottlenecks-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-[12px] font-semibold text-gray-700 dark:text-gray-200">
          Where human review time goes
        </h3>
        <span className="text-[11px] text-gray-400">
          The human layer of the review flow. Automation is measured on the Bots rail.
        </span>
      </div>

      {isError ? (
        <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          Could not measure this Workspace’s review flow just now.
        </p>
      ) : model == null || isPending ? (
        <div className="space-y-1.5 py-0.5" aria-hidden="true">
          {['62%', '94%', '80%'].map((w) => (
            <div key={w} className="digest-skeleton-line h-3.5" style={{ width: w }} />
          ))}
        </div>
      ) : (
        <>
          {/* ⚠ ALWAYS ON SCREEN. Retroactive history is coverage-biased and the reader should not
              have to know that — so the panel states what it measured, and flags partial coverage
              or a capped scan as a caution rather than leaving it to be inferred. */}
          <p className="text-[11px] text-gray-400">{model.coverageLine}</p>
          {model.coverageCaution != null && (
            <p
              data-testid="bottleneck-coverage-caution"
              className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300"
            >
              <PartialCircleIcon size={11} className="mt-0.5 shrink-0" />
              <span>{model.coverageCaution}</span>
            </p>
          )}

          {model.nothingStandsOut ? (
            // Nothing found AND nothing refused: every kind cleared its floors and none crossed a
            // threshold. An honest "nothing stands out" rather than a blank pane — and distinct
            // from the per-kind refusals, which say something much weaker.
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
              Nothing stands out in this Workspace’s review flow.
              <div className="mt-1 text-[11px]">
                Every check cleared its sample floor over the last {model.windowDays} days and none
                of them found a wait worth naming.
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* FRAMING ONLY. Four dashed boxes with one reason between them (the empty-workspace
                  case) reads as a broken panel; this line says it is deliberate. ⚠ It never
                  replaces the sections — each refusal still renders under its own name, because
                  that name is the "X" in "not enough data to say X". */}
              {model.allRefused && (
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  Nothing could be measured here yet. Each check below says what it was missing.
                </p>
              )}
              {model.sections.map((s) => (
                <Section key={s.kind} section={s} windowDays={model.windowDays} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
