# syntax=docker/dockerfile:1
#
# The image behind pierre-review.com: the landing pages, the static demo at /demo/ and
# the contact form, served by ONE small Node process (apps/site). Nothing else.
#
# Limn itself is local-only — `npx limn-review` on your own machine. There is no
# hosted app, no database and no sign-in, so this image carries no backend.
#
# Build:   docker build -t limn-site .
# Run:     docker run -p 4300:4300 -e PORT=4300 limn-site

# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /repo
# Pin pnpm explicitly so the build never drifts to corepack's bundled default.
# Mirrors the root "packageManager" field.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY . .
# Only what the site needs: the landing, the frontend (for the demo build, if there is
# one) and the site service, plus their workspace dependencies. The backend's native
# modules are never installed.
RUN pnpm install --frozen-lockfile \
      --filter @pierre-review/landing... \
      --filter @pierre-review/frontend... \
      --filter @pierre-review/site...

# Google Analytics — BUILD-TIME ONLY. Vite inlines import.meta.env.VITE_GA_ID into the
# bundles, so the id must be present when `vite build` runs. Railway exposes a service
# variable to a Dockerfile build only when it is declared as an ARG. Declared after the
# install so changing it does not bust that layer. Empty = analytics stays off.
ARG VITE_GA_ID=""
ENV VITE_GA_ID=$VITE_GA_ID

# 1. The landing, prerendered per route (apps/landing/dist).
RUN pnpm --filter @pierre-review/landing build

# 2. The demo: a static, frontend-only build of the app with sample data, served at
#    /demo/. Built only when the frontend defines `build:demo`, which must write
#    apps/frontend/dist-demo with base /demo/. Until then the site shows a short
#    "coming soon" page at /demo/.
RUN pnpm --filter @pierre-review/frontend run --if-present build:demo

# 3. The site service itself (apps/site/dist). No runtime dependencies.
RUN pnpm --filter @pierre-review/site build

# Assemble /out: exactly what the runtime stage needs.
RUN mkdir -p /out/site /out/demo \
  && cp -r apps/site/dist /out/site/dist \
  && cp apps/site/package.json /out/site/package.json \
  && cp -r apps/landing/dist /out/landing \
  && if [ -f apps/frontend/dist-demo/index.html ]; then cp -r apps/frontend/dist-demo/. /out/demo/; fi

# ---- runtime stage ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV LANDING_DIR=/app/landing
ENV DEMO_DIR=/app/demo
# Railway's edge appends the client address to X-Forwarded-For; the rate limit reads
# the entry it wrote, never the client-supplied leftmost one.
ENV TRUST_PROXY_HOPS=1
COPY --from=build --chown=node:node /out ./
# Unprivileged: the process only reads files and makes one outbound webhook call.
USER node
EXPOSE 4300
# Railway injects PORT; the site reads it (default 4300).
CMD ["node", "site/dist/server.js"]
