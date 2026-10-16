// SONARCLOUD GATHER (gather.ts) against a FAKE SonarClient. What is pinned:
//   1. severity: the legacy field wins, else the highest impact; hotspots map HIGH/MEDIUM/LOW;
//   2. RANKING: severity first, an issue before a hotspot of the same severity, then file + line;
//   3. THE CAP: at most SONAR_ISSUE_CAP kept, and the totals SonarCloud reported travel with them so
//      the cut is STATED ("50 of 132"), never silent;
//   4. each distinct rule is read ONCE and cached per (account, organization, rule);
//   5. a missing analysis is told apart from a missing project; a refused token is `unauthorized`;
//      nothing throws.
import { beforeEach, describe, expect, it } from 'vitest';
import { SONAR_ISSUE_CAP, type SonarIssue } from '@pierre-review/shared';
import { SonarError, sonarUrl, type SonarClient, type SonarParams } from './client.js';
import {
  _clearSonarRuleCache,
  capSonarItems,
  gatherSonarForPr,
  htmlToText,
  issueSeverity,
  hotspotSeverity,
  rankSonarItems,
  ruleGuidance,
  sonarCutSentence,
} from './gather.js';

const PK = 'acme_api';

function issue(n: number, severity: string, extra: Record<string, unknown> = {}) {
  return {
    key: `AX${n}`,
    rule: `typescript:S${n % 7}`,
    severity,
    component: `${PK}:src/f${n % 5}.ts`,
    line: n,
    textRange: { startLine: n, endLine: n },
    message: `Problem ${n} @alice`,
    type: 'CODE_SMELL',
    effort: '5min',
    tags: ['x'],
    ...extra,
  };
}

interface Calls {
  [path: string]: SonarParams[];
}

function fakeClient(handler: (path: string, params: SonarParams) => unknown, calls: Calls = {}): SonarClient {
  return {
    async get(path, params = {}) {
      (calls[path] ??= []).push(params);
      const out = handler(path, params);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

const gate = { projectStatus: { status: 'ERROR', conditions: [{ metricKey: 'new_coverage', status: 'ERROR', actualValue: '40', errorThreshold: '80', comparator: 'LT' }] } };

function standard(issues: unknown[], hotspots: unknown[] = [], total?: number) {
  return (path: string): unknown => {
    switch (path) {
      case 'api/qualitygates/project_status':
        return gate;
      case 'api/issues/search':
        return { paging: { total: total ?? issues.length }, issues, rules: [{ key: 'typescript:S1', name: 'Rule one' }] };
      case 'api/hotspots/search':
        return { paging: { total: hotspots.length }, hotspots };
      case 'api/rules/show':
        return {
          rule: {
            name: 'A rule',
            descriptionSections: [
              { key: 'root_cause', content: '<p>Because &amp; so.</p>' },
              { key: 'how_to_fix', content: '<h2>Fix</h2><ul><li>Do <code>this</code></li></ul>' },
            ],
          },
        };
      case 'api/sources/lines':
        return { sources: [{ line: 1, code: '<span class="k">const</span> a = 1;' }, { line: 2, code: 'b &lt; c' }] };
      default:
        return new SonarError('not_found', 404);
    }
  };
}

const input = { accountId: 1, organization: 'acme', projectKey: PK, prNumber: 7 };

beforeEach(() => _clearSonarRuleCache());

describe('the pure folds', () => {
  it('maps severities', () => {
    expect(issueSeverity({ severity: 'BLOCKER' })).toBe('blocker');
    expect(issueSeverity({ impacts: [{ severity: 'LOW' }, { severity: 'HIGH' }] })).toBe('critical');
    expect(issueSeverity({})).toBe('major');
    expect(hotspotSeverity('HIGH')).toBe('critical');
    expect(hotspotSeverity('MEDIUM')).toBe('major');
    expect(hotspotSeverity('LOW')).toBe('minor');
  });

  it('ranks by severity, issues before hotspots, then file and line', () => {
    const mk = (key: string, severity: SonarIssue['severity'], kind: SonarIssue['kind'], path: string, line: number) =>
      ({ key, severity, kind, path, line }) as SonarIssue;
    const out = rankSonarItems([
      mk('a', 'minor', 'issue', 'a.ts', 1),
      mk('b', 'critical', 'hotspot', 'a.ts', 1),
      mk('c', 'critical', 'issue', 'b.ts', 9),
      mk('d', 'blocker', 'issue', 'z.ts', 1),
      mk('e', 'critical', 'issue', 'b.ts', 2),
    ]);
    expect(out.map((i) => i.key)).toEqual(['d', 'e', 'c', 'b', 'a']);
  });

  it('caps and states the cut', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ key: `k${i}`, severity: 'major', kind: 'issue', path: 'a', line: i }) as SonarIssue);
    expect(capSonarItems(many)).toHaveLength(SONAR_ISSUE_CAP);
    expect(sonarCutSentence(50, 120, 12)).toBe('50 of 132 issues, highest severity first');
    expect(sonarCutSentence(3, 2, 1)).toBe('3 issues');
    expect(sonarCutSentence(1, 1, 0)).toBe('1 issue');
  });

  it('turns rule HTML into plain text', () => {
    expect(htmlToText('<p>a &amp; b</p><ul><li>one</li><li>two</li></ul>')).toBe('a & b\n\n- one\n- two');
    const g = ruleGuidance({ name: 'N', htmlDesc: '<p>Bad thing.</p><h2>Compliant Solution</h2><pre>x = 1</pre>' });
    expect(g.why).toBe('Bad thing.');
    expect(g.howToFix).toContain('Compliant Solution');
  });

  it('builds URLs on the fixed host only', () => {
    expect(sonarUrl('api/issues/search', { componentKeys: 'a&b', p: 1 })).toBe(
      'https://sonarcloud.io/api/issues/search?componentKeys=a%26b&p=1',
    );
    expect(() => sonarUrl('//evil.example/api')).toThrow();
    expect(() => sonarUrl('api/../x')).toThrow();
  });
});

describe('gatherSonarForPr', () => {
  it('reads gate, issues and hotspots, ranks, caps at 50, keeps the totals', async () => {
    const issues = Array.from({ length: 120 }, (_, i) => issue(i + 1, i % 10 === 0 ? 'CRITICAL' : 'MINOR'));
    const hotspots = Array.from({ length: 12 }, (_, i) => ({
      key: `H${i}`,
      ruleKey: 'typescript:S5332',
      component: `${PK}:src/h.ts`,
      vulnerabilityProbability: 'HIGH',
      securityCategory: 'insecure-conf',
      line: i + 1,
      message: 'Check this',
    }));
    const calls: Calls = {};
    const res = await gatherSonarForPr(fakeClient(standard(issues, hotspots), calls), input);
    expect(res.state).toBe('ok');
    expect(res.issues).toHaveLength(50);
    expect(res.totalIssues).toBe(120);
    expect(res.totalHotspots).toBe(12);
    // The 12 critical issues lead, then the 12 critical hotspots, then minors.
    expect(res.issues.slice(0, 12).every((i) => i.kind === 'issue' && i.severity === 'critical')).toBe(true);
    expect(res.issues.slice(12, 24).every((i) => i.kind === 'hotspot')).toBe(true);
    expect(res.qualityGate?.status).toBe('ERROR');
    const first = res.issues[0]!;
    expect(first.path).toMatch(/^src\/f\d\.ts$/);
    expect(first.howToFix).toContain('- Do this');
    expect(first.whyIsThisAnIssue).toBe('Because & so.');
    expect(first.code[0]).toEqual({ line: 1, code: 'const a = 1;', flagged: expect.any(Boolean) });
    expect(first.url).toContain('https://sonarcloud.io/project/issues?id=acme_api&pullRequest=7&open=');
    // The PR's issues were asked for unresolved, every field, and for THIS pull request.
    const q = calls['api/issues/search']![0]!;
    expect(q).toMatchObject({ componentKeys: PK, pullRequest: '7', resolved: 'false', additionalFields: '_all' });
  });

  it('reads each rule once, and caches it for the next gather', async () => {
    const issues = [issue(1, 'MAJOR'), issue(8, 'MAJOR'), issue(2, 'MAJOR')]; // rules S1, S1, S2
    const calls: Calls = {};
    await gatherSonarForPr(fakeClient(standard(issues), calls), input);
    expect(calls['api/rules/show']!.map((p) => p.key).sort()).toEqual(['typescript:S1', 'typescript:S2']);
    const calls2: Calls = {};
    await gatherSonarForPr(fakeClient(standard(issues), calls2), input);
    expect(calls2['api/rules/show']).toBeUndefined();
    // Another account does not share the cache.
    const calls3: Calls = {};
    await gatherSonarForPr(fakeClient(standard(issues), calls3), { ...input, accountId: 2 });
    expect(calls3['api/rules/show']).toHaveLength(2);
  });

  it('tells no project from no analysis, and a refused token from an outage', async () => {
    const noAnalysis = await gatherSonarForPr(
      fakeClient((p) => (p === 'api/components/show' ? { component: { key: PK } } : new SonarError('not_found', 404))),
      input,
    );
    expect(noAnalysis.state).toBe('not_analyzed');
    const noProject = await gatherSonarForPr(fakeClient(() => new SonarError('not_found', 404)), input);
    expect(noProject.state).toBe('no_project');
    expect(noProject.message).toContain('acme_api');
    const refused = await gatherSonarForPr(fakeClient(() => new SonarError('unauthorized', 401)), input);
    expect(refused.state).toBe('unauthorized');
    const down = await gatherSonarForPr(fakeClient(() => new SonarError('timeout')), input);
    expect(down.state).toBe('error');
    expect(down.issues).toEqual([]);
  });

  it('a hotspot or enrichment failure costs that part only', async () => {
    const res = await gatherSonarForPr(
      fakeClient((p) => {
        if (p === 'api/hotspots/search' || p === 'api/sources/lines' || p === 'api/rules/show') return new SonarError('forbidden', 403);
        return standard([issue(1, 'MAJOR')])(p);
      }),
      input,
    );
    expect(res.state).toBe('ok');
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0]!.code).toEqual([]);
    expect(res.issues[0]!.howToFix).toBeNull();
    expect(res.totalHotspots).toBe(0);
  });

  it('stops enriching once the deadline is spent', async () => {
    const calls: Calls = {};
    await gatherSonarForPr(fakeClient(standard([issue(1, 'MAJOR')]), calls), { ...input, now: () => 0, deadline: -1 });
    expect(calls['api/rules/show']).toBeUndefined();
    expect(calls['api/sources/lines']).toBeUndefined();
  });
});
