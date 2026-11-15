// Settings → Sandbox: the one line with how many of this Limn's sandboxes run now.
import { describe, expect, it } from 'vitest';
import { runningLine } from '../src/components/settings/SandboxRuntimeSection.js';

describe('runningLine', () => {
  it('says the count in plain words', () => {
    expect(runningLine(0)).toBe('No Ensemble sandboxes are running.');
    expect(runningLine(1)).toBe('1 Ensemble sandbox is running.');
    expect(runningLine(3)).toBe('3 Ensemble sandboxes are running.');
  });
});
