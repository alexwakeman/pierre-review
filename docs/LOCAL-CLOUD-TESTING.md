# Testing the cloud (deployed) experience locally

The local runner has a `--cloud` flag that boots the **full deployed experience**
on your laptop: the landing page at `/`, GitHub OAuth App sign-in, Postgres, and the
timeline app at `/app` — without touching your normal local SQLite setup.

This is for verifying the cloud build before (or instead of) deploying to Railway.

---

## What you need

1. **A local Postgres** — use the bundled `docker-compose.yml`:
   ```bash
   docker compose up -d db          # postgres:16 on localhost:5432
   ```
   (DB `pierre_review`, user/pw `pierre`/`pierre`.) Stop with `docker compose down`;
   wipe with `docker compose down -v`.

2. **A GitHub OAuth App and/or GitHub App** with a callback for localhost — see
   [GITHUB-AUTH-SETUP.md](./GITHUB-AUTH-SETUP.md). Add
   `http://localhost:4000/api/auth/callback` as a callback URL on whichever you set up.

3. **Cloud env vars.** Copy the template and fill it in:
   ```bash
   cp .env.cloud.example .env       # at the repo root
   ```
   Set `DATABASE_URL=postgres://pierre:pierre@localhost:5432/pierre_review`,
   `APP_BASE_URL=http://localhost:4000`, the `GITHUB_OAUTH_CLIENT_ID` /
   `GITHUB_OAUTH_CLIENT_SECRET` values, and generate the two secrets:
   ```bash
   openssl rand -hex 32   # SESSION_SECRET
   openssl rand -hex 32   # ENCRYPTION_KEY (64 hex chars)
   ```

---

## Run it

### Option A — the dev servers (two processes, hot reload)

```bash
docker compose up -d db
# apply the Postgres migrations once:
DEPLOYMENT_MODE=cloud pnpm --filter @pierre-review/backend db:migrate
# run backend (cloud) + frontend dev server:
DEPLOYMENT_MODE=cloud pnpm dev
```
The Vite dev server proxies `/api` to the backend. The frontend is served under
`/app` in cloud mode; the landing page is served by the backend at `/`.

### Option B — the production single-process build (closest to Railway)

```bash
docker compose up -d db
pnpm package                      # assembles ./release (app + landing + backend)
cd release
DEPLOYMENT_MODE=cloud \
DATABASE_URL=postgres://pierre:pierre@localhost:5432/pierre_review \
APP_BASE_URL=http://localhost:4000 \
GITHUB_OAUTH_CLIENT_ID=... GITHUB_OAUTH_CLIENT_SECRET=... \
SESSION_SECRET=... ENCRYPTION_KEY=... \
node dist/index.js
```

### Option C — the installed CLI with `--cloud`

If you've installed the package (or are running `dist/cli.js`), `--cloud` flips
the mode and skips the local `gh` pre-check (cloud uses OAuth):

```bash
DATABASE_URL=postgres://pierre:pierre@localhost:5432/pierre_review \
APP_BASE_URL=http://localhost:4000 \
GITHUB_OAUTH_CLIENT_ID=... GITHUB_OAUTH_CLIENT_SECRET=... \
SESSION_SECRET=... ENCRYPTION_KEY=... \
pierre --cloud --port 4000
```

`--cloud` is equivalent to setting `DEPLOYMENT_MODE=cloud` before boot.

---

## Verifying

Open `http://localhost:4000/`:

1. **Landing at `/`** — you should see the marketing page (NOT the timeline),
   because cloud mode serves the landing page to anonymous visitors.
2. **Sign in with GitHub** → OAuth round-trip → redirected to `/app`.
3. **`/app`** now shows the timeline app for *your* account.
4. **Per-account isolation** — sign in as user A, add/sync a repo. In a separate
   browser/incognito, sign in as user B. Confirm B cannot see A's repos/PRs, and
   that `GET /api/prs/<one of A's PR ids>` while signed in as B returns **404**.
5. **Workspaces** — a brand-new cloud account must land in a **Default** workspace
   with the repos it adds already in it (`GET /api/workspaces` returns exactly one
   row, `isDefault: true`, and it contains every repo you added). This is worth
   checking on Postgres specifically: the pg migration has to advance the `id`
   sequence by hand after preserving legacy ids, so the FIRST workspace on an empty
   database must come back as **id 1** — an off-by-one there shows up here and
   nowhere else. Then confirm `GET /api/activity?workspace=<B's workspace id>` while
   signed in as A resolves to **A's own Default** (never a 404, never B's repos).
6. **Local mode is unchanged** — `pnpm dev` (no `DEPLOYMENT_MODE`) still goes
   straight to the timeline at `/app` with no landing page and no sign-in.

To reset the cloud DB between tests: `docker compose down -v && docker compose up -d db`
then re-run migrations.
