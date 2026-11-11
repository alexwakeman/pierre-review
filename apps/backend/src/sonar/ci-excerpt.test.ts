// The SonarCloud stand-in for a failing SonarCloud check in the CI review (ci-excerpt.ts). Pinned: the
// check is known by name; only an `ok` read with something in it gives text; the gate's failing
// conditions come first, then the issues, most severe first, one line each; the text is clipped.
import { describe, expect, it } from 'vitest';
import type { SonarSnapshot } from '@pierre-review/shared';
import { isSonarCheckName, sonarCiExcerptText } from './ci-excerpt.js';

const snap = (o: Partial<SonarSnapshot> = {}): SonarSnapshot =>
  ({
    state: 'ok',
    message: null,
    qualityGate: { status: 'ERROR', conditions: [{ metric: 'new_coverage', status: 'ERROR', actual: '40', threshold: '80', comparator: 'LT' }] },
    issues: [
      { key: 'I1', kind: 'issue', rule: 'ts:S1854', severity: 'major', type: 'CODE_SMELL', path: 'src/a.ts', line: 41, message: 'Remove this useless assignment.' },
      { key: 'H1', kind: 'hotspot', rule: 'ts:S5852', severity: 'critical', type: null, path: 'src/b.ts', line: null, message: 'Make sure this regex is safe.' },
    ],
    totalIssues: 1,
    totalHotspots: 1,
    ...o,
  }) as unknown as SonarSnapshot;

describe('the SonarCloud stand-in', () => {
  it('knows the check by name', () => {
    expect(isSonarCheckName('SonarCloud Code Analysis')).toBe(true);
    expect(isSonarCheckName('sonarqube')).toBe(true);
    expect(isSonarCheckName('Unit tests')).toBe(false);
    expect(isSonarCheckName('personal-sonarless')).toBe(false);
  });

  it('the gate first, then each issue on one line', () => {
    const t = sonarCiExcerptText(snap(), 8000)!;
    expect(t).toContain('Quality gate: failed.');
    expect(t).toMatch(/- Failing: .*80/);
    expect(t).toContain('- MAJOR code smell ts:S1854 at src/a.ts:41: Remove this useless assignment.');
    expect(t).toContain('- CRITICAL security hotspot ts:S5852 at src/b.ts: Make sure this regex is safe.');
    expect(t.indexOf('Quality gate')).toBeLessThan(t.indexOf('MAJOR'));
  });

  it('nothing for a read that is not ok, or that holds nothing; clipped to the budget', () => {
    expect(sonarCiExcerptText(null, 8000)).toBeNull();
    expect(sonarCiExcerptText(snap({ state: 'not_analyzed' } as any), 8000)).toBeNull();
    expect(sonarCiExcerptText(snap({ issues: [], qualityGate: { status: 'OK', conditions: [] } } as any), 8000)).toBeNull();
    expect(sonarCiExcerptText(snap(), 40)!.length).toBe(40);
  });
});
