// SETTINGS → FEATURES, THE TOOL SWITCHES — the server's half (ai/tool-switches.ts).
//
// WHAT THIS PINS:
//   1. AI SWITCHED OFF reads as 'absent' with the Settings → Features line, so every AI surface shows its
//      not-set-up line and every automatic run waits; switched on (or never touched) the real status stands.
//   2. The resolver: a switch never touched follows what is installed; a stored switch wins.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveToolSwitch, type ToolSwitches } from '@pierre-review/shared';

let stored: ToolSwitches | null = null;
vi.mock('../auth/account.js', () => ({
  getLocalAccountCached: () => ({ id: 1, toolSwitches: stored }),
}));

const { AI_SWITCHED_OFF_MESSAGE, aiSwitchedOff, botAnalysisSwitchedOff, withAiSwitch } = await import('./tool-switches.js');

beforeEach(() => {
  stored = null;
});

describe('the AI switch', () => {
  const ready = { runtime: 'ready' as const, runtimeMessage: null };

  it('leaves the runtime status alone when never touched or switched on', () => {
    expect(withAiSwitch(ready)).toEqual(ready);
    stored = { ai: true };
    expect(withAiSwitch(ready)).toEqual(ready);
    expect(aiSwitchedOff()).toBe(false);
  });

  it('reads as not set up, with the Settings line, when switched off', () => {
    stored = { ai: false };
    expect(aiSwitchedOff()).toBe(true);
    expect(withAiSwitch(ready)).toEqual({ runtime: 'absent', runtimeMessage: AI_SWITCHED_OFF_MESSAGE });
    expect(AI_SWITCHED_OFF_MESSAGE).toMatch(/Settings → Features/);
  });
});

describe('the bot analysis switch', () => {
  it('is off only when the reader switched it off', () => {
    expect(botAnalysisSwitchedOff()).toBe(false);
    stored = { botAnalysis: false };
    expect(botAnalysisSwitchedOff()).toBe(true);
  });
});

describe('resolveToolSwitch', () => {
  it('follows what is installed until the reader chooses', () => {
    expect(resolveToolSwitch(undefined, true)).toMatchObject({ on: true, setting: null, defaultOn: true, installed: true });
    expect(resolveToolSwitch(null, false)).toMatchObject({ on: false, setting: null, defaultOn: false });
  });
  it('lets a stored switch win either way', () => {
    expect(resolveToolSwitch(false, true).on).toBe(false);
    expect(resolveToolSwitch(true, false).on).toBe(true);
  });
});
