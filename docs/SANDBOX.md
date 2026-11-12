# Sandboxed workspace sessions

**Implement** (and **Fill gaps**) on a story opens a **workspace session**: a disposable sandbox on the
reader's own computer that holds every repository of the workspace, the ticket in full and the reader's
own Claude notes. A full **Claude Code** or **Codex** agent works in it with a shell. The reader talks to
the agent in the build tab, presses **Start build**, reviews one diff per repository and presses
**Push**. The push runs on the HOST, with the host's GitHub sign-in; nothing is pushed, posted or written
to the tracker before the reader presses a button, except the opt-in "After the build: review and fix, then
open the pull request" (the reader's tick; docs/STORY-BUILD.md § The review loop: the branch, its fix
commits and the final PR). **AI Fix** runs in the same kind of session, on a pull
request: the PR's repository at its head, its ticket's other repositories read only, one push to the PR's own
branch (§ AI Fix sessions). The product flows are [STORY-BUILD.md](STORY-BUILD.md) and
[CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § AI Fix; this file is how the sandbox works and how to set one up.

| Section | What it says |
|---|---|
| § Setting up a runtime | what to install, per computer; how Limn finds it; resources; clean-up |
| § Threat model | what could go wrong, and what stops each thing |
| § Troubleshooting | the usual failures, and what to do |
| § Invariants | the rules the code keeps |
| § The runtime layer … § Sessions | how each part works (runtime, image, labels, proxy, allow-list, credentials, drivers, mirror, services, microsandbox, sessions) |
| § Every end removes the sandbox | how each way a session ends stops and removes its container or VM, the periodic sweep, shutdown, "Stop all" |
| § Testing · § Spike results | the tests, and what the spikes measured |

There is ONE path: with no container runtime, Implement and AI Fix say what is missing and link the setup
steps below (owner decision Q2: the old shell-less plan/build agents and the shell-less fixer are removed,
not kept as a fallback). An unattended AI Fix with no runtime is skipped, with its reason recorded.

## Setting up a runtime

A session needs a container runtime on the reader's computer. **Every route below is free** (owner
decision D9). Docker Desktop is optional; its licence limit is stated.

| Computer | Recommended (free) | Steps | Notes |
|---|---|---|---|
| Mac, Apple Silicon | **microsandbox** | `curl -fsSL https://install.microsandbox.dev \| sh`, then `msb doctor` | Beta. Each sandbox is a microVM with its own kernel; the model credential never enters it. ⚠ Limn's microsandbox backend is **untested** (§ microsandbox): use Colima until it is proven. |
| Mac, Apple Silicon or Intel | **Colima** | `brew install colima docker docker-compose`, then `colima start --cpu 4 --memory 8 --disk 60` | MIT licence. The Colima VM is a second boundary around every container. Intel Macs cannot use microsandbox. |
| Mac (other) | Docker Desktop | Install it; Settings → Resources: at least 8 GB of memory | Free only for organisations under 250 employees AND under US$10M a year in revenue. OrbStack also works; it is paid for commercial use. |
| Linux | **Docker Engine** or **Podman** | Your distribution's packages. Add yourself to the `docker` group, or run Podman without root (`SANDBOX_CLI=podman`) | A container on Linux shares the host kernel. Where `/dev/kvm` exists, microsandbox gives a separate kernel. ⚠ Podman is untested. |
| Linux with KVM | microsandbox | The installer above, then `msb doctor` | Needs glibc 2.28+ and access to `/dev/kvm`. ⚠ Untested (§ microsandbox). |
| Windows | **WSL2 + Docker Engine inside WSL**, or Podman | Install WSL2, then Docker Engine in the Linux distribution; run Limn inside WSL | microsandbox needs WHP (beta). Windows containers are refused. |

The build tab and Settings → Sandbox show the same steps behind **How to set up**
(`components/StoryBuild/SandboxSetupHelp.tsx`); keep the two in step.

**How Limn finds the runtime.** `GET /api/sandbox/runtime` (cached 10 s) runs the detection of
§ The runtime layer: the CLI on `PATH`, whether the daemon answers, and the product (Docker Desktop with
its licence line, Colima, Podman, Rancher Desktop, OrbStack, Docker Engine). The build tab shows the
result in one line ("Runs in Docker Desktop 29.6.2"), or what is wrong.

**How to switch.**

| Setting | What it does |
|---|---|
| `SANDBOX_RUNTIME=auto` (default) | microsandbox when `msb` is installed and `msb doctor` passes, else Docker. Fixed for the life of the process. |
| `SANDBOX_RUNTIME=docker` · `=microsandbox` | Forces one backend. |
| `SANDBOX_CLI=podman` (or an absolute path) | Another CLI with Docker's verbs, for the Docker backend. |
| `LIMN_SANDBOX_MAX_SESSIONS` (2) · `LIMN_SANDBOX_IDLE_MINUTES` (15) · `LIMN_SANDBOX_TURN_MAX_MINUTES` (120) | Open sessions on this computer; a session with nothing to do closes after this long (its sandbox is removed, its changes are kept); one agent turn running longer than the last is stopped. |
| Settings → Sandbox, per workspace | CPUs, memory and disk per session (default 4 CPUs, 8 GB, 30 GB), the Claude notes to bring (found, not set: § Where the reader's clones are), services, the always-allowed hosts. |

There is no Settings switch for the backend: there is no per-computer settings store.

**Resources.** Give the runtime at least **8 GB of memory, 4 CPUs and 60 GB of disk**. Measured on the
BNG backend (spike 4): the sandbox and seven services peaked at 1.9 GiB of memory; the sandbox image is
about 1.3 GB; the BNG service images 2.4 GB; one session's clone with `node_modules` about 560 MB. The
first session pulls (or builds) the image, which takes minutes; later sessions start in seconds.

**Disk clean-up.** Every end of a session removes its containers, network and volumes (§ Every end
removes the sandbox); a sweep every 5 minutes and the boot sweep remove what a failed removal or a crash
left. Settings → Sandbox shows how many sandboxes run now, with **Stop all**. `limn sandbox prune [--dry-run]` (stop Limn first) removes every sandbox
resource of this Limn install, built service images included. The repo store (§ The repo store) is KEPT
by both; `limn sandbox prune --store` removes it too (the next session copies the repositories again). Limn keeps the sandbox image; remove old
`limn-sandbox:local-*` tags with `docker image rm` when the disk is full.

## Threat model

The agent reads text Limn does not control (the ticket, pull requests, the repositories), and it has a
shell. Treat everything it does as untrusted.

| Threat | What stops it |
|---|---|
| Ticket, PR or repository text tells the agent to send data out | The sandbox network has NO route out (`--internal`); the only way out is Limn's proxy, with an allow-list. Every request is logged and shown in the Network panel; a blocked host is opened only by the reader's Allow press. No GitHub credential is inside. The model credential stays on the host: the proxy adds it to each request to the provider (§ Credentials). Web search and web fetch are off in Claude Code, because they run on the provider's side, past the allow-list. |
| The agent damages the host | No writable host mount and no Docker socket (a bind mount is read-only by type; `spec.ts` refuses the socket, `~/.ssh`, `~/.docker`, `~/.config/gh`, `/` and others as sources). Non-root, all capabilities dropped, `no-new-privileges`, CPU / memory / process caps. On Docker for Mac or Windows the VM is a second boundary; **on Linux Docker the kernel is shared** (stated here and in the setup table). microsandbox gives a separate kernel (untested). |
| A compose file escalates | The compose policy (§ Services) refuses the WHOLE file for privileged mode, added capabilities, devices, host namespaces, host mounts (the Docker socket included), loosened security options, outside builds and images from unlisted registries; it rewrites every service onto the session network with Limn's caps. Limn runs compose on the host; the sandbox only asks. |
| The agent's changes reach GitHub unseen | Work leaves the sandbox only as a patch per repository (an AI Fix with the merge item: as a git bundle of its commits, checked on the host — parents, conflict markers, fixes on top — and rebuilt from the checked trees; § AI Fix sessions, "The merge"); the HOST applies it and pushes, on the reader's Push press (Implement: draft by default). Two exceptions push with no press, both on AI Fix and both opt-in: an auto fix on the reader's OWN PR under the workspace's "Push automatically" (OFF by default), and dependency automation's fix of a TRUSTED bot's PR under its policy (all OFF by default; docs/MERGE-CI-TRUNK.md). Both push only the PR repository's patch to the PR's own branch, compare-and-set on the head, after the session has closed. A third, on Implement / Fill gaps: "After the build: review and fix, then open the pull request" (the reader's tick at Start or in the tab, OFF by default; THE REVIEW LOOP): the HOST pushes the branch first (no PR), then ONE NEW fast-forward commit per fix pass (the live ref checked first, never forced), then the PR — ready for review, the reader's own, under the reader's `gh` login; every write a claim row inserted before it, never retried (docs/STORY-BUILD.md § The review loop). The sandbox still holds no GitHub credential. |
| Resource exhaustion | Per-session CPU / memory / process caps (disk enforced on microsandbox only); a total cap on services; at most `LIMN_SANDBOX_MAX_SESSIONS` open sessions; one build turn per computer; idle teardown. |
| Leftovers | Every resource carries Limn's labels; discard, the boot sweep and `limn sandbox prune` remove them. |
| Spend | Every turn of Implement and of a manual AI Fix is a reader's press. An UNATTENDED AI Fix (auto fix, dependency automation) asks the ONE spend gate before it starts, runs ONE build turn with Claude's `--max-budget-usd`, then closes. Each turn's usage is recorded on the ledger and the session's spend is shown. |
| The reader's own files leak in | Only the ticked memory projects, the user `CLAUDE.md` and (opt-in) skills are copied, read-only at source, size-capped. The reader's clones only lend git OBJECTS for the base commit to the repo store, read with hooks, fsmonitor and their config off; never the working tree, index or stash. **Past sessions are never imported** (owner decision D1): no transcript is copied, resumed or written back. |

The details of each layer are the sections below; [SECURITY.md](SECURITY.md) § Workspace sessions has
the summary.

## Troubleshooting

| What you see | What to do |
|---|---|
| "No container runtime" / "Docker is not running" | Start the runtime (`colima start`, Docker Desktop, `sudo systemctl start docker`), then **Check again** in Settings → Sandbox. `docker info` must answer. |
| `permission denied … docker.sock` (Linux) | Add yourself to the `docker` group (`sudo usermod -aG docker $USER`, then sign in again), or use rootless Podman. |
| The first session waits long at "Getting the sandbox image" | The image is about 1.3 GB. When the pull fails (offline, a registry proxy), Limn builds it from the shipped Dockerfile, which takes longer. |
| "No space left on device" | `docker system df`; then `limn sandbox prune` (stop Limn first) and remove old `limn-sandbox:local-*` images. Give Colima more disk (`colima start --disk 100`). |
| A tool in the sandbox cannot reach a host | Open the Network panel: the host is listed as blocked. Press **Allow for this session**, or **Always allow** (this workspace). A tool that ignores the per-tool proxy settings needs Settings → Sandbox → HTTP_PROXY. |
| Behind a corporate proxy or VPN | The runtime must reach the registries to pull images, and the host must reach the model provider. Set the runtime's own proxy (Docker Desktop: Settings → Resources → Proxies; Colima: `colima start --env HTTPS_PROXY=…`). Inside the sandbox, every request still goes through Limn's proxy. |
| Services do not start | The Services panel names each refused rule or failed service. `docker compose config` on the host shows the file as compose reads it. Services do not run on microsandbox yet. |
| microsandbox is installed but not used | `msb doctor` must pass. An Intel Mac cannot run it (Apple Silicon only); Linux needs `/dev/kvm`. `SANDBOX_RUNTIME=docker` forces Docker. |
| A session closed by itself | Nothing happened for 15 minutes, a turn ran past 120 minutes, the agent ended, Limn stopped, or someone pressed **Stop all**. When it stored changes, it stays pushable and **Resume** starts it again. |
| Sandboxes still running after you closed the tab | A session with nothing to do closes after 15 minutes. Settings → Sandbox → **Stop all** closes every one now. |

## Invariants

1. **The sandbox never holds GitHub credentials, the Docker socket, or a writable host mount.** A bind
   mount is read-only by TYPE (`BindMount` has no writable form); writable storage is a named volume
   Limn created. `spec.ts` refuses the Docker/Podman socket, `~/.docker`, `~/.ssh`, `~/.gnupg`,
   `~/.config/gh`, `/`, `/proc`, `/sys`, `/dev` and `/run` as mount sources, even read-only.
2. **On Docker, the sandbox's only route out is the proxy.** The sandbox joins ONLY the session's
   `--internal` network; the proxy joins that network and the runtime's default bridge.
3. **Every sandbox resource carries Limn's labels** and is removed at EVERY end of its session, by the
   periodic sweep and by the boot sweep (§ Every end removes the sandbox). A kept session keeps its
   CHANGES (the stored patch), never a running container or VM.
4. **The model credential stays on the host** (spike 3): the sandbox holds a per-session placeholder,
   the proxy swaps in the real one.
5. **Nothing outside `sandbox/runtime/` starts a container CLI**, and no caller writes `docker run`
   flags: a new need is a typed field in `spec.ts`, with its test.
6. **The sandbox never runs Docker on the Docker backend.** Services run on the HOST from a POLICED
   model (`services/policy.ts`, on every `up`), only from files the reader picked; the agent asks through
   `limn-svc`, and nothing on the host listens for the sandbox (§ Services).
7. **The agent has a full shell inside the sandbox — the ONE exception to "no agent has a shell".** It
   holds ONLY inside a sandbox `sandbox/runtime` started — Implement and AI Fix (§ AI Fix sessions) run
   there; every review and every chat keep the no-shell rule (docs/CLAUDE-REVIEW.md § The agents' tools). The two drivers (`sandbox/drivers/`) are the
   only code that starts `claude` or `codex` in a sandbox (`provider-seam.test.ts`).
8. **The reader's clones (found through their Claude projects, never a setting) decide the LAYOUT and which
   notes come in; the BASE COMMIT comes from Limn's clone cache** at the bases today's rules pick. The reader's clone may only LEND OBJECTS for that commit to the
   repo store — read-only, never its working tree, index, stash, hooks or remote credentials; a commit id
   is content-addressed, so the code is the same (§ The repo store).
9. **One fold for everything the agent is told** (`workspace/seed.ts`), for both subjects: `CLAUDE.md`,
   `AGENTS.md`, `TICKET.md` (a story's; an AI Fix's context ticket), `FIX.md` + `PR.diff` + the report
   checker (an AI Fix) and the system prompt; nothing rebuilds them.
10. **Memories only, never past sessions** (owner decision D1). The ticked projects' `memory/` files
    are copied in; no transcript is copied, resumed or imported, Claude Code runs with
    `--no-session-persistence`, and nothing is written back to the reader's machine.

## The runtime layer (`apps/backend/src/sandbox/runtime/`)

| File | What it holds |
|---|---|
| `types.ts` | `SandboxRuntime`, the one contract: `detect`, `ensureImage`, `createNetwork`, `createVolume`, `startProxy`, `startSandbox`, `exec` (streamed events + stdin), `run`, `copyIn`, `readFile`, `followLogs`, `networkMembers`, `startServices`/`stopServices`, `stats`, `destroy`, `sweep`, `listSandboxes` (the running ones, for Settings), the optional `destroySync` (the 'exit' fallback) and the optional `repoStore` (Docker only: `ensure`, `exec`, `remove`). |
| `docker.ts` | The Docker backend: the `docker` CLI, no SDK. `SANDBOX_CLI=podman` (or an absolute path) names another CLI with the same verbs. |
| `spec.ts` | Every `docker run` argv, as pure functions (pinned by `spec.test.ts`). |
| `image.ts` | Which image, and where it comes from (below). |
| `labels.ts` | The labels and resource names. |
| `detect.ts` | What serves the Docker API, from `docker info --format json` (or Podman's own shape). |
| `tar.ts` | The tar stream `copyIn` sends to `tar -x` running as the agent. |
| `fake.ts` | The in-memory runtime every caller's tests use (below). |
| `microsandbox.ts`, `msb-spec.ts` | The microsandbox backend (`msb` CLI) and its argv/parsers. ⚠ **Untested** (§ microsandbox). |
| `index.ts` | The runtime in use (`SANDBOX_RUNTIME`: `auto` picks microsandbox when healthy, else Docker), the boot sweep and the live sweep (`sweepSandboxesNow`) of every installed backend, the sweep gate (`sweepSettled`), the running count (`listRunningSandboxes`). |

**The sandbox container** (`sandboxRunArgs`): `--user agent`, `--cap-drop ALL`, `--security-opt
no-new-privileges`, `--init`, `--cpus`, `--memory` with the same `--memory-swap`, `--pids-limit`, ONE
`--network` (the session's internal one), bind mounts `readonly`, named volumes, labels, `sleep
infinity`. Work happens through `exec`. Defaults: 4 CPUs, 8 GB, 2,048 processes (spike 4 measured the
BNG backend stack at 1.9 GiB in total).

**A new volume** is made the agent's by a one-off root container that holds `CHOWN` only, with no
network (`volumeChownArgs`). ⚠ Every volume mount carries `volume-nocopy`: without it, an EMPTY volume
takes the ownership of its mount point on first use, which is root when the path is also the working
directory, and the agent cannot write to its own workspace (measured on Docker 29).

**Disk.** Docker cannot cap a named volume on Docker Desktop or Colima, so `diskBytes` is recorded and
reported there, not enforced. On microsandbox the workspace is a private disk of exactly that size.

**Detection** reports the CLI, whether the daemon answers, the server OS and architecture, memory and
CPUs the daemon can give, rootless or not, and the product: Docker Desktop (with the licence line:
free only under 250 employees AND under US$10M revenue), Colima (by context or name), Podman, Rancher
Desktop, OrbStack (paid for commercial use), or Docker Engine. A stopped daemon or a missing CLI is ONE
plain line in `problem`. Windows containers are refused.

## The image (`apps/backend/sandbox-image/Dockerfile`; owner decision Q3)

`ensureImage` tries, in order:

1. a local image tagged `limn-sandbox:local-<recipe>` whose `limn.recipe` label equals the recipe;
2. the release's pinned image, pulled BY DIGEST (`limnSandboxImage` in the release manifest:
   `ghcr.io/<owner>/limn-sandbox@sha256:…`) and tagged locally, only when the pin's recipe equals the
   shipped Dockerfile's;
3. otherwise, or when the pull fails, a local build from the shipped Dockerfile
   (`release/dist/sandbox-image/`, or `apps/backend/sandbox-image/` in a checkout).

**The recipe** is 16 hex characters of SHA-256 over the Dockerfile's bytes and the two CLI pins (Claude
Code = the Agent SDK's bundled `claudeCodeVersion`; Codex = `limnAiRuntime['@openai/codex']`). An edit
to the Dockerfile or a pin bump changes the tag, so a stale image is never reused. It is computed in
ONE place (`image.ts`): the app, `scripts/build-release.mjs` (through the compiled module) and CI
(`apps/backend/scripts/sandbox-image.ts`) all call it. The recipe rides into the image as the build arg
`LIMN_RECIPE` → label `limn.recipe`, declared after every `RUN` so it does not invalidate cached
layers. CI publishing: docs/RELEASE.md § The sandbox image.

## Labels and the sweep

| Label | Value |
|---|---|
| `limn.managed` | a short hash of the Limn DATA DIR (`appInstance`), so two Limn installs on one machine (`pnpm demo` beside the real one) never sweep each other's sessions. A test passes its own value, so the app's boot sweep never removes a test's resources, nor a test's sweep the app's. |
| `limn.session` | the session id (`[a-z0-9][a-z0-9_-]{0,62}`, checked before it becomes a name) |
| `limn.account` | the account id |
| `limn.role` | `sandbox`, `proxy`, `service`, `setup`, `network`, `volume`, `image`, `store` |
| `limn.store` | on the repo store's volume ONLY, the same instance hash as `limn.managed`. The store has NO `limn.managed` label, so the sweep (which lists by it) cannot see it. |

Names are `limn-<session>-<suffix>` (`-sandbox`, `-proxy`, `-net`, `-vol-<key>`). `destroy(session)`
and `sweep(liveSessions)` list each kind by the `limn.managed` filter, read each one's `limn.session`
BY NAME (never by line position: a resource removed between the list and the inspect would shift the
pairing), and remove containers, then networks, then volumes.

**The periodic sweep** while Limn runs, and every way a session ends: § Every end removes the sandbox.

**The boot sweep** (`index.ts` after listen, `sweepSandboxesAtBoot`): no session survives a restart
(the session manager marks them failed), so every resource carrying this Limn's `limn.managed` value goes. It starts no
process when no container CLI is installed, and does nothing when the daemon does not answer. Never
awaited, never fatal. By hand: `limn sandbox prune [--dry-run]` (stop Limn first); `--store` also
removes the repo store (`limn-repo-store-<instance>`), by its `limn.store` label and without `--force`, so
the daemon refuses while a sandbox mounts it. A store maintenance container is `--rm` and carries
`limn.managed` + `limn.role=setup`, so a leftover one is swept like any other.

⚠ **The sweep trusts that ONE backend owns the data dir.** `start()` takes `<dataDir>/server.lock`
(`instance-lock.ts`) before any sweep: a second backend on the same data dir (a worktree's
`pnpm dev:backend` with only `PORT` changed, the CLI beside `pnpm dev`) refuses to start rather than
remove the first one's live sandboxes. A dead holder's lock is taken over. docs/TESTING.md § Scratch stack.

## The egress proxy (`apps/backend/src/sandbox/proxy/`)

One container per session, from the sandbox image, non-root, read-only root, 1 CPU / 256 MB, on the
default bridge and the session network (alias `limn-proxy`). **Its whole program is its command**:
`node --input-type=module -e <server.js>` (`source.ts`), so there is no host mount and no copy step.
⚠ `server.ts` therefore imports `node:` built-ins only and uses erasable TypeScript only (a dev
checkout strips the types with Node's `module.stripTypeScriptTypes`); `source.test.ts` and
`build-release.mjs` both check it.

| Port | What |
|---|---|
| `:3128` | Forward proxy: CONNECT (end-to-end TLS) and absolute-form HTTP, by the allow-list. A refused request never opens an upstream socket (tested with an upstream that counts its connections). |
| `:8081` | Anthropic injector: plain HTTP in, TLS out to `api.anthropic.com`. |
| `:8082` | ChatGPT injector: the same for `chatgpt.com`. |
| `127.0.0.1:3199` | Control (in the proxy container's own loopback): Limn sets the rules and the credentials here through `docker exec -i … node -e` with the JSON on STDIN and a per-session token. |

**The address rule.** A listed name is resolved by the proxy and the connection goes to the vetted
address (no second lookup). Loopback (also `localhost`), link-local (the cloud metadata address
`169.254.169.254`), unspecified, multicast and reserved addresses are always refused. A PRIVATE address
(RFC 1918, CGNAT, IPv6 ULA) is allowed only when the rule that matched names the host EXACTLY, so a
`*.suffix` rule cannot be turned into a way onto the reader's network by a DNS answer. The proxy's own
control port is loopback, so it is never reachable through the forward proxy. Addresses are classified
by ONE table checked with Node's `BlockList`, so every spelling counts (`0:0:0:0:0:0:0:1`,
`::ffff:7f00:1`), and the IPv6 forms that carry an IPv4 address to another network (NAT64, 6to4, Teredo,
IPv4-compatible, site-local) are `reserved`. A forwarded plain-HTTP request's `Host` header is the vetted
authority, never the client's (on a shared front end another `Host` would reach an unlisted site; a
CONNECT tunnel is end-to-end TLS, so its inner `Host` is the residual domain-fronting case).

**It never crashes on a client.** Every socket has an error handler (spike 3: a client that reset after
a refusal took the first spike proxy down, and its DNS name vanished with it).

**The log.** One JSON line per request: time, kind, source address, host, port, method, verdict and
reason, status, bytes, duration; for an injector also the path WITHOUT its query and what was swapped.
Never a header value or a body.

## The allow-list (`allow-list.ts`)

A session's list is the UNION of the defaults, the workspace's "Always allow" rows
(`sandbox_allowed_hosts`, migration 0173), and the session's own "Allow for this session" hosts (in
memory). Nothing is added automatically. Rules are an exact host, `*.suffix` (never the bare suffix,
never a top-level domain), an IP literal (matches only itself), each with an optional `:port` or `:*`;
no port means 80 and 443. Hosts are compared lower-case ASCII (IDN → punycode).

Defaults, finalised from spike 4's log:

| Host | Why |
|---|---|
| `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com` | npm and Yarn packages |
| `pypi.org`, `files.pythonhosted.org` | Python packages |
| `nodejs.org` | Node versions named by `.nvmrc` (BNG needs 24.22.1; the image has 22) |
| `repo1.maven.org`, `repo.maven.apache.org` | Maven Central (the JDBC driver for Liquibase migrations) |
| `github.com`, `codeload.github.com`, `objects.githubusercontent.com` | git dependencies and release downloads, read only: there is no GitHub credential in the sandbox |

Left off on purpose: container registries (the HOST's daemon pulls images, never the sandbox);
`auth.openai.com` (a token refresh must never happen in the sandbox); the provider hosts while
credentials are injected (the model is reached through the injector, which is not on the forward
list); telemetry and update hosts seen in spike 4 (harmless denies).

A reader may add any rule except `*`, a top-level suffix, `localhost`, and loopback, link-local,
multicast or IPv6 literals (`validateReaderRule`). Rules are stored normalised, so one host has one row.

## Credentials (`credentials.ts`; owner decision Q4)

Spike 3 proved injection for both providers, so it ships for both, and Settings states it in one line
(`credentialModeLine`).

- **Claude.** The host credential comes from the ONE ladder (`resolveAiCredential`): an API key, or the
  Claude Code login's access token (`CLAUDE_CODE_OAUTH_TOKEN`, else the CLI's credentials file, else the
  macOS Keychain item `Claude Code-credentials`). An expired login is reported, never refreshed by Limn.
  The sandbox gets `ANTHROPIC_BASE_URL=http://limn-proxy:8081` and the placeholder as
  `CLAUDE_CODE_OAUTH_TOKEN` (login) or `ANTHROPIC_API_KEY` (key).
- **Codex.** The sandbox's `auth.json` has the real file's shape and fake secrets: unsigned JWTs with
  only `exp`, `iat`, the auth claim and a session nonce; `refresh_token` is a placeholder. The fake
  access token IS the ChatGPT placeholder. Its `exp` is the real one's, so Codex never tries to refresh
  inside the sandbox. `codexInjectedConfigToml()` points Codex's provider at `:8082`; the driver adds
  the lockdown around it.
- **Where the real secret goes.** Only to the proxy's in-memory store, over the control port, through
  `docker exec -i` STDIN. Never an env var of any container, an argv or a file: `docker inspect` of the
  proxy shows none. `EgressSession.refreshCredentials()` pushes it again (call it before each turn: the
  host refreshes, the sandbox never does).
- A request to an injector carrying ANY credential other than the placeholder is refused (403) and
  never forwarded.

## How tools in the sandbox reach the internet

**No global `HTTP(S)_PROXY` by default** (spike 4 rule 2, now the built default): code under test that
reads those variables itself (DEFRA's CDP apps do, and ignore `NO_PROXY`) would send its calls to local
services out through the proxy. `sandboxToolProxyEnv()` points each tool at the proxy instead —
`npm_config_proxy`/`npm_config_https_proxy` (npm, pnpm), `YARN_HTTP(S)_PROXY`, `PIP_PROXY`, git
`http.proxy` and a GitHub `insteadOf` pair for `ssh://git@github.com/` and `git@github.com:` (there is no
SSH out) — and sets `LIMN_PROXY` for anything else (`curl -x "$LIMN_PROXY" …`). A workspace that wants
the global variables gets them with `globalProxyEnv` (Settings, WP4). The plan's "the sandbox gets
`HTTP(S)_PROXY`" is superseded by this.

## The request log (`log.ts`)

The proxy's lines become ONE ROW per (source, injector or forward, host, port, verdict) with a count,
bytes and the last status, so a looping client is one climbing row. The source is the client's
container name on the session network (looked up once per address). A new row is sent at once; updates
to a row at most once a second; past 500 rows the rest fold into one "(other hosts)" row per verdict.
`EgressSession.log` feeds the Network panel; `allow(rule, 'session' | 'workspace')` is the Allow
buttons' backend (the route is WP7's).

## Agent drivers (`apps/backend/src/sandbox/drivers/`)

ONE long-lived agent process per session, started INSIDE the sandbox through `runtime.exec` (never a host
process), and ONE normalised event for both providers: packages/shared `SandboxAgentEvent` (`status`,
`text` partial/final, `tool_call`, `tool_result`, `turn_end`, `error`). The build tab renders only it.

- **The run choice, once** (`index.ts` `resolveSandboxAgentChoice`): the request's `{provider, model}`,
  already validated by `ai/run-choice.ts` (kind `story_build`); a stored model maps back through
  `requestModelOf`; the provider resolves the DEPTH to its own model (`getProvider(p).resolveModel`); the
  effort is THE Settings level for a worktree run (`agenticRunEffort`). The drivers take the result and
  pick nothing (`provider-seam.test.ts` § the sandbox agents: only `claude.ts` / `codex.ts` start a CLI
  in a sandbox, and neither resolves a model or an effort).
- **Claude** (`claude.ts`, spike 1): `claude -p` stream-json in and out, `--permission-mode plan` for the
  chat (the CLI refuses every write), `set_permission_mode bypassPermissions` for **Start build** on the
  SAME process (it starts with `--allow-dangerously-skip-permissions`), `interrupt` for **Stop** (the
  process lives on). `--strict-mcp-config` with no server, `--setting-sources user,project`,
  `--no-session-persistence`, the seed as `--append-system-prompt-file`, the other repositories as
  `--add-dir` with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` (their CLAUDE.md loads at start). `--disallowedTools`: schedules, remote triggers, messages to other sessions, the web tools
  (a web search runs on Anthropic's side, past the allow-list) and `ExitPlanMode` (the reader starts the
  build).
- **Codex** (`codex.ts`, spike 2: `codex app-server --strict-config`): `thread/start` (or `thread/resume`
  of the stored thread), the seed as `developerInstructions`, and the sandbox policy PER TURN — chat
  `externalSandbox` (network "restricted"), build `dangerFullAccess`, no restart. Codex's own read-only
  sandbox cannot run in ours (bubblewrap), so after every CHAT turn the driver runs `git status` in each
  repository and reports what changed (`turn_end.changedInChat`). **Stop** is `turn/interrupt`; only
  when that is not answered in 10 s is the process ended. The config is Limn's lockdown
  (`lockdownToml(LOCKED_SETTINGS)`) minus `features.shell_tool` (the shell is the point) and
  `project_doc_max_bytes` (the repositories' AGENTS.md are the work's), around the injected provider
  (`codexInjectedConfigToml`). ⚠ Every server REQUEST is refused, `account/chatgptAuthTokens/refresh`
  included: a refresh must never happen in the sandbox.
- **Usage** (one ledger row per turn, `db/usage.ts` `recordAiUsage`, feature `story_plan` for a chat turn
  and `story_build` for a build turn): Claude's `result` carries the PROCESS's running `total_cost_usd`
  and `modelUsage`, so a turn records the DIFFERENCE (an interrupted turn adds nothing). Codex's
  `thread/tokenUsage/updated` `total` is the THREAD's, so a turn is `last total − (first total − first
  last)`, right after a resume too; its row is US$ 0 with raw input tokens, like every Codex row.
  Claude's `rate_limit_event` goes to the budget's reading (`noteAgentMessage`: the CLI is not an SDK
  query, so the runtime tap does not see it). The session shows spend with `useRunCostText()`.
- **Before each turn** the driver calls `beforeTurn` — the session passes
  `EgressSession.refreshCredentials` (the host refreshes, the sandbox never does).
- **No automatic continuation lives here.** A driver takes every turn it is given (a reader's click);
  the session manager asks the ONE budget gate before any automatic one.

**Live checks, 2026-11-07** (`drivers.live.test.ts`, image `limn-sandbox:dev`, credential injected):
Claude Haiku 5.5 at low effort — two chat turns in plan mode (the second recalled "alpha" and refused the
`touch`; no file appeared), Start build, a build turn wrote the file; three ledger rows, US$ 0.0033 +
0.0012 + 0.0005; the real token in no sandbox file. Codex (`gpt-6-luna`) — the sandbox config passed
`--strict-config`, the thread started, the turn reached the model and failed on the account's usage limit
(429, until 9 Nov), the thread RESUMED in a new app-server under the same id and its build turn reached the
model the same way. ⚠ A finished Codex turn (deltas, usage, a write under `dangerFullAccess`, a real
interrupt) is still NOT proven live: re-run `LIMN_SANDBOX_LIVE=codex` once the limit resets.

## The workspace mirror (`apps/backend/src/sandbox/workspace/`)

What the agent finds when the session opens: the repositories the job needs (Implement: every workspace
repository; AI Fix: § AI Fix sessions → Scope), the ticket in full, and the reader's own Claude notes. The
session manager (WP7) calls, in order: `resolveWorkspaceLayout` (the SAME computation Settings shows) →
`sandboxMountsFor` → `readSessionTicket` → `prepareSessionWorkspace`.

| File | What it holds |
|---|---|
| `remote.ts` | A git remote → `owner/name` (scp-like, `ssh://`, `https://` with or without a credential, `git://`, SSH host aliases); the remotes of a git config, read as TEXT. |
| `discover.ts` | Where the reader's clones are, with no setting: every Claude project key DECODED by a disk walk, its clone (or team folder) matched by remote, and the folder the layout mirrors picked (below). |
| `scan.ts` | The folder walk: clones at depth ≤ 3, Claude projects at depth ≤ 6 (entered only where a key leads). Dot-folders, `node_modules` and symlinks skipped; a clone inside a clone is not one; ≤ 20,000 folders and 5 s, else `truncated`. No `git` process. |
| `layout.ts` | The match (BY REMOTE, case-insensitive, the shallowest clone first; the rest `alsoAt`) and the layout. Pure. |
| `memories.ts` | The reader's Claude files: memory projects, `~/.claude/CLAUDE.md`, `~/.claude/skills/`. |
| `project-skills.ts` | The repositories' own skills (`…/.claude/skills/<name>/SKILL.md`), from the clone cache's tree: counted for the start panel, named in the seed. |
| `check.ts` | `resolveWorkspaceLayout` + `toFolderCheck` (the Settings check's wire shape). |
| `ticket.ts` | The ticket, read FRESH (below). |
| `seed.ts` | THE ONE FOLD of everything the agent is told. Goldens: `__fixtures__/seed-*.md`. |
| `mirror.ts` | The repositories into the sandbox (`MIRROR_CONCURRENCY` = 3 at once), the per-session copy, and the reader's files. |
| `store.ts` | The repo store's side: the local-clone check, the copy into the store, the repository built from it (§ The repo store). |
| `index.ts` | The order above, and `prepareSessionWorkspace`. |

**Where the reader's clones are** (`discover.ts`; since 2026-11-10 — the "local folder" and "starting
folder" settings are REMOVED, their columns `local_folder` / `start_dir` DORMANT: never read, never written,
kept). Before, a reader who set no folder (the default) got NO memories at all, silently. Now:

1. Every key under `~/.claude/projects/` (Limn's own litter skipped, ≤ 400 keys) is DECODED by walking the
   disk from `/`: a folder is entered only when its encoded name is the next part of the key, so
   `bng-fe-be` and `bng/fe/be` are told apart by what exists (≤ 400 folders read per key). Never a string
   rule: the encoding is lossy.
2. A decoded folder inside a clone (a `.git` FOLDER; the home folder and its parents never count, so a
   dotfiles repository does not swallow everything) whose remote names a workspace repository: that clone is
   the repository's, and the project is RELATED. A decoded folder in no clone that holds a workspace clone
   below it (depth ≤ 3, ≤ 2,000 folders, 1 s; never the home folder) is a TEAM FOLDER, also related. A linked
   worktree (`.git` file) is neither.
3. The folder the layout mirrors (`pickReaderFolder`): the closest common parent of every clone's parent (a
   team folder stands for the clones in it) when `localFolderProblem` allows it (never the home folder or an
   ancestor), else the parent holding the most clones, else a clone itself. A clone outside the picked folder
   is not mirrored at its path (it goes beside the others); its memories still come.
4. The memories OFFERED are the related projects' only, every one ticked by default (a saved untick list
   still applies). Another project that happens to sit near the clones is never offered.

The check and a session run the SAME `resolveWorkspaceLayout`. Disk only, no `git` process, no network.

**The layout** (owner decision D6; the plan's "mirroring absolute paths"):

- a repository with a clone in the found folder sits at that clone's path, so Claude Code's
  project key (the folder with every non-alphanumeric character as `-`) and every path a memory cites
  still hold. Measured on the BNG folder: 9 of 9 repositories matched, `DEFRA/cdp-app-config` (another
  workspace's) named and left out, the `bng-metric-harness` project's 37 memories offered, 51 ms;
- one with no clone there sits at `<folder>/<name>` (`<folder>/<owner>-<name>` when that path is taken,
  also by a clone outside the workspace);
- with no clone found at all, at `/workspace/<owner>/<name>`;
- the ROOT (the folder, or its parent when the folder is itself a clone, or `/workspace`) is ONE session
  volume holding every repository and the seed files, which sit there OUTSIDE every repository and are
  never committed. The container's working folder is the root (Docker would create a missing start
  folder as root inside the agent's volume); the driver runs the agent with `cwd: startDir`;
- refused as a folder: `/`, the home folder or an ancestor of it, Limn's data folder; refused as a place
  inside the sandbox (the layout falls back to `/workspace` with a note): the image's own trees (`/usr`,
  `/etc`, `/home/agent`, …), and `/home`, `/var`, `/tmp`, `/opt` themselves;
- **the start folder**: the ticked project with the most memories (inside the root), else the folder. There is
  no setting: Claude Code loads the memories of the project it starts in, so this is the right default.

**The base commit comes from Limn's clone cache** (plan invariant 4): `prepBranchWorktree`'s fetch and
pin rules at the base the caller chose (story-build `baseFor` rules; the base is pinned by the caller's
ref). On Docker the repositories come from the KEPT REPO STORE (below); without it (microsandbox, a store
that could not be made, or a store step that failed for one repository) from THE PER-SESSION COPY.
Repositories are prepared **3 at a time** (`MIRROR_CONCURRENCY`, one constant); every host step still
takes clone-manager's per-repository lock. As each one starts, the `repos` boot step's detail reads
`Loading repositories <n>/<total>: <owner/name>` (`mirrorProgressLine`, on the session's existing stream; no
polling), so the reader sees how far along it is. Each sandbox repository keeps `refs/limn/base` = the start
commit (the patch is `git format-patch refs/limn/base..<KEY>`) and must end with `HEAD` at exactly
that commit (checked). A repository that cannot be cloned is one line in the boot notes; the session goes
on and the seed names only what is there.

**The per-session copy** (`mirror.ts`): per repository, on the HOST, `prepBranchWorktree`, then a
throw-away DEPTH-1 repository fetched from the cache at that commit, whose `.git` is streamed into the
sandbox as a tar on `tar -x`'s stdin (as the agent), and checked out on `<KEY>` (the ticket key, case kept, `sessionBranch`). ⚠ The cache
is BLOBLESS: a shallow fetch from it fails ("possible repository corruption on the remote side") until the
base tree's blobs are in it, so the worktree checkout comes first (measured). ⚠ macOS's `tar` adds
AppleDouble `._*` files and xattr headers: the host tar runs with `COPYFILE_DISABLE=1 --no-xattrs` and the
extract excludes `._*` (measured: `._.git` was an untracked file in every repository). No folder is mounted
for this (a bind mount of the cache's 0700 folders would not be readable by the agent's uid on Linux), and
no remote, hook or credential crosses. Measured on the real `DEFRA/bng-metric-harness`: 55 s to prepare
the first time (the cache fetching the base's blobs from GitHub), 8 s to stream and check out 770 files.

**Memories** (owner decision D1): the ticked projects' `memory/**` only — never a transcript — copied as
FILES under the SAME key in `/home/agent/.claude/projects/<key>/memory/`. Because each clone sits at its own
path, the key Claude Code computes in the sandbox IS the reader's key, so the start project's `MEMORY.md`
loads as on the reader's machine; the seed lists every other project's folder as files to read (each project
is named by its folder, so the repository it belongs to is plain). Found by DECODING each key against the
disk (§ Where the reader's clones are). Limn's own project folders (`ai/session-litter.ts`
`litterPrefixes`) are never offered. Default ticks: every related project with memories. Pinned by
`discover.test.ts` (two repositories, each one's memories under the key of its own sandbox path). Regular files only, symlinks skipped, ≤ 256 KB a file and 4 MB in all
(left out and counted, never cut). Codex has no memory store: AGENTS.md lists the same files to read.

**The repositories' own CLAUDE.md and AGENTS.md** are committed files, so they are in each checkout at the
base commit (a `CLAUDE.local.md` is not committed and does not come). Claude Code loads the start folder's and
its parents' at start; every other repository is an `--add-dir`, and the driver sets
`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` (`claudeSandboxEnv`) so theirs load at start too. Codex
loads AGENTS.md from the git root down to its start folder (`project_doc_max_bytes` is NOT locked in a
session); the seed's rule 6 tells both agents to read each changed repository's CLAUDE.md / AGENTS.md first.

**The reader's CLAUDE.md and skills** (Q1): `~/.claude/CLAUDE.md` → `/home/agent/.claude/CLAUDE.md`
(default on), and the found folder's own CLAUDE.md (outside every repository) quoted in the seed under the
same switch; `~/.claude/skills/**` → `/home/agent/.claude/skills/` only when the workspace opts in (≤ 1 MB
a file, 16 MB in all; an executable keeps its bit).

**Project skills** (`project-skills.ts`): the skills a repository keeps in its own tree,
`<any folder>/.claude/skills/<name>/SKILL.md` (not under `node_modules` / `vendor` / `third_party` /
`bower_components`, ≤ 50 per repository), are in each checkout already — nothing is copied for them. Claude
Code loads only the start folder's skills and Codex none, so the seed NAMES each one at its sandbox path
("Read a skill's SKILL.md when its task comes up"), for both providers. Read from Limn's clone cache at the
session's base commit (`git ls-tree`, file names only, lazy fetch off); a skill's text is repository content
and never enters the seed. The build tab's start panel counts them, with the memories, CLAUDE.md and the
reader's skills, before Start (`GET …/sandbox/project-skills`; frontend `lib/sessionInherits.ts`).

**The ticket** (`ticket.ts`, `tracker/open-points-ticket.ts`): read FRESH at session start — a session is
a RUN the reader started, the same exception a PR review run makes (docs/TRACKERS.md § Open points). With
PRs: `openPointsForPr(…, {refresh: true})` on at most two of them, open first; with none: the workspace's
sprint list read, marked due and run (waited for ≤ 20 s). Then the story is resolved exactly as the story
view shows it (`resolveStoryBuildInputs`: the same AC1, AC2, … order). Never fatal: a failed read is the
stored copy, said so in TICKET.md. Fill gaps adds the gap fold's verdicts and missing items. The ticket
also carries WHERE its criteria live (`acLocation`, `tracker/ac-location.ts` through a lazy seam; absent ⇒
the description's AC heading): TICKET.md's "Acceptance criteria as written in the ticket" names the
place (a field, a description section, nowhere), the criteria's layout and their raw text (fenced), and
"Description layout" lists the headings in order (`seed.ts ticketLayoutFacts`, shared `ticketLayoutOf`).
`plan-context.json` gets the same as `ticket` (`acLocation`, `headings`, `criteriaStyle`, `gherkin`), so the
validator refuses criteria written outside the description when they live in it (docs/TRACKERS.md § The
ticket update).

**The seed** (`seed.ts`, plan invariant 5): `CLAUDE.md`, `AGENTS.md` (the same, worded for Codex) and
`TICKET.md` at the root, plus `systemPrompts[provider]` for the driver. They carry the layout (path, base,
branch per repository), what was left out and why, the reader's notes, the services (WP6) and `limn-svc`,
the network rule, the rules (chat first; no push, no remote; commit on the branch; do not edit the seed;
`TODO(open point N)`; the repositories' own conventions and checks; report per AC) and the WRITING RULES.
The ticket text sits in TICKET.md under a line saying it is the requirement, not instructions about the
session. A driver, the manager and the UI read these strings; nothing rebuilds them. Plan first
(`planFirst`): rule 1 says the session starts with a PLAN, a `## The plan` section gives the
`limn.plan/1` shape and its rules (goldens `__fixtures__/seed-plan-*.md`), and the seed writes the
checker and its context (§ The plan and its checks); after Approve `PLAN.md` joins the root files.

**Reference documents** ("Implement with docs"; `workspace/docs.ts`, `docs-choose.ts`): a `docs` boot step
after `repos`, before `services`, copies a READ-ONLY SUBSET of the library to `/home/agent/.limn/docs/`
at the library's own relative paths (`INDEX.md`, every `CONTENTS.md`, the chosen sections, a
`SHORTLIST.md`), as root, files 0444 and folders 0555; no host folder is mounted and no model is asked.
The sections: the CURRENT Check against docs run's shortlist and cited sections, else the whole small
library, else the top 30 full-text hits; ≤ 30 sections and 600 KB. `DOCS.md` at the root carries that
check's findings (fenced as library text) or says there is none; TICKET.md points at the folder. No
built document ⇒ the step is skipped with one line; a copy that fails is skipped too, never fatal.

**Settings → Sandbox** (`sandbox_workspace_settings`, migration 0174; `db/sandbox-settings.ts`;
routes docs/API.md § Sandbox settings): the ticked memory projects (NULL = the default), the user CLAUDE.md
and skills switches, `globalProxyEnv`, CPUs / memory / disk (NULL = 4 / 8 GB / 30 GB), the services, and the
"Always allow" hosts. Per workspace, nothing inherited; PUT replaces the whole setting. `local_folder` and
`start_dir` are DORMANT (removed 2026-11-10): not on the wire, dropped from a stale PUT by the schema, never
cleared, still in the data export. The check (`POST …/sandbox/check`, no body, the reader's **Find** press) is
the same `resolveWorkspaceLayout` the session runs.

## The repo store (`workspace/store.ts`, `runtime.repoStore`; Docker only)

ONE named volume per Limn install, `limn-repo-store-<instance>` (labels `limn.store=<instance>`,
`limn.role=store`, no `limn.managed`: the sweep never sees it), holding ONE BARE REPOSITORY per
repository (`<owner>__<name>.git`), KEPT across sessions. Every sandbox mounts it READ-ONLY at
`/limn-store` (`sandboxMountsFor`; `/limn-store` is a refused layout place). Per repository:

1. **The commit**: `resolveBranchCommit` (clone-manager) — `prepBranchWorktree`'s fetch and pin, without
   the worktree. No blob is downloaded.
2. **In the sandbox** (as the agent): when the store has `refs/limn/keep/<sha>`, `git init` at the layout
   path, `objects/info/alternates` → the store's objects (BORROWED, not copied), `.git/shallow` = the
   commit, `refs/limn/base`, the branch checked out, hooks folder removed; `HEAD` must equal the commit.
   Exit 75 = the store lacks it. Only the argv crosses `docker exec`.
3. **Only then, the missing objects**, under a per-repository lock in this process: a MAINTENANCE
   container (`storeMaintenanceArgs`: Limn's image, `--rm`, `--network none`, root with EVERY capability
   dropped, `no-new-privileges`, read-only root, the store read-write) runs `git fetch --depth 1` whose
   transport is its own stdin/stdout (`ext::`, allowed by `-c` for that one fetch). Limn connects that to
   `git upload-pack` run on the HOST against the SOURCE. The store sends its keep refs as `have`s, so
   only the objects it lacks cross (measured: a second base that changed one file copied 4–5 objects);
   `fetch.fsckObjects` + `transfer.fsckObjects` check every object; git writes them into a quarantine and
   the ref last. Then step 2 again.

**The source** is the reader's LOCAL CLONE when the layout matched one by remote (the first path, then
`alsoAt`) AND it has the commit AND it is complete (not shallow, not partial) — no blob comes from GitHub.
Anything else (a missing commit, a shallow, partial or broken clone, a failed copy) falls back to the clone
cache after `prepBranchWorktree` brought the base tree's blobs in, with ONE boot-note line naming each
repository and why ("Copied from Limn's own clone, not yours: …"). A failure after the commit is known
falls back to the per-session copy for that repository.

**Why fetch over the container's stdin, not a bundle or a pack file**: git's own negotiation decides what
the store lacks (a bundle needs Limn to list prerequisites the store has, and a pack of "missing objects"
needs Limn to compute them); thin packs are completed and every object fsck'd by the receiving git; the
same code serves both sources; no file is written on the host, and nothing is mounted from it. The
repository borrows the store's objects instead of copying them, so a session's `.git` is ~100–200 KB
(the harness's 112 MB pack is never copied per session).

⚠ **The reader's clone is READ, never written.** Only `rev-parse`, `config --get-regexp`, `cat-file -e`
and `upload-pack` run against its git dir, each with `core.hooksPath=/dev/null`, `core.fsmonitor=false`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_NO_LAZY_FETCH=1` (no remote, no credential is
ever used), `GIT_OPTIONAL_LOCKS=0` and `GIT_NO_REPLACE_OBJECTS=1`. None reads the working tree, the index
or the stash. No transport is configured on the host side (upload-pack runs directly on the git dir), so
no `protocol.file.allow` is set. `store-real.test.ts` pins it on a DIRTY clone (a stash, a staged change,
an edit, an untracked file, hooks and an fsmonitor that would leave a mark): every path's mtime and size
and `git status` are unchanged, and nothing ran. Measured on the BNG folder: no file under any `.git` was
newer than the run's start, and `git status` was unchanged.

⚠ **Every `git fetch` inside a store-borrowing repository passes `-c core.alternateRefsCommand=true`.**
git reads only the `shallow` file of the repository it runs in, so the store's depth-1 cuts are not cuts
there. A DEEPENING fetch (`--depth`/`--deepen`) checks connectivity with the alternate refs as POSITIVE
tips (no `--not --all`), walks an older keep ref, misses its parent and fails ("Failed to traverse parents
of commit …", "remote did not send all necessary objects") once the store holds a second keep ref. The
flag gives git no alternate refs; objects are still borrowed. Copying the store's `shallow` file in is NOT
a fix (another session adds keep refs later). The fetches today: the MERGE item's (`FETCH_INTO_REPO_SCRIPT`)
and Resume's (`RESTORE_BUNDLE_SCRIPT`, not deepening; the flag guards a later `--depth`). `STORE_FETCH` runs
in the store itself, which borrows nothing. Pinned by `session/fix-merge-store-real.test.ts` (`slow`, real
git, no daemon), whose control runs the same fetch WITHOUT the flag and must still fail.

⚠ **The sandbox cannot write the store** (shared by every session): the mount is read-only and every
file is root's (the maintenance container runs as root; the agent is uid 1001). Pinned by
`store-real.test.ts`.

⚠ **The store is never gc'd or pruned by Limn** (`gc.auto=0`, `maintenance.auto=false`, fetch with
`--no-auto-maintenance`): a running sandbox borrows its objects. It only grows: the depth-1 tree of the
first base of each repository, then only the objects each later base changed. Measured on the BNG
workspace (9 repositories, one base each): **139 MB** (108 MB of it `bng-metric-harness`). `limn sandbox
prune --store` removes it whole; the daemon refuses while a sandbox mounts it.

**Not on microsandbox**: it has no named volumes (its workspace is a private disk per VM), so a shared
store would be a host folder written by host git and mounted `:ro`, a different trust shape. microsandbox
keeps the per-session copy behind the same seam (`runtime.repoStore` absent).

**Measured, 2026-11-07** (Intel Mac, Docker Desktop 29.6, the 9 BNG repositories, bases = each default
branch's tip, so every repository also asks GitHub for the tip; no model run): the per-session copy one at
a time **33–36 s** (the clone cache already holding the blobs); the store, 3 at a time, **24.7 s** with
an EMPTY store (4 of 9 objects from the local clones, 5 from the cache: those clones did not have the
new tips) and **7.4 s** for the next session (nothing copied). The harness alone from its local clone:
9.7 s to fill the store (pack 6 s on the host), then 3 s per session.

## Services (`apps/backend/src/sandbox/services/`; owner decision D5)

Integration tests run against REAL services from the repositories' compose files. On Docker, **Limn runs
the services; the agent asks** — there is no Docker, socket or daemon in the sandbox.

| File | What it holds |
|---|---|
| `policy.ts` | THE COMPOSE POLICY: a normalised model in, a runnable model (or the whole file refused, every reason) out. Pure. |
| `controller.ts` | One per session, on the host: the `limn-svc` verbs, normalise → police → build → `docker compose`, the forwards, the Services panel's status. |
| `relay.ts` | The host side of the relay: `limn-svcd` started over `runtime.exec`, NDJSON over its stdio. |
| `dind.ts` | microsandbox: Docker INSIDE the VM, the same policy on the picked files. ⚠ Code only, never run. |
| `index.ts` | `serviceStacksFor` (the picked files, placed), `startSessionServices` (controller + relay). |
| `../../../sandbox-image/limn-svc`, `limn-svcd.cjs` | The agent's command and the relay, baked into the image (root-owned; part of the recipe). |

**Why services, and not the ones the reader already runs.** The sandbox sits ONLY on the session's
`--internal` network: no route to the host, the LAN or Docker Desktop's VM. Its one way out is the proxy, which
always refuses loopback (`localhost`, `127.0.0.1`), link-local and reserved addresses, allows a private
address only for a host the reader named EXACTLY, and speaks HTTP CONNECT only — so a Postgres or Redis client
could not use it even then. Opening a route to the reader's own containers would hand code the agent runs
(steered by ticket and PR text Limn does not control) the reader's local data: their dev databases, queues and
credentials. So every session gets its OWN throw-away services, on its own network, removed at its end.

**Which files.** Settings → Sandbox `services` (`SandboxServiceStackChoice {repo, file,
egress}`, migration 0175). Limn never runs a file the reader did not pick. **Choose compose files**
(`GET …/sandbox/compose-files`, `services/compose-files.ts`, click-gated) lists the candidates: per workspace
repository, every path whose name is `compose*.y(a)ml` / `docker-compose*.y(a)ml` at any depth (not under
`node_modules`, `vendor`, `third_party`, `bower_components`; ≤ 50 a repository, shallowest first), read with
`git ls-tree` from Limn's OWN clone cache at its newest default-branch ref (`refs/pierre/ticket-default-branch`,
`refs/heads/*`, `refs/remotes/origin/*`, else `HEAD`). Names only, so the blobless cache answers with no
download (`GIT_NO_LAZY_FETCH=1`); a repository with no cached copy says so (`copied: false`). The reader ticks
several at once; a file not listed can still be typed. The reader's own checkout is never read for this. A picked file of a repository
not in the session is one line in the boot notes. `limn-svc` calls each file by its repository's name
(`bng-metric-backend`).

**How a request travels.**

```
 limn-svc up postgres ──unix socket /tmp/limn-svc.sock──► limn-svcd (sandbox, as the agent)
                                                              │ stdout (docker exec, Limn's own pipe)
                                                              ▼
 Limn (host): ServicesController ── docker-compose config (IN the sandbox) ─► JSON
                                 ── policeCompose ─► refused (reasons) │ runnable model
                                 ── runtime.buildImage / runtime.compose (on the host, model on stdin)
                                 ── forwards ─► limn-svcd listens on localhost:<published port>
```

Nothing on the host listens for the sandbox: the only channel is the `docker exec` Limn started, so a
sandbox can never connect to Limn. The agent can kill the relay (same user); Limn starts it again up to
five times and gives it the forwards again. The request is DATA: every word is matched against the picked
files' services, every path against the workspace root.

**The verbs** (`limn-svc help`): `ls`, `check [file]`, `up [file | file/service | service …]` (a named
service starts with what it `depends_on`), `down [file]`, `ps`, `logs <service> [--tail N]`, `build
<service> [folder] [--file F] [--target T]`, `run <service> [command …]` (a one-off container: spike 4
rule 4's migration job). A bare service name must be in exactly one file. Two files that share a
service name cannot run at the same time (both would answer to it on the one network). Mutating verbs
run one at a time per session.

**Normalising.** `docker-compose config --format json` runs INSIDE the sandbox (the image carries the
pinned Compose binary for this only; no daemon is involved), on the file as it is at that moment, where
its `env_file`s, `.env` and relative paths are. Paths come out absolute in sandbox terms, `${VAR}` filled
and `$` written `$$`. ⚠ The output is UNTRUSTED (the agent can edit the file): the policy is the
boundary, and it runs on every `up`, `run`, `build` and `check`.

**The policy** (`policy.ts`). REFUSED, the whole file, every reason listed: `privileged`, `cap_add`,
`devices`, `device_cgroup_rules`, GPUs (also as a device reservation), `network_mode` other than `none`
or `service:<same file>` (so `host` AND `bridge`), `pid`/`ipc` `host` or `container:`, `uts`/`userns_mode`/
`cgroup` `host`, `cgroup_parent`, a non-runc `runtime`, a `security_opt` other than `no-new-privileges`,
a logging driver other than `json-file`/`local`/`none` (a syslog/fluentd/gelf driver would send data out
from the HOST daemon), `use_api_socket`, provider services, compose models, `external_links`,
`volumes_from: container:`, a bind from outside the workspace root (the Docker socket is outside it), a
mount type other than bind/volume/tmpfs, a volume with a driver or `driver_opts` (a local volume with
`o: bind` is a host mount), an external volume, a file-based or external secret/config, a build from
outside the workspace or with `ssh`/`secrets`/`additional_contexts`/`entitlements`/`network`/
`privileged`/`dockerfile_inline`, an image from a registry not on `DEFAULT_ALLOWED_REGISTRIES` (Docker Hub,
GHCR, ECR Public, MCR, Quay, GCR, registry.k8s.io: the HOST daemon pulls, so an image name is a way out;
`localhost:5000` is refused), more containers than 30, more memory than the total. REWRITTEN:

- networks → ONLY the session's internal network (`external`); other networks' aliases, `container_name`
  and `links` aliases become aliases there; `extra_hosts` dropped (caddy's `host-gateway` route is dead);
- `ports` dropped → **localhost forwards** in the sandbox (`limn-svcd`, 127.0.0.1 and ::1): tests that
  hard-code `localhost:5432` reach `postgres:5432` (spike 4 rule 3). TCP only; the first file to claim a
  port keeps it;
- a bind inside the workspace → a **subpath of the session's workspace volume** (`volume.subpath`, Docker
  26+; the host daemon cannot see the sandbox's files), read-only kept, a missing folder created first as
  the agent (as compose does on a host). Writable binds stay writable: a service writes into the agent's
  workspace, as it would on the reader's machine (BNG's `./localstack` data, the journey tests'
  `docker/scripts/localstack` init folder, which an empty fresh volume would lose);
- named volumes → `<project>_<key>` with Limn's labels (anonymous ones go with their container);
- every service: Limn's labels, `no-new-privileges`, `mem_limit` = `memswap_limit`, `cpus`, `pids_limit`
  (per service ≤ 2 GB / 2 CPUs / 1,024; a service with no limit gets 768 MB, less when 8 GB ÷ the file's containers is smaller);
  the total ≤ 8 GB across running files. `deploy.resources` is replaced;
- a variable with NO value (`- FOO`, normalised to `FOO: null`) is DROPPED (noted): compose would fill it
  from the environment of the process that runs it, Limn's on the host. A secret/config read from an
  `environment:` variable is refused for the same reason; `oom_score_adj` < 0 and `oom_kill_disable` too;
- NO proxy environment, unless the reader opted that service in (`egress`; spike 4 rule 1: CDP apps read
  `HTTP_PROXY` and ignore `NO_PROXY`);
- project name `limn-<session>-<file>`; the model goes to `docker compose --file -` with an EMPTY project
  directory (`--project-directory`), so no `compose.yaml` or `.env` of Limn's own folder is read.

**Builds** (`limn-svc build`, or a `build:` section before `up`). The context is a folder INSIDE the
workspace, streamed out of the sandbox as a tar **as the agent** (so the image holds the agent's edits;
`.git` left out; ≤ 1 GB) into `docker build -` on the host. ⚠ It runs the CLASSIC builder
(`DOCKER_BUILDKIT=0`) with `--network <session network>`: the only builder whose steps join a
user-defined network, so a step reaches only `limn-proxy` (given as the standard proxy build args, which
Docker never stores in the image) and every request is in the Network panel. BuildKit can take only
`default`, `host` or `none`. Costs: Dockerfile features only BuildKit has (`RUN --mount`, heredocs) fail
with the builder's message, and the classic builder is deprecated upstream. `--force-rm` removes failed
steps' containers; `--memory` caps a step at 4 GB. A service with only an `image:` (BNG's journey tests run
the backend and frontend as images) is swapped for the built one with `limn-svc build <service> <folder>`;
`up` then uses it (`pull_policy: never`). Tags `limn-<session>-svc-<file>-<service>:<n>`, labelled;
`destroy` / `sweep` / `limn sandbox prune` remove them (by image ID, so an untagged older build goes too).
⚠ Two Dockerfile instructions are done by the HOST daemon, on the host's network, never through the proxy:
`ADD <url>` (a download to any host) and `FROM` / `COPY --from=<image>` (a pull). The Dockerfile is
therefore checked AS THE CONTEXT STREAMS (`runtime/dockerfile.ts` `DockerfileTap`: the entry is read out of
the tar, so the text checked is the text the daemon gets; the stream is ended only after the check):
`ADD` from a URL, `git@` or a variable is REFUSED, a pulled image must come from an allowed registry, and a
Dockerfile that is a link, sits under a linked folder, is over 1 MB or is missing is refused. An image
named through a variable (`FROM $BASE`) and a base image's own `ONBUILD` lines are NOT checked (residual).
A Dockerfile that fetches over SSH fails (no SSH out).

**Status** (`SandboxServicesStatus`, packages/shared `sandbox-services.ts`): per file `state` (`stopped ·
starting · running · stopping · failed · refused`), `reasons`, `notes`, `services`, `forwards`,
`builtImages`, sent to `onStatus` on every change for the Services panel (WP7/WP8); `onOutput` carries
every compose/build line. The seed (`buildSeed`, `services`) lists each file's services from
`controller.inventory()` and the `limn-svc` rules.

**Discard.** `services.close()` takes every running file down (`compose down --volumes`), then
`runtime.destroy(session)` removes whatever is left, images included.

**The run log** (`services/run-log.ts`): every `limn-svc run` is executed by the HOST, which records it
(`svc-<n>`, the stack, service and command, the exit code, stdout + stderr as received, the tail ≤ 64 KB,
and whether the reader opened that service to the internet) and prints `limn-svc: run recorded as
svc-<n>` as its last line. ≤ 100 per session; `limn-svc runs` lists them; `session_json.serviceRuns`
keeps them with the output clipped to 16 KB. A plan's `data_run` evidence is checked against this log
only — a query over a `localhost` forward is not recorded and is not evidence.

**microsandbox** (`dind.ts`, ⚠ untested: no machine here runs it). Docker runs INSIDE the VM
(`startDindDaemon`: `dockerd` as the one root step, then `docker info` until it answers) and the agent
runs `docker compose` itself. `prepareDindServices` normalises and polices every picked file (`bindMode:
'bind'`: the files are beside the daemon, so binds stay binds, still only from inside the workspace) and
writes the runnable model to `/limn/services/<file>.compose.json` (a `build:` section stays a build). The
VM is the boundary there; the policy keeps the reader's choice honest. The image needs Docker Engine for
this (WP9).

**Docker-in-Docker on the Docker backend is NOT offered**: it needs `privileged`, which is exactly what
the policy refuses, and a privileged container on Linux is root on the reader's machine.

## microsandbox (`runtime/microsandbox.ts`; plan WP9) — ⚠ UNTESTED

> **Never run on a real microVM.** Written 2026-11-07 against the documented `msb` CLI
> (docs.microsandbox.dev) on an Intel Mac, which cannot run microsandbox. What IS verified here: the
> argv and the output parsers (`msb-spec.test.ts`, with HAND-WRITTEN `msb` output, not recorded), the
> adapter's sequence over a scripted `msb` (`microsandbox.test.ts`), the REAL proxy program running as
> a host process on unix sockets (control requests, a refused CONNECT, a refused foreign credential),
> and the guest relay's piping (with unix sockets standing in for vsock). What is NOT: every `msb`
> call, the JSON shapes, vsock to a host socket, `msb exec --detach`/`-u root`, the private disk's
> ownership, the image load. `microsandbox-real.test.ts` (slow project) is the real check; it skips
> with its reason anywhere `msb doctor` fails, and `.github/workflows/microsandbox.yml` runs it on a
> Linux runner only when `/dev/kvm` exists (and then a skip is a failure, `LIMN_MSB_REQUIRED=1`).

**Choosing it.** `SANDBOX_RUNTIME=auto` (the default) picks microsandbox when `msb` is installed (PATH,
`~/.local/bin`, `~/.microsandbox/bin`; or `MSB_CLI`) AND healthy — the hardware first, with no process
started (an Apple Silicon Mac, Linux with `/dev/kvm`, or Windows), then `msb doctor` — else Docker. The
pick is made by the first detection that finds a backend available, then FIXED for the process.
`SANDBOX_RUNTIME=docker` or `=microsandbox` forces one. (A Settings switch is not built: the choice is
per machine and there is no per-machine setting store yet.)

**The shape**, and why it differs from Docker:

| | Docker | microsandbox |
|---|---|---|
| Boundary | the container (a shared kernel on Linux) | a microVM with its own kernel |
| Network | `--internal` network + the proxy container | `--no-net`: no network at all |
| Way out | `limn-proxy:3128/8081/8082` on the internal network | the SAME names and ports, served by a relay in the guest (`GUEST_RELAY`, python3: Node has no `AF_VSOCK`) that pipes each connection over vsock (`--vsock <host socket>:<port>`) to the host |
| Egress proxy | a container from the sandbox image | the SAME program (`proxy/server.ts`) as a HOST child process, on four unix sockets in a 0700 folder `<data dir>/sbx/<hash>/`; the control socket is never routed into the VM; it exits when Limn's end of its stdin closes |
| Control requests | `docker exec -i` into the proxy | `proxyControl()`: a POST over the control socket (folder 0700 + the control token) |
| Credentials | injected at the proxy | injected at the proxy: the secret lives only in Limn and the host proxy process, never in the VM (host-bound) |
| Workspace | a named volume (`volume-nocopy`), disk cap NOT enforced | `--mount-owned <root>:kind=disk,size=<disk>` — removed with the VM, cap enforced |
| Repositories | the kept repo store, a read-only volume the repository borrows objects from (§ The repo store) | the per-session copy (a tar of a depth-1 `.git` over exec): no named volumes to share |
| Read-only mounts | `type=bind,…,readonly` | `-v <src>:<dst>:ro,noexec` |
| Caps | `--cpus`, `--memory`, `--pids-limit`, no capabilities, no new privileges | `-c` (whole vCPUs, rounded up), `-m`, `--rlimit nproc=` on every agent command |
| Root | never in the sandbox (a CHOWN-only helper container) | one setup `exec -u root`: the `limn-proxy` hosts line and the disk's owner |
| Services | the controller (`services/controller.ts`) | **not available**: `compose`/`buildImage` refuse in one line and the session skips the step. Docker would run inside the VM (`services/dind.ts`, code only), but the image has no Docker Engine |
| Log source | the client IP → container name | always the session's one VM (unix-socket peers carry no address) |
| Leftovers | labels + sweep | labels on the VM (`msb ls --label limn.managed=…`, `msb rm --force`); the host proxies of this process; stale socket folders |

**Why not microsandbox's own allow-list and secrets?** Its `--net-rule` host rules and `--secret`
substitution need TLS interception with msb's CA trusted in the guest, and give Limn no per-request log
to show; `--proxy` sends the destination IP, not the name, so a host-name allow-list cannot work
through it (§ Spike 5). With `--no-net` + vsock, ONE allow-list, ONE log and ONE injector serve both
backends, and the VM has no network to misconfigure.

**The image.** In msb's cache already (the pinned GHCR reference, or `limn-sandbox:local-<recipe>`) →
`msb pull <repository>@<digest>` (used by that immutable reference) → built with the host's Docker and
loaded (`docker save | msb load --tag limn-sandbox:local-<recipe>`). The last needs Docker as well; without
it the step fails in one line.

**Open questions only a real run answers:** whether `--no-net` keeps vsock routes (they are not the
network device, so it should); whether `msb exec --detach` keeps the relay alive and `-u root` works with
our image's `USER agent`; whether a `--mount-owned` disk at a deep path (the mirrored root) mounts and
can be chowned; the JSON of `msb ls` / `msb metrics`; whether `docker save` archives load as-is; first
boot time of the ~1.3 GB image; how `msb doctor` reports a failure.

## Sessions (`apps/backend/src/sandbox/session/`; plan WP7)

The session manager ties the pieces above into the new Implement. A session IS a `story_builds` row
(`session_phase` not null, migration 0176; [DATA-MODEL.md](DATA-MODEL.md) § `story_builds`) and one
`story_build_repos` row per mirrored repository. Routes: [API.md](API.md) § Implement story — workspace
sessions, mounted from `registerAgenticRoutes`.

| File | What it holds |
|---|---|
| `manager.ts` | THE state machine: start, boot, turns, Start build, Stop, Allow, the patch extraction, close (discard, idle, the agent ending, a failed boot), resume, the restart reconcile, the wire (`sessionWire`) and the stream subscription. Every dependency is a seam (`setSessionDepsForTests`). |
| `patches.ts` | The patch out of the sandbox (and back in, for Resume). |
| `state.ts` | `session_json` (`SessionStateJson`), the conversation fold, the ONE wire mapper `toStoryBuildSession`. Pure. |
| `limits.ts` | `LIMN_SANDBOX_MAX_SESSIONS` (2), `LIMN_SANDBOX_IDLE_MINUTES` (15), `LIMN_SANDBOX_TURN_MAX_MINUTES` (120), the patch cap, the turns per message. |
| `janitor.ts` | The periodic sweep, the running count and "Stop all" (§ Every end removes the sandbox). |
| `routes.ts` | The routes; the push and per-repository diff routes (`coding/story-build/routes-build.ts`) are registered from here. |
| `subject.ts` | The SUBJECT contract: the machine serves Implement's story (`storySubject` in `manager.ts`) and AI Fix (`fix.ts`). |
| `fix.ts` | The AI Fix subject and its actions (§ AI Fix sessions). |

**The phases** (shared `SandboxSessionPhase`): `booting → ready ⇄ chatting`, Start build `→ building →
built ⇄ building`, `→ pushed` once every change is pushed (recorded on the next read), and `discarded` /
`failed`. `story_builds.status` is DERIVED from the phase (`sandboxSessionStatus`: booting `assessing`,
ready `plan_ready`, chatting `planning`, building `building`, built and pushed `ready`), so the one open
session per ticket (`story_builds_one_open`), the sprint card's mark and the push code's `status ===
'ready'` check hold with no change. An open row of the removed plan/build flow for the same ticket is
closed when a session starts (`coding/story-build/legacy.ts`).

**The boot**, each step a `SandboxBootStep` on the stream: the start checks the runtime first (`409
NoRuntime` with its one line, no row) and the cheap DB story check (`400 NoStory`); then, in the
background, waiting first for the boot sweep (`bootSweepSettled`: a session booted while it ran would
lose its fresh resources): `runtime` → `image` → `ticket` (read FRESH; Fill gaps adds the latest story
check's verdicts, never starting a check) → `network` (+ the session volume) → `proxy` (`startEgress`; a
host with no usable sign-in fails here, in one line) → `sandbox` → `repos` (the bases are today's rules:
`baseFor` + `unstackablePrs`, pinned by `refs/pierre/story-build/<id>/<repo>`; then
`prepareSessionWorkspace`) → `services` (only the picked files; after the mirror, before the seed, so
`inventory()` reaches the seed — `prepareSessionWorkspace` takes `services` as a function for this) →
`agent` (`startSandboxAgent`; the system prompt is the seed's `systemPrompts[provider]`; `beforeTurn`
is the egress's `refreshCredentials`). Measured live (Intel Mac, Docker Desktop, the image already
local, a two-file repository): ready in 4 s.

**Turns.** Every turn is a reader's click (a message, Start build, Approve, a Reply) — the planning turn
Limn sends at boot answers the reader's Implement click — except plan first's ONE repair turn (§ The plan
and its checks), which asks the budget gate (`review/budget-gate.ts automaticRunAllowed`) first. ONE turn per session at a time (`409 AgentBusy`) and ONE
build-mode turn per machine (`409 BuildBusy`, owner decision 3 of STORY-BUILD); both claims are taken in
the same tick as the click's checks. Spend comes from each `turn_end`: chat turns add to
`plan_cost_usd`, build turns to `build_cost_usd`, tokens and turns to the row; the ledger rows are the
drivers' (`story_plan` / `story_build`).

**Start build** reads the ticket AGAIN (open points change while a ticket is in flight), rewrites
TICKET.md with the same fold (`seed.ts ticketMarkdown`), and, when the criteria list changed, adds ONE
notice to the conversation ("The acceptance criteria changed since the session started: there are now
3.") and tells the agent to read TICKET.md again. Then the driver switches to build mode and one build
turn runs; any later message is also a build turn.

**The patch** (`patches.ts`; plan invariant 1): after EVERY build-mode turn (an interrupted one
included), each repository not yet pushed is read out with one script run as the agent: a throw-away
index (`GIT_INDEX_FILE`) takes `git add -A` over the agent's HEAD, then `git diff --cached --binary
refs/limn/base` — commits and uncommitted edits alike, the repository's `.gitignore` applied, the
agent's own index untouched (measured on real git). The agent's commit messages become the row's
`commit_message`; its last words in the turn the `summary` (the PR body's opening). An empty patch makes
the row `skipped`, one past `STORY_BUILD_PATCH_MAX_BYTES` (4 MB) `failed` with the reason (never cut).
Rows with a patch are `ready`, so the EXISTING `…/repos/:repoId/diff`, Push and Push all work unchanged
(draft by default, stacking, the fork refusal). The push branch is the sandbox branch, `<KEY>` (the ticket key).

**Closing.** Discard (any phase, a running turn included) closes the agent, the services and the proxy,
`runtime.destroy(sessionId)`, and drops the pinned base refs. The same close runs on an IDLE session (no
turn and no reader action for 15 minutes), when the agent process ends on its own, when a boot
fails, when a turn will not stop after its cap, and on "Stop all" (§ Every end removes the sandbox). A session closed that way with a stored patch stays `built` (pushable) and RESUMABLE; without
one it is `failed` and says the work is gone. **Resume** boots it again: the same bases (the rows'
`base_sha`), each stored patch applied and committed in the fresh clone (so the next extraction gives
the same patch plus the new work), the agent started in build mode. The agent's conversation does not
come back (sessions are not persisted, D1); the stored conversation stays on screen. **The restart
reconcile** (`reconcileSessionsOnStartup`, at boot; `legacy.ts` then settles any old-flow row) does the same to every session
that was live: `built` with patches, `failed` without.

**The review loop's hooks** (docs/STORY-BUILD.md § The review loop): `Live.hold` — `holdSession(key,
reason)` / `releaseSession(key)` keep a session from the idle close between turns while the loop reviews
and pushes (the turn cap is unchanged); `startHostBuildTurn(key, text, {loopTurn: true})` starts a
HOST-started build turn (the fix pass) with the same claim as a build continuation, in one tick (`started`
| `not_live` | `busy` | `build_busy`), and resets the subject's continuation count; the subject hook
`afterBuildTurnEnded(l, {outcome, stored, saved})` fires for EVERY build turn that ended with no
continuation, whatever its outcome (the story subject routes a loop turn to `afterLoopFixTurn`, a
completed stored turn to `maybeStartLoop`). `busyReason` refuses a reader's message while a loop step
runs; Discard is refused during a loop push or PR open and otherwise stops the loop first. `sessionWire`
carries `loop`, and the stream adds `{type: 'loop', loop}` at every loop transition.

**The stream**: one `snapshot` (the whole `StoryBuildSession`), then `phase`, `boot`, `agent` (live-only:
partial text and the agent's state), `item` (a stored conversation row; a tool's result re-sends its row
by id), `network` and `services` frames; `done` when the sandbox closes. The conversation is stored
(`session_json`, ≤ 400 items, a tool's output clipped to 600 characters); partial deltas never are.

**Live check, 2026-11-07** (`session.live.test.ts`; Intel Mac, Docker Desktop 29, image
`limn-sandbox:local-ac6352b98ef29f83`, Claude Code on the subscription, Sonnet 5 at low effort): through
the routes on a scratch DB, a two-file git repository as the clone cache — ready in 4 s; one chat turn
named the files; Start build appended a line and committed it; the patch (`+Built by Limn.`,
`README.md`) was in `…/diff` with the agent's commit message; discard left nothing labelled; 21 s and
US$ 0.16 in all; the Network panel showed only `api.anthropic.com:443` (6 requests, through the
injector); the token was in no sandbox file.

**The screen** (plan WP8; [FRONTEND.md](FRONTEND.md) § The build tab): the build tab follows the
stream through the pure fold `apps/frontend/src/lib/sandboxSession.ts`; Settings → Sandbox
(`components/settings/SandboxRuntimeSection.tsx` for the computer, `SandboxSection.tsx` per workspace)
edits the setting above. `GET /api/sandbox/runtime` (`api/routes/sandbox-settings.ts`
`runtimeStatusOf`, cached 10 s) gives both the runtime's one line. The Ticket panel reads
`StoryBuildSession.ticket` (`SessionStateJson.criteria` + `openPoints`, rewritten at Start build), so
it shows what TICKET.md holds, not the tracker's newest text.

## Every end removes the sandbox (`session/manager.ts`, `session/janitor.ts`, `runtime/index.ts`)

A session's sandbox (the container or microVM, its proxy, its services, its network and its volumes) lives
only while the session is OPEN. Every end removes it at once, through ONE call, `closeSession` →
`runtime.destroy(sessionId)`, which lists by `limn.managed` + `limn.session` and removes containers (with
their anonymous volumes, `rm --force --volumes`), then networks, volumes and built service images. A KEPT
session (`built` with a stored patch, or plan first's `plan_ready`) keeps its CHANGES on the row, never a
running sandbox: Resume boots a new one on demand.

| How the session ends | What closes it | Phase afterwards |
|---|---|---|
| Discard | the reader (`discardSession`, `discardFixSession`) | `discarded` |
| Push | an AI Fix push (`closeFixAfterPush`); a story's push does NOT end the session (the reader may keep working), so its idle close does | `pushed` |
| Success of an unattended run | the subject's `afterBuildTurn` → `close` (an auto fix, dependency automation) | `built` (then its own push rules) |
| Stop | a manual session: the turn stops, the session stays; an unattended one closes | `discarded` (cancelled) |
| Nothing happens | the idle close: no turn and no reader action for `LIMN_SANDBOX_IDLE_MINUTES` (ONE constant, `SANDBOX_IDLE_MINUTES_DEFAULT`, 15). The browser closing is this case: nothing in a session depends on a page being open. | kept phase with work, else `failed` |
| A turn runs too long | the turn's watchdog (`LIMN_SANDBOX_TURN_MAX_MINUTES`, 120): the turn is interrupted (its work stored as after any stop); a turn that has not ended 60 s later closes the session | the session stays; or kept / `failed` |
| The agent process ends | `agentEnded` (a build session's work is extracted first) | kept / `failed` |
| The boot fails | `boot`'s catch; a close DURING a boot step re-runs the removal once the step returns (`reapAfterClose`) | kept / `failed` |
| Settings → Sandbox → **Stop all** | `stopAllSessions`: a manual session's running turn is interrupted and its work stored (up to 30 s), then it closes keeping its changes; an UNATTENDED one closes as `discarded` (a person's cancel wins: nothing is pushed) | kept / `failed` / `discarded` |
| Limn stops (SIGTERM, SIGINT, SIGHUP) | `index.ts` → `teardownSandboxesForShutdown` (after the SIGTERM drain), bounded at 10 s, then the 'exit' fallback; no row is written | the restart reconcile settles the rows |
| Limn crashes | the process's `'exit'` handler `destroyLeftSync` force-removes the containers / VMs of every session not yet removed (`destroySync`: `docker rm --force --volumes`, `msb rm --force`, the host proxies killed); the next boot sweep removes the rest. A SIGKILL runs nothing: the boot sweep is the only cure. | the restart reconcile |

**A removal that fails** (a daemon that refused, a timeout) is logged and the session id stays in the
manager's `undestroyed` set. **The periodic sweep** (`janitor.ts`, every `SANDBOX_SWEEP_INTERVAL_MS`, 5
minutes, started after listen when agentic AI is on) removes every resource of THIS data dir whose
session is not live, on every installed backend: the backend in use through the PROCESS's runtime object
(microsandbox's host proxies live there), any other through a fresh one. It runs only while a session has
made resources since the last clean sweep, so a machine that never starts a sandbox never starts a
container CLI for it. ⚠ It trusts the data dir's lock (§ Labels and the sweep): only the backend holding
`server.lock` runs it, and it never touches another install's `limn.managed` value or an unlabelled
resource. ⚠ **THE SWEEP GATE**: a sweep reads the live sessions in the same tick it sets the gate
(`sweepSettled`, which `boot` awaits before it creates anything), so a session registered during a sweep
waits for it and is never swept as "not live".

**microsandbox**: `destroy` removes only its own session's socket folder; the sweep keeps the folder of
every live session id (not only the proxies of the runtime object that runs it).

**Settings → Sandbox** (`SandboxRuntimeSection.tsx`): one line, "2 Limn sandboxes are running.", read from
the runtime (`GET /api/sandbox/running` → `listSandboxes` on every installed backend that answers) when
the section opens and on **Check again**, never polled; **Stop all** (`POST /api/sandbox/stop-all`, after
an inline confirm) closes every session, then sweeps every leftover, and answers the new count.

Tests: `session/cleanup-flow-db.test.ts` (each end above, on the fake runtime; its `resources()` is the
leak detector), `fix-session-flow-db.test.ts` (push, an unattended fix, Stop, Stop all), `runtime/fake.test.ts`
(the gate, the count), `docker.test.ts` / `microsandbox.test.ts` (argv, the socket folders),
`docker-real.test.ts` (the count and the 'exit' fallback on a real daemon; skipped when none answers).

## The plan and its checks (plan first; `session/plan.ts`, `session/plan-block.ts`, `workspace/plan-check.ts`, `coding/story-build/plan-verify.ts`)

Every NEW story session is plan first ([STORY-BUILD.md](STORY-BUILD.md) § Plan first; `session_json.planFirst`,
older rows read as before). The subject adds three phases, `planning` (the opening or repair turn), `revising`
(a reply, message or repair turn on an existing plan) and `plan_ready` (a usable revision waits for the
reader, live or closed), and the machine calls the subject at three new points: `firstTurn` (the opening
turn, the moment the agent is ready), `chatPhase` (what a running chat turn shows) and `afterChatTurn`
(after every chat turn, with the turn's FINAL agent texts, `Live.turnTexts`). `afterChatTurn` may ask for
ONE automatic follow-up turn, which `runTurn` claims in the same tick.

- **Delivery.** Claude's chat mode is `--permission-mode plan` (no write), so the plan is the LAST
  ```` ```limn-plan ```` fenced block of the turn's final text (`plan-block.ts extractPlanBlock`; a block inside
  another fence is text; ≤ `BUILD_PLAN_MAX_BYTES`). The stored conversation item has the block replaced
  by "(The plan went to Limn to check.)" (`stripPlanBlock`), so `session_json` never holds the plan.
  The live partial text hides an open block (shared `hidePartialPlanText`).
- **ONE validator.** `BUILD_PLAN_CHECK_SOURCE` is plain ES2019 text: the checker `~/.limn/plan-check.cjs`
  embeds it (the agent pipes its plan in; it also tries each code quote against `refs/limn/base` and each
  docs quote against the copied sections — advice only) and the host compiles the SAME text. Context:
  `<root>/.limn/plan-context.json` (the refs, the repositories and their paths, the docs folder, the
  `svc-<n>` ids so far; rewritten after every `limn-svc run`). SHAPE problems (a missing criterion, an
  unknown repository, a PR that is not in the stack, a stack in one repository that is not one line,
  `stackReason` missing, > 3 PRs in a repository or > 6 in all, a contention with 0 or > 4 evidence items,
  Fill gaps: a gap marked `met`) make the plan unusable; CONTENT problems drop the item.
- **The host's evidence check** (`plan-verify.ts verifyBuildPlan`; the agent controls the sandbox, so its
  quotes count for nothing): `code` / `data_file` — the blob at the session's pinned base sha in Limn's
  clone cache (`plan-blobs.ts`: hooks and config off, the lazy fetch's token only in a process-scoped
  `insteadOf`, ≤ 2 MB, never binary); the quote, whitespace folded, in the cited lines ± 3, or EXACTLY
  once elsewhere (lines corrected); the page shows the HOST's text (≤ 40 lines / 4 KB). `data_file`'s
  label stays only on a data path. `docs` — `validateDocReferences` against the FULL built library.
  `data_run` — a run in Limn's own log (§ Services → The run log) from a service with no internet route,
  the quote in the recorded output. A point left with no evidence is dropped; `storySays` not in
  TICKET.md is cleared. Only counts and plain reasons are kept (`dropped`).
- **No usable plan** (no block after an opening, reply, or — with no plan yet — message turn; bad JSON;
  shape problems): ONE repair turn per reader action (`planRepairInstruction`, ≤ 20 problems), an
  AUTOMATIC run, so it asks the budget gate first; refused, or a failed repair ⇒ no turn, the stage is
  `failed` with the first problem, and the session waits (`ready`). The session never loops.
- **Approve** (`approveSessionPlan`): the route checks the LATEST revision and every answer, then
  `claimBuildTurn` (the one build slot); inside the turn's instruction ONE transaction records the
  approval and the `story_build_prs` rows and `PLAN.md` is copied in (`planMarkdown`). Start build is
  refused `PlanNotApproved` (`buildRefused`).
- **The build after Approve**: `planBuildInstruction` names each PR's branch (`<KEY>` (the ticket key), `-2`, `-3`, each
  made from the previous one in its repository) and asks for THE BUILD REPORT (`workspace/build-report.ts`,
  the fix-report pattern: ONE validator text, `~/.limn/build-report-check.cjs`, read out after every build
  turn; a self-report, never a gate). Seed rule 3 says to commit each planned PR on the branch PLAN.md
  names. A build turn that hit the turn cap (`max_turns`) with work unfinished gets ≤ 2 automatic
  continuation turns (`SessionSubject.buildFollowUp`, claimed by `runTurn` in the same tick with the build
  slot); each asks the ONE budget gate first (`deps.automaticAllowed`), refused ⇒ no turn, one notice.
- **The stacked extraction** (`session/stack-turn.ts`, `session/stack.ts`, `coding/story-build/stack-verify.ts`):
  after every build turn of an approved plan, per repository with planned PRs, ONE script as the agent
  (`EXTRACT_STACK_SCRIPT <repo> <max> <branch…>`: each planned branch's tip, uncommitted work folded into
  ONE commit through a throw-away index only when the LAST planned branch is checked out — dirty elsewhere
  is reported, never folded — and ONE bundle `refs/limn/stack/<k> ^refs/limn/base`, ≤ 8 MB, base64). On the
  HOST, in Limn's clone cache for THAT repository only, under its lock, hooks and config off (the
  `verifyMergeBundle` discipline): only the expected heads; the bundle header's prerequisites exactly the
  base; fetched with fsck into `refs/pierre/story-build/<id>/stack/<prRowId>`; base → tip 1 → … ancestors in
  turn, no merge commit, ≤ 200 commits, no gitlink, no path in `.git`; each PR's patch, numstat, tree and
  messages computed here. A failure at PR k fails k and every later PR of that repository; a repository
  with changes but no planned PR is left out (`leftOut`, one notice). ⚠ The agent's commit objects never
  reach GitHub: Push makes ONE commit per PR by the reader and checks its tree against the verified one.
- **Resume of an approved plan**: `restoreApprovedStack` puts each stored PR patch back as ONE commit on
  its own branch (`RESTORE_STACK_SCRIPT`), the branches stacked, the last checked out, the agent in build
  mode.
- **Closed in the plan stage**: `keptPhase` is `plan_ready` (the plan is stored work); `bootedPhase` makes a
  resumed plan-stage session `plan_ready` in CHAT mode with PLAN.md "not approved yet" and no turn. The
  restart reconcile does the same.
- **Live check, 2026-11-07** (`plan-session.live.test.ts`; Docker Desktop 29, Claude Code on the
  subscription, Sonnet 5 at low effort; two throw-away repositories, a ticket whose AC2 says the API
  already exports 10000 rows while the code caps it at 500): with no reader message, the opening turn read
  TICKET.md and both repositories and sent one block; Limn verified it as revision 1 in 37 s for
  US$ 0.19 — AC1 planned, AC2 `not_planned`, contention C1 on AC2 with code evidence the host re-read
  (`MAX_EXPORT_ROWS = 500`), one PR in the one repository it changes, nothing dropped. **Spike S1:** in
  `--permission-mode plan` the agent RAN Bash (`find`, `git show refs/limn/base:…`, the heredoc checker),
  every call allowed — so no fallback F1 is needed. That plan had `ticketUpdate: null`; the validator now
  requires a draft whenever there is a point of contention (a missing one gets the repair turn).
- **Codex** is untested here (its usage limit): the block rides its final `agentMessage` the same way, and
  its chat turns can write files (reported, not prevented, as before).

## The review response (`workspace/review-response.ts`)

The review loop's fix pass (docs/STORY-BUILD.md § The review loop). Before each fix turn the host writes
REVIEW.md into the layout root (the items, fenced, with refs `F<n>` / `AC<n>` / `M<n>`), the refs file
`.limn/review-refs.json` and the checker `/home/agent/.limn/review-response-check.cjs`, and removes any
earlier `.limn/review-response.json`. The agent ends the turn by writing that file —
`{items: [{ref, action: 'fixed' | 'answered' | 'pushed_back' | 'not_applicable', reply}]}` — and running
the checker. It follows `fix-report.ts` exactly: ONE validator text, compiled on the host (`new
Function`) and embedded in the checker, so the two never disagree. Rules: each shown ref at most once;
unknown refs are dropped and named; `not_applicable` only on `AC` / `M` refs; a reply is required (≤ 600
characters); the file ≤ 256 KB. A missing or unreadable file makes every shown item `not_reported` (open
again) with one notice; the loop goes on, since the code may still have changed. The agent never pushes
and never opens a PR: the host pushes each fix as a new commit (§ Invariants hold).

## AI Fix sessions (`session/fix.ts`, `workspace/fix-report.ts`)

**Which repositories a session loads, and why not lazily.** Implement loads every workspace repository: it is
offered only on a ticket with NO pull request, so nothing says in advance which repositories the work
touches, and the plan is made by reading the code. Fill gaps does the same (a gap can need a repository the
ticket's PRs never touched). AI Fix narrows (Scope below). Loading a repository LATER, when the agent asks, is
not built: the sandbox has no channel to Limn except the services relay (started only with services), the
request would be untrusted agent text driving host git work mid-turn, and every per-repository row (patch,
Push, Resume) is made after the mirror. The kept repo store makes a repeat load cheap (7 s for 9 repositories,
§ The repo store).

Every AI Fix run — manual, Plan first, the unattended auto fix and dependency automation's fix — is a session
of the SAME machine with a second subject (`subject.ts`): the caps, the ONE build slot, boot, the idle close,
the stream, the restart reconcile and Resume are shared with Implement. The row is the fix's own `ai_fixes`
row (migration 0177: `session_phase`, `sandbox_ref`, `agent_ref`, `runtime`, `session_json`, `last_active_at`,
`unattended`, `workspace_id`); `ai_fixes.status` is DERIVED from the phase by shared `aiFixStatusForPhase`
(booting/building `running`, ready/chatting `planned`, built/pushed `succeeded`, discarded `cancelled` unless
pushed, failed `failed`), so the banner, the Open PRs pill, the auto-fix caps, dependency automation's poll and
`pushFix` read it unchanged. A NULL phase is a row of the removed shell-less fixer (history).

| | |
|---|---|
| **Start** (`coding/ai-fix/manager.ts` `startRun`) | provider pre-flight → instruction → ONE FIX PER PR (`claimFixPr`, same tick) → the seed (review / CI-only / plain; `NothingToFix` boots nothing) → runtime (`409 NoRuntime`, no row) → the slot: a session and, for a fix that builds at once, THE build slot (`reserveSessionSlot`, same tick; `409 TooManySessions` / `BuildBusy`) → the live head (`base_sha`) → the row → `startFixSession`. Never queued. |
| **Scope** | ONLY what the job needs (2026-11-10): the PR's repository plus the workspace repositories of the OTHER pull requests of its ticket(s) (`FixSessionDeps.relatedRepoIds`: `ticketsForPr` → `ticketPrIds` → `ticketPrs`, ≤ 3 tickets, open or merged; a failed read ⇒ the PR's alone), at the reader's layout, memories as in Implement. Not every workspace repository: each costs load time. The agent cannot ask for another one mid-session (below). The PR repository at the PR's HEAD SHA, fetched through the base repository's `refs/pull/<n>/head` (`RepoBaseRequest.remoteRef`; a fork's head too); every other repository on its default branch, "read only". Branch `limn/fix-pr-<n>`; pins `refs/pierre/ai-fix/<fixId>/<repoId>` (dropped on push, discard and a failed close). |
| **Seed** | `FIX.md` (the PR, its fenced description, the task — review-seed.ts's fenced items or the fenced plain instruction — and the report contract), `PR.diff` (GitHub's diff, noise files out, capped at 1 MB, cuts named), `TICKET.md` for a MANUAL fix of a PR with a ticket ("For context only"), `.limn/fix-refs.json` and the checker `~/.limn/fix-report-check.cjs`. Goldens `__fixtures__/seed-fix*.md`. |
| **Turns** | Manual: the first turn is the build turn, started the moment the agent is ready ("Start fix"). Plan first: one chat turn ("make a plan"), then the session waits; Start fix (`…/plan/approve`) switches to build. Every later message is one more turn in the SAME session; in build mode the agent rewrites the report for the whole change. Unattended: ONE build turn, then the session closes (`built`, resumable). |
| **The report** | A JSON FILE, not a tool: the drivers run no MCP server and nothing on the host listens for the sandbox, and a file is the same for both providers. The agent writes `<root>/.limn/fix-report.json` (the `submit_fix` shape) and runs the checker until it prints OK. After every build turn the host reads it out (as the agent), checks it with the SAME validator text (`FIX_REPORT_VALIDATOR_SOURCE`), and normalises it against the extracted diff (`normalizeChangeReport`). A wrong shape ⇒ no report (every shown ref "not reported") and one notice; content problems ⇒ named, and the normaliser drops them. The old report is removed before each build turn. |
| **The patch** | The PR repository's only, capped at `AI_FIX_PATCH_MAX_BYTES` (1 MB). Every other repository's changed files are listed in `session_json.leftOut` and one notice each ("… are left out"), never stored. |
| **Stop / Discard / Push / Resume** | Stop on a manual session stops the turn (the session stays); on an unattended one it closes it `discarded` ⇒ `cancelled` (a person's cancel wins). Discard closes any phase except while a push runs. Push is the unchanged `pushFix` (compare-and-set on the head, never forced): refused while a turn runs, the session refuses messages while it pushes (`push-guard.ts`), and a push that lands ends the session `pushed` (no follow-up after a push). Resume boots a closed, unpushed `built` row again with its patch put back; it is a manual session from then on. |
| **Unattended runs** (auto fix, dependency automation) | Asked FIRST, never reserving: `fixSandboxReadiness()` (a runtime — its answer reused 30 s per runtime object — a free session and the free build slot). No runtime ⇒ the auto fix records `no_sandbox`; dependency automation writes ONE `skipped` row ("No container runtime on this computer.", before any claim, never counted). Busy ⇒ `sandbox_busy` / nothing written. `startRun` asks the ONE budget gate again for every unattended start. The session: boot → ONE build turn → report + patch stored → closed `built`; then (`onClosed`, the session already gone) "Push automatically" for an own-PR auto fix, or dependency automation's own push. Never queued, never retried in a loop: the next auto review / deps tick decides. |
| **Spend** | Chat turns bill `ai_fix_plan`, build turns `ai_fix`, with the PR repository and `prId` on the ledger row (the Reports' "fix" bucket). Claude: `--max-turns` `AI_FIX_MAX_TURNS` (40); an UNATTENDED session also gets `--max-budget-usd` `AI_FIX_BUDGET_USD` (5; the pinned Claude Code 2.1.295 accepts it in print mode; the cap is the PROCESS's, which runs that one turn, and its `error_max_budget_usd` result ends the turn with the work so far extracted). A manual session has no US$ cap (the reader stops it). Codex has no such flag: the budget gate and the caps bound it. |


### The merge (`session/fix-merge.ts`, `coding/ai-fix/merge-host.ts`, `coding/ai-fix/merge-verify.ts`)

The fix picker's **"Resolve merge conflicts with `<base>`"** item (ref `MERGE`; docs/CLAUDE-REVIEW.md § AI
Fix, "Merge conflicts"), and dependency automation's conflict run (`resolveConflicts: true`; on a PR that is
red too, with "Fix them with AI" on, the CI-only seed with the merge REQUIRED — the CI review's fixable items
ride in the same session), add a MERGE to the session. The agent merges and resolves FIRST, then fixes the other items on top. Owner decision
2026-11-07: the host-side "Resolve with Claude" is removed; conflicts are resolved by hand in the resolver or
here. ⚠ **AN AUTO FIX** (the unattended own-PR run after an auto review) carries the item ONLY with the
workspace's "Merge conflicts with the base branch" under Always include (`AutoFixInclude.conflicts`, OFF by
default; 2026-11-10 — before, never). Nothing else changes for it: the host checks below gate every push (an
invalid merge pushes nothing, not even the fixes on top), and "Push automatically" decides whether a valid
one is pushed after the session closes or waits for the reader's Push.

| Step | Where | What |
|---|---|---|
| **The commits** | host, `bases` (before the mirror) | `resolveMergePlan`: the base branch's tip NOW (Resume reuses the one picked at the start) and the merge base of it and the PR head, from Limn's clone cache; pinned as `refs/pierre/ai-fix/<fixId>/merge/{head,base,merge-base}` (dropped with the fix's other refs). No common commit ⇒ the boot fails in one line. Written to `ai_fixes.merge_json` (migration 0178). |
| **Into the sandbox** | `afterMirror` | Both commits through the MIRROR SEAMS (`prepare` = the clone cache's depth-1 copy, the same tar stream), fetched into the PR repository as `refs/limn/merge-target` and `refs/limn/merge-base`, with `core.alternateRefsCommand=true` (⚠ § The repo store: without it a store with two keep refs fails every such fetch). A failure fails the session in one line, "Limn could not bring `<base>` into the sandbox: `<git's line>`"; it is never retried. The repository stays SHALLOW: the PR head, the base tip and the merge base, each with its whole tree, no history between (FIX.md says `git log` is cut). |
| **Limn starts the merge** | sandbox, before the agent | `~/.limn/start-merge.sh` (`START_MERGE_SCRIPT`, also the agent's "start again"): `git merge-recursive <merge base> -- HEAD <base tip>` — git's own three-way merge with the EXPLICIT merge base (a shallow repository cannot find it, and the image's git 2.39 has no `merge-tree --merge-base`); the conflicts stay in the index and the files, `MERGE_HEAD` is the base tip, so the agent's `git commit` makes a MERGE COMMIT with parents (PR head, base tip). A snapshot of the automatic merge WITH the markers is kept (`refs/limn/auto-merge`). The conflicted files are one notice and `merge_json.conflictedFiles`. |
| **FIX.md** | seed | "First: the merge conflicts (MERGE)": the two refs and their shas, judgement over taking a side, read the lines around each hunk (nothing twice, nothing lost, no marker), `git add` + `git commit --no-edit`, never `--abort` / `--squash` / rebase / amend, how to start again, build and test, then the other fixes on top, cite MERGE. The system prompt adds one sentence. Golden: `__fixtures__/seed-fix-merge.md`. |
| **Out of the sandbox** | after every build turn | `EXTRACT_MERGE_SCRIPT` (as the agent): `refs/limn/out` = HEAD plus ONE commit over any uncommitted change (a throw-away index); the merge commit = the oldest merge on the first-parent line since the PR head; the fix = merge..out (the row's `patch`, shown as the fix); the resolution = the merge commit against the automatic merge (`AiFix.merge.resolutionDiff`, ≤ 1 MB); a BUNDLE `refs/limn/out ^<PR head> ^<base tip>` (≤ 4 MB, else invalid, never cut) — REAL COMMITS, never a flattened patch, because GitHub sees conflicts resolved only through a merge commit. `MERGE_HEAD` still there ⇒ "not finished". |
| **The host's check** | `verifyMergeBundle`, in the clone cache, no lazy fetch (except the review diffs below), no hooks, no config | the bundle names ONE ref, its prerequisites are the PR head and the base tip, every object fsck'd into `refs/pierre/ai-fix/<fixId>/merge/result`; ONE first-parent line whose oldest commit is a merge with parents EXACTLY (PR head, base tip) and every later one has one parent; nothing else; no conflict marker in any file that was in conflict, in the merge commit and in the last commit (a blob that is one side's own version passes; a new blob is read; one Limn cannot read fails). The sandbox's merge and result must be the checked ones. |
| **What the reader reviews** | `verifyMergeBundle` → `HostMergeView` (merge-verify.ts) | ⚠ computed ON THE HOST from the verified commits, never the sandbox's own diffs (the agent controls the sandbox's refs, config and even its `git`; a forged `refs/limn/auto-merge` could hide a change in the merge commit): the fix = `git diff merge result`, the resolution = the merge commit against the HOST's `git merge-tree --write-tree` of (PR head, base tip), whose conflicted files also join the marker check (git < 2.38: against the PR head, a superset). Lazy blob fetch is on for these diffs only (token in a process-scoped `insteadOf`). Push pins the exact `mergeSha`/`resultSha` checked after the turn (`expectedMergeSha`/`expectedResultSha`). |
| **The verdict** | `merge_json.status` | `valid` (the bundle is kept, base64, `merge_bundle`), `invalid` (the reason; nothing kept), `missing` (no merge commit). ⚠ Only `valid` is pushable — not even the other fixes push without it (they may depend on it). Limn's verdict wins over the report: not valid ⇒ MERGE is "not addressed" with "Limn: <reason>". A follow-up message re-extracts and re-checks. |
| **Push** | `push.ts` → `ctx.coding.pushMerge` (`git-ops.ts` `pushMergeResult`) | only `target: 'existing'`, never a fork's branch; the live head must still be the fix's start (HEAD_MOVED); the check again in the clone cache (fetched again if evicted); the merge commit (the merge's tree, parents PR head + base tip) and ONE fix commit (the last tree) rebuilt under the reader's name — nothing about the agent's commit objects reaches GitHub; pushed as a fast-forward, never forced; then the settle. The bundle is cleared on push, discard and a failed close. |
| **Resume** | `restore` | the two commits come in again; the merge is NOT started again; the stored bundle is fetched back and the branch reset to it. Only a `valid` merge is resumable. |

Measured live, 2026-11-07 (`session/fix-merge-session.live.test.ts`): see § Testing.

## Testing

- **The fake runtime** (`fake.ts`): records every call (`fake.calls`) and replays `exec` answers
  (`fake.onExec(match, handler)`): a fixed result, or an interactive handler that reads the caller's
  stdin lines and emits output lines (a recorded stream-json fixture, turn by turn). `copyIn` files
  are readable with `readFile`; `destroy`/`sweep` remove resources, so a leak shows in `fake.resources()`.
- **The Docker adapter** is tested over a SCRIPTED CLI (`docker.test.ts`): detection per product, the
  image decision, the sweep, argv shapes.
- **The proxy** is tested in process with real sockets (`server.test.ts`): matcher, address rule,
  CONNECT, HTTP, injectors, control, log shape.
- **The drivers** are tested over the fake runtime: Claude REPLAYS the recorded spike-1 stream turn by
  turn (`claude.test.ts`); Codex runs against a scripted app-server, with a successful turn built from
  the 0.164 protocol schema (`codex.test-support.ts`) beside the recorded usage-limit session. The live
  run (`drivers.live.test.ts`, the `live` project) needs `LIMN_SANDBOX_LIVE=claude|codex`.
- **The workspace mirror**: the walk, the match and the layout on a scratch folder shaped like the BNG
  one (`layout.test.ts`), the reader's files and the check (`memories.test.ts`), finding the clones with no
  setting and each repository's memories under its own key (`discover.test.ts`), the progress line
  (`store.test.ts`), the compose-file list (`api/routes/sandbox-settings.test.ts`), the ticket over seams
  (`ticket.test.ts`), the seed goldens (`seed.test.ts`; `SANDBOX_SEED_GOLDEN_WRITE=1` rewrites them), the
  settings routes on a scratch DB (`api/routes/sandbox-settings.test.ts`), the tracker re-read
  (`tracker/open-points-ticket.test.ts`). `mirror-real.test.ts` (the `slow` project) runs real git — a
  blobless cache refuses a shallow fetch until the base is checked out — and, with a daemon,
  `prepareSessionWorkspace` end to end: mirrored paths, the branch at the real base, no remote, clean
  status, memories under the same key, the seed at the root, agent-owned files, a commit out as a patch.
- **The repo store**: the decisions over the fake runtime and fake host steps (`store.test.ts`): a warm
  store copies nothing, the local clone first, the cache when it lacks the commit (one note), the next
  clone and the cache when a copy fails, the per-session copy when a store step fails, no fallback when
  the base cannot be resolved, at most 3 at once in the layout's order; the argv and labels
  (`spec.test.ts`, `docker.test.ts`). `store-real.test.ts` (`slow`): which local clones qualify (complete
  yes; shallow, partial, missing commit, not a repository no), then with a daemon a test-named store
  filled from a DIRTY clone, a sandbox repository at exactly the commit with a patch out, the sandbox
  unable to write the store, a second base copying 4–5 objects and the same base none, the reader's clone
  untouched; the store volume is removed after. `session/fix-merge-store-real.test.ts` (`slow`, real git,
  no daemon): the MERGE item's fetches into a repository built by `IN_SANDBOX_FROM_STORE` from a store
  holding an older keep ref whose parent it lacks — without `core.alternateRefsCommand=true` the fetch
  fails as it did on #610, with it both commits arrive and the merge starts; a stored bundle comes back.
- **Services**: the policy over normalised models shaped like the BNG backend file, every refusal and
  rewrite (`policy.test.ts`); the controller over the fake runtime — the verbs, a refused file never
  reaching compose, clashes, builds, `run` (`controller.test.ts`); the relay as REAL Node processes —
  the shipped `limn-svcd.cjs` and `limn-svc`, a unix socket, a TCP forward, a restart (`relay.test.ts`,
  `slow`); and `services-real.test.ts` (`slow`, a daemon): a refused file with its reasons, a build from
  the sandbox on the session network with no direct route out, an edit carried into a rebuilt image,
  `up`/`ps`/`logs`/`down` and the localhost forwards from inside, and the REAL BNG backend file (copied
  from the local clone with `git show`, never edited) allowed, up, postgres answering on
  `localhost:5432`, localstack on `:4566`. The BNG case skips without the clone
  (`LIMN_SANDBOX_BNG_BACKEND`).
- **Sessions**: the patch parser and its script's argv over the fake runtime (`patches.test.ts`), the
  conversation fold and the wire mapper (`state.test.ts`), and THE FLOW (`session-flow-db.test.ts`, the
  successor of the old `e2e-flow-db.test.ts`): the real routes, manager, egress, mirror, seed, Claude
  driver (the recorded spike-1 stream) and push code over the fake runtime and a scratch DB — boot,
  a chat turn and a refused second message, Start build with a changed ticket, the patches, both diff
  routes, Push, discard, then no runtime, the open-session cap, the idle teardown, the restart reconcile
  and Resume. `session.live.test.ts` (`live`) is the same flow for real.
- **AI Fix sessions**: the report validator, the checker script run with `node` on a real git
  repository, and the host's read (`workspace/fix-report.test.ts`); the fix goldens (`seed.test.ts`);
  THE FLOW (`session/fix-session-flow-db.test.ts`, the successor of the shell-less fixer's manager tests):
  the real ai-fix routes and manager over the fake runtime and the recorded stream — a CI-only seed fixed
  at once on the PR head, the report normalised, an edit elsewhere left out, a follow-up turn, Push ending
  the session, Plan first → Start fix with no report → Discard, then no runtime, the build slot, the cap,
  a push while a turn runs, the idle close, Resume, an unattended fix closing itself and Stop cancelling
  one, an own-PR auto fix carrying `--max-budget-usd`, closing and THEN being pushed by "Push
  automatically", the unattended pre-check, the restart reconcile and another account's ids. The
  unattended callers: `coding/ai-fix/auto-fix.test.ts` (`no_sandbox`, `sandbox_busy`, the start's own
  answers) and `merge/dependency-automation-teams.test.ts` (one skip row, no claim, later ticks read
  nothing, not counted, taken over; busy writes nothing; a lost race gives the claim back; cancel wins). `session/fix-session.live.test.ts` (`live`,
  `LIMN_SANDBOX_LIVE=claude`) runs one tiny real fix.
- **AI Fix's merge** (`slow`, real git): `coding/ai-fix/merge-verify.test.ts` runs Limn's sandbox scripts with
  `sh` on a repository shaped as the sandbox makes it (shallow, three commits) — the conflict found with the
  explicit merge base, a valid merge with a fix on top and an uncommitted edit passing, its rebuilt commits'
  parents / trees / author, a push from a blobless clone being a fast-forward; refused: a marker left (also
  when only a later commit cleans it), the parents reversed, a fix before the merge, a second merge, another
  base, a bundle naming another ref; an unfinished merge read as such. `session/fix-merge-session-flow-db.test.ts`
  is THE FLOW over the fake runtime whose sandbox steps run those scripts on real git: the picker's MERGE row
  first and ticked (and gone with no conflict), a merge + CI item session (the commits in through the mirror
  seams, pinned; FIX.md; the check; the fix on top; the resolution on the wire; Push through `pushMerge`, a
  new-branch push refused), a marker left and a merge never committed both refusing Push. The unattended
  caller: `merge/dependency-automation-ai.test.ts` (seams) and `session/fix-deps-session-flow-db.test.ts`
  (`slow`, the same real-git fake runtime, NO click: conflict only, CI only, conflicting AND red in ONE
  session counted once, a refused merge pushing nothing and logged, a person's Stop winning). The auto fix's switch (OFF by default, on only by `include.conflicts`): `review-seed.test.ts`.
  `session/fix-merge-session.live.test.ts` (`live`, `LIMN_SANDBOX_LIVE=claude`) runs one real merge.
- **The real-daemon test** (`docker-real.test.ts`, the `slow` project): a sandbox on an internal network
  reaches `registry.npmjs.org` through the proxy, is refused `example.com` (logged against the sandbox
  container), has no direct route out, gets `example.com` after "Allow for this session", the injector
  refuses a foreign credential, the sandbox is non-root with no capabilities and `NoNewPrivs`, and
  nothing is left after. Skipped with its reason when no daemon answers; needs the internet; the first
  run builds the image unless `LIMN_SANDBOX_TEST_IMAGE` names one.
- **microsandbox** (⚠ untested on a real VM, § microsandbox): the argv and the tolerant parsers over
  hand-written `msb` output (`msb-spec.test.ts`), the adapter over a scripted `msb` and the real proxy
  program on unix sockets (`microsandbox.test.ts`), and `microsandbox-real.test.ts` (`slow`), the
  docker-real checks on a real microVM — skipped with its reason wherever `msb doctor` fails, run by
  `.github/workflows/microsandbox.yml` only on a Linux runner with `/dev/kvm`.

**Live checks, 2026-11-07** (Intel Mac, Docker Desktop 29.6, image `limn-sandbox:local-bf378801d29690a7`,
through `startEgress` and the Docker adapter, not the spike scripts): one Claude Code turn on the
subscription answered `injected.` (US$ 0.0003 list price); the sandbox env held only the placeholder;
no sandbox file and no proxy env var contained the token; the Network log showed one `anthropic` row,
status 200. One Codex turn: every ChatGPT request was swapped and authenticated (the model call
answered 429 "usage limit", as in spike 2); no sandbox file held the real token; the host's refresh
token and `last_refresh` were unchanged.

## Spike results

Measured 2026-11-07 on macOS Intel x86_64, Docker Desktop 29.6 (engine 29.6.2, amd64), image
`limn-sandbox:dev` built from `apps/backend/sandbox-image/Dockerfile` (Claude Code **2.1.295** = the
Agent SDK 0.3.295's bundled CLI, Codex **0.164.0** = `limnAiRuntime`). Scripts:
`apps/backend/scripts/sandbox-spikes/` (not shipped). Recorded, scrubbed streams:
`apps/backend/src/sandbox/drivers/__fixtures__/`.

Every spike ran the same network shape: the sandbox on a `docker network create --internal` network,
non-root `agent`, `--cap-drop ALL`, `no-new-privileges`; a proxy container (`proxy.mjs`) on that
network and the default bridge is the only way out.

### Verdicts

| Spike | Verdict |
|---|---|
| 1. Claude interactive driver | **Works.** One long-lived process, turns over stdin, live switch to `bypassPermissions`, interrupt. No `--resume` fallback needed. |
| 2. Codex driver | **Choose `codex app-server`.** Protocol proven up to the model call; no Codex turn completed (the ChatGPT account was over its usage limit). Re-run before WP5 ships. |
| 3. Credentials, Claude | **injected** (subscription OAuth: proven end to end). API key: the swap path is proven, a real key is not (none was available). |
| 3. Credentials, Codex | **injected** (provisional): every authenticated ChatGPT request succeeded with the bearer swapped at the proxy; the model call answered 429 "usage limit", which only an authenticated request gets. A full turn is not yet proven. |
| 4. Services | **Works, green.** BNG backend stack on the internal network; `npm run test:integration` passed from the sandbox, both halves (282 + 295 tests). No secrets needed. Four rules for WP6 below. |
| 5. microsandbox | **Untested.** This machine is an Intel Mac. Desk check below; the adapter (§ microsandbox) is built and says "untested" until it runs on Apple Silicon or a Linux KVM host. It uses `--no-net` + vsock to a host proxy instead of the `host.microsandbox.internal` route the desk check sketched (no host TCP ports, no port clashes between sessions). |

### Spike 1 — Claude Code interactive driver (`spike1-claude.mjs`)

One process, credential injected (spike 3), 5 user turns, 1 run:

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
  --permission-mode plan --allow-dangerously-skip-permissions \
  --effort low --model sonnet --max-turns 6 --strict-mcp-config
```

All 12 checks passed:

- **Handshake.** Send `{"type":"control_request","request_id":"…","request":{"subtype":"initialize","hooks":null}}`
  first; the `control_response` carries `commands, agents, models, account, current_permission_mode, …`.
- **User turn** = one stdin line `{"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":"…"}}`.
- **Turn boundary** = one `{"type":"result"}` per turn. Each turn starts with a fresh
  `{"type":"system","subtype":"init"}` that states the CURRENT `permissionMode` (plan → bypassPermissions
  after the switch). One `session_id` for the whole process.
- **Partial streaming**: `{"type":"stream_event","event":{…}}` wraps the Messages API stream
  (`message_start`, `content_block_delta` with `text_delta` / `thinking_delta` / `input_json_delta`, …).
- **Plan mode held**: asked to `touch` a file, the agent refused and no file appeared (it refused
  itself: `permission_denials` was empty, so the CLI's own denial was not exercised).
- **Switch to build**: `{"subtype":"set_permission_mode","mode":"bypassPermissions"}` →
  `{"subtype":"success","response":{"mode":"bypassPermissions"}}`; the next turn wrote the file.
  ⚠ Start the process with `--allow-dangerously-skip-permissions`, or the switch to bypass is not offered.
- **Interrupt**: `{"subtype":"interrupt"}` sent at the first text delta → ack `success`, then a
  `result` with `subtype:"error_during_execution"`, `is_error:true`, `terminal_reason:"aborted_streaming"`.
  The process stays alive: the next turn answered normally.
- **Usage**: every `result` has `usage`, `modelUsage{<model>:{costUSD,…}}` and `total_cost_usd`.
  ⚠ `total_cost_usd` is the PROCESS's running total, not the turn's (0.1018 → 0.1269 → 0.1397 → 0.1397
  → 0.1451): WP5 records the difference. The interrupted turn added nothing (its partial tokens are
  not reported).
- **Budget signal**: a `{"type":"rate_limit_event","rate_limit_info":{…,"unifiedWindows":{"seven_day":{"utilization":…}}}}`
  arrives on the subscription — usable for the budget reading.
- **Effort**: the CLI flag `--effort low|medium|high|xhigh|max` (accepted; this run used `low`).
  `agenticRunEffort` maps straight onto it.
- **Tools offered**: the init lists `Task, Bash, CronCreate, CronDelete, CronList, Edit, EnterWorktree,
  ExitWorktree, ListAgents, NotebookEdit, Read, RemoteTrigger, ReportFindings, ScheduleWakeup,
  SendMessage, Skill, TaskStop, WebFetch, WebSearch, Workflow, Write`. WP5 should pass
  `--disallowedTools` for the ones that make no sense in a sandbox (Cron*, RemoteTrigger,
  ScheduleWakeup, SendMessage, Workflow; WebFetch/WebSearch are blocked by the proxy anyway).
- **Network**: with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (set in the image) the CLI made ONLY
  `POST /v1/messages` calls (5) and tried no other host.

Fixtures: `claude-interactive.in.jsonl` (what was sent), `claude-interactive.out.jsonl` (102 lines).

### Spike 2 — Codex driver (`spike2-codex.mjs`)

Two runs, both stopped by the account's usage limit ("try again at Nov 9th, 2026 9:28 AM") before
the model answered. What was proven, and what was read from the 0.164 protocol schema
(`codex app-server generate-json-schema`):

- **`exec` + `exec resume`** (`--mode exec`, token in the sandbox): `codex exec --json --sandbox read-only`
  then `codex exec resume <thread> --json --dangerously-bypass-approvals-and-sandbox` — the resume kept
  the same `thread_id`. Each turn is a new process; there is no partial-text stream and no interrupt
  other than killing the process.
- **`app-server`** (`--mode app-server`, injected): `initialize` → `initialized` → `thread/start
  {cwd, model, approvalPolicy:"never", sandbox:"read-only"}` → `turn/start {threadId, input:[{type:"text",text}],
  sandboxPolicy, effort}` → `turn/started` … `turn/completed {turn.status}`. Proven live up to the turn
  (the turn ended `failed` on the usage limit; the error arrives as an `error` notification and
  `thread/status/changed {type:"systemError"}`).
- **Why app-server**: one long-lived process per session like Claude's driver; **`sandboxPolicy` is per
  TURN** (`readOnly` for chat, `dangerFullAccess` for the build — no restart); `turn/interrupt
  {threadId, turnId}` and `turn/steer` exist; partial text arrives as `item/agentMessage/delta`;
  usage as `thread/tokenUsage/updated`; rate limits as `account/rateLimits/updated`. Limn already has a
  JSON-RPC client for it (`ai/codex/app-server.ts`). The cost: it is marked experimental — pin the
  CLI and keep `exec`/`exec resume` as the documented fallback. NOT YET PROVEN LIVE: deltas, usage
  notifications, interrupt, a write in a `dangerFullAccess` turn. Re-run `spike2-codex.mjs --mode
  app-server --record` once the limit resets.
- ⚠ **Codex's own sandbox does not work inside our container.** `read-only` and `workspace-write` use
  bubblewrap, which needs user namespaces; Docker's default seccomp profile refuses them ("bwrap: No
  permissions to create a new namespace"). It works only with `--security-opt seccomp=unconfined`,
  which weakens the outer boundary — do not do that. Consequence: a Codex CHAT turn cannot be made
  read-only by Codex here (every shell command, including reads, would fail under `readOnly`).
  Recommendation: run Codex chat turns with `sandboxPolicy {type:"externalSandbox"}` (or
  `dangerFullAccess`), tell it in the seed not to change files until Start build, and have Limn run
  `git status --porcelain` in each repository after every chat turn and show any change. Claude's
  plan mode is enforced by the CLI and needs none of this.
- ⚠ **Lock Codex's extras down inside the sandbox too.** Without the lockdown it fetched the plugin
  catalog (`/backend-api/ps/plugins/*`, `/plugins/featured`), tried the `codex_apps` MCP server
  (`POST /backend-api/ps/mcp` → 451) and tried three `sdmntpr*.oaiusercontent.com` CDN hosts (denied).
  The sandbox's `config.toml` should carry the non-shell part of `LOCKED_SETTINGS`
  (`features.apps/plugins/remote_plugin/tool_suggest/memories=false`, `analytics.enabled=false`, …) —
  but NOT `features.shell_tool=false`: the shell is the point here.
- **Hosts Codex needs**: `chatgpt.com` only (model list, responses, account checks). `auth.openai.com`
  is needed only for a token refresh (see spike 3).
- ⚠ **Never refresh inside the sandbox.** OpenAI refresh tokens are single-use: a refresh with a COPY
  of the reader's `auth.json` would rotate it and sign the HOST out of Limn's Codex. Codex refreshes
  on age; the spike refuses to run when `last_refresh` is over 5 days old. Injection (spike 3) removes
  the problem.

Fixtures: `codex-exec-usage-limit.jsonl`, `codex-exec-resume-usage-limit.jsonl`,
`codex-app-server-usage-limit.jsonl` (both directions, `{"dir":"in"|"out","msg":…}`). They record the
usage-limit error path; a successful-turn fixture is still to be recorded.

### Spike 3 — credential injection (`spike3-credentials.mjs`, `proxy.mjs`)

The proxy listens on three ports: `:3128` forward proxy (CONNECT + HTTP, allow-list by host[:port],
`*.suffix`), `:8081` → `https://api.anthropic.com`, `:8082` → `https://chatgpt.com`. The injectors
take plain HTTP on the internal network and forward over TLS. A request carrying the PLACEHOLDER gets
the real credential; a request carrying ANY other credential is refused (403) and never forwarded.
The real secrets live only in the proxy container (env vars passed by name; Codex's `auth.json` as a
read-only mount, read per request so the host's own refresh is picked up).

**Claude — injected.** Sandbox env: `ANTHROPIC_BASE_URL=http://limn-proxy:8081`,
`CLAUDE_CODE_OAUTH_TOKEN=limn-placeholder`, `HTTPS_PROXY/HTTP_PROXY=http://limn-proxy:3128`,
`NO_PROXY=limn-proxy`. Evidence (all PASS): a `claude -p` turn on the subscription answered
`"injected"` (US$ 0.005 list price); the sandbox env held only `limn-placeholder`; no sandbox file
contained the token; the proxy log shows `POST /v1/messages 200 swapped:"bearer"`. Spike 1's 5 turns
ran the same way. The CLI accepted a custom base URL with an OAuth token with no complaint
(`account.tokenSource: "CLAUDE_CODE_OAUTH_TOKEN"`).
API key: the placeholder in `x-api-key` was swapped (`swapped:"x-api-key"`) and reached
api.anthropic.com, which answered 401 for the DUMMY host key used. A run with a real key is still
to do; the code path is the same header swap.

**Codex — injected (provisional).** The sandbox's `auth.json` keeps the real file's shape but every
secret is fake: unsigned JWTs carrying only `exp`, `iat` and the `https://api.openai.com/auth` claim
(plan, account id), and `refresh_token: "limn-placeholder"`. `config.toml`:

```toml
model_provider = "limn"
chatgpt_base_url = "http://limn-proxy:8082/backend-api/"
[model_providers.limn]
name = "OpenAI via Limn"
base_url = "http://limn-proxy:8082/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
```

Evidence: 19 requests, every one swapped or credential-free, none refused —
`GET /backend-api/wham/accounts/check 200`, `GET /backend-api/codex/models 200`,
`GET /backend-api/wham/settings/user 200`, plugin endpoints 200, and the model call
`POST /backend-api/codex/responses 429` (usage limit: an authenticated answer). No sandbox file
contained the real access token. Not yet proven: a completed turn. Token refresh stays on the HOST
(Limn's app-server probe, `account/read {refreshToken:true}`, already refreshes `~/.limn/codex`); the
fake access token's `exp` is copied from the real one, so Codex inside never tries to refresh while
the host keeps the real one fresh. If the host token lapses, Codex's refresh attempt fails at the
proxy (auth.openai.com not allowed, placeholder refresh token) and the session shows a sign-in error.
`codex app-server`'s `chatgptAuthTokens` login (client-supplied tokens + an
`account/chatgptAuthTokens/refresh` server request) would also fit, but its schema says "FOR OPENAI
INTERNAL USE ONLY"; do not build on it.

**Proxy lessons for WP3**: (1) the first version CRASHED when a client reset its socket after a 403
on CONNECT — the container stopped and its DNS name vanished, so later requests failed with "Could not
resolve host". Every socket needs an `error` handler, and the proxy must never exit on a stray socket
error. (2) curl ignores upper-case `HTTP_PROXY` for `http://` URLs; set both cases. (3) The log line
carries host, port, method, path (injector only), status, bytes, allowed/denied, swapped — never a
header value.

### Spike 4 — services on the internal network (`spike4-services.mjs`, `egress-proxy.mjs`)

`DEFRA/bng-metric-backend` at committed HEAD `90dcdb9`, `compose.yml` (localstack, redis, postgis,
cdp-defra-id-stub, caddy, cdp-uploader). The sandbox was the prototype image (`limn-sandbox:proto`,
Node 22) with `--memory 4g --cpus 4 --pids-limit 2048`; the repository was mounted read-only and
cloned inside. Every resource was labelled `limn.test=1` + `limn.spike=spike4` and removed after.
The run went beside the owner's own BNG stack with no clash (no published ports).

**Result: green, no secrets needed.** `SERVICE_TEMPLATE_ENABLED=false`: 26 files passed, 6 skipped
(282 tests passed, 164 skipped), 112 s. `=true`: 27 passed, 5 skipped (295 passed, 151 skipped),
118 s. The same split as the repository's CI.

| Phase (final run) | Time |
|---|---|
| network + proxy + compose rewrite | 1.3 s |
| image pull | 1.3 s (every image was already cached; a cold pull was NOT measured) |
| services up (`compose up --wait`, all healthy) | 7.2 s |
| sandbox + clone | 3.0 s |
| Node 24.22.1 from `.nvmrc` (nodejs.org, 58 MB) | 5.0 s |
| `npm ci` (399 packages, 76 MB) | 18.7 s (33–38 s on earlier runs) |
| migrations (Liquibase job) | 5.4 s |
| `npm run test:integration` | 111.7 s |
| **nothing → green** | **155 s** |

**RAM** (peak, `docker stats` every 4 s): 1.9 GiB in total — sandbox 1.0 GiB, localstack 406 MiB,
cdp-defra-id-stub 242 MiB, cdp-uploader 148 MiB, postgres 89 MiB, proxy 27 MiB, caddy 15 MiB,
redis 8 MiB. A 4 GiB sandbox cap was ample. **Disk**: sandbox writable layer 562 MB (clone with
`node_modules` 328 MB, Node 208 MB, npm cache 81 MB); `pgdata` volume 115 MB; images 2.4 GB for the
services + 308 MB Liquibase + the sandbox image.

**Hosts the proxy saw** (final allow-list run; earlier runs added the rows marked *):

| Host | From | Verdict | Use |
|---|---|---|---|
| `registry.npmjs.org:443` | sandbox | allowed | `npm ci`, 29 tunnels, 76 MB |
| `codeload.github.com:443` | sandbox | allowed | the `bng-library` git dependency (tarball, 0.5 MB) |
| `github.com:443` * | sandbox | allowed | `git ls-remote` for that dependency, 8 KB (3 of 5 runs) |
| `nodejs.org:443` | sandbox | allowed | Node from `.nvmrc` |
| `repo1.maven.org:443` | migration job | allowed | the Postgres JDBC driver (Liquibase 5 ships none) |
| `config.liquibase.com:443` | migration job | denied, harmless | Liquibase's own update/analytics call |
| `analytics.localstack.cloud`, `raw.githubusercontent.com`, `cdn.jsdelivr.net` * | localstack | denied, harmless | start-up telemetry and downloads; only seen when services had a proxy env |
| `169.254.169.254:80` * | cdp-uploader, the backend under test | denied, correct | the AWS SDK's instance-metadata probe |

Not seen by the proxy: image pulls (the host daemon pulls; Docker Hub hosts stay off the sandbox
allow-list). **Seed for WP3's default list**: `registry.npmjs.org`, `github.com`,
`codeload.github.com`, `nodejs.org`, `repo1.maven.org` (plus the providers and PyPI from the plan).
Isolation checked: a direct `fetch` from the sandbox failed with `EAI_AGAIN` (no DNS out);
`example.com` and `gitlab.com` through the proxy got 403 on CONNECT and were logged; a service
container cannot resolve outside names.

**Rules for WP6 (each one broke a run before it was fixed):**

1. **Service containers get NO proxy environment by default.** None of BNG's services needs the
   internet. CDP apps read `HTTP_PROXY` themselves and IGNORE `NO_PROXY` (undici `ProxyAgent` as the
   global dispatcher, `src/common/helpers/proxy/setup-proxy.js`), so cdp-uploader sent its calls to
   `localstack:4566` out through the proxy: 92,890 denied requests in three minutes. Egress for a
   service is a per-service opt-in.
2. **The code under test runs WITHOUT `HTTP(S)_PROXY`.** The backend under test uses the same CDP
   proxy setup: with the variables set, its call to `localhost:7337` went to the proxy and 57 tests
   failed with 502. Proposal (untested): give the sandbox NO global proxy variables; configure the
   tools instead (`npm config set proxy/https-proxy`, git `http.proxy`, `~/.curlrc`, `pip.conf`), and
   reach the model through the injector base URL (spike 3), which needs no proxy variable either.
3. **Tests hard-code `localhost:<port>`** (`vitest.integration.config.js` sets
   `S3_ENDPOINT=http://localhost:4566` over any environment value; the helpers default to
   `localhost`). The sandbox runs a localhost port-forward per service, built from the `ports` that
   the rewrite drops (5432→postgres, 4566→localstack, 7337→cdp-uploader, …). `limn-svc up` starts it.
4. **Set-up steps that need Docker run as host-side JOBS on the internal network.** The repository's
   own `db:update` is `docker run liquibase/liquibase …`, which the sandbox cannot do (no socket). The
   spike ran that container from the host on the session network, with the changelog from the clone
   mounted read-only, then the tests with `SKIP_MIGRATIONS=1` — what the repository's CI does. WP6
   needs a `limn-svc run <job>` verb (a policed one-off container), not just `up`/`build`. Liquibase
   detail: `--classpath` replaces the search path, so pass `--search-path=/liquibase` too.

**Smaller findings:**

- **Normalise with `docker compose config --format json`**, then police and rewrite the JSON: no YAML
  dependency, relative paths already absolute, defaults (`${X:-latest}`) already filled. The rewrite
  dropped `ports` (all six services; localstack's 4510–4559 range), `links`, caddy's
  `extra_hosts: host.docker.internal:host-gateway`, set the external internal network, and named every
  volume `<project>_<key>`. caddy's route to `host.docker.internal:3001` is dead in a session; the
  tests do not use it.
- **A writable directory bind (`./localstack:/var/lib/localstack`) becomes a NAMED, labelled
  volume.** An anonymous volume carries no labels, so the boot sweep could never find it. Read-only
  file binds (`start-localstack.sh`, `Caddyfile`) stay binds, from the session's copy of the repository
  (the spike used `git archive HEAD`; WP6 needs a volume subpath or a host-side copy, since the
  workspace lives on a named volume).
- **Node version**: the repository needs Node ≥ 24.22.1 (`.nvmrc`); the image has 22. The spike
  downloaded it through the proxy. The image should carry a version manager, or Limn caches the
  tarballs per version.
- **No SSH in the sandbox.** The lockfile names `git+ssh://git@github.com/DEFRA/bng-library.git`; a git
  `url.https://github.com/.insteadOf` rule for `ssh://git@github.com/` and `git@github.com:` sends it
  over HTTPS through the proxy.
- `.npmrc` `min-release-age` must go before `npm ci` (the repository's CI does the same).
- **The proxy log needs coalescing**: one row per (source, host, port, verdict) with a count and bytes,
  or a looping client floods the Network panel. It also needs the SOURCE container: the log carries the
  client IP, mapped to a container name on the session network. Read the CONNECT client's address when
  the request arrives; it is gone once the socket closes.

### Spike 5 — microsandbox (desk check; untested)

Source: https://docs.microsandbox.dev (CLI pages, secrets, networking, TLS, the Compose how-to),
read 2026-11-07. Requirements: Apple Silicon Mac, or Linux glibc ≥ 2.28 with `/dev/kvm`, or Windows
with WHP (preview). Install `curl -fsSL https://install.microsandbox.dev | sh` (writes
`~/.microsandbox/`, links in `~/.local/bin/`) or `brew install superradcompany/tap/microsandbox`.
The adapter drives the CLI (no npm dependency):

| Need | CLI call |
|---|---|
| Detect / health | `msb doctor` (exit status + report); `msb --version` |
| Image | `msb pull ghcr.io/<owner>/limn-sandbox@sha256:<digest>`; local fallback `docker save limn-sandbox:<v> \| msb load --tag limn-sandbox:<v>` (needs Docker on the host) |
| Create | `msb create limn-sandbox:<v> --name limn-<session> --label limn.session=<id> --label limn.account=<id> -c 4 -m 8G --root-disk flat:30G,clone=auto -w <start dir> -e KEY=VALUE …` (labels must not start with `sandbox.`, `microsandbox.`, `service.`) |
| Read-only mounts | `-v <clone-cache>/<owner>/<repo>:/limn/src/<owner>/<repo>:ro,noexec` and `-v ~/.claude/projects/<key>/memory:/limn/memory/<key>:ro` |
| Private disk for services | `--mount-owned /var/lib/docker:kind=disk,size=20G` (removed with the sandbox) |
| Egress allow-list | `--net-default deny --net-rule "allow@dns" --net-rule "allow@host:tcp:3128,allow@host:tcp:8081,allow@host:tcp:8082"` — i.e. allow ONLY Limn's host proxy at `host.microsandbox.internal`, and set `HTTPS_PROXY=http://host.microsandbox.internal:3128` + `ANTHROPIC_BASE_URL=http://host.microsandbox.internal:8081` in the guest. ONE allow-list, ONE log, ONE injector on both backends. |
| Native alternative (not chosen) | `--net-rule "allow@api.anthropic.com"` (hostname rules need `--net-strict`, the default) + `--secret 'CLAUDE_CODE_OAUTH_TOKEN@api.anthropic.com'` (the guest sees `$MSB_CLAUDE_CODE_OAUTH_TOKEN`, a placeholder). Needs TLS interception with msb's CA trusted in the guest (`msb-trust.sh`, `NODE_EXTRA_CA_CERTS` for Claude, `CODEX_CA_CERTIFICATE`/`SSL_CERT_FILE` for Codex). It gives no per-request log Limn can show, so the host proxy route is preferred. ⚠ `--proxy http://IP:PORT` is NOT a substitute: msb resolves names itself and sends the destination IP in CONNECT, so a host-name allow-list cannot work through it. |
| Streaming exec | `msb exec --stream -u agent -w <dir> -e … limn-<session> -- claude -p --input-format stream-json …` (stdin forwarded, output flushed as it arrives; `--timeout`, `--rlimit` available) |
| Copy in / out | `msb copy <host> limn-<session>:<guest>` and back (seed files, patches); or `msb exec … -- git format-patch --stdout` |
| Services | Docker INSIDE the VM: the image needs Docker Engine + compose plugin (or a `docker:<v>-dind` base), started by a root `msb exec … -- dockerd` and polled with `msb exec … -- docker info`; then `docker compose up` as the agent. The guide uses `--root-disk flat:10G`. |
| Stats | `msb metrics` (`--watch`), `msb inspect limn-<session> --format json` |
| Teardown / sweep | `msb rm --force limn-<session>`; boot sweep `msb ls --label limn.account=<id> --format json` then `msb rm --force --label limn.session=<id>` for each dead one |

Open questions only a real run can answer: whether `-u agent` works for `msb exec --stream` with our
image's user; dind start time and disk use for the BNG stack; whether `host.microsandbox.internal`
rules accept a port list in one token; first-boot time of a 1.3 GB image. A GitHub Actions Linux
runner is reported to expose `/dev/kvm` (after a udev rule) — not verified here.
