import {
  STORY_MISSING_HEADING,
  TICKET_CRITERION_STATUS_LABEL,
  storyBuildIsGap,
  type StoryBuild,
  type StoryBuildCoverageCriterion,
  type StoryBuildPlanCriterion,
} from '@pierre-review/shared';
import { TICKET_CRITERION_STATUS_CLASS } from '../../lib/claudeReviewFollowUp.js';
import { REVIEW_CHIP, REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import { InfoButton } from '../InfoModal.js';
import { StoryBuildSection } from './StoryBuildSection.js';

// "ALREADY DONE" — the gap fold the session froze at assess time (`StoryBuild.coverage`): the criteria
// the ticket's existing pull requests already meet (with their PR numbers), the gaps this build covers,
// and what the ticket asks for outside its criteria. A check that could not be used says so in one line.
// Each row carries an anchor (`story-build-ref-<ref>`) the build's change report jumps to.

export function storyBuildRefAnchor(ref: string): string {
  return `story-build-ref-${ref}`;
}

const HOW_WORDS: Record<StoryBuildPlanCriterion['how'], string> = {
  existing: 'Done already',
  planned: 'In the plan',
  not_planned: 'Not in the plan',
};

function coverageLine(b: StoryBuild): string | null {
  const c = b.coverage;
  if (c == null) return null;
  if (c.note != null) return c.note;
  switch (c.state) {
    case 'none':
      return 'The ticket has no pull requests: every criterion is a gap.';
    case 'stale':
      return 'The last ticket check is out of date: it may say less than the pull requests do.';
    case 'failed':
      return 'Couldn’t check the existing pull requests: building every criterion.';
    default:
      return null;
  }
}

export function CoverageSection({ build }: { build: StoryBuild }): JSX.Element | null {
  const c = build.coverage;
  if (c == null) return null;
  const met = c.criteria.filter((x) => !storyBuildIsGap(x));
  const gaps = c.criteria.filter(storyBuildIsGap);
  const prNumber = new Map(c.existingPrs.map((p) => [p.prId, p.number]));
  const how = new Map((build.plan?.criteria ?? []).map((p) => [p.ref, p]));
  const repoName = new Map((build.candidates ?? []).map((r) => [r.ref, r.fullName.split('/').pop() ?? r.fullName]));
  const line = coverageLine(build);
  return (
    <StoryBuildSection
      testId="story-build-coverage"
      title="Already done"
      info={
        <InfoButton title="Already done">
          <p>What the ticket&rsquo;s existing pull requests already deliver, from its latest ticket check.</p>
          <p>The build covers only the gaps. A criterion the check could not judge counts as a gap.</p>
        </InfoButton>
      }
    >
      {line != null && <p className="mb-2 text-meta text-ui-mute">{line}</p>}
      {met.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {met.map((x) => (
            <CriterionLine key={x.ref} c={x} extra={x.coveredByPrIds.map((id) => (prNumber.has(id) ? `#${prNumber.get(id)}` : null)).filter((s): s is string => s != null)} />
          ))}
        </ul>
      )}
      {gaps.length > 0 && (
        <>
          <h4 className={`${REVIEW_SUBHEAD} mb-1`}>Gaps this build covers ({gaps.length})</h4>
          <ul className="mb-3 space-y-1.5">
            {gaps.map((x) => {
              const p = how.get(x.ref);
              const word = p != null ? (p.how === 'planned' && p.repo != null && repoName.has(p.repo) ? `In the plan: ${repoName.get(p.repo)}` : HOW_WORDS[p.how]) : null;
              return <CriterionLine key={x.ref} c={x} extra={word != null ? [word] : []} reason={p?.how === 'not_planned' ? p.reason : null} />;
            })}
          </ul>
        </>
      )}
      {c.missing.length > 0 && (
        <>
          <h4 className={`${REVIEW_SUBHEAD} mb-1`}>
            {STORY_MISSING_HEADING} ({c.missing.length})
          </h4>
          <ul className="space-y-1.5">
            {c.missing.map((m) => {
              const p = how.get(m.ref);
              return (
                <li key={m.ref} id={storyBuildRefAnchor(m.ref)} className="flex flex-wrap items-baseline gap-x-2 text-body text-ui-ink">
                  <span className="font-mono text-meta text-ui-mute">{m.ref}</span>
                  <span className="min-w-0 flex-1">{m.text}</span>
                  {p != null && <span className="text-meta text-ui-mute">{HOW_WORDS[p.how]}</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </StoryBuildSection>
  );
}

function CriterionLine({ c, extra, reason = null }: { c: StoryBuildCoverageCriterion; extra: string[]; reason?: string | null }): JSX.Element {
  return (
    <li id={storyBuildRefAnchor(c.ref)} data-testid="story-build-criterion" className="text-body text-ui-ink">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-meta text-ui-mute">{c.ref}</span>
        <span className={`${REVIEW_CHIP} ${TICKET_CRITERION_STATUS_CLASS[c.verdict]}`}>{TICKET_CRITERION_STATUS_LABEL[c.verdict]}</span>
        <span className="min-w-0 flex-1">{c.text}</span>
        {extra.map((e) => (
          <span key={e} className="text-meta text-ui-mute">
            {e}
          </span>
        ))}
      </div>
      {reason != null && <p className="ml-8 mt-0.5 text-meta text-ui-mute">{reason}</p>}
    </li>
  );
}
