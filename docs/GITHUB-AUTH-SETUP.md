# GitHub sign-in setup (cloud mode)

pierre-review's **cloud** deployment can offer **two GitHub sign-in methods**, side by
side — configure **either or both**, and the sign-in screen shows whatever you've set up:

| | **OAuth App** | **GitHub App** |
|---|---|---|
| Installation | **None** — sign in and go | Must be **installed** on an org/user for their **private** repos |
| Public repos | ✅ instant | ✅ instant (no install) |
| Public-repo **CI checks** | ✅ (`public_repo` scope) | ✅ **only if the App is installed** on that owner |
| Private repos | Only with `repo` scope (see below) | ✅ where the App is installed |
| Permission granularity | Coarse (classic scopes) | Fine-grained, read-only |
| Best for | Public repos in orgs you **can't** administer | Private org repos / least-privilege installs |

Each is a **separate GitHub registration** with its own client id/secret; they share
GitHub's authorize/token endpoints. Locally, neither is used — local mode shells out to
your `gh` CLI. You need **at least one** configured for cloud mode to boot.

- **OAuth App** → `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` (+ optional `GITHUB_OAUTH_SCOPE`).
- **GitHub App** → `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`.

---

## A. OAuth App (public repos, no install)

A traditional OAuth App's user token acts **as the user** with classic scopes, needs **no
installation**, and reads everything you can see on **public** repos — **including CI
checks**. Ideal when you can't install apps on an org (e.g. a locked-down org).

1. **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.**
2. **Application name** — e.g. `pierre-review`.
3. **Homepage URL** — your `APP_BASE_URL` (e.g. `https://pierre-review.com`).
4. **Authorization callback URL** — `APP_BASE_URL` + `/api/auth/callback`. Must match exactly.
   OAuth Apps support multiple callback URLs, so add `http://localhost:4000/api/auth/callback`
   too for local cloud testing.
5. **Enable Device Flow** — leave unchecked. Click **Register application**.
6. Copy the **Client ID** → `GITHUB_OAUTH_CLIENT_ID`; **Generate a new client secret** →
   `GITHUB_OAUTH_CLIENT_SECRET` (shown once).

**Scopes** are requested at sign-in from `GITHUB_OAUTH_SCOPE` (default **`public_repo read:org`**):
- `public_repo` — read public PRs/reviews/comments/commits **and CI checks + statuses** (an
  unscoped token can't reliably read checks) and perform the interactive PR actions on public
  repos (for users with write access).
- `read:org` — floats your orgs' public repos in the Add-repo picker.

To include **private** repos via OAuth, set `GITHUB_OAUTH_SCOPE=repo read:org` — but a private
repo in an org with **OAuth App access restrictions** still needs a one-time org-owner approval.

> OAuth Apps have **no permissions page and no installation** — access is decided entirely by
> the scopes above, intersected with what the signed-in user can already see.

---

## B. GitHub App (adds private org repos via install)

A GitHub App issues a user-to-server token whose reach is the **intersection** of (a) what the
user can access and (b) where the App is **installed**. Public repos read without installation
— **except** CI **Checks** and **Actions**, which require the App to be installed on the owner
even for public repos. Private repos always require installation.

### 1. Create the App
1. **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.**
2. **Name** — e.g. `pierre-review` (its lowercased slug is `GITHUB_APP_SLUG`).
3. **Homepage URL** — `https://pierre-review.com`. **Callback URL** —
   `https://pierre-review.com/api/auth/callback` (add a localhost callback too for testing).
   ✅ Check **"Request user authorization (OAuth) during installation"**.
4. **Expire user authorization tokens** — **uncheck** (this flow stores long-lived tokens; no
   refresh code).
5. **Webhook** — uncheck **Active** (pierre-review polls; no webhooks needed).
6. **Where can this GitHub App be installed?** — **Any account** (required so users other than
   the owner can sign in; "Only on this account" makes everyone else 404 on the authorize page).
   Already private? Edit → Advanced → Danger zone → **Make public**.

### 2. Permissions
Under **Repository permissions**, grant **Read-only** to each (the dropdown per row is
No access / Read-only / Read and write):

| GitHub UI permission | Why / what breaks without it |
|---|---|
| **Metadata** | Mandatory. Repo metadata on every query. |
| **Pull requests** | PRs, reviews, review threads, review comments, review requests, files, diffs. |
| **Contents** | Changed-file paths per commit, diffs. |
| **Checks** | CI check runs — **needs the App installed even for public repos**. |
| **Commit statuses** | Legacy status contexts in the CI rollup. |
| **Issues** | PR conversation (issue-level) comments. |
| **Actions** | Read failed-CI job logs (the log viewer). |

Under **Organization permissions**: **Members → Read-only** (optional; floats your orgs' repos
in the picker). Upgrade **Pull requests** / **Issues** / **Actions** to **Read and write** only
if you want the interactive PR actions (reply, resolve, comment, approve, merge) and CI re-run
to work — those also require the signed-in user to personally have write access.

### 3. Grab the credentials
- **Client ID** → `GITHUB_APP_CLIENT_ID`.
- **Generate a new client secret** → `GITHUB_APP_CLIENT_SECRET` (shown once).
- The **App slug** in the URL `https://github.com/apps/<slug>` → `GITHUB_APP_SLUG`.

### 4. Installing for private repos
`authorize` (sign-in) and `install` are independent. Sign-in alone unlocks public repos;
**installation** extends the same token to specific **private** repos:
- **Own account / an org you own** → install in one click at
  `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new` ("All repositories" or a
  selection).
- **An org you don't own** → GitHub shows a **"Request"** button that notifies an org owner to
  approve the install. **If you can't get that approval, use the OAuth App (public repos) instead.**

---

## Summary — env vars

| Env var | Value | Provider |
|---|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | OAuth App Client ID | OAuth App |
| `GITHUB_OAUTH_CLIENT_SECRET` | OAuth App client secret | OAuth App |
| `GITHUB_OAUTH_SCOPE` | *(optional)* default `public_repo read:org` | OAuth App |
| `GITHUB_APP_CLIENT_ID` | GitHub App Client ID | GitHub App |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App client secret | GitHub App |
| `GITHUB_APP_SLUG` | GitHub App slug (private-repo install link) | GitHub App |

Set **at least one** provider's vars (both is fine), plus `SESSION_SECRET`, `ENCRYPTION_KEY`,
`APP_BASE_URL`, `DATABASE_URL`, `DEPLOYMENT_MODE=cloud` — see
[DEPLOY-RAILWAY.md](./DEPLOY-RAILWAY.md). Each app's callback URL **must** match
`APP_BASE_URL` + `/api/auth/callback`.
