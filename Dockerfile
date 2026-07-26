# syntax=docker/dockerfile:1
#
# Cloud (Railway) image for pierre-review. Builds the SPA (base /app/), the
# landing page, and the backend, assembles them into ./release via `pnpm package`,
# installs the release's production deps (compiling better-sqlite3 + pg natively),
# then runs the single Fastify process in cloud mode (serves /, /app, and /api).
#
# Local mode does NOT use this image — it's `npx pierre-review` on your machine.

# ---- build stage: full toolchain (needed to compile native addons) ----
FROM node:22-bookworm AS build
WORKDIR /app
# Pin pnpm explicitly so the build never drifts to corepack's bundled default
# (that drift — corepack pulling pnpm 11, which blocks native build scripts — is
# what broke the Railway build). Mirrors the root "packageManager" field.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# --with-pro (cloud image ONLY): also build + ship the private @pierre/pro summary-AI plugin.
# Empty default = the OSS image, byte-identical to before. CI checks out the private submodule
# into packages/pro BEFORE `docker build` (the .git metadata is .dockerignore'd, so the submodule
# can't self-init inside the image — it must already be on disk in the build context).
ARG WITH_PRO=

# Bring in the whole workspace, then install. Default = the committed lockfile (submodule absent,
# fully reproducible). With Pro, the submodule adds workspace deps the public lockfile can't carry,
# so let pnpm extend the lockfile in-image (--no-frozen-lockfile) instead of failing.
COPY . .
RUN if [ -n "$WITH_PRO" ]; then pnpm install --no-frozen-lockfile; else pnpm install --frozen-lockfile; fi

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

# Assemble ./release (frontend@/app + landing + backend + migrations + public dirs). With Pro,
# compile the plugin to packages/pro/dist FIRST, then package it in (--with-pro copies it to
# release/pro + adds @anthropic-ai/sdk to the manifest). Without Pro this is the exact `pnpm
# package` line as before, so the default image is unchanged.
RUN if [ -n "$WITH_PRO" ]; then pnpm --filter @pierre/pro build && pnpm package --with-pro; else pnpm package; fi

# Install ONLY the release's runtime deps (curated in build-release.mjs).
# Compiles better-sqlite3 + pg against this node/glibc so they match the runtime.
WORKDIR /app/release
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime stage: slim image, same base so native addons are compatible ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# ARGs don't cross a FROM boundary — re-declare so this stage can gate PRO_PLUGIN_PATH.
ARG WITH_PRO=
ENV NODE_ENV=production
ENV DEPLOYMENT_MODE=cloud
ENV HOST=0.0.0.0
# Point bind.ts straight at the copied-in plugin (the repo-relative fallback paths don't exist in
# the flattened release layout). Empty for the OSS image (release/pro absent → bind no-ops). NOTE:
# activating Pro in cloud ALSO needs PRO_CLOUD_ENABLED=true + SUMMARY_ANTHROPIC_API_KEY (Railway vars).
ENV PRO_PLUGIN_PATH=${WITH_PRO:+/app/pro/dist/index.js}
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
