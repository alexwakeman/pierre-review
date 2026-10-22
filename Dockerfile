# syntax=docker/dockerfile:1
#
# Cloud (Railway) image for Limn (npm: limn-review). Builds the SPA (base /app/), the
# landing page, and the backend, assembles them into ./release via `pnpm package`,
# installs the release's production deps (compiling better-sqlite3 + pg natively),
# then runs the single Fastify process in cloud mode (serves /, /app, and /api).
#
# Local mode does NOT use this image — it's `npx limn-review` on your machine.

# ---- build stage: full toolchain (needed to compile native addons) ----
FROM node:22-bookworm AS build
WORKDIR /app
# Pin pnpm explicitly so the build never drifts to corepack's bundled default
# (that drift — corepack pulling pnpm 11, which blocks native build scripts — is
# what broke the Railway build). Mirrors the root "packageManager" field.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Bring in the whole workspace, then install from the committed lockfile.
COPY . .
RUN pnpm install --frozen-lockfile

# Google Analytics — BUILD-TIME ONLY. Vite inlines import.meta.env.VITE_GA_ID into
# the landing + SPA bundles when `vite build` runs (below, inside `pnpm package`),
# so the id MUST be present in the build env, not just at runtime. Railway exposes a
# service variable to a Dockerfile build only when it's declared as an ARG here; the
# ENV then puts it on process.env so Vite's loadEnv() picks it up. Declared late so
# changing the id doesn't bust the cached `pnpm install` layer. Empty default = GA
# stays disabled (analytics.ts no-ops on a missing/invalid id) — set VITE_GA_ID in
# the Railway service variables to enable.
ARG VITE_GA_ID=""
ENV VITE_GA_ID=$VITE_GA_ID

# Assemble ./release (frontend@/app + landing + backend + migrations + public dirs).
RUN pnpm package

# Install ONLY the release's runtime deps (curated in build-release.mjs).
# Compiles better-sqlite3 + pg against this node/glibc so they match the runtime.
WORKDIR /app/release
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime stage: slim image, same base so native addons are compatible ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# git is NOT in the -slim base, and the coding seams (AI Fix's applyAndPush, the advisor's
# commitFilesAndOpenPr) shell out to it for their worktree → commit → push path. Without
# this, every cloud push would die on ENOENT after the feature looked healthy at boot.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV DEPLOYMENT_MODE=cloud
ENV HOST=0.0.0.0
# Railway injects PORT; the app reads it (default 4000).
# Owned by the unprivileged `node` user that the base image already ships (uid 1000), so the
# process cannot rewrite its own code at runtime.
COPY --from=build --chown=node:node /app/release ./

# Drop root. The container previously ran as uid 0 with no USER directive, which meant any
# code-execution bug in the app — or in one of its transitive dependencies — executed as root
# inside the container: free rein over the filesystem, the ability to patch the running app,
# and a much shorter path out through any kernel/runtime escape. `node:22-bookworm-slim`
# provides the `node` user for exactly this, and nothing here needs privilege: the app binds
# 4000 (not a privileged port), writes only to Postgres, and serves static files read-only.
#
# NOTE for the local-mode/CLI path: that runs outside Docker as the invoking user, and its
# SQLite/clone directories live under $HOME — unaffected by this.
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
