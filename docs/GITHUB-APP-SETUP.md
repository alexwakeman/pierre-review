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
3. **Homepage URL** — your deployment URL, e.g. `https://pierre.example.com`.
4. **Callback URL** — `https://<your-domain>/api/auth/callback`.
   - For local cloud testing add a second callback: `http://localhost:4000/api/auth/callback`.
   - ✅ Check **"Request user authorization (OAuth) during installation"**.
5. **Expire user authorization tokens** — **UNCHECK this** (disable expiration).
   v1 uses long-lived, non-expiring user tokens — there is no refresh code.
   (Refreshing tokens is a later hardening item.)
6. **Webhook** — uncheck **Active** (pierre-review polls; it doesn't need webhooks).
7. **Setup URL / redirect on install** — leave default.

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

## 3. Where it can be installed

- **Only on this account** (simplest for a personal deployment), or **Any account**
  if you want others to install it.

## 4. Grab the credentials

After creating the App, on its settings page:

- **Client ID** → `GITHUB_APP_CLIENT_ID`.
- **Client secrets → Generate a new client secret** → `GITHUB_APP_CLIENT_SECRET`
  (copy it now; GitHub shows it once).
- The **App slug** is the lowercased app name in the URL
  (`https://github.com/apps/<slug>`) → `GITHUB_APP_SLUG`.

## 5. Installation flow (what users do)

A GitHub App user token can only see repositories where the **App is installed**
and that the **user can access**. So after first sign-in, users should **install
the App** on the accounts/orgs whose repos they want to watch:

- The sign-in page links users to `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`
  to choose which repos to grant.
- They can revisit `https://github.com/settings/installations` to add/remove repos.

If a user tries to add a repo the App can't see, the repo-search/add will simply
not return it — point them at the install/configure page.

---

## Summary — env vars produced

| Env var | Value |
|---|---|
| `GITHUB_APP_CLIENT_ID` | App's Client ID |
| `GITHUB_APP_CLIENT_SECRET` | a generated client secret |
| `GITHUB_APP_SLUG` | the app slug (for the install link) |

Put these (plus `SESSION_SECRET`, `ENCRYPTION_KEY`, `APP_BASE_URL`,
`DATABASE_URL`, `DEPLOYMENT_MODE=cloud`) into your deployment — see
[DEPLOY-RAILWAY.md](./DEPLOY-RAILWAY.md). The callback URL on the App **must**
match `APP_BASE_URL` + `/api/auth/callback`.
