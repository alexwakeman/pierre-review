import {
  SPRINT_CHIP_ORDER,
  sprintChipFix,
  type SprintChip,
  type SprintChipId,
  type SprintLabelState,
  type StoryCriteriaSource,
  type StoryCriterionLabel,
  type StoryLevelLabels,
  type TrackerProvider,
} from '@pierre-review/shared';
import { acceptanceSectionOf, extractCriteria } from './story-criteria.js';
import { STORY_LABEL_CRITERION_MAX_CHARS } from './story-label-input.js';
import { userValueStated } from './story-user-value.js';

// REPORTS → THIS SPRINT — THE CHIPS (pure; sprint-chips.test.ts). Each sprint ticket carries the
// flags a reader can act on before the work starts, from TWO sources labelled apart on screen:
//
//   CODE   no_criteria · criteria_not_in_field (Jira only: Linear and GitHub Issues keep criteria in
//          the body, so a criteria section there is the right place) · user_value_missing (the ONE
//          rule, db/story-user-value.ts).
//   LABEL  the six stored story labels (review/story-labels, Haiku, `STORY_RUBRIC_VERSION`):
//          per criterion testable / bundled / dependsOnOtherWork; per story outOfScopeStated /
//          dependencyNamed / nonCodeWork.
//
// ⚠ A LABEL CHIP NEEDS A CURRENT LABEL — the caller hands in only the label whose text hash equals
// today's `storyLabelInput` hash, and a label whose criteria count no longer matches today's
// numbered criteria is ignored here too (a criterion's n must point at the text it judged).
// ⚠ THE FIX TEXT IS TEMPLATED (`sprintChipFix`, shared) — never model text.
// The criteria are the ONE extractor's (`extractCriteria`), over the criteria field, else the
// description's "Acceptance criteria" section — the same rule `storyLabelInput` sends the labeller.

export interface SprintChipInput {
  provider: TrackerProvider;
  title: string;
  description: string;
  acceptanceCriteria: string;
  /** The CURRENT label only (text hash matches today's); null when there is none. */
  label: { criteria: StoryCriterionLabel[]; story: StoryLevelLabels } | null;
}

const clip = (s: string, max: number): string => {
  if (s.length <= max) return s;
  let cut = max;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return s.slice(0, cut);
};

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

/** The label usable for chips: present AND judged the same number of criteria as today's list. */
function usableLabel(i: SprintChipInput, items: readonly string[]): SprintChipInput['label'] {
  if (i.label == null || items.length === 0) return null;
  return i.label.criteria.length === items.length ? i.label : null;
}

/** Every chip of one ticket, in SPRINT_CHIP_ORDER (criterion chips by n within their id). */
export function sprintChipsFor(i: SprintChipInput): SprintChip[] {
  const { items, source } = sprintCriteriaOf(i, i.provider);
  const found: Array<{ id: SprintChipId; criterion: { n: number; text: string } | null }> = [];
  if (items.length === 0) found.push({ id: 'no_criteria', criterion: null });
  if (source === 'description_heading' && i.provider === 'jira') found.push({ id: 'criteria_not_in_field', criterion: null });
  if (!userValueStated([i.title, i.description, i.acceptanceCriteria].join('\n'))) {
    found.push({ id: 'user_value_missing', criterion: null });
  }
  const label = usableLabel(i, items);
  if (label != null) {
    const at = (n: number): { n: number; text: string } | null => {
      const text = items[n - 1];
      return text == null ? null : { n, text: clip(text, STORY_LABEL_CRITERION_MAX_CHARS) };
    };
    const byN = [...label.criteria].sort((a, b) => a.n - b.n);
    for (const c of byN) {
      const criterion = at(c.n);
      if (criterion == null) continue;
      if (!c.testable) found.push({ id: 'criterion_not_testable', criterion });
      if (c.bundled) found.push({ id: 'criterion_bundled', criterion });
      if (c.dependsOnOtherWork) found.push({ id: 'criterion_depends_on_other_work', criterion });
    }
    if (!label.story.outOfScopeStated) found.push({ id: 'out_of_scope_missing', criterion: null });
    if (label.criteria.some((c) => c.dependsOnOtherWork) && !label.story.dependencyNamed) {
      found.push({ id: 'dependency_not_named', criterion: null });
    }
    if (label.story.nonCodeWork) found.push({ id: 'non_code_work', criterion: null });
  }
  const rank = new Map(SPRINT_CHIP_ORDER.map((id, k) => [id, k]));
  return found
    .map((f, k) => ({ f, k }))
    .sort(
      (a, b) =>
        (rank.get(a.f.id) ?? 99) - (rank.get(b.f.id) ?? 99) ||
        (a.f.criterion?.n ?? 0) - (b.f.criterion?.n ?? 0) ||
        a.k - b.k,
    )
    .map(({ f }) => ({ id: f.id, criterion: f.criterion, fix: sprintChipFix(f.id, f.criterion) }));
}

/** The label half's state on this ticket. */
export function sprintLabelState(i: SprintChipInput, aiEnabled: boolean): SprintLabelState {
  if (!aiEnabled) return 'off';
  const { items } = sprintCriteriaOf(i, i.provider);
  if (items.length === 0) return 'none';
  return usableLabel(i, items) != null ? 'current' : 'pending';
}
