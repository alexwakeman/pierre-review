import { describe, expect, it } from 'vitest';
import { resolveFeatures, type FeatureFacts } from '@pierre-review/shared';
import { FEATURE_WORDS, nextFeatureSettings } from '../src/lib/featureSwitches.js';
import { currentLocation, DESTINATIONS, isDestinationShown, shownDestinations } from '../src/components/shell/nav.js';

// Settings → Features: the shared resolver's defaults, the form's overrides-only write, and the
// sidebar's gate (visibility only — a deep link still lands).

const NEW: FeatureFacts = { existingInstall: false, reportsReady: false, sprintSource: false };
const EXISTING: FeatureFacts = { existingInstall: true, reportsReady: false, sprintSource: false };
const ids = (gates: Parameters<typeof shownDestinations>[0]): string[] => shownDestinations(gates).map((d) => d.id);

describe('resolveFeatures: the defaults', () => {
  it('a new install hides Feed and Bots; Reports and This Sprint wait on their facts', () => {
    const f = resolveFeatures(null, NEW);
    expect(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.visible]))).toEqual({
      feed: false,
      reports: false,
      sprint: false,
      bots: false,
    });
    const ready = resolveFeatures(null, { ...NEW, reportsReady: true, sprintSource: true });
    expect(ready.reports.visible && ready.sprint.visible).toBe(true);
    expect(ready.feed.visible || ready.bots.visible).toBe(false);
  });
  it('an existing install shows everything; a stored switch wins either way', () => {
    expect(Object.values(resolveFeatures(null, EXISTING)).every((s) => s.visible)).toBe(true);
    const f = resolveFeatures({ reports: false, feed: true }, NEW);
    expect(f.feed).toEqual({ visible: true, setting: true, defaultOn: false });
    expect(resolveFeatures({ reports: false }, EXISTING).reports.visible).toBe(false);
  });
  it('ignores a non-boolean stored value', () => {
    expect(resolveFeatures({ feed: 'yes' } as never, NEW).feed.setting).toBeNull();
  });
});

describe('nextFeatureSettings: overrides only', () => {
  it('stores a switch that differs from the default and drops one that matches it', () => {
    const f = resolveFeatures(null, NEW);
    expect(nextFeatureSettings(f, 'feed', true)).toEqual({ feed: true });
    const on = resolveFeatures({ feed: true }, NEW);
    expect(nextFeatureSettings(on, 'feed', false)).toBeNull();
  });
  it('a derived page switched off is kept off; back on follows the default again', () => {
    const ready = resolveFeatures(null, { ...NEW, reportsReady: true });
    expect(nextFeatureSettings(ready, 'reports', false)).toEqual({ reports: false });
    const off = resolveFeatures({ reports: false }, { ...NEW, reportsReady: true });
    expect(nextFeatureSettings(off, 'reports', true)).toBeNull();
  });
  it('keeps the other stored switches', () => {
    const f = resolveFeatures({ bots: true }, NEW);
    expect(nextFeatureSettings(f, 'feed', true)).toEqual({ feed: true, bots: true });
  });
});

describe('the sidebar gate', () => {
  it('lists every destination when /api/me carries no switches (older server, or not loaded)', () => {
    expect(ids({ aiOn: true, features: undefined })).toEqual(DESTINATIONS.map((d) => d.id));
  });
  it('leaves out a hidden destination, and keeps the AI gate', () => {
    const shown = ids({ aiOn: false, features: resolveFeatures(null, NEW) });
    expect(shown).toEqual(['open-prs', 'attention', 'timeline']);
    expect(ids({ aiOn: true, features: resolveFeatures(null, EXISTING) })).toEqual(DESTINATIONS.map((d) => d.id));
  });
  it('a deep link to a hidden destination still lands there', () => {
    const features = resolveFeatures(null, NEW);
    const bots = DESTINATIONS.find((d) => d.id === 'bots')!;
    expect(isDestinationShown(bots, { aiOn: true, features })).toBe(false);
    // Location is read from the stores, never from the gate: `?activityRepo=bots` / `?view=sprint` resolve.
    expect(currentLocation('activity', [], 'bots')).toBe('bots');
    expect(currentLocation('sprint', [], null)).toBe('sprint');
    expect(currentLocation('activity', [], 'feed')).toBe('feed');
  });
});

describe('the switch hints promise only what happens by itself', () => {
  it('This Sprint: a tracker shows it, and so does a GitHub milestone or iteration Limn finds', () => {
    // A GitHub milestone or iteration is found by the tracker worker's sprint-source probe
    // (backend tracker/sprint/probe.ts), which runs in the background without the page being
    // opened — so the hint may say the page shows itself for one.
    const hint = FEATURE_WORDS.sprint.hint;
    expect(hint).toMatch(/^Shows once a Jira, Linear or Notion tracker is set up/);
    expect(hint).toContain('GitHub milestone with a due date');
    expect(hint).toContain('Projects iteration');
    expect(hint).not.toMatch(/switch it on/i);
  });
});
