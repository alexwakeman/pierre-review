// The names of the three Do next weights — the ONE spelling, read by the board's explanations (a
// card's score rows, the guide's table, the header popover, Help). The weights themselves are fixed
// (`DO_NEXT_RULES.weights`); there is no setting for them.

export type WeightKey = 'proximity' | 'stall' | 'relevance';

/** The three weights in the one fixed order the explanations list them in. */
export const WEIGHT_KEYS: readonly WeightKey[] = ['proximity', 'stall', 'relevance'];

export const WEIGHT_LABEL: Record<WeightKey, string> = {
  proximity: 'How close to done',
  stall: 'How long it has waited',
  relevance: 'How much it is about you',
};

/** A weight's name mid-sentence, lower-cased ("how long it has waited"). */
export function weightPhrase(k: WeightKey): string {
  return WEIGHT_LABEL[k].charAt(0).toLowerCase() + WEIGHT_LABEL[k].slice(1);
}
