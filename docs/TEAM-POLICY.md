# Team policy

A file a team commits to a repository's default branch, `.ensemble/policy.json`, that sets rules for
that repository's PRs on every copy of Ensemble. The first ORGANISATION FEATURE: a copy applies it only
while it holds a valid licence key or is in its 30-day evaluation (docs/LICENSING.md).

Format and readers: `packages/shared/src/team-policy.ts`. Store: `apps/backend/src/db/team-policy.ts`.
User docs: `apps/landing/src/docs/pages/settings/team-policy.tsx`.

## The rules

1. **A policy can only restrict.** Every rule switches something off or narrows a list. Nothing in a
   policy can switch an automation on, widen what a reader chose, or spend more on their machine. A
   missing rule, or `true`, restricts nothing.
2. **Strict.** An unknown key, a wrong type, a bad login or a missing `"version": 1` makes the WHOLE file
   invalid, with every problem listed in words. An invalid file is not applied (a typo never silently
   drops a rule) and Settings shows why. Adding a rule later is a new key: an older copy reads such a
   file as invalid and says so, which tells its reader to update.
3. **Per repository, per PR.** A policy applies to the PRs of the repository it is committed to. The
   workspace settings stay as they are; the readers below override them for that repo's PRs.
4. **An organisation feature, never silent.** Without a key or a running evaluation, nothing is applied,
   and Settings → Team policy says "This copy does not apply team policies: it needs a licence key",
   with "Enter a key" and (once) "Start the 30-day evaluation". Team size does not matter: a small team
   asks for a free key. ⚠ This is a deliberate fail-open on a copy without a key — the same behaviour
   as before the feature existed. GitHub's branch protection remains the hard control.

## The file (version 1)

```json
{
  "version": 1,
  "automation": {
    "auto_review": false,
    "auto_post": false,
    "auto_fix": false,
    "auto_push": false,
    "auto_resolve": false,
    "dependencies": false
  },
  "ai": { "approve": false },
  "dependencies": { "trusted_bots": ["dependabot[bot]"] },
  "note": "Why these rules exist (shown in Settings, never interpreted)."
}
```

`$schema` is allowed and ignored. At most 16 KB.

## Reading it

The default-branch snapshot (`sync/branch-status.ts`) carries a `teamPolicy: object(expression:
"HEAD:.ensemble/policy.json")` alias in its phase-1 query, so it costs no extra request.
`teamPolicyObservation` turns the answer into what `recordRepoTeamPolicy` may act on:

| GitHub said | Stored |
|---|---|
| a partial response, or no repository | nothing changes (`undefined`) |
| `teamPolicy: null` on a clean response | the row is DELETED (a positive "no file") |
| a Blob with text | parsed; the policy, or the problems |
| a Tree, a binary or truncated Blob | one problem ("not a file", "could not be read as text") |

`repo_team_policies` (migration 0220): one row per `(account_id, repo_id)`, named composite FK onto
`repos (id, account_id)`; erased with the account and exported. Whether a copy APPLIES the policy is
decided on read, never stored.

## Where it is enforced

Every check reads `effectiveRepoTeamPolicy` / `effectivePrTeamPolicy` (null = no file, an invalid file,
or no key and no evaluation). Read through the caller's `AgentContext` like the external-repo gate: a
fake context reads no policy, so mocked tests drive their path. `db/team-policy-gate.test.ts` pins
every point by source scan.

| Rule | Where |
|---|---|
| `auto_review` | `startAutoItem` (the auto lane: tick, "Run auto reviews now", retries); `startRepliesCheck` / `startCoverCheck` (auto); `startThreadCheck` (auto); `readWorkspaceAutoPostForPr.autoReviewOn` |
| `auto_post` | `readWorkspaceAutoPostForPr` → `settings.enabled = false`. A "Review and post" press still posts (the press is the consent) |
| `auto_resolve` | `readWorkspaceAutoPostForPr` → `settings.resolveOwnPrs = false` |
| `ai.approve` | `readWorkspaceAutoPostForPr.policyNoApprove` → `verdictGate` holds APPROVE as COMMENT, `heldReason: 'team_policy'` (auto-post and the replies outcome) |
| `auto_fix` | `readWorkspaceAutoFixSettingsForPr.enabled` (the queue, the start, the panel) |
| `auto_push` | `readWorkspaceAutoFixSettingsForPr.settings.autoPush`; `pushFixHeld` refuses every AUTOMATIC fix push ("Push automatically", "Push when done", dependency fixes); `maybeStartLoop` does not start Implement story's loop when any target repo's policy forbids it |
| `dependencies`, `trusted_bots` | `beginDependencyAction` (approve, rebase, conflict fix, AI fix, the merge arm), via `dependencyActionAllowedByPolicy`; the auto-merge runner disarms a POLICY-armed intent the policy no longer allows |

A reader's own press (Review, Post, Push, Merge, Approve) is never refused by a policy.

## In the app

- `GET /api/team-policy?workspace=<id>` → `TeamPolicyResponse` (docs/API.md § Team policy). DB only.
- Settings → **Team policy** (`TeamPolicySection`, a workspace tab): per repo the rules in words
  (`describeTeamPolicy`), the note and the commit, or the problems; the not-applied line.
- `TeamPolicyNote` under Settings → AI Review → Auto review and Settings → Dependencies names the repos
  whose applied policy switches something off.
- A licence write invalidates `['team-policy']`.

## Not yet

- **Allowed AI providers and a per-run spend cap.** A run's provider is chosen in about fifteen places
  and its cap in several, per run kind (`ai/run-choice.ts`, `ai/run-profile.ts`, `review/agent.ts`,
  `sandbox/session/fix.ts`). A rule enforced in some of them would promise more than it does. They come
  with one check every run kind passes.
- An organisation-wide policy (one file for every repo of a GitHub organisation).
