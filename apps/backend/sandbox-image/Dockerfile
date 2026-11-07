# The Limn sandbox image: a disposable Linux box for a workspace session (docs/SANDBOX.md).
# Node 22, git, build tools, pnpm, Claude Code and Codex, `docker-compose` (config only) and limn-svc. Nothing from the host enters except what
# Limn copies in or mounts READ-ONLY. The agent runs as the non-root user `agent` (Claude Code refuses
# bypassPermissions as root).
#
# The two CLI versions are PINNED and must move with Limn's own pins:
#   CLAUDE_CODE_VERSION = the Agent SDK's bundled CLI (`claudeCodeVersion` in
#                         @anthropic-ai/claude-agent-sdk's package.json, apps/backend/package.json dep)
#   CODEX_VERSION       = apps/backend/package.json `limnAiRuntime['@openai/codex']`
# Build: Limn builds it itself when the pinned image cannot be pulled (src/sandbox/runtime/image.ts);
# by hand: docker build -t limn-sandbox:dev apps/backend/sandbox-image
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.295
ARG CODEX_VERSION=0.164.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep python3 make g++ sqlite3 postgresql-client jq procps \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force
RUN useradd -m -s /bin/bash agent && mkdir -p /work && chown agent:agent /work

# Docker Compose, for `docker compose config` ONLY: Limn normalises the reader's compose file INSIDE the
# sandbox (where the repository is), then polices the JSON on the host (src/sandbox/services/). There
# is no Docker daemon or socket here: `up` is run by Limn on the host. Pinned by checksum.
ARG COMPOSE_VERSION=5.3.1
ARG COMPOSE_SHA256_X86_64=f9ebc6ebdb19d769b793c245a736caaeb198c62587f13b25c660c13b4987f959
ARG COMPOSE_SHA256_AARCH64=aa611e811d0ea25897839c404bfb5bf93ce706dc51c500a4457890f5d0606a86
RUN arch="$(uname -m)" \
 && case "$arch" in x86_64) sum="$COMPOSE_SHA256_X86_64";; aarch64) sum="$COMPOSE_SHA256_AARCH64";; *) echo "no compose for $arch"; exit 1;; esac \
 && curl -fsSL -o /usr/local/bin/docker-compose "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${arch}" \
 && echo "$sum  /usr/local/bin/docker-compose" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/docker-compose

# limn-svc (the agent's command) and its relay (Limn starts it over `docker exec`): docs/SANDBOX.md
# § Services. Root-owned, so the agent cannot change them. Part of the recipe hash (image.ts).
COPY limn-svc /usr/local/bin/limn-svc
COPY limn-svcd.cjs /usr/local/lib/limn/limn-svcd.cjs
RUN chmod 0755 /usr/local/bin/limn-svc && chmod 0644 /usr/local/lib/limn/limn-svcd.cjs

# The recipe hash (src/sandbox/runtime/image.ts `recipeHash`): Limn passes it, so a local image built
# from a different Dockerfile or other pins is never reused. Not part of the hash itself. Declared
# here, after every RUN, so a new value does not invalidate the cached layers above.
ARG LIMN_RECIPE=unset
LABEL org.opencontainers.image.title="limn-sandbox" \
      limn.claude-code="${CLAUDE_CODE_VERSION}" \
      limn.codex="${CODEX_VERSION}" \
      limn.recipe="${LIMN_RECIPE}"

USER agent
WORKDIR /work
# No auto-update, no telemetry or other non-essential traffic: the egress proxy allows only what the
# session needs.
ENV CI=true \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1
CMD ["sleep", "infinity"]
