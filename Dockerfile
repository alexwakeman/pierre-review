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

# Bring in the whole workspace, then install (the committed lockfile drives it).
COPY . .
RUN pnpm install --frozen-lockfile

# Assemble ./release (frontend@/app + landing + backend + migrations + public dirs).
RUN pnpm package

# Install ONLY the release's runtime deps (curated in build-release.mjs).
# Compiles better-sqlite3 + pg against this node/glibc so they match the runtime.
WORKDIR /app/release
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime stage: slim image, same base so native addons are compatible ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DEPLOYMENT_MODE=cloud
ENV HOST=0.0.0.0
# Railway injects PORT; the app reads it (default 4000).
COPY --from=build /app/release ./
EXPOSE 4000
CMD ["node", "dist/index.js"]
