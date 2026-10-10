import {
  SPRINT_CHECKS_DEFAULT,
  applyStoryIssueChecks,
  foldStoryIssues,
  usableStoryLabel,
  type SprintChecks,
  type SprintLabelState,
  type StoryCriteriaSource,
  type StoryIssue,
  type StoryIssueLabel,
  type TrackerProvider,
} from '@pierre-review/shared';
import { acceptanceSectionOf, extractCriteria } from './story-criteria.js';

// REPORTS → THIS SPRINT — A TICKET'S ISSUES (pure; sprint-chips.test.ts). The FOUR story issues
// (`foldStoryIssues`, shared story-issues.ts) over the ticket's numbered criteria and its CURRENT
// stored label, then the workspace's checks (`applyStoryIssueChecks`) — HERE, so flagCount, the
// order and Copy all agree with what is on screen.
//
// ⚠ A LABEL HALF NEEDS A CURRENT LABEL — the caller hands in only the label whose text hash equals
// today's `storyLabelInput` hash; the fold also ignores a label that judged a different NUMBER of
// criteria than today's list. With no usable label only "no criteria" and "more than 8 criteria" show.
// The criteria are the ONE extractor's (`extractCriteria`), over the criteria field, else the
// description's "Acceptance criteria" section — the same rule `storyLabelInput` sends the labeller.

export interface SprintChipInput {
  provider: TrackerProvider;
  description: string;
  acceptanceCriteria: string;
  /** The ticket's issue type name, for the workspace's checks. */
  issueType?: string | null;
  /** The CURRENT label only (text hash matches today's); null when there is none. */
  label: StoryIssueLabel | null;
}

/** The ticket's numbered criteria and where they came from. */
export function sprintCriteriaOf(
  t: { description: string; acceptanceCriteria: string },
  provider: TrackerProvider,
): { items: string[]; source: StoryCriteriaSource } {
  const jira = provider === 'jira';
  const field = extractCriteria(t.acceptanceCriteria, { jira });
  if (field.length > 0) return { items: field, source: 'acceptance_criteria' };
  const section = acceptanceSectionOf(t.description, { jira });
  const fromDescription = section == null ? [] : extractCriteria(section, { jira });
  if (fromDescription.length > 0) return { items: fromDescription, source: 'description_heading' };
  return { items: [], source: 'none' };
}

/** The issues this workspace raises on one ticket, in STORY_ISSUES order (≤ 4). */
export function sprintIssuesFor(i: SprintChipInput, checks: SprintChecks = SPRINT_CHECKS_DEFAULT): StoryIssue[] {
  const { items } = sprintCriteriaOf(i, i.provider);
  return applyStoryIssueChecks(foldStoryIssues({ criteria: items, label: i.label }), checks, i.issueType ?? null);
}

/** The label half's state on this ticket. */
export function sprintLabelState(i: SprintChipInput, aiEnabled: boolean): SprintLabelState {
  if (!aiEnabled) return 'off';
  const { items } = sprintCriteriaOf(i, i.provider);
  if (items.length === 0) return 'none';
  return usableStoryLabel({ criteria: items, label: i.label }) != null ? 'current' : 'pending';
}
