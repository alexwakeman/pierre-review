# GitHub App setup (cloud mode sign-in)

pierre-review's **cloud** deployment authenticates users with a **GitHub App**
(OAuth user-to-server flow). Each signed-in user gets a per-account, encrypted
GitHub token that the server uses for *their* GitHub API calls. Local mode does
not use this — it shells out to your `gh` CLI instead.

This is a one-time setup. You'll end up with three secrets to put in your
deployment env: `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and
`GITHUB_APP_SLUG`.

---

## 1. Create the App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
   (for an org app, use the org's Developer settings instead).
2. **GitHub App name** — e.g. `pierre-review` (this becomes part of the public
   slug). The lowercased, hyphenated name is the **App slug** (`GITHUB_APP_SLUG`).
3. **Homepage URL** — `https://pierre-review.com`.
4. **Callback URL** — `https://pierre-review.com/api/auth/callback`.
   - For local cloud testing add a second callback: `http://localhost:4000/api/auth/callback`.
   - ✅ Check **"Request user authorization (OAuth) during installation"**.
5. **Expire user authorization tokens** — **UNCHECK this** (disable expiration).
   v1 uses long-lived, non-expiring user tokens — there is no refresh code.
   (Refreshing tokens is a later hardening item.)
6. **Webhook** — uncheck **Active** (pierre-review polls; it doesn't need webhooks).
7. **Setup URL / redirect on install** — leave default.
8. **Where can this GitHub App be installed?** — choose **Any account** (makes the
   App public). **Required** so anyone other than you can sign in — see §3.

## 2. Permissions (read-only)

Under **Permissions → Repository permissions**, grant **Read-only** to:

| Permission | Why |
|---|---|
| **Contents** | read changed-file paths per commit |
| **Metadata** | (mandatory) repo metadata |
| **Pull requests** | PRs, reviews, review threads, comments |
| **Issues** | issue-level PR comments |
| **Commit statuses** / **Checks** | CI status + per-job checks on the head commit |

Under **Organization permissions**: **Members → Read-only** (optional; lets the
repo-search picker float org repos you're a member of to the top).

The app needs **no write permissions** — pierre-review is read-only mirroring.
(The local-only Claude Review feature posts reviews using your local `gh` token,
not the App, and is disabled in cloud mode.)

> These repository permissions only matter for **private** repos (they're granted
> when a user installs the App). **Public** repos are readable with **no
> installation and no permissions at all** — see §5.

## 3. Where it can be installed — **make it public for cloud**

The **"Where can this GitHub App be installed?"** setting decides who can sign in,
and it's the #1 cloud-deploy gotcha:

- **Any account** — **required for the public/cloud deployment.** Any GitHub user can
  authorize (sign in) and, for private repos, install the App.
- **Only on this account** (the default) makes the App **private**: GitHub renders
  the OAuth **authorize** *and* install pages **only for the account that owns the
  App**. Every *other* user who tries to sign in gets a bare **404 from github.com**
  on the authorize URL — so the owner can log in but everyone else 404s. Fine for a
  single-user/local deployment, broken for a shared one.

For `pierre-review.com` (multi-user by design), choose **Any account**.

> **Already created the App as private?** Flip it without recreating: **Settings →
> Developer settings → GitHub Apps → Edit** (your app) → **Advanced** → under
> **"Danger zone"** click **Make public**. It takes effect immediately — no redeploy,
> no code change; signed-out users can retry the flow right away. (Caveat: a public
> App **can't** be switched back to private once it's installed on other accounts.)

## 4. Grab the credentials

After creating the App, on its settings page:

- **Client ID** → `GITHUB_APP_CLIENT_ID`.
- **Client secrets → Generate a new client secret** → `GITHUB_APP_CLIENT_SECRET`
  (copy it now; GitHub shows it once).
- The **App slug** is the lowercased app name in the URL
  (`https://github.com/apps/<slug>`) → `GITHUB_APP_SLUG`.

## 5. Public vs. private repos — what installation is (and isn't) for

The single most important thing to understand, because it's a common GitHub-App
misconception:

- **Public repositories work with NO installation.** When a user signs in
  (authorizes the App), the resulting user access token has GitHub's *implicit
  read access to public resources* — it can read any public repo's PRs, reviews,
  comments, and commits via **both** the GraphQL and REST APIs, **even if the App
  is not installed** on the repo's owner/org. So watching a public repo is one
  click: sign in → search → add. No per-org install, no owner approval, ever.
  (Ref: GitHub's [2023-04-27 changelog](https://github.blog/changelog/2023-04-27-graphql-improvements-for-fine-grained-pats-and-github-apps/)
  — *"GitHub Apps now have read access to public resources via GraphQL by default
  when using user-to-server tokens. This is true even if they are not installed on
  the organization or user that owns the resource."*)

- **Private repositories DO require installation.** A user access token can only
  reach private repos in the **intersection** of (a) what the *user* can access
  and (b) where the *App is installed*. So to watch a private repo:
  - **Own account / an org they own** → install in one click at
    `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`, choosing
    **"All repositories"** (covers current + future) or just the ones they want.
  - **An org they don't own** → GitHub shows a **"Request"** button that notifies
    an org owner to approve the installation.
  - Manage later at `https://github.com/settings/installations`.

`authorize` (sign-in) and `install` are **independent**: sign-in alone unlocks all
public repos; installation only extends the same token to specific **private**
repos. So most users never install anything — installation is the exception (a
private repo), not the rule.

---

## Summary — env vars produced

| Env var | Value |
|---|---|
| `GITHUB_APP_CLIENT_ID` | App's Client ID |
| `GITHUB_APP_CLIENT_SECRET` | a generated client secret |
| `GITHUB_APP_SLUG` | the app slug (for the private-repo install link) |

Put these (plus `SESSION_SECRET`, `ENCRYPTION_KEY`, `APP_BASE_URL`,
`DATABASE_URL`, `DEPLOYMENT_MODE=cloud`) into your deployment — see
[DEPLOY-RAILWAY.md](./DEPLOY-RAILWAY.md). The callback URL on the App **must**
match `APP_BASE_URL` + `/api/auth/callback`.
