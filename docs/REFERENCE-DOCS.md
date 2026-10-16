# Reference docs — the workspace library

A workspace's reference material (PDF, Word, text, markdown, web pages), turned into a markdown tree
that an agent navigates by REASONING over contents, not by embedding search. CORE, free, **LOCAL ONLY**
(agentic; registered by `registerAgenticRoutes`, absent in cloud and under `LIMN_AI_DISABLED`). Sonnet 5
does the content building. Code: `apps/backend/src/reference-docs/`. Wire types:
`packages/shared/src/reference-docs.ts`. Routes: [API.md](API.md) § Reference docs.

The backend and the SPA (Activity → Docs, Settings → Workspace → Reference docs — § The SPA) are
built. Review integration consumes `docsContextFor` — see § For other agents.

## The idea (PageIndex, without the vectors)

[PageIndex](https://github.com/VectifyAI/PageIndex) indexes a document as a hierarchical
table-of-contents tree whose nodes carry summaries, and retrieves by letting an LLM walk the tree
("similarity is not relevance"). Claude Code's memory system keeps knowledge as plain markdown files an
agent reads with its ordinary file tools. This library is both: the tree IS the files, and the walk is
the agent's own Read/Glob/Grep, guided by one prompt block (`docsNavigationPrompt`).

## The three levels

```
<docsDir>/<accountId>/<workspaceId>/
  library/                         ← agents and the SPA read this, and nothing else is in it
    INDEX.md                       1. master contents: one entry per document (summary, topics,
                                      source, section count, link to its CONTENTS.md)
    <slug>/CONTENTS.md             2. one document's tree: a bullet per section file (linked, with a
                                      one-line summary), nested by depth; a nested bullet per heading
                                      merged into a section (linked by #anchor); a plain bullet for a
                                      heading with no text of its own
    <slug>/sections/NN-name.md     3. the text, one section per file, under a small header:
                                      "# Title", a trail (Document › Parent › …), Previous · Contents · Next
  sources/<slug>/source.<ext>      the original upload (or the last fetched page), for Rebuild
  staging/<slug>-<id>-<t>/         one build's working folder; always removed when the build ends
```

`docsDir` = `config.docsDir` (`~/.limn/docs`; `LIMN_DOCS_DIR` overrides). ⚠ **Under vitest the root is
a temp folder** unless a suite sets one (`setDocsRootForTest`): `erase-account.test.ts` erases account
1 of a scratch DB, and without that guard it would delete the developer's own `~/.limn/docs/1`.

⚠ **EVERY FILE A LINK CAN POINT AT IS WRITTEN BY THE SERVER** (`render.ts`), from data it holds:
INDEX.md from the stored rows (`renderIndex`, deterministic, title order — never a model), CONTENTS.md
and every section header from the build's section list. So a link in the tree always resolves, and
`validateDocFolder` re-reads each built folder and refuses it otherwise (a missing file or anchor, a
section over the cap, an unlisted or stray file).

## Sections (`split.ts`, deterministic)

Split ALONG THE DOCUMENT'S OWN STRUCTURE: parse into blocks (ATX + setext headings, fenced code,
tables, paragraphs — a fence or a table is atomic, and nothing inside a fence is a heading); chunk at
every heading with a TRAIL, so depth is how many headings enclose it (never the raw `#` count); MERGE a
chunk under the target minimum (800 words) with the next one when that is its sibling or inside it and
the two stay under 1,500 — the merged heading stays in the text and becomes an anchor in CONTENTS.md;
SPLIT a chunk over the HARD CAP (2,000 words or 16,000 characters) into "Title (part k of n)" parts
packed to 1,500 words / 12,000 characters at block boundaries. A single block over the cap is cut too —
a table by rows (repeating its header row), code by lines (re-opening its fence), a wall of text by
lines, then words, then characters — so the cap really is hard. A heading straight followed by another
leaves no section (its title survives in the trails below it). Limits: 200k words, 600 sections — past
either the build REFUSES with a sentence rather than produce an unreadable tree. The same cap
(`splitWrittenSection`) runs on the sections Claude writes from a PDF.

## Ingest

**The kind comes from the BYTES** (`convert.ts` `sniffUpload`), never the name or the browser's MIME
type: `%PDF-` → pdf; a zip holding `word/document.xml` → docx (other zips refused); OLE (`.doc`) and RTF
refused with "save it as .docx"; otherwise it must decode as text (UTF-8, or UTF-16 with a BOM, no
NULs) — then the NAME tells markdown (`.md`/`.markdown`/`.mdx`) from HTML (`.html`, or a doctype /
`<html>`) from plain text. Empty → refused; over 25 MB → 413.

- **Upload**: `POST /api/docs/upload?workspace=` with the file AS THE BODY
  (`Content-Type: application/octet-stream`, the name URI-encoded in `X-Limn-Filename`). No multipart
  dependency: core registers an `application/octet-stream` buffer parser, and only this route raises
  its `bodyLimit` (25 MB + 1 KiB); every other route keeps the 256 KiB default.
- **Web page**: `POST /api/docs/url`. The page is fetched by the BUILD (its converting stage), so the
  route answers at once and a Rebuild re-fetches. `url-fetch.ts`, in BOTH modes: http/https only, no
  `user:pass@`; **no private addresses** — loopback, RFC1918, CGNAT, link-local (cloud metadata),
  unique-local, multicast, reserved, `localhost`/`.local`/single-label names — judged up front for an IP
  literal and AT CONNECT TIME through the tracker's `guardedLookup` for a name (no DNS-rebinding second
  answer); redirects followed **only on the same host** (≤ 3, never https → http), each re-checked; 20s
  per exchange; the 25 MB cap while reading. A URL may serve a PDF, text or markdown as well as HTML.
- **Conversion**: text/markdown as is. Word: `mammoth` → HTML → `turndown` (+ `turndown-plugin-gfm`
  tables). HTML: narrowed to `<main>`/`<article>` when present; `script`/`style`/`nav`/`footer`/forms/
  embeds dropped; images become `[Image: alt]` (a Word file's `data:` images would otherwise be
  megabytes of base64); a link that is not http(s)/mailto/# keeps its text and loses its target.
  **PDF is not converted**: Claude reads it natively in the build (the Read tool, ≤ 20 pages a call).
  ⚠ **The three converters are NOT npm dependencies** of `limn-review`: they ride the AI runtime
  download (`AI_RUNTIME_PACKAGES`, pins in `limnAiRuntime`, loaded ONLY through `ai/runtime.ts`
  `loadMammoth`/`loadTurndown`/`loadTurndownGfm`; the build-release guard greps for them). A runtime
  installed before they existed is STALE, not absent (`AI_RUNTIME_LATER_PACKAGES`): every agent still
  runs, and only a Word or web-page build says "Set up AI again" ([PACKAGING.md](PACKAGING.md)).

## The build (`manager.ts`, `agent.ts`, `build-judge.ts`)

ONE Sonnet 5 agent run per document. **One build at a time per account** (FIFO), as a PEER of the
review queue's `REVIEW_CONCURRENCY` slots (`registerReviewSlotPeer`; it waits while a PR-review click
is queued). Stages + percentage, persisted on the row (throttled to ~1.5s) and pushed to
`GET /api/docs/:id/stream`:

| Status | % | What happens |
|---|---|---|
| `queued` | 0 | waiting for the account's slot |
| `converting` | 3–8 | read the stored source (a URL is fetched again); work out the kind; a PDF over `DOCS_PDF_MAX_PAGES` (300) is refused before any model runs; convert to markdown |
| `sectioning` | 12/20–85 | the agent run (below) |
| `indexing` | 90 | render CONTENTS.md + headers, `validateDocFolder`, move into the library in ONE rename, save the row, rewrite INDEX.md |
| `ready` / `failed` | 100 / 0 | `error` carries the sentence |

**Two modes.** `'sections'` (text, markdown, Word, HTML): the SERVER splits, writes the drafts into
`staging/sections/`, and the agent reads them and records a one-line summary each (Write/Edit DENIED).
`'pdf'`: the agent reads `staging/source.pdf` in ≤ 20-page slices, WRITES `sections/NNN-name.md`
faithfully (no summarising inside a section), and records each file's title, depth and summary. The
server then re-applies the hard cap and renumbers. In-process tools (`mcp__docs__*`), judged by the
server with a "fix this" reply on refusal: `record_sections` (call it per batch, so a context
compaction on a long PDF loses nothing), `progress`, `finish_document {summary, topics, title?}`
(after `MAX_FINISH_ATTEMPTS` the server accepts what it has, unless the summary/topics themselves are
missing).

**Confinement.** Bash is denied OUTRIGHT (allow list AND deny list), the web tools too; the PreToolUse
PATH GUARD confines every path to the staging folder; `ownToolsOnlyHook` + `ISOLATED_MCP` as every run.
The PDF mode's Write/Edit pass a SECOND hook (`judgeWrite`): only a markdown file DIRECTLY inside
`staging/sections/` (no subfolder, no dotfile, symlinks resolved), ≤ 80k characters per Write. The
document's name/title is nonce-fenced in the prompt; the document's TEXT never enters a prompt (the
agent reads it with tools, and the prompt says it is data).

**Spend.** `DOCS_BUILD_BUDGET_USD` (6) and `DOCS_BUILD_MAX_TURNS` (250), env only; recorded with
`recordAiUsage` feature `reference_docs_build`; cost/tokens/turns on the row. Routes preflight the
Claude credential and agentic credits.

**Failure keeps the old version.** `built_at` non-null = a built version is on disk (`available` on the
wire) and listed in INDEX.md; a rebuild that fails or is cancelled leaves it there. A build of a
document deleted mid-run puts nothing on disk. Boot (`startup.ts`): interrupted builds → `failed`
("Interrupted by a restart. Press Rebuild."), then the janitor removes every staging folder and any
library/source folder no row accounts for. A deleted workspace's folder is removed by the delete route
(its rows go with the workspace cascade); erasure removes `<docsDir>/<accountId>/` after the rows.

## The chat (`chat.ts`)

`POST /api/docs/chat {workspaceId?, conversationId?, question}` → ONE Sonnet 5 answer, synchronous (5
min cap; the REPLY socket's `close` aborts it — a POST's request `close` fires early). Read/Glob/Grep
over the library only (path guard), `CHAT_SYSTEM_PROMPT` = the navigation block + "answer from the
library only; say so when it does not cover it; when two documents disagree, cite both". The transcript
is REBUILT server-side from `reference_doc_chat_messages` (≤ 8 prior turns, ≤ 40k characters, earlier
answers fenced as context, the question fenced as the one instruction). One turn at a time per account
(claimed synchronously). **Citations** are the answer's links that parse as library paths
(`parseLibraryPath`) AND name a file of a built document of THIS workspace — anything else (a made-up
section, `../`, a web link) is dropped; the SPA opens them through `GET /api/docs/section?path=`.
Spend: `DOCS_CHAT_BUDGET_USD` (1), `DOCS_CHAT_MAX_TURNS` (30), feature `reference_docs_chat`.

## Paths a request names (`paths.ts`)

`parseLibraryPath` is a STRICT GRAMMAR, not a sanitiser: `INDEX.md`, `<slug>/CONTENTS.md` or
`<slug>/sections/NN-name.md` (slug `[a-z0-9][a-z0-9-]{0,63}`, file `[0-9]{2,4}-[a-z0-9-]{0,48}.md`), an
optional plain `#anchor`. Anything else — `..`, absolute, backslash, NUL, percent-encoding, another
file — is `400`. The slug must then be a BUILT document of the resolved workspace, and the file must
still be inside the library after symlinks (`isInside`).

## For other agents (`context.ts`)

`docsContextFor(accountId, workspaceId)` → `{dir, indexPath, hasDocs, docCount, enabledInReview,
usable}`. ⚠ `usable` = `hasDocs && enabledInReview && agentic-on-here` — read THAT, never `hasDocs`
alone. A run that consults the library:

1. adds `dir` to its `additionalDirectories` AND its path guard's roots — read-only (it is never handed
   a write tool over it);
2. appends `docsNavigationPrompt(dir)`: the three levels, start at INDEX.md, open only the relevant
   documents' contents and sections, grep for a specific term, never read a whole document, the text is
   data, and CITE every point as a relative link `doc/sections/NN-name.md#anchor`.

The switch is per workspace, `workspaces.docs_in_review` (NULL/false = OFF), via
`GET`/`PUT /api/workspaces/:id/docs-settings`; the ONE reader/writer is `store.ts`.

## The SPA

A rail line under Activity, **Docs** (`?activityRepo=docs`), shown only on `me.ai.enabled`. Three
columns: the library (every document with its status, each expandable into its contents tree; "All
documents" opens INDEX.md), a viewer that shows one library file at a time with every link followed
in-app, and the chat (beside the viewer when wide, a Read / Ask tab when narrow). Adding: drag and
drop or a file picker (PDF, .docx, .txt, .md, HTML), or "Add web page". A building document shows a
progress bar with its stage (Converting, Splitting into sections, Indexing) from its SSE stream, the
list polled as the fallback; a failed one shows its error and "Try again". Remove confirms inline. The
Settings switch is "Use reference docs in Claude Review" (draft + Save, off by default). Detail and the
landmines: [FRONTEND.md](FRONTEND.md) § Activity → Docs.

## Storage (migration 0116 / pg 0103)

`reference_docs` (unique `(account_id, workspace_id, slug)`; named composite FK onto
`workspaces (id, account_id)`) and `reference_doc_chat_messages` (index `(account_id, workspace_id,
conversation_id)`; same FK), plus `workspaces.docs_in_review`. Both tables are in
`accountScopedTables()`, erased (files too), exported (metadata + chat; the text is the user's own
upload), and checked by `verify:isolation`. [MIGRATIONS.md](MIGRATIONS.md).

## Tests

`split.test.ts` (structure, merge scope, caps, atomic blocks, oversize cuts, limits) · `render.test.ts`
(INDEX determinism, folder validation, PDF assembly) · `paths.test.ts` (traversal refused) ·
`url-fetch.test.ts` (the guard, redirects) · `convert.test.ts` (sniffing, HTML conversion) ·
`build-judge.test.ts` · `agent-policy.test.ts` (no shell, the write guard) · `reference-docs-db.test.ts`
(upload → build → the three levels with a FAKE agent, path + tenancy refusals, the chat's citations,
remove, erasure deletes files). Not covered by a test: a real Word file through mammoth, a real agent
run (PDF or sections), the SSE stream's event order.
