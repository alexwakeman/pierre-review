# Plan: Implement story builds front ends — the ticket relay, Figma, and an on-demand browser

Status: **BEING BUILT** (2026-11-21). BUILT: § 2 (the ticket relay: Jira attachments and every provider's links;
[SANDBOX.md](SANDBOX.md) § The ticket relay), § 4 (the plan's UI section) and §§ 6–7 (the design-system and
no-design rules, in the seed's plan section; SANDBOX.md § The plan and its checks) and § 5 (the browser; SANDBOX.md
§ The browser) and § 3 (Figma; SANDBOX.md § The ticket relay → `figma <id>`). The rest is not built yet. When a part is built, move
its detail into [STORY-BUILD.md](STORY-BUILD.md) / [SANDBOX.md](SANDBOX.md) / [TRACKERS.md](TRACKERS.md) and
mark it built here, as [CODEX-PLAN.md](CODEX-PLAN.md) does.

Items marked **(unverified)** are assumptions about third-party products or about our own code paths that
were not checked while writing this note. Check each before building on it.

## The goal

A reader presses **Implement** on a ticket that needs UI work. The agent builds a front end that **fits the
workspace's repositories**: their components, tokens and patterns, not hand-rolled markup that only looks
like a mockup.

Inputs are uneven. Some tickets link a Figma frame, some attach screenshots or a photo of a sketch, and many
have only words. Most developers **cannot use the Figma API** in practice, because Figma limits non-paid
seats heavily **(unverified: check the current tiers)**. So:

- **The agent reads the ticket itself at build time**, through the host, and decides what it needs. We stop
  trying to pass in an exhaustive ticket. TICKET.md (the story context) is still seeded, so it can decide well.
- **Figma is an optional integration.** With a token, the agent can read the linked design. Without one, it
  works from whatever the ticket has.
- **A browser is optional too.** The PLAN says whether the build needs one; the reader confirms at Approve.
- **No design-system setting.** The plan agent finds the design system in the workspace itself.
- **No design given still means "build it"**, fitted to the existing design.

## Decisions made

| Question | Decision |
|---|---|
| How the agent reads the ticket | **A host relay, `ensemble-ticket`** (option B). Not a host-only prefetch (A), and not the tracker token added by the proxy (C). |
| Figma | A new **optional** per-workspace integration: a sealed token, read by the HOST only. |
| Browser | **Optional, chosen in the plan**, confirmed by the reader at Approve. It runs as a **separate container Ensemble starts** (the services pattern), never baked into the sandbox image. |
| Design system | **Not configured.** The plan agent finds it; the host verifies the plan's code evidence as today. |
| No design input | Build anyway, fitted to the nearest existing screens; the plan says so. |
| Names | New agent-visible names use **`ensemble-`** (`ensemble-ticket`, `ensemble-browser`, `.limn/ticket/` stays under the existing `.limn/` folder). Existing internal names (`limn-svc`, `limn-proxy`, `limn-plan`, `.limn/`) are kept, per CLAUDE.md § Packaging. |

## Scope

**Implement and Fill gaps only.** Receipt-time ingest (`tracker/worker.ts`, `tracker_tickets`) does not change:
the PR review, the story check and the ticket review still read the stored row. The host-side fetchers built
here (attachments, Figma) are written so that a later ingest upgrade can reuse them, but that upgrade is not
part of this plan.

---

## 1. What exists today (the starting point)

- **Jira already receives every field and throws most away.** The reader asks for
  `issue/<KEY>?fields=*all&expand=names,schema`; `jira/candidates.ts` keeps only custom fields whose value is
  TEXT. The `attachment` system field is in the answer and is ignored. ADF `media*` nodes are dropped
  (`jira/text.ts`); wiki `!file.png!` becomes `(image: file.png)`.
- **GitHub Issues**: body, type, state, assignee, sub-issues, comments. Pasted images are `user-attachments`
  addresses in the body.
- **Linear**: description, project, blockers, comments. The issue's `attachments` (where Linear's Figma
  integration puts links **(unverified)**) are not read for a ticket.
- **Notion**: the mapped properties only; image, embed and file blocks are skipped (`notion/blocks.ts`).
- **The figures pipeline** (`reference-docs/figures.ts`, `figure-fetch.ts`, `figure-describer.ts`,
  `diagram-outline.ts`; [REFERENCE-DOCS.md](REFERENCE-DOCS.md) § Figures): bytes → header-checked PNG / JPEG /
  GIF / WebP → sha256 dedupe → Claude vision description (cached per account + sha256), draw.io / Gliffy
  outlines with no model, Atlassian's signed media redirect handled credential-free (`confluenceGetBytes`).
- **The services relay** ([SANDBOX.md](SANDBOX.md) § Services): `limn-svc` in the sandbox → `limn-svcd` →
  Ensemble's own `docker exec` pipe → the host does the work. Nothing on the host listens for the sandbox.
- **Implement clones every workspace repository** into the session ([STORY-BUILD.md](STORY-BUILD.md) § What it
  is), so a design-system repository in the workspace is already in the sandbox.
- **The sandbox image** is `node:22-bookworm-slim` plus tools. There is no browser.

---

## 2. The ticket relay — `ensemble-ticket`

> **Built 2026-11-21** (Jira attachments; links from every provider). Differences from the design below: there is
> no `figma` verb yet (§ 3); a link is never fetched by the host — `get` answers how to open it through the proxy, so
> the reader's allow-list still decides; the manifest scans the session's own TICKET text, so it adds no tracker read.

The agent asks for ticket material; the HOST reads it with the workspace's tracker credential and writes the
result into the sandbox. **No tracker credential ever enters the sandbox.** This keeps the threat model's
"no credentials inside" row true and keeps "the ONLY tracker writes are the reader's picks" true.

### Transport

The same shape as `limn-svc`: an `ensemble-ticket` command and a small daemon in the image, a unix socket in
the sandbox, NDJSON over the `docker exec` stdio Ensemble started. The request is DATA. The host matches every
argument against what it already knows about THIS session's ticket.

### The manifest (written before the first turn)

At session start the host reads the ticket once (it already refreshes it: `refreshTicketForSession`) and writes
`.limn/ticket/manifest.json`: one entry per thing the ticket attaches or links.

```ts
interface TicketArtifact {
  id: string;            // the host's handle: stable for the session, opaque to the agent
  kind: 'figma' | 'image' | 'diagram' | 'json' | 'pdf' | 'file' | 'link';
  source: 'attachment' | 'field' | 'description' | 'comment' | 'remote_link' | 'integration';
  name: string;
  mime?: string;
  size?: number;
  figma?: { fileKey: string; nodeId: string | null; readable: boolean }; // readable = a token is saved
}
```

Where entries come from, per provider:

| Source | Jira | GitHub Issues | Linear | Notion |
|---|---|---|---|---|
| Native attachments | `fields.attachment` (already in the answer) | none | issue `attachments` | `files` properties, image / file blocks |
| URL-typed fields | custom URL fields | issue fields **(unverified)** | — | `url` properties |
| Links in text | description + comments | body + comments (incl. `user-attachments`) | description + comments | page body |
| Integration links | `remotelink` (one more call) | — | Figma attachments **(unverified)** | — |

One pure classifier names the kind from the address: `figma.com/(file|design|proto|board)/<key>` with
`node-id`, image extensions, `.json`, `.drawio`, `.pdf`. It is a LINEAR scanner (ticket text is untrusted, as
every scanner in `tracker/`).

⚠ **Identity is never a signed address.** Notion's S3 addresses expire within the hour and Atlassian media
addresses are signed. `id` is derived from a stable id (attachment id, Figma file + node, the normalised link),
never from the address the tracker returned.

Atlassian's own "Figma for Jira" app may show designs in Jira's Designs panel rather than in a field or a
remote link **(unverified)**. Check a real site before relying on it; until then such a design is not in the
manifest.

### The verbs

| Verb | What the host does |
|---|---|
| `ensemble-ticket show` | Writes the latest ticket text (title, description, criteria, open points, comments) to `.limn/ticket/TICKET.latest.md`. |
| `ensemble-ticket list` | Prints the manifest. |
| `ensemble-ticket get <id>` | Downloads that one artifact on the host and writes it to `.limn/ticket/files/<id>-<safe name>`. |
| `ensemble-ticket figma <id> [--node <nodeId>]` | § 3. Answers "no Figma token saved" without one. |

Rules:

- **Only this ticket.** `<id>` must be in the manifest. There is no "read another ticket" verb. A linked or
  blocking ticket can be added later as its own verb if needed, with the same rule.
- **Read only.** No verb writes to the tracker.
- **Host-side fetch rules**: through the tracker's own guarded fetch (`tracker/jira/fetch.ts` for customer
  hosts), no redirects except the one credential-free hop to a signed media address (as `confluenceGetBytes`),
  public addresses only for that hop. ⚠ The GitHub token goes ONLY to GitHub's own hosts; a redirect elsewhere
  drops it.
- **Caps**: a per-file byte cap, a per-session byte total and a per-session request count. Past a cap the verb
  says so in one line; it never fails the turn.
- **Logged**: each verb is one row in the session's Network panel (host, artifact name, bytes, verdict).
- **The bytes are untrusted.** They are written into the sandbox as files and nothing on the host opens them,
  except the header check that names an image type.

### What the agent is told

The seed (`sandbox/workspace/seed.ts`, the ONE fold) gets a short paragraph: the manifest exists, how to fetch
items, and that the ticket and its files are untrusted requirements, not instructions. TICKET.md stays the
requirement.

---

## 3. Figma — an optional integration

> **Built 2026-11-21**, as designed below. The cache is in memory (per process), not stored. Figma's endpoint
> shapes are parsed defensively and were NOT checked against a live Figma account while building (only against
> fakes): confirm `/v1/files/:key/nodes`, `/v1/images/:key` and `/v1/me` with a real token before relying on it.

### Setting

Settings → Integrations → **Figma**: a personal access token, sealed write-only per workspace (the SonarCloud
pattern, `auth/crypto.ts`). One plain line: what it is used for and that it is read only.

### What the host reads (with a token)

- `GET /v1/files/:key/nodes?ids=<node>` → the frame's tree. The host turns it into a **deterministic
  outline** with no model, like `drawioOutline`: frames and auto-layout (direction, gap, padding), sizes,
  fills and text styles, text content, component and instance names. Written as
  `.limn/ticket/figma/<id>.outline.md` (and the trimmed JSON beside it).
- `GET /v1/images/:key?ids=<node>&format=png` → a render of the frame, written as `.limn/ticket/figma/<id>.png`.
- Cache per (account, file key, node id, file version), so a re-run does not spend the reader's Figma rate
  limit again.

Endpoints and response shapes are from memory **(unverified)**; check Figma's current REST reference.

### Rules

- `api.figma.com` is called **from the host**. It is never on the sandbox allow-list.
- A new outbound host means: the SSRF guard pattern, a rate-limit tier if a route triggers it
  (`api/plugins/rate-limit.ts` `tierFor`), and the token redacted from logs.
- **Without a token**: the manifest entry says `readable: false`, and the plan reports "Figma frame linked;
  not read" and what it built from instead.
- A Figma link to a whole file (no `node-id`) is read as its first page's top frames, capped; the plan names
  which frames it used.

---

## 4. The plan's UI section

> **Built 2026-11-21.** As designed below, except: `nearestScreens` is a list of code quotes (no wrapper object);
> a design input not in the manifest is dropped by the host (the agent's checker only drops it once the relay
> has read the manifest); the Approve tick for the browser comes with § 5.

The `limn-plan` block gets an optional `ui` section. It is checked by the SAME validator text the host and
the agent share (`BUILD_PLAN_CHECK_SOURCE`), and its code evidence is verified on the host like every other
point (`coding/story-build/plan-verify.ts`).

```ts
ui?: {
  needed: boolean;
  browser: boolean;                 // the agent's recommendation
  reason: string;                   // one sentence
  designInputs: Array<{ id: string; used: boolean; note?: string }>;   // manifest ids
  designSystem: {
    summary: string;                // "Tailwind tokens + packages/ui components + Storybook"
    evidence: PlanEvidence[];       // code quotes: tokens file, components it will reuse
  };
  nearestScreens: PlanEvidence[];   // 1–3 existing screens it will follow
  renderTarget: 'storybook' | 'dev_server' | 'test_page' | 'none';
  newComponents: Array<{ name: string; why: string }>;  // anything it will introduce
  gaps: string[];                   // states the design does not show (empty, error, mobile, …)
}
```

- **Shape rules** (unusable plan): `browser: true` with `renderTarget: 'none'`; a `designInputs` id not in the
  manifest; `needed: true` with no `designSystem.evidence` and no `nearestScreens`.
- **Content rules** (the item is dropped): evidence that does not verify, as today. A component the agent
  invented does not survive the host check, and the reader sees it dropped.
- The plan view shows the section as a few plain lines, with the dropped items counted.

---

## 5. The browser — optional, chosen in the plan

> **Built 2026-11-21.** Decisions on the open questions: (1) the image is the pinned `chromedp/headless-shell` by
> digest (small, maintained, no recipe of our own); (2) its network is the SANDBOX'S namespace and its requests out
> go through the session proxy; (3) the agent may start it mid-build with `ensemble-browser start`, which is one
> notice to the reader. Differences from the design below: no forwarder is needed (the shared namespace makes
> `localhost` the sandbox), there is no `run <script>` verb (the DevTools endpoint is open to the agent's own
> tools, for example playwright-core), and screenshots stay in the sandbox (§ 8 is not built).

### Why a separate container

| Option | Verdict |
|---|---|
| Install a browser inside the running sandbox | **Not possible**: the sandbox is non-root with all capabilities dropped, so no system packages, and the download host is not on the allow-list. |
| Two sandbox images, swap after the plan | Possible but wrong: the mirror, seed and agent session would have to be rebuilt in the new container, and a large image would be pulled for any session that might need it. |
| **A browser container Ensemble starts on request** | **Chosen.** The services pattern ("Ensemble runs the services; the agent asks"). The sandbox image does not change. A session that needs no browser pays nothing. |

### How it starts

1. The plan says `ui.browser: true` (or false).
2. The Approve panel shows **"Give the build a browser"**, preset from the plan. The reader can turn it on
   when the agent did not ask, or off.
3. On Approve, the host starts the browser container on the session network before the build turn, with
   Ensemble's caps, counted against the services total.
4. **Pre-pull**: when a cheap signal suggests UI work (a front-end framework in a workspace repository's
   `package.json`), the host starts pulling the browser image during planning. The first pull is the slow part.
5. **Mid-build start** (open question 3): `ensemble-browser start` when the plan did not ask.

### The verbs

| Verb | What it does |
|---|---|
| `ensemble-browser shot <url> [--width 375,768,1280] [--full] [--wait <selector>]` | Screenshots written into `.limn/browser/`. |
| `ensemble-browser run <script.js>` | Runs an agent-written Playwright script inside the browser container (log in a test user, open a menu, then shoot). The script is untrusted; it runs in the browser container only. |
| `ensemble-browser console <url>` | The page's console errors and failed requests. |
| `ensemble-browser stop` | Stops it (the session's end stops it anyway). |

The agent opens the PNGs to look at them (Claude Code's Read reads images). Whether the Codex sandbox driver
lets Codex view an image is **(unverified)**: the host-side lockdown turns image input off, and the sandbox
driver's own config was not checked. Until checked, a Codex build gets the browser's console output and the
screenshots' existence, not their content.

### Reaching the app

- The page must see `localhost:<port>`: Vite (`server.allowedHosts`), webpack-dev-server and Next check the
  `Host` header, and cookies and CORS assume `localhost`. A small forwarder INSIDE the browser container maps
  `localhost:<port>` to the sandbox over the session network. (Services forward the other way already.)
- The dev server must listen on the session network, not only on the sandbox's loopback. The seed says how.

### The image

Open question 1: a pinned Playwright image from MCR (already on `DEFAULT_ALLOWED_REGISTRIES`), pulled by
digest; or Ensemble's own `ensemble-browser` image built from a recipe like the sandbox image (control over
size and the Chromium version). Either way it is pinned, part of the release manifest, and pulled by the
HOST's daemon.

### Plan time

Seeing the current look of nearby screens before planning is valuable, most of all with no design. Plan turns
already run commands (`limn-svc run` output is `data_run` evidence). Whether Claude's `--permission-mode plan`
allows starting a dev server is **(unverified)**. If it does not, the plan reasons from code, and the first
build step shoots the nearest existing screens before any change.

---

## 6. Finding the design system (no setting)

The plan agent looks, in this order, and cites what it finds as code evidence:

1. **Tokens**: `tailwind.config.*`, CSS custom properties, theme files, `tokens.json`, a MUI / styled-system theme.
2. **Components**: local `components/` or `ui/` folders, a UI package in a monorepo, another workspace
   repository that is a component library, or a published package (`@org/ui`), which is readable in
   `node_modules` after install (types, often stories).
3. **Storybook**: `.storybook/`, `*.stories.*`. The best catalogue and the best render target.
4. **Patterns**: the 1–3 existing screens nearest to the ticket; routing, forms and data fetching.

Rules for the build, in the seed: reuse existing components and tokens; every new component or one-off style
goes in `ui.newComponents` with a reason; follow the nearest screen's structure.

When Figma is read, the outline's component and instance names are matched against the code's component
names. This is a plain name match, a rough stand-in for Figma's Code Connect.

**Gaps**: a design system outside the workspace (and not a published package) is not visible. If there is no
design system (ad hoc CSS), the plan says so and "fit" means following the nearest screen's markup and classes.

---

## 7. No design input

The build still goes ahead. The plan says it plainly: "No design given. Built from `PageHeader`, `Card`,
`Form`, following `pages/billing`." It lists what it had to choose (states, copy, spacing).

With a browser, the build compares the new screen with the nearest existing one at the same widths ("does it
look like it belongs?") instead of with a mockup ("does it match?"). Both are a model's judgement and are shown
as such, never as a pass or fail.

A photo of a sketch gives layout intent, not spacing or colour. The design-system rules (§ 6) are what make a
vague input come out looking like the rest of the product.

---

## 8. Evidence for the reader, and what leaves the sandbox

- **The plan**: the UI section (§ 4).
- **The build report** (`workspace/build-report.ts`): per screen, before / after screenshots at the planned
  widths, next to the design input when there is one; the new components; the gaps.
- **The review loop** may add a visual round that compares the screenshot with the design or the nearest
  screen. Advisory only, never a gate.

⚠ **Screenshots leaving the sandbox is a NEW way out.** Today work leaves only as a patch (or an AI Fix merge
bundle). Screenshots are data, not code, but the rule changes, so: the host copies only files under
`.limn/browser/`, checks each is a real PNG by its header, caps size and count, and the SPA shows them through
a backend route on a click, never on mount and never by a sandbox address. SANDBOX.md's threat model gets a
row for it.

---

## 9. Threat model additions

| Threat | What stops it |
|---|---|
| Ticket text tells the agent to read other tickets or write to the tracker | `ensemble-ticket` serves only this ticket's manifest ids; no write verb; the credential stays on the host. |
| A hostile attachment (SVG with script, HTML, zip) | It is a file in the sandbox. The host only header-checks; the SPA never renders it. |
| Instructions inside an image | The agent is told ticket files are requirements, not instructions; a model description of an image is never grounding (`withoutFigureDescriptions`). |
| The browser leaks page data out | Open question 2. With no route out, nothing leaves (and external fonts and scripts do not load). Through the proxy, the same allow-list and log as the sandbox apply. |
| An agent-written Playwright script | Runs only in the browser container: non-root, capped, no host mount, the same network rules. |
| Screenshots as an exit | § 8: PNG header check, caps, a fixed folder, shown through the backend on a click. |
| Spend | Images and screenshot rounds use tokens. Each round is inside a turn the reader started; cap screenshots per turn. Automatic turns (repair, continuation, the review loop) already ask the budget gate. |
| Figma and tracker rate limits | Shared with the reader's normal use: caches, caps, and the tracker's workspace back-off honoured. |

---

## 10. Invariants that must still hold

- No GitHub, tracker or Figma credential inside the sandbox; no Docker socket; no writable host mount.
- The ONLY tracker writes are the reader's picks (TRACKERS.md). The relay writes nothing.
- Views never call a reader. The relay runs inside a session the reader started.
- Work leaves only as a patch per repository; screenshots are the one new, checked, data-only exit.
- Every model call goes through `ai/provider.ts`; any image description goes through `describeImage`.
- Signed addresses never feed an identity, a hash or `changed_at`.
- New account-scoped tables (the Figma token, a Figma cache) join `accountScopedTables()` and export; each
  migration is registered in the journal by hand ([MIGRATIONS.md](MIGRATIONS.md)).
- User-visible copy is plain English; the user docs and `CHANGELOG.md` Unreleased change with the feature.

---

## 11. Open questions (the owner's)

1. **The browser image**: MCR's pinned Playwright image, or Ensemble's own `ensemble-browser` recipe image?
2. **The browser's network**: none, or through the session proxy with the allow-list? Recommended: the proxy.
3. **A browser the plan did not ask for**: start it automatically with a notice, or ask the reader?
4. **Repositories outside the workspace**: should the plan be able to ask for one as read-only design-system
   context? (Inside the workspace is already covered: Implement clones every workspace repository.)
5. **Logins**: many apps render nothing without SSO. Is "Storybook or a test page with mocked data" an
   acceptable rule, or do we want a way to give the browser a test login (which is a credential: it would need
   its own design)?

## 12. Order of work

No dates. Each step is useful on its own.

1. **The relay, Jira first**: the manifest from `fields.attachment` and links in text; `show`, `list`, `get`.
   Then GitHub Issues, Linear, Notion.
2. **The plan's UI section** and the design-system rules in the seed. Useful with no browser and no Figma.
3. **The browser container**: start on Approve, `shot` / `console`, the forwarder, screenshots in the report.
4. **Figma**: the setting, the outline, the render, the cache.
5. **Visual review round** in the review loop.

## 13. Docs to change when each part is built

- [SANDBOX.md](SANDBOX.md): the relay and the browser container (new sections), the threat-model rows, the
  image (if the recipe approach is chosen), the screenshot exit.
- [STORY-BUILD.md](STORY-BUILD.md): the plan's UI section, the Approve tick, the report's screenshots.
- [TRACKERS.md](TRACKERS.md): the host-side attachment fetchers per provider.
- [SECURITY.md](SECURITY.md): the Figma host and token; the screenshot route.
- [API.md](API.md): any new route (Figma setting, screenshot fetch).
- [DATA-MODEL.md](DATA-MODEL.md) / [MIGRATIONS.md](MIGRATIONS.md): new tables.
- The user docs (`apps/landing/src/docs/`), `CHANGELOG.md` Unreleased, and any landing mock that shows the
  build tab.
