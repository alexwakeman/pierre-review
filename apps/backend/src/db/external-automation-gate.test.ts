// EXTERNAL REPOS — THE AUTOMATION GATE IS ASKED BY EVERY AUTOMATIC PATH (db/external-repos.ts).
//
// A source scan, the provider-seam.test.ts pattern: each automatic path below must keep the line that
// keeps it off an external repo's PR. Dropping one would let auto review, auto fix, an automatic post or
// a Slack signal run on a repo the reader marked external, and nothing else would fail.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const GATES: Array<{ file: string; token: string; what: string }> = [
  { file: 'review/claude-review/manager.ts', token: 'automationAllowedForPr(accountId, prId, ctx)', what: 'auto review start' },
  { file: 'review/claude-review/replies-check.ts', token: 'automationAllowedForPr(a.accountId, a.prId, ctx)', what: 'automatic Check threads / cover check' },
  { file: 'review/claude-review/auto-settings.ts', token: "repoModeOf(r.repoMode) === 'external'", what: 'auto-post, auto verdict, resolve-my-threads switches' },
  { file: 'coding/ai-fix/auto-fix.ts', token: 'automationAllowedForPr(accountId, prId, ctx)', what: 'auto fix' },
  { file: 'coding/ai-fix/manager.ts', token: 'unattended && !(await automationAllowedForPr(', what: 'unattended AI Fix backstop' },
  { file: 'review/ci-review/sweep.ts', token: '!externals.has(p.repoId)', what: 'CI review sweep' },
  { file: 'review/ticket-review/sweep.ts', token: '!externals.has(p.repoId)', what: 'ticket review sweep' },
  { file: 'review/diagrams/trigger.ts', token: 'automationAllowedForPr(accountId, prId, ctx)', what: 'automatic diagrams' },
  { file: 'platform/event-hooks.ts', token: 'automationAllowedForRepo(e.accountId, e.repoId)', what: 'Slack merge signal' },
  { file: 'platform/event-hooks.ts', token: 'automationAllowedForPr(e.accountId, e.prId)', what: 'Slack review signal' },
  { file: 'sync/ml-enrichment.ts', token: 'externalRepoIds', what: 'ML scoring' },
];

describe('every automatic path asks the external-repo gate', () => {
  for (const g of GATES) {
    it(`${g.what} (${g.file})`, () => {
      expect(src(g.file)).toContain(g.token);
    });
  }

  it('dependency automation and auto review read WATCHED members only (getWorkspaceRepoIds default)', () => {
    const q = src('db/queries.ts');
    expect(q).toContain("members: 'watched' | 'all' = 'watched'");
    expect(q).toContain("members === 'all' ? undefined : eq(workspaceRepos.mode, 'watched')");
  });
});
