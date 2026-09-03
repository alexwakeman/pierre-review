// What ONE Save button on a section holding TWO independently-stored settings is allowed to send.
//
// The Settings modal's Sprint section used to be two controls at two GRAINS — a per-workspace
// cadence and an account-wide comparison-window mode — fenced apart with two Save buttons, because
// one Save spanning two grains is how an edit meant for one team travels silently to every team.
// The mode moved onto the workspace row in plugin migration 0032, so the grains collapsed and the
// two Saves became one. This pins what survived that collapse.
//
// The rule that matters is NOT "does the patch carry the right values" — it is WHICH SECTIONS ARE
// PRESENT. `useUpdateWorkspaceProSettings` keys its cache invalidation off `patch.sprint` /
// `patch.comparisonMode` being present, not off their values differing from stored ones, and a
// `sprint` section means "the period grid may have moved": it sweeps the period-report list and
// every stored report. A mode-only edit that dragged an unchanged `sprint` along would regrid
// nothing and still push every stored report through that path.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { buildSprintPatch } from '../src/components/settings/SprintSection.js';

const base = { cadenceDirty: false, modeDirty: false, days: 14, start: '2026-01-05', mode: 'rolling_14' } as const;

describe('buildSprintPatch — only the half that changed goes on the wire', () => {
  // ⚠ THE LOAD-BEARING ONE. `sprint` present ⇒ the period grid may have moved ⇒ the stored
  // reports are re-listed. Changing how two stretches of time are COMPARED moves no boundary.
  it('a mode-only edit carries NO sprint section', () => {
    const patch = buildSprintPatch({ ...base, modeDirty: true, mode: 'sprint' });
    expect(patch).toEqual({ comparisonMode: 'sprint' });
    expect('sprint' in patch).toBe(false);
  });

  it('a cadence-only edit carries NO comparisonMode', () => {
    const patch = buildSprintPatch({ ...base, cadenceDirty: true, days: 21 });
    expect(patch).toEqual({ sprint: { cadenceDays: 21, startDate: '2026-01-05' } });
    expect('comparisonMode' in patch).toBe(false);
  });

  it('both dirty ⇒ one patch carrying both, because they are one grain now', () => {
    expect(
      buildSprintPatch({ ...base, cadenceDirty: true, modeDirty: true, days: 7, mode: 'rolling_7' }),
    ).toEqual({ sprint: { cadenceDays: 7, startDate: '2026-01-05' }, comparisonMode: 'rolling_7' });
  });

  // The Save button is disabled when neither half is dirty, but "disabled" is a UI state, not a
  // guarantee — an empty patch must be a well-formed no-op, never a throw or a written default.
  it('neither dirty ⇒ an empty, legal patch', () => {
    expect(buildSprintPatch(base)).toEqual({});
  });
});

describe('buildSprintPatch — clearing the cadence NULLS THE PAIR', () => {
  // The row survives a clear: it also holds the comparison mode and the Jira/Linear tracker, so a
  // delete would take two unrelated settings with it. `cadenceDays: null` IS the clear.
  it('sends both halves as null, never an omitted startDate', () => {
    const patch = buildSprintPatch({ ...base, cadenceDirty: true, days: null, start: '2026-01-05' });
    expect(patch.sprint).toEqual({ cadenceDays: null, startDate: null });
  });

  // ⚠ AN OMITTED `startDate` KEEPS THE STORED ANCHOR (that is the wire contract), so clearing has
  // to say null out loud — otherwise a later re-enable silently inherits a phase anchor the user
  // cleared months ago, and the grid lands somewhere nobody chose.
  it('null is stated, not implied by omission', () => {
    const sprint = buildSprintPatch({ ...base, cadenceDirty: true, days: null }).sprint;
    expect(sprint && 'startDate' in sprint).toBe(true);
  });

  it('an empty start date on an ENABLED cadence is null, not the empty string', () => {
    expect(buildSprintPatch({ ...base, cadenceDirty: true, days: 14, start: '' }).sprint).toEqual({
      cadenceDays: 14,
      startDate: null,
    });
  });

  // Clearing the cadence and changing the mode in one Save is a legal, reachable edit: the mode
  // still applies (a workspace with no grid reads 'sprint' as rolling-14), so it must not be
  // dropped just because the cadence went away.
  it('a clear and a mode change ride together', () => {
    expect(
      buildSprintPatch({ ...base, cadenceDirty: true, modeDirty: true, days: null, mode: 'sprint' }),
    ).toEqual({ sprint: { cadenceDays: null, startDate: null }, comparisonMode: 'sprint' });
  });
});
