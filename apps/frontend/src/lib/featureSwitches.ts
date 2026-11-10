import { FEATURE_IDS, type FeatureId, type FeatureSettings, type FeaturesStatus } from '@pierre-review/shared';

// SETTINGS → FEATURES, the form's pure half (test/featureSwitches.test.ts).

/** Each switch's words: the name and the one line under it (what it needs, where it waits on something). */
export const FEATURE_WORDS: Record<FeatureId, { label: string; hint: string }> = {
  timeline: { label: 'Timeline', hint: 'Every pull request drawn over time, with its reviews, comments and commits.' },
  feed: { label: 'Feed', hint: 'One stream of everything happening in this workspace.' },
  reports: { label: 'Reports', hint: 'Shows once your first repository has finished syncing 90 days.' },
  sprint: {
    label: 'This Sprint',
    hint: 'Shows once a Jira, Linear or Notion tracker is set up, or Limn finds a GitHub milestone with a due date or a current Projects iteration.',
  },
  bots: { label: 'Bots Monitoring', hint: 'Measure what your review bots cost and catch.' },
};

/**
 * The whole switches object after one switch moves. Overrides only: a switch moved back to what the
 * default says is dropped, so it follows the default again (Reports keeps showing itself once ready).
 * Nothing left → null.
 */
export function nextFeatureSettings(features: FeaturesStatus, id: FeatureId, on: boolean): FeatureSettings | null {
  const out: FeatureSettings = {};
  for (const f of FEATURE_IDS) {
    const s = features[f];
    const value = f === id ? on : s.setting;
    if (value != null && value !== s.defaultOn) out[f] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}
