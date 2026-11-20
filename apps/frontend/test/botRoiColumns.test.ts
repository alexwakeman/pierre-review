// Bots → ROI: the Inflation column + the Severity inflation chart gate (lib/botRoiColumns.ts).
// Run: ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { inflationShown, isEnsembleBot, onlyEnsembleBots } from '../src/lib/botRoiColumns.js';

const ensembleAlice = { login: 'limn:alice', kind: 'pierre' };
const ensembleBob = { login: 'limn:bob', kind: 'pierre' };
const coderabbit = { login: 'coderabbitai[bot]', kind: 'coderabbit' };

describe('isEnsembleBot', () => {
  it('reads the stored kind or the limn: login', () => {
    expect(isEnsembleBot(ensembleAlice)).toBe(true);
    expect(isEnsembleBot({ login: 'limn:carol', kind: 'vendor' })).toBe(true);
    expect(isEnsembleBot({ login: null, kind: 'pierre' })).toBe(true);
    expect(isEnsembleBot(coderabbit)).toBe(false);
    expect(isEnsembleBot({ login: null, kind: 'in_house' })).toBe(false);
  });
});

describe('onlyEnsembleBots', () => {
  it('is false for an empty table', () => {
    expect(onlyEnsembleBots([])).toBe(false);
  });
  it('is true only when every row is Ensemble’s', () => {
    expect(onlyEnsembleBots([ensembleAlice, ensembleBob])).toBe(true);
    expect(onlyEnsembleBots([ensembleAlice, coderabbit])).toBe(false);
  });
});

describe('inflationShown', () => {
  it('never shows without the ML columns', () => {
    expect(inflationShown(false, [coderabbit])).toBe(false);
  });
  it('hides when every row is Ensemble’s own bot', () => {
    expect(inflationShown(true, [ensembleAlice, ensembleBob])).toBe(false);
  });
  it('shows when any other bot is in the table', () => {
    expect(inflationShown(true, [ensembleAlice, coderabbit])).toBe(true);
    expect(inflationShown(true, [coderabbit])).toBe(true);
  });
});
