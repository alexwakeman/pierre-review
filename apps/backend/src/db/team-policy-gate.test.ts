// THE TEAM POLICY — EVERY ENFORCEMENT POINT KEEPS ITS CHECK (docs/TEAM-POLICY.md § Where it is enforced).
//
// A source scan, the external-automation-gate.test.ts pattern: each automatic path below must keep the
// line that asks the repo's policy. Dropping one would let that automation run against a team's
// committed rule, and nothing else would fail.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const POINTS: Array<{ file: string; token: string; what: string }> = [
  { file: 'review/claude-review/manager.ts', token: "effectivePrTeamPolicy(accountId, prId, ctx), 'auto_review')", what: 'the auto review lane' },
  { file: 'review/claude-review/replies-check.ts', token: 'policyAllowsAutoReview(ctx, a.accountId, a.prId)', what: 'the replies pass and cover check' },
  { file: 'review/claude-review/thread-check.ts', token: 'policyAllowsAutoReview(ctx, a.accountId, a.prId)', what: 'the automatic thread check' },
  { file: 'review/claude-review/auto-settings.ts', token: "policyAllowsAutomation(policy, 'auto_post')", what: 'auto-posting' },
  { file: 'review/claude-review/auto-settings.ts', token: "policyAllowsAutomation(policy, 'auto_resolve')", what: 'resolving threads' },
  { file: 'review/claude-review/auto-settings.ts', token: 'policyNoApprove: !policyAllowsAiApproval(policy)', what: 'the AI approval' },
  { file: 'review/claude-review/auto-settings.ts', token: "policyAllowsAutomation(policy, 'auto_fix')", what: 'auto fix' },
  { file: 'review/claude-review/auto-settings.ts', token: "policyAllowsAutomation(policy, 'auto_push')", what: 'auto fix’s automatic push' },
  { file: 'review/claude-review/auto-post.ts', token: 'policyNoApprove: ws.policyNoApprove', what: 'the auto-post verdict' },
  { file: 'review/claude-review/replies-outcome.ts', token: 'policyNoApprove: ws.policyNoApprove', what: 'the replies pass verdict' },
  { file: 'coding/ai-fix/push.ts', token: "'auto_push')", what: 'every automatic AI Fix push' },
  { file: 'coding/story-build/loop/driver.ts', token: "policyAllowsAutomation(decided.policy, 'auto_push')", what: 'Implement story’s automatic push' },
  { file: 'coding/story-build/loop/driver.ts', token: 'effectiveMultiRepoTeamPolicy(accountId, b.workspaceId', what: 'the workspace’s choice when policies differ' },
  { file: 'merge/dependency-automation.ts', token: 'dependencyActionAllowedByPolicy(pr.accountId, pr.id)', what: 'every dependency action' },
  { file: 'merge/auto-merge-runner.ts', token: 'work.armedByPolicy && !(await dependencyActionAllowedByPolicy(', what: 'a dependency merge armed earlier' },
  { file: 'sync/branch-status.ts', token: 'recordRepoTeamPolicy(accountId, repoId, teamPolicyObservation(resp, partial, headSha))', what: 'reading the file' },
];

describe('every team policy enforcement point keeps its check', () => {
  for (const p of POINTS) {
    it(`${p.what} (${p.file})`, () => {
      expect(src(p.file)).toContain(p.token);
    });
  }
});
