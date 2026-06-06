# Release automation

This repo publishes the single, unscoped, **public** npm package
[`pierre-review`](https://www.npmjs.com/package/pierre-review) via a GitHub
Actions workflow (`.github/workflows/release.yml`).

> **Policy note.** This automation **supersedes** the previous "publishing is the
> user's job / never publish from CI" policy. Releases now happen automatically
> from `main`. The one exception is the very first publish that claims the npm
> name (see [First publish](#first-publish-claiming-the-name)).

---

## What the workflow does

On every release run it:

1. Checks out the repo (full history + tags, so the tag/commit can be pushed and
   the next version can be computed from existing tags).
2. Installs pnpm (pinned to `pnpm@9.15.9` via the root `package.json`
   `packageManager` field, read by `pnpm/action-setup`) + Node 20 and runs
   `pnpm install --frozen-lockfile`.
3. Runs `pnpm typecheck` and `pnpm test` (a failure here aborts the release).
4. **Computes the next version**, drift-proof: it takes the **highest** of {npm's
   latest published version, the committed `apps/backend/package.json` version, the
   newest `vX.Y.Z` git tag} as the base, applies the bump (`npm version <bump>
   --no-git-tag-version`, default `patch`), and then skips forward past any version
   whose tag already exists. So a run never reuses or collides with an existing
   version even if `main`, the tags, and npm have drifted apart.
5. **Builds** the publishable package with `pnpm package`
   (`scripts/build-release.mjs` assembles `./release`, copies the bumped version
   into `release/package.json`, and self-verifies — it exits non-zero on any
   problem).
6. **Commits & pushes** the bump as `chore(release): bump to X.Y.Z [skip ci]`
   plus a `vX.Y.Z` git tag to `main`, in a single **atomic** push
   (`git push --atomic`) — so a rejected push never leaves a dangling tag behind.
7. **Publishes** `./release` to npm with `npm publish --access public`,
   **idempotently** — if `pierre-review@X.Y.Z` is already on npm (e.g. a re-run),
   it skips instead of failing.

### When it runs

- **Automatically** on every push/merge to `main` — this performs a **patch**
  release.
- **Manually** for a non-patch release: go to the repo's **Actions** tab →
  **Release** workflow → **Run workflow** (**from the `main` branch**) → choose
  `patch`, `minor`, or `major`. (Dispatch is gated to `main` — see [Loop
  guard](#loop-guard).)

---

## Required secret: `NPM_TOKEN`

The **Publish to npm** step authenticates with an npm token exposed as
`NODE_AUTH_TOKEN` from the `NPM_TOKEN` secret.

### Minting the token

On [npmjs.com](https://www.npmjs.com/): **your avatar → Access Tokens →
Generate New Token**, then pick **one** of:

- **Automation** (classic token) — simplest; works for CI publishing.
- **Granular access token** — scoped to **Read and write** / publish permission
  on the **`pierre-review`** package specifically (preferred for least
  privilege).

> **2FA note.** If the publishing npm account has **two-factor authentication on
> publish** enabled, an **Automation token or a Granular token is REQUIRED.**
> These token types **bypass the one-time-password (OTP) prompt** that would
> otherwise appear at publish time and **hang the CI job** (CI can't enter an
> OTP). A plain "Publish" classic token tied to interactive 2FA will not work.

### Adding it to the repo

Repo **Settings → Secrets and variables → Actions → New repository secret**:

- **Name:** `NPM_TOKEN`
- **Value:** the token from above

---

## Push permissions (`GITHUB_TOKEN`) and branch protection

The workflow declares `permissions: contents: write`, which lets the built-in
`GITHUB_TOKEN` push the bump commit and the `vX.Y.Z` tag back to `main`.

Two things must be in place:

1. **Workflow permissions.** Repo **Settings → Actions → General → Workflow
   permissions** must be set to **"Read and write permissions"**. (The
   `permissions:` block in the YAML only narrows what's available — it can't grant
   more than the repo default allows.)

2. **Branch protection / rulesets on `main`.** If `main` is protected by a
   ruleset that **requires pull requests or reviews**, the `github-actions[bot]`
   push will be **REJECTED** and the release will fail at the push step. You have
   two options:

   - **Option A — Ruleset bypass (simplest).** In the branch ruleset, add a
     **bypass** for the **GitHub Actions** actor (or for the
     `github-actions[bot]`), so the automated bump push is allowed.

   - **Option B — Fine-grained PAT.** Create a **fine-grained Personal Access
     Token** with **Contents: Read and write** on this repo, store it as a
     secret (e.g. `RELEASE_PAT`), and use it as the checkout `token` instead of
     the built-in `GITHUB_TOKEN`:

     ```yaml
     - uses: actions/checkout@v4
       with:
         fetch-depth: 0
         token: ${{ secrets.RELEASE_PAT }}
     ```

     The PAT's pushes are attributed to its owner, which can satisfy bypass rules
     a bot push cannot. (Note: a PAT-attributed push **can** re-trigger workflows;
     the `[skip ci]` suffix and the `if:` loop guard below still prevent a release
     loop.)

---

## Loop guard

Two independent mechanisms stop the bot's own bump commit from re-triggering a
release (which would otherwise loop forever):

1. **The job-level `if:`** check:

   ```yaml
   if: ${{ (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') || (github.event_name == 'push' && !startsWith(github.event.head_commit.message, 'chore(release):')) }}
   ```

   A push whose head commit starts with `chore(release):` is skipped. Manual
   dispatch runs **only from `main`** (so a dispatch off a feature branch can't push
   that branch's tree onto `main`).

2. **The `[skip ci]` suffix** on the bump commit message
   (`chore(release): bump to X.Y.Z [skip ci]`) tells GitHub Actions not to start
   a workflow run for that push at all.

Both are belt-and-suspenders: either one alone breaks the loop, and they cover
both the `GITHUB_TOKEN` (which by design doesn't re-trigger workflows) and the
PAT path (which would).

---

## Versioning model

**Only `apps/backend/package.json` is bumped.** That `version` field is the
**canonical published version** — `build-release.mjs` copies it into
`release/package.json`, which is the manifest that actually goes to npm.

The root `package.json`, the frontend, and the shared package versions are
**intentionally left untouched** (the root version is stale and unused). Do not
bump them.

---

## The self-healing order (compute → build → push → publish)

The steps run in a deliberate order:

```
compute next version → build release → atomic PUSH (commit + tag) → THEN publish
```

The **compute** step is drift-proof (highest of npm / `package.json` / tag, then
bump, skipping any already-tagged version), the push is **atomic** (commit + tag
land together or not at all), and publish is **idempotent** (skips a version that's
already on npm). Together these mean a run can never collide on an existing tag —
the old failure mode, `fatal: tag 'vX.Y.Z' already exists` — or double-publish.

Publish is intentionally the **last** step. The rationale:

- **If the push fails** (e.g. branch protection rejects the bot), **nothing has
  been published** yet. The version bump only lives in the failed job, so `main`
  is unchanged and you can safely fix the permissions and re-run.
- **If publish fails *after* the push succeeded**, the bumped version + tag are
  already on `main` and consistent. The next release simply moves to the next
  number — the failed version becomes a **gap in the npm version sequence**, but
  the repo stays consistent. Just re-run / merge again and the next version
  publishes.

Doing it the other way around (publish before push) would be worse: a successful
publish followed by a failed push would leave npm ahead of the repo, and the
**next unrelated merge** would try to publish a version that already exists on npm
and fail with a duplicate-version error — poisoning an innocent merge.

### Recovery cheat-sheet

| Failure | State | What to do |
| --- | --- | --- |
| Push rejected (branch protection) | Nothing pushed, nothing published | Fix workflow/ruleset permissions, then re-run the job. |
| Publish failed after push | Bump + tag on `main`; that npm version skipped | Re-run the job or merge again — the next version publishes (the idempotent publish + tag-skip loop make re-runs safe). Optionally publish the skipped one manually. |

---

## Constraints & notes

- **`better-sqlite3` is a native addon.** It is **not bundled** into the release —
  it stays a runtime dependency and is **recompiled on each consumer's machine at
  install time**. This is fine for CI (the publish step ships source/manifest, not
  a prebuilt binary) and for consumers (`npx pierre-review` triggers the build).

- **The unscoped name `pierre-review` must already be owned** (reserved) on npm by
  the publishing account before automation can publish to it.

### First publish (claiming the name)

The **very first** publish may need to be done **manually** to claim the unscoped
name, before the automation can take over:

```bash
pnpm package
cd release
npm publish --access public
```

Once the name is owned by the account whose `NPM_TOKEN` is configured, subsequent
releases run entirely through the workflow.

---

## Optional: npm provenance

You can opt in to [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
(a signed, verifiable link from the published package back to this workflow run).
It is **not enabled by default.** To turn it on:

1. Add `id-token: write` to the workflow `permissions:` block:

   ```yaml
   permissions:
     contents: write
     id-token: write
   ```

2. Add `--provenance` to the publish command:

   ```yaml
   - name: Publish to npm
     working-directory: release
     run: npm publish --access public --provenance
     env:
       NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```
