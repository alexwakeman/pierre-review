// CHECK A STORY AGAINST THE DOCS — the Story section's docs block (TicketStorySection.tsx; docs/FRONTEND.md
// § The story view). CORE, free, LOCAL ONLY (`me.ai.enabled`), and only on a CLICK: Claude Sonnet reads the
// workspace's reference library — all of it when it is short, else the sections Claude Haiku picks — and says where the story matches them and where it does not.
//
//   StoryDocsButton           "Check against docs" / "Check docs again" / "Check again anyway" (after a
//                             click the server answered `reused`: the forced re-run) — one of the STORY'S
//                             ACTIONS, in the Story section's heading row (TicketStorySection.tsx), not in the block
//   StoryDocsAlignmentBlock   the heading, the ⓘ, progress, failure, refusal, "Nothing has changed since
//                             this check." (a click the server answered `reused`), and the whole-story
//                             result: verdict, 2-3 sentences, actionable bullets, points on other parts
//                             of the story, and — when the notes cannot sit under the section's own
//                             criteria — the run's own numbered list
//   StoryDocsCriterionDetail  ONE criterion's note, drawn UNDER that criterion's row (both criteria
//                             lists of the Story section take it through an optional prop)
//   StoryDocsRefLinks         every reference: the in-app library link (DocLink) and its quote beneath
//
// Every point was kept by the server only because its quote was found in the linked section, so the
// lists are drawn as stored. The button and the block share the section's ONE start mutation, so a
// refusal or error from the heading click shows in the block. All text is PLAIN TEXT. A verdict is a WORD and an icon, never a colour alone.
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import {
  STORY_DOCS_ITEM_VERDICT_LABEL,
  STORY_DOCS_OVERALL_VERDICT_LABEL,
  STORY_DOCS_REFUSAL_TEXT,
  type StartStoryDocsAlignmentResponse,
  type StoryDocsAlignmentResponse,
  type StoryDocsAlignmentRun,
  type StoryDocsCriterionItem,
  type StoryDocsItemVerdict,
  type StoryDocsOverallVerdict,
  type StoryDocsRef,
} from '@pierre-review/shared';
import { useAiCapabilities, useAiProvider, useAiProviderName } from '../../hooks/useAiCapabilities.js';
import type { StartStoryDocsVars } from '../../hooks/useStoryDocsAlignment.js';
import { TICKET_CRITERION_STATUS_CLASS, OUTDATED_CLASS } from '../../lib/claudeReviewFollowUp.js';
import { citationLabel } from '../../lib/referenceDocs.js';
import { REVIEW_CHIP, REVIEW_PROSE } from '../../lib/reviewStyles.js';
import { clickMessageStale, docsButtonLabel, docsChecking, docsProgressPct, docsProgressText, shownRun } from '../../lib/storyDocsAlignment.js';
import { RegenProgressBar } from './RegenProgressBar.js';
import { AiRunGate } from '../AiSetup.js';
import { DocLink } from '../DocReferences.js';
import { CheckCircleIcon, PartialCircleIcon, WarningIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { AiStatusLine } from '../AiStatusLine.js';
import { AiRunLabel } from '../AiRunLabel.js';
import { aiModelWords, aiRunProviderName } from '@pierre-review/shared';
import { InlineMarkdown } from '../InlineMarkdown.js';

const MUTED = 'text-ui-mute';
const BTN =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2 text-meta text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-40 touch:h-10 touch:px-3';

type Tone = 'good' | 'mid' | 'bad';
const OVERALL_TONE: Record<StoryDocsOverallVerdict, Tone> = { aligned: 'good', mixed: 'mid', diverges: 'bad' };
const ITEM_TONE: Record<StoryDocsItemVerdict, Tone> = { aligned: 'good', partly: 'mid', diverges: 'bad' };
// The measured chip palette the ticket review's criteria already wear (met / partly met / not met).
const TONE_CLASS: Record<Tone, string> = {
  good: TICKET_CRITERION_STATUS_CLASS.met,
  mid: TICKET_CRITERION_STATUS_CLASS.partly_met,
  bad: TICKET_CRITERION_STATUS_CLASS.not_met,
};

function ToneIcon({ tone }: { tone: Tone }): JSX.Element {
  if (tone === 'good') return <CheckCircleIcon size={11} aria-hidden />;
  if (tone === 'mid') return <PartialCircleIcon size={11} aria-hidden />;
  return <WarningIcon size={11} aria-hidden />;
}

/** Every reference: the library link, then the quote it rests on. */
export function StoryDocsRefLinks({ refs }: { refs: readonly StoryDocsRef[] }): JSX.Element | null {
  if (refs.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1">
      {refs.map((r, i) => (
        <li key={`${r.path}#${r.anchor ?? ''}-${i}`}>
          <DocLink target={r}>{citationLabel(r)}</DocLink>
          <blockquote className="mt-0.5 border-l-2 border-ui-line pl-2 text-meta italic text-ui-ink">
            {r.quote}
          </blockquote>
        </li>
      ))}
    </ul>
  );
}

/** One criterion's note against the docs, drawn under the criterion's own row. */
export function StoryDocsCriterionDetail({ item }: { item: StoryDocsCriterionItem }): JSX.Element {
  const tone = ITEM_TONE[item.verdict];
  return (
    <div className="mt-1 rounded-ui border-l-2 border-ui-line py-0.5 pl-2" data-testid="story-docs-criterion">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className={`${REVIEW_CHIP} ${TONE_CLASS[tone]}`}>
          <ToneIcon tone={tone} />
          {`Docs: ${STORY_DOCS_ITEM_VERDICT_LABEL[item.verdict]}`}
        </span>
        {item.note !== '' && <span className="min-w-0 break-words text-meta text-ui-ink">{item.note}</span>}
      </div>
      <StoryDocsRefLinks refs={item.refs} />
    </div>
  );
}

function StoryDocsInfo(): JSX.Element {
  const provider = useAiProvider();
  const name = useAiProviderName();
  return (
    <InfoButton title="Check against the docs">
      <p>
        {name} reads this story — its description and acceptance criteria — against the workspace's reference docs
        (Activity → Docs).
      </p>
      <p>
        When the docs are short, {aiModelWords(provider, 'Sonnet')} reads all of them. Otherwise {aiModelWords(provider, 'Haiku')} first
        picks up to 8 sections that could matter, and {aiModelWords(provider, 'Sonnet')} reads those. It says where the story matches
        the docs and where it does not.
      </p>
      <p>
        It only comments on criteria the docs say something about. Every point links to the passage it rests on; anything it
        could not back with an exact quote is left out.
      </p>
      <p>
        The criteria are the ones shown here: from the AI check against the pull requests, else from the sprint summary,
        else worked out from the description.
      </p>
      <p>
        It runs only when you press the button, on your own {name}. If nothing has changed since the last check, you get that
        check back. Out of date means the story, its criteria or the docs changed since.
      </p>
    </InfoButton>
  );
}

/** This mount's click was answered with the last good check (nothing changed since), and that check is
 *  still the one shown. The block says so; the heading's button becomes the forced re-run. */
function reusedAnswer(
  data: StoryDocsAlignmentResponse,
  start: UseMutationResult<StartStoryDocsAlignmentResponse, Error, StartStoryDocsVars>,
  starting: boolean,
): boolean {
  const clickStale = starting || clickMessageStale(data.run, start.submittedAt);
  return !clickStale && start.data?.outcome === 'reused' && shownRun(data)?.id === start.data.runId;
}

/** The Story heading's docs action. Only where agentic AI runs and the workspace has docs to check
 *  against (`available`), behind the one AiRunGate. */
export function StoryDocsButton({
  q,
  start,
  starting,
}: {
  q: UseQueryResult<StoryDocsAlignmentResponse>;
  start: UseMutationResult<StartStoryDocsAlignmentResponse, Error, StartStoryDocsVars>;
  starting: boolean;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  const data = q.data;
  if (!ai.enabled || data == null || !data.available) return null;
  // After a click the server answered from the last check, the next press runs anyway.
  const force = reusedAnswer(data, start, starting);
  return (
    <AiRunGate kind="story_docs">
      <button type="button" className={BTN} disabled={docsChecking(data, starting)} onClick={() => start.mutate(force ? { force: true } : undefined)}>
        {force ? 'Check again anyway' : docsButtonLabel(data, starting)}
      </button>
    </AiRunGate>
  );
}

export function StoryDocsAlignmentBlock({
  q,
  start,
  starting,
  attached,
}: {
  q: UseQueryResult<StoryDocsAlignmentResponse>;
  start: UseMutationResult<StartStoryDocsAlignmentResponse, Error, StartStoryDocsVars>;
  /** A click for this ticket is in flight in any mount. */
  starting: boolean;
  /** The per-criterion notes sit under the section's own criteria rows (else they are drawn here). */
  attached: boolean;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  const data = q.data;
  if (!ai.enabled || data == null) return null;
  const shown = shownRun(data);
  if (!data.available && data.run == null && shown == null) return null;
  const checking = docsChecking(data, starting);
  const progress = checking ? docsProgressText(data.run?.status, starting) : null;
  // While a click is pending the old run is still `data.run`: never show its failure under "Starting…".
  // This mount's own click answer, hidden while a click is pending and once a newer run exists.
  const clickStale = starting || clickMessageStale(data.run, start.submittedAt);
  // A click answered `reused` makes the good run the answer: an older failure no longer speaks for it.
  const failed = !starting && data.run?.status === 'failed' && !(!clickStale && start.data?.outcome === 'reused') ? data.run : null;
  const refusal = !clickStale && start.data?.outcome === 'refused' ? STORY_DOCS_REFUSAL_TEXT[start.data.refusal] : null;
  // The click was answered with the last good check (nothing changed since): say so — the heading's
  // button is now "Check again anyway" (run buttons live in the Story heading, never in a block).
  const reused = reusedAnswer(data, start, starting);
  return (
    <section aria-label="Docs check" className="scroll-mt-4 space-y-2 focus:outline-none" data-testid="story-docs" data-story-section="docs">
      <div className="flex flex-wrap items-center gap-1.5">
        <h4 className="text-body font-medium text-ui-ink">Docs check</h4>
        <StoryDocsInfo />
        {shown != null && <AiRunLabel provider={shown.provider} model={shown.model} />}
        {shown != null && !shown.current && !checking && (
          <span className={`${REVIEW_CHIP} ${OUTDATED_CLASS}`}>
            <WarningIcon size={11} aria-hidden />
            Out of date
          </span>
        )}
      </div>
      {/* The bar: each stored step has its share, eased by the time since the run began, so a reload
          draws it again where it was. It fills and fades when the check ends. */}
      <RegenProgressBar
        active={checking}
        label="Checking the story against the docs"
        value={checking && !starting && data.run != null ? docsProgressPct(data.run.status, Date.now() - Date.parse(data.run.createdAt)) : null}
        timeConstantSec={30}
      />
      {progress != null && (
        <AiStatusLine
          stage={progress}
          since={!starting && data.run != null ? data.run.createdAt : null}
        />
      )}
      {failed != null && <p className="text-meta text-ui-danger">{failed.error ?? 'The docs check failed.'}</p>}
      {refusal != null && <p className={`text-meta ${MUTED}`}>{refusal}</p>}
      {reused && <p className={`text-meta ${MUTED}`}>Nothing has changed since this check.</p>}
      {start.isError && !clickStale && <p className="text-meta text-ui-danger">{start.error.message}</p>}
      {shown != null && <StoryDocsResultView run={shown} attached={attached} />}
    </section>
  );
}

/**
 * The wide story layout's rail: the docs check in one line — its verdict (or "Checking…", "Not checked
 * yet") and "Out of date" — the whole block stays in the reading column ("Docs" in the section nav).
 * Rendered only in the rail (`InRail slot="docs"`, rail-only), under the same condition as the block.
 */
export function StoryDocsRailSummary({
  q,
  starting,
}: {
  q: UseQueryResult<StoryDocsAlignmentResponse>;
  starting: boolean;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  const data = q.data;
  if (!ai.enabled || data == null) return null;
  const shown = shownRun(data);
  if (!data.available && data.run == null && shown == null) return null;
  const checking = docsChecking(data, starting);
  const overall = shown?.result?.overall ?? null;
  const outcome = shown?.result?.outcome ?? null;
  const tone = overall != null ? OVERALL_TONE[overall.verdict] : null;
  return (
    <div data-testid="story-docs-rail">
      <p className="mb-1 text-meta text-ui-mute">Docs check</p>
      <div className="flex flex-wrap items-center gap-1.5 text-body text-ui-ink">
        {checking ? (
          <span>{docsProgressText(data.run?.status, starting)}</span>
        ) : shown == null ? (
          <span className="text-ui-mute">Not checked yet</span>
        ) : overall != null && tone != null ? (
          <span className={`${REVIEW_CHIP} ${TONE_CLASS[tone]}`}>
            <ToneIcon tone={tone} />
            {STORY_DOCS_OVERALL_VERDICT_LABEL[overall.verdict]}
          </span>
        ) : (
          <span className="text-ui-mute">{outcome === 'no_relevant_docs' ? 'No docs bear on this story' : 'Nothing to report'}</span>
        )}
        {shown != null && !shown.current && !checking && (
          <span className={`${REVIEW_CHIP} ${OUTDATED_CLASS}`}>
            <WarningIcon size={11} aria-hidden />
            Out of date
          </span>
        )}
      </div>
    </div>
  );
}

function StoryDocsResultView({ run, attached }: { run: StoryDocsAlignmentRun; attached: boolean }): JSX.Element | null {
  // A finished check names the provider that RAN it, never the active one.
  const name = aiRunProviderName(run);
  const result = run.result;
  if (result == null) return null;
  if (result.outcome === 'no_relevant_docs') {
    return <p className={`text-meta ${MUTED}`}>Nothing in the reference docs bears on this story.</p>;
  }
  if (result.outcome === 'nothing_grounded' || result.overall == null) {
    return <p className={`text-meta ${MUTED}`}>{name} found nothing it could back with a quote from the docs.</p>;
  }
  const overall = result.overall;
  const tone = OVERALL_TONE[overall.verdict];
  // The notes not drawn under the section's own rows: the run's own numbered list. A derived run lists
  // every criterion Claude worked out; any other only the ones with a note.
  const derived = run.criteriaSource === 'derived';
  const itemsByN = new Map(result.criteria.map((c) => [c.n, c]));
  const ownList = attached ? [] : run.criteria.filter((c) => derived || itemsByN.has(c.n));
  return (
    <div className="space-y-2">
      <div>
        <span className={`${REVIEW_CHIP} ${TONE_CLASS[tone]}`}>
          <ToneIcon tone={tone} />
          {STORY_DOCS_OVERALL_VERDICT_LABEL[overall.verdict]}
        </span>
      </div>
      <p className={`${REVIEW_PROSE} text-ui-ink`}>{overall.summary}</p>
      {overall.actions.length > 0 && (
        <div className="space-y-1">
          <h5 className="text-meta font-medium text-ui-mute">What to do</h5>
          <ul className="list-disc space-y-1.5 pl-5">
            {overall.actions.map((a, i) => (
              <li key={i} className="text-body text-ui-ink">
                <InlineMarkdown className="break-words">{a.text}</InlineMarkdown>
                <StoryDocsRefLinks refs={a.refs} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.storyParts.length > 0 && (
        <div className="space-y-1">
          <h5 className="text-meta font-medium text-ui-mute">Other parts of the story</h5>
          <ul className="space-y-1.5">
            {result.storyParts.map((p, i) => {
              const t = ITEM_TONE[p.verdict];
              return (
                <li key={i} className="rounded-ui bg-ui-raise px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-1.5">
                    <span className="text-body font-semibold text-ui-ink">{p.part}</span>
                    <span className={`${REVIEW_CHIP} ${TONE_CLASS[t]}`}>
                      <ToneIcon tone={t} />
                      {STORY_DOCS_ITEM_VERDICT_LABEL[p.verdict]}
                    </span>
                  </div>
                  {p.note !== '' && <p className="mt-0.5 break-words text-meta text-ui-ink">{p.note}</p>}
                  <StoryDocsRefLinks refs={p.refs} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {ownList.length > 0 && (
        <div className="space-y-1">
          <h5 className="text-meta font-semibold text-ui-ink">
            {derived ? 'Criteria worked out from the description' : 'Criteria as they read when checked'}
          </h5>
          <ol className="space-y-1" aria-label="Criteria checked against the docs">
            {ownList.map((c) => {
              const item = itemsByN.get(c.n);
              return (
                <li key={c.n} className="flex flex-col px-1">
                  <div className="flex items-baseline gap-2 text-body text-ui-ink">
                    <span className={`w-5 shrink-0 text-right font-mono text-meta ${MUTED}`}>{c.n}</span>
                    <InlineMarkdown className="min-w-0 break-words">{c.text}</InlineMarkdown>
                  </div>
                  {item != null && (
                    <div className="pl-7">
                      <StoryDocsCriterionDetail item={item} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
