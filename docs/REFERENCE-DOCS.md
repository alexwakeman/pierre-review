# Reference docs — the workspace library

A workspace's reference material (PDF, Word, text, markdown, web pages, Confluence and Notion pages), turned into a markdown tree
that an agent navigates by REASONING over contents, not by embedding search. CORE and agentic
(registered by `registerAgenticRoutes`, absent under `LIMN_AI_DISABLED`). Sonnet 5
does the content building. Code: `apps/backend/src/reference-docs/`. Wire types:
`packages/shared/src/reference-docs.ts`. Routes: [API.md](API.md) § Reference docs.

The backend, the SPA (Activity → Docs, Settings → AI review → Reference docs — § The SPA) and the review
integration (§ Use in reviews) are built.

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
  .owner                           this database's id — the janitor's proof the folder is its own
```

`docsDir` = `config.docsDir`, **ONE ROOT PER DATABASE** (`data-dir.ts` `defaultDocsDir`;
`LIMN_DOCS_DIR` overrides): the data directory's own database (`~/.limn/pierre-review.sqlite`, the
installed CLI) keeps `~/.limn/docs`; any other database (`pnpm dev`'s `apps/backend/data/…`, a
worktree's dev server, a `--db`) gets `~/.limn/docs/db-<12 hex of sha256(absolute DB path)>`. The
`db-` prefix is non-numeric, so the default root's janitor — which walks only `<accountId>` folders, in
every version — never enters it. ⚠ **Under vitest the root is a temp folder** unless a suite sets one
(`setDocsRootForTest`): `erase-account.test.ts` erases account 1 of a scratch DB, and without that
guard it would delete the developer's own `~/.limn/docs/1`.

### Ownership (`owner.ts`) — why two databases cannot wipe each other's library

Until 2026-10-28 every database on the machine shared `~/.limn/docs`, and account/workspace ids are
small integers every database reuses. The boot janitor deletes what ITS rows do not account for, so a
second backend on another DB (a worktree's `pnpm dev`, the installed CLI) deleted the first one's
library folders; the rows survived and INDEX.md (rendered from rows) still listed documents that no
longer opened. Two layers stop it:

1. **The per-database root** above.
2. **The `.owner` marker.** `instance_meta.instance_id` (migration `0139`, `db/instance-id.ts`) is a
   random id written once per database FILE (it survives moving the file). `claimWorkspaceDir`
   writes it into a workspace folder when it is created — ⚠ only while the folder holds no document
   folders, so an unmarked folder with documents (maybe another database's) is never claimed. The
   janitor (`sweepDocsRoot`) ⚠ **never enters a folder whose `.owner` names another id, and never
   deletes anything from a folder with no `.owner`** (it logs one with documents and leaves it).
   `removeDocFiles`, `removeWorkspaceDocs` and `removeAccountDocs` skip a foreign-marked folder too.

**The one-time move** (`migrateLegacyDocs`, at boot before the janitor): a database whose root is not
the shared `~/.limn/docs` moves each of ITS workspace folders out of it with ONE `renameSync`, when the
target does not exist yet (never clobbers) and the folder is provably its own — `.owner` is its id,
or it is unmarked, holds at least one document folder and EVERY document folder is a slug this
database has a row for in that workspace. Anything else stays where it is and is logged
(`foreign_owner` / `unproven` / `rename_failed`). Never under `LIMN_DOCS_DIR` or a test root.

⚠ **EVERY FILE A LINK CAN POINT AT IS WRITTEN BY THE SERVER** (`render.ts`), from data it holds:
INDEX.md from the stored rows (`renderIndex`, deterministic, title order — never a model), CONTENTS.md
and every section header from the build's section list. So a link in the tree always resolves, and
`validateDocFolder` re-reads each built folder and refuses it otherwise (a missing file or anchor, a
section over the cap, an unlisted or stray file). ⚠ It checks ONLY the links the server wrote: a
section's HEADER (marker, title, trail, nav — `sectionHeader`) and CONTENTS.md. The document's own text
keeps its links as written, so a numbered doc's `[Deploy](05-deploy.md)` is the author's link, never a
refusal. Every model-written or third-party string the server prints (summaries, topics, source labels,
titles on `#` lines) goes through `inlineText`, which escapes `[ ] ( )`, so a summary saying
`See [RFC](https://…)` is text, not a link to chase. In the `sections` build the same check runs on the
server's own split (empty summaries) BEFORE the paid run, so a refusal costs nothing.
`cleanHeadingTitle` unescapes markdown backslash escapes (turndown writes `1\. Intro`, `snake\_case`)
and strips only PAIRED emphasis, so `snake_case` keeps its underscore.

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
  route answers at once and a Rebuild re-fetches. `url-fetch.ts`: http/https only, no `user:pass@`;
  **never loopback, link-local (cloud metadata), multicast, reserved or `localhost`**
  (`localhost` is Limn's own unauthenticated API); **private networks — RFC1918, CGNAT,
  unique-local — and intranet names (`.local`, single-label) are allowed**
  (`defaultPagePolicy()` → `privateNetwork: true`; the reader's company wiki is the point).
  Judged up front for an IP literal and AT CONNECT TIME through the tracker's `guardedLookup` with the
  policy's predicate for a name (no DNS-rebinding second answer; ANY blocked answer refuses); redirects followed **only on the same host** (≤ 3, never https → http), each re-checked; 20s
  per exchange; the 25 MB cap while reading. A URL may serve a PDF, text or markdown as well as HTML.
- **Following links** (optional, the form's "Links to follow" select): the body may carry
  `crawl: {depth}` (1–3). See § Following links.
- **Conversion**: text/markdown as is. Word: `mammoth` → HTML → `turndown` (+ `turndown-plugin-gfm`
  tables). HTML: narrowed to `<main>`/`<article>` when present; `script`/`style`/`nav`/`footer`/forms/
  embeds dropped; an image whose bytes are at hand (a Word file's `data:` image, a web page's image
  downloaded for the build) becomes a FIGURE (§ Figures), else `[Image: alt]` (never the base64); a
  link that is not http(s)/mailto/# keeps its text and loses its target.
  **PDF is not converted**: Claude reads it natively in the build (the Read tool, ≤ 20 pages a call).
  ⚠ **The three converters are NOT npm dependencies** of `limn-review`: they ride the AI runtime
  download (`AI_RUNTIME_PACKAGES`, pins in `limnAiRuntime`, loaded ONLY through `ai/runtime.ts`
  `loadMammoth`/`loadTurndown`/`loadTurndownGfm`; the build-release guard greps for them). A runtime
  installed before they existed is STALE, not absent (`AI_RUNTIME_LATER_PACKAGES`): every agent still
  runs, and only a Word or web-page build says "Set up AI again" ([PACKAGING.md](PACKAGING.md)).

## Following links (`crawl.ts`, `crawl-rank.ts`, `robots.ts`; migration `0124`)

"Add web page" with **Links to follow** set to 1, 2 or 3 levels stores `reference_docs.crawl_json`
(`ReferenceDocCrawl`: `depth`, `maxPages` = `REFERENCE_DOC_CRAWL_MAX_PAGES` (25), and — after a
successful build — the `pages` read and the links `skipped` by reason). "This page only" (the default)
sends no `crawl` and behaves exactly as before. A Rebuild crawls again at the stored depth.

**ONE DOCUMENT PER CRAWL, a chapter per page.** The crawl's pages are converted (`htmlToMarkdown`,
the same narrowing) and bundled (`bundleCrawlMarkdown`) into ONE markdown source: `# <page title>`,
`Source: <url>`, then the page's own headings pushed one level down. It is stored as the doc's `md`
source and built by the ordinary 'sections' pipeline, so the INDEX → CONTENTS → sections tree, its
validator and every link resolver are unchanged; the 200-documents-per-workspace cap stays meaningful
(one crawl is one entry in INDEX.md, not 25); and the contents tree groups by page, because a page's
chapter heading is the top of its trail. `MAX_SECTIONS` / `MAX_DOC_WORDS` still refuse a crawl too
long to split, in a sentence.

**The rules** (every one pinned in `crawl.test.ts`):

- **Same site only** — the start page's exact host and port. `www.` is NOT folded (it can be another
  server). An http link on an https site is upgraded; never https → http. Every request, robots.txt
  included, goes through `fetchPage` (§ Ingest's guard), so a redirect off the host is still refused.
- **Web pages only** — an address whose extension names a file (PDF, image, archive, feed, office
  file, script, font…) or a `/feed`/`/rss` path is dropped BEFORE any request; a fetched linked page
  must answer `text/html` or `application/xhtml+xml`, and is read under `CRAWL_PAGE_MAX_BYTES` (2 MB).
  A START page that is not HTML (a PDF, text) is read as one page, as without a crawl.
- **Each address once** — `normalizeUrl`: resolved (and `<base href>`), fragment dropped, tracking
  parameters (`utm_*`, `gclid`, `fbclid`, `ref`…) dropped, query sorted, scheme ignored, `index.html`
  and a trailing slash folded into the KEY (the fetched address keeps its slash). The address a
  redirect lands on and a page's same-site `<link rel="canonical">` join the visited set; two pages
  with the same text (sha256 of the readable text) are read once. ⚠ A canonical only stops a LATER
  read of that address — it never drops the page carrying it: misconfigured sites point every page's
  canonical at the home page, and dropping on it alone silently ended such a crawl at the start page.
  The text check decides what is a copy. The address a redirect lands on gets the link checks too
  (robots, traps, file-shaped addresses); a START page that redirected onto a disallowed path is
  refused. `mailto:`/`javascript:`/`tel:`,
  `rel="nofollow"` and `download` links are ignored.
- **Traps** (`looksLikeTrap`) — over 400 characters, over 12 path segments, a segment repeated three
  times, over 4 query parameters, pagination past 5 (`?page=`, `/page/N`), a calendar parameter, a
  dated path deeper than a day.
- **robots.txt** — read once per crawl (`robots.ts`, RFC 9309: the `limn` group beats `*`, longest
  match, Allow wins a tie, `*` and `$`). A 4xx, an HTML answer, a redirect off the host or an
  unreadable body means no rules; a **5xx, timeout or network failure means read nothing** (RFC 9309
  § 2.3.1.4 — `DISALLOW_ALL`; the crawl is refused in one sentence). The START page is checked too
  ("This site asks robots not to read that page."). ⚠ **Wildcards are matched by a LINEAR two-pointer
  glob (`robotsPatternMatches`), NEVER a RegExp**: robots.txt and the paths are both a stranger's, and
  `.*a.*a.*a.*b` against a 60-character path backtracked for 23 s on the event loop, where neither
  cancel nor the clock cap can reach. Runs of `*` fold to one; ≤ 2,000 rules, ≤ 512 characters each. Requests are spaced by its
  `Crawl-delay` (capped at 5 s), else 500 ms.
- **Every HTML scanner is LINEAR** (`crawl.ts`): a lazy `<a>[\s\S]*?</a>` over 70,000 UNCLOSED `<a>`
  blocked the server for 5 s, and a page may be 25 MB. Spans are found by a forward search from the
  open tag — an anchor's or heading's close within `SPAN_WINDOW` (8 KB; the next close of each tag is
  remembered, so the search only moves forward), script/style/comment drops with one forward pass —
  and attribute runs stop at the next `<`. Links are read off at most `CRAWL_LINK_SCAN_BYTES` (2 MB) of
  any page. `crawl.test.ts` § linear scanners pins each shape under a second.
- **Claude picks the links** — each level's candidate links (anchor text ≤ 120 chars, path, the
  heading above the link; main-content links first, then the rest of the page, since a docs site's
  sidebar is its map; ≤ 300 per page, ≤ 160 per level) go to `makeLinkRanker`: ONE Haiku 5.5
  `cheapComplete` per 80 links (tool-less, connectors isolated), the start page's title, address and
  first 1,500 characters as the topic, everything inside a per-call NONCE fence (page text and anchors
  are a stranger's). Scores 0–3; only `REFERENCE_DOC_CRAWL_MIN_SCORE` (2) and up are followed, highest
  first, document order on a tie. The answer is validated (unknown index / out-of-range score ignored,
  missing = 0); an unreadable answer is retried once, then its links count as low value. ⚠ **An
  unranked link is NEVER followed**: no runtime or credential stops the build with one sentence.
  Each call is recorded (`ai_usage` feature `docs_crawl_rank`, seam `summary`) and added to the
  document's `costUsd`.
- **Caps** — `depth` levels, 25 pages (start included), 3 minutes of wall clock, 25 MB of HTML in all;
  what was left is counted as `overCap`. ⚠ A level checks ALL of these BEFORE it ranks — a level that
  can read nothing must not pay for a ranking call whose every answer is then thrown away.

Progress: the converting stage reads "Crawling 6 of 25" (the SPA's bar shows the server's stage
words). Cancel aborts between requests and during the politeness wait.

## Wiki sources — Confluence and Notion (`wiki/`; migrations `0140`, `0143`)

A Confluence Cloud page — and, optionally, its child pages 1–3 levels down (the crawl's depth words,
reused) — becomes ONE document (`sourceKind: 'wiki'`, `doc.wiki`), the root and each child a chapter.
Pasting a Confluence (or Notion — § Notion) page address into "Add web page" switches the form to it ("Add Confluence page",
"With child pages, N levels"); shared `wikiProviderOfUrl` decides, through `parseConfluencePageUrl` — `/wiki/spaces/<K>/pages/<id>`,
`…/pages/edit-v2/<id>`, `viewpage.action?pageId=<id>`; https only; a short `/wiki/x/…` link names no id
and is refused. ≤ `REFERENCE_DOC_WIKI_MAX_PAGES` (100) pages, root included; the rest are counted
(`pagesLeftOut`).

**The seam.** `wiki/source.ts` `WikiSource` — `resolveRef(url)` (pure),
`getPage(site, id, {body})` (title, parent, version / last-edit time, body in the provider's format),
`listDescendants(site, root, depth, cap)` (ids, parents, depth, order; no bodies), `changedSince(site,
root, since, {known})` (may over-report, never under; `known` = the document's page ids, for a wiki whose
search is not scoped to a tree), `toMarkdown(page, {figures})` (images read NOW, § Figures), `checkAccess(site)`,
`pageUrl(site, id)`. Errors are `WikiSourceError` CODES (never the upstream body). Adapters register in
`wiki/register.ts`; `sync.ts`, `build.ts`, `refresh.ts` and the routes never name a provider (except the
credential ladder below and the provider union on the wire). `fake-wiki.ts` is the in-memory adapter the
tests use.

**Confluence** (`wiki/confluence.ts`): REST v2 `GET /wiki/api/v2/pages/{id}[?body-format=storage]`,
`…/pages/{id}/descendants?depth=&limit=250` (folders are transparent, whiteboards / databases and
non-`current` pages left out; a page's parent is its nearest PAGE ancestor), and the v1 CQL search
`ancestor = <root> AND type = page AND lastmodified > "<since − 1 day>"` with `expand=version` (CQL reads
the instant in the account's own zone, so it asks a day early and the VERSION compare decides). ⚠ Every
request goes through the tracker's guarded transport (`tracker/jira/fetch.ts`): https and PUBLIC
addresses only (the cloud policy, judged at connect time), NO redirects, 15 s, 8 MB, JSON only; a
listing's `next` link is followed only on the same site and API path. 429 → Retry-After waited (≤ 60 s
in all, cancellable), then `rate_limited` with the wait, stored as `retryAfter` (the background check
waits for it).

**Converting a page** (`wiki/confluence-storage.ts`): storage-format XHTML → plain HTML → the library's
ONE turndown pipeline (`htmlToMarkdown`). code / noformat → a fenced block (language kept); info / note /
tip / warning / panel (+ the new editor's `ac:adf-extension` panels) → a quote headed by its kind;
expand → its title in bold then its body; mermaid / PlantUML with a text source → a fenced block of it;
draw.io / Gliffy → the adapter's text for it (§ Figures: an outline of its file, else its PNG preview as a
figure), else — and always for Lucidchart or a diagram with no text — `[Diagram: name]` (`diagramPlaceholder`);
status / Jira → their words; toc / children / anchor and other navigation macros dropped; an unknown
macro → its rich-text body; `ac:link` → its text; `ac:image` → its figure marker, else `[Image: alt or file
name]` (an attachment of ANOTHER page keeps its name); task lists →
`[x]` / `[ ]`; table cells and list items unwrap their `<p>`. Bracketed words travel through turndown as
private-use sentinels so they are not escaped. ⚠ The body is a stranger's: ONE forward tokenizer pass,
quote-aware tag ends, an element stack capped at 256 (no quadratic close-tag matching), scripts dropped.

**Credentials** (`wiki/credentials.ts`, `workspace_wiki_credentials`; Settings → AI review →
**Confluence** / **Notion**): for Confluence, ONE ladder — the workspace's own Confluence credential when its site's host is the
page's host; else the workspace's JIRA credential when Jira is its tracker, the hosts match and an email
+ token are saved (Atlassian Cloud shares one API token); else none (`400 NoWikiCredential`, "Add a
Confluence API token in Settings"). HTTP Basic `email:apiToken`. ⚠ The token is SEALED exactly like a
tracker token (`tracker/secret.ts`), WRITE-ONLY (`hasToken`), never logged; a changed site drops a token
not re-sent; the export carries site + email only.

**Per-page records** (`reference_doc_wiki_pages`, `wiki/pages.ts`): one row per page (version, last edit,
sha256 of the converted markdown + title, last fetch, last error code), upserted on `(doc_id, page_id)`,
and each page's markdown cached at `sources/<slug>/pages/<pageId>.md`. ⚠ **Written ONLY by
`commitWikiPages`, after a successful build or a refresh that found nothing to rebuild** — a failed,
cancelled or budget-skipped refresh never advances a version, so the next check finds the same change.

**The incremental rebuild** (`manager.ts` + `sync.ts`):
1. **Read only what changed** (`syncWikiTree`): the root's metadata, the CQL search, then the BODY of only
   the pages whose version moved (or that are new, or have no cached file); the full id list only on the
   first build, once a day, or when the search names a page the stored tree does not know. Every other
   page comes from the cache. A child that is gone (404) leaves the tree; a child that fails otherwise
   keeps its last text (`lastError`); the ROOT failing stops the read.
2. **Stop if nothing moved**: every hash, title and place in the tree as stored ⇒ no rebuild and NO model
   call — the check is stamped and the document goes back to `ready`.
3. **Re-summarise only changed sections**: the bundle (`bundleWikiMarkdown`: a heading per page at its
   depth, `Source: <url>`, the page's headings below it — ⚠ always the adapter's `pageUrl`, so a fetched
   and a cached page bundle identically) is split as ever; each section's hash (title + trail + text,
   `sectionHash`) is looked up in `summary_cache_json`. Cached sections keep their summary; the agent's
   `expected` list is ONLY the new / changed files (`buildSectionsUpdatePrompt` lists the kept summaries,
   fenced, as context), and it still writes the whole document's summary. All cached + a cached
   document summary ⇒ no model at all. **Rebuild** (`full`) reads every page and summarises afresh.
4. **Swap in one rename** as every build; the last good version stays readable throughout.

**Refresh** (`wiki/refresh.ts`; ONE cheap check, `build.ts` `quickCheckWikiDoc`, reads no body):
- **the cadence** — an hourly job (`WIKI_REFRESH_CRON`) checks wiki documents not checked for 3 h, in
  workspaces whose library was USED in the last 7 days (`workspaces.docs_used_at`, stamped — throttled —
  by the docs list, tree, chat and every run that reads the library), past any `retryAfter`, ≤ 10 per
  tick, oldest first; "changed" queues a refresh build.
- **before use** — `reviewDocsFor` (Claude Review, the ticket review) and the story check kick a check of
  documents not checked in 15 min. It never waits: the run reads the current version.
- **Refresh now** — the document's button (`POST /api/docs/:id/refresh`).
- ⚠ The first two are AUTOMATIC: the build asks `automaticRunAllowed` (`review/budget-gate.ts`) right
  before a model call and is SKIPPED (back to `ready`, nothing committed), never queued, when over.
- ⚠ **Never delete on an error.** A root 404 / 403 / 401 / no credential / network / 429 is RECORDED on
  the row (`unreachableSince` — the first failure since the last good check — and the reason); the built
  version stays readable and the document line says "Can't reach this page in Confluence since <date>."
  A first build that cannot read the wiki fails with the sentence.

**On screen**: the document line reads "Confluence · N pages · M sections" (or "Notion · …", with its own
mark — `ConfluenceIcon` / `NotionIcon`), then "Checked 2 hours ago · last edited <date>" or the can't-reach
line, then the figures line (§ Figures); "Refresh now" beside Rebuild. The form's ⓘ explains the import,
the credential and the refresh. The address box is TEXT (`inputMode="url"`): a bare Notion id is accepted.

### Notion (`wiki/notion.ts`, `wiki/notion-blocks.ts`)

A Notion page — `notion.so` / `www.notion.so` / `notion.com` / `<name>.notion.site` addresses ending in the
32-hex id (dashes or not), a database row opened as `?p=<id>`, or a bare id (`parseNotionPageUrl`; a database
VIEW `?v=` names no page and is refused) — and its child pages 1–3 levels down, as ONE document.

- **Transport**: ONE fixed host, `api.notion.com`, through the tracker's guarded transport (https, public
  addresses at connect time, no redirects, 15 s, 8 MB, JSON only), `Authorization: Bearer <token>`,
  `Notion-Version: 2022-06-28` PINNED. ⚠ ONE process-wide limiter spaces every request
  `NOTION_MIN_INTERVAL_MS` (350 ms ≈ Notion's three a second); a 429 is waited out (Retry-After, ≤ 60 s in
  all, cancellable), then `rate_limited` with the wait. A 404 means "no such page OR not shared with the
  integration" — the sentence says both.
- **A page** (`GET /v1/pages/{id}`): the title is the ONE property whose type is `title`; `last_edited_time`
  is the change marker (`version` is null); a page in the trash reads as gone (`not_found`).
- **The body** (`readBlockTree`): `GET /v1/blocks/{id}/children`, paginated, recursing into every block with
  children — bounded by `NOTION_MAX_BLOCKS` (5,000), `NOTION_MAX_BLOCK_REQUESTS` (250) and depth 8. A synced
  block reads its ORIGINAL's children (one visit each; an original the integration may not read keeps
  nothing). `child_page` / `child_database` are NEVER entered: they are chapters. The body is stored as
  JSON (`{v:1, blocks}`), the provider's own format.
- **The tree** (`listDescendants`): the same block walk per page, collecting `child_page` blocks ANYWHERE in
  it (columns, toggles, lists) and the rows of each `child_database` (`POST /v1/databases/{id}/query`, ≤ 100,
  trashed rows left out) — a database is transparent, like a Confluence folder: its rows are the containing
  page's children. Reading order; the cap applies in that order. (It reads each page's blocks, so a daily
  list costs about what a full read does — at three requests a second.)
- **Changes** (`changedSince`): Notion has no ancestor query, so `POST /v1/search` — pages, sorted by
  `last_edited_time` descending, 100 a page — is read until a page older than `since − 2 min`. Kept: the
  document's own pages (`known`) and NEW pages whose parent is one of them; the rest of the workspace is
  ignored. ⚠ An edit to a child page bumps only ITS time (never the parent's), which is why the stored
  per-page records are compared one by one. ⚠ `last_edited_time` is rounded to the MINUTE, so every hit is
  reported `NOTION_EDIT_FUZZ_MS` (60 s) later: an edit in the same minute as the last read still reads as
  newer (an unchanged page read again costs a request, never a model call — its hash does not move). ⚠ Past
  `NOTION_MAX_SEARCH_REQUESTS` (30) pages of results without reaching `since`, EVERY known page is
  reported: over, never under. A new row in a child DATABASE is found by the daily list only. The root is in
  `known`, so the search can name it too (`syncWikiTree` then reads the root again).
- **Converting** (`notionBlocksToMarkdown`, pure): headings; paragraphs with bold / italic / strikethrough /
  code and http(s)/mailto links; bulleted, numbered (running number) and to-do (`[x]` / `[ ]`) lists, nested
  by indentation; a toggle → its summary in bold, then its contents (a toggleable heading stays a heading);
  quote / callout (its emoji kept) → a quote; code → a fenced block with its language — **`mermaid` /
  `plantuml` stay fenced: the source IS the diagram**; table → a GitHub table (first row as header, `|`
  escaped); divider; equation → a fenced `math` block; bookmark / embed / link preview → a link; image → its
  figure marker or `[Image: caption or file name]`; file / pdf / video / audio → `[File: name]` (a
  Notion-hosted address expires, so only an EXTERNAL one links); column list / column / synced block → their
  contents; child page / database / link-to-page / table of contents / breadcrumb / template / unsupported →
  nothing. ⚠ Every string is a stranger's: text is ESCAPED so it cannot become a link, a heading or a figure
  marker.
- **Credentials**: ONE rung — the workspace's own Notion row (provider `notion`, token only; no site, no
  email). The token must match `NOTION_TOKEN_RE` (`ntn_…`, issued since September 2024, or the older
  `secret_…`, then 20+ letters and digits), so a pasted page address never becomes the stored token. Sealed
  and write-only exactly like Confluence's. The integration must be SHARED with the pages in Notion (the
  settings' ⓘ says how). "Test connection" (`POST …/wiki-credentials/check {provider: 'notion'}`) reads
  `GET /v1/users/me`.
- **The page address** in a chapter's `Source:` line is `https://www.notion.so/<id without dashes>`.

## Figures — images and diagrams as text (`figures.ts`, `figure-describer.ts`, `diagram-outline.ts`, `figure-fetch.ts`; migration `0143`)

Every source's images and diagrams become WORDS, in this order of preference:

1. **Their own source, no model.** A Mermaid / PlantUML block (a Confluence macro, a Notion code block, a
   markdown fence) stays a fenced block. A Confluence **draw.io** or **Gliffy** diagram whose file can be read
   (an attachment named after the diagram: `name`, `name.drawio`, `name.xml` for draw.io; `name` for Gliffy)
   becomes a DETERMINISTIC outline (`drawioOutline` / `gliffyOutline`): `[Diagram outline from its draw.io
   source: Name]`, then `- Shapes: A; B; C` and one `- A → B: label` per connector (labels drawn on a
   connector join it; compressed draw.io pages are inflated, capped at 5 MB; HTML labels are flattened). The
   same file always gives the same text, so an unchanged diagram never changes a section's hash. A diagram
   whose file does not read falls back to its PNG preview (`name.png`) as a figure, then to `[Diagram: name]`.
2. **A description by Claude's vision**, one call per image (below).
3. **Its name**: `[Image: alt]` / `[Diagram: name]` — icons, unsupported formats (SVG, …), past the cap, on
   Codex, with no Claude sign-in.

**At ingest** (the converters and the wiki adapters) an image's bytes go to a `FigureSink`
(`folderFigureSink`, the document's `sources/<slug>/figures/<sha256>`), which answers a MARKER for the text:
`[[limn-figure:<sha256>:<fallback>]]`. It answers null — the caller writes the name — for anything that is not
PNG / JPEG / GIF / WebP (`imageInfo`, from the header), under `REFERENCE_DOC_FIGURE_MIN_BYTES` (2 KB) or
`REFERENCE_DOC_FIGURE_MIN_PIXELS` (48 px) on a side (icons), or over `REFERENCE_DOC_FIGURE_MAX_BYTES` (5 MB). The
same image twice is ONE file and one figure. A build downloads at most `FIGURE_MAX_FETCHES_PER_BUILD` (60)
files. Where the bytes come from:

- **Word**: mammoth's inline `data:` images. **An uploaded HTML file**: its `data:` images (a relative `src`
  has nowhere to come from).
- **A web page (and each crawled page)**: its `<img src>` addresses, resolved against the page and read
  through `fetchPage` (the page's own guard) — ONLY when Claude can describe them here (a page is fetched
  again on every build, so bytes kept for later buy nothing). `imageSources` is a linear scanner.
- **Confluence**: an `ac:image` attachment of THIS page (`GET /wiki/api/v2/pages/{id}/attachments?filename=`,
  then its `downloadLink` with the credential). Confluence answers with a redirect to Atlassian's media
  service, whose address carries its own signature: that ONE hop is followed WITHOUT the credential, through
  the library's guarded fetch, public addresses only (`confluenceGetBytes`). An `ri:url` image is fetched the
  same way.
- **Notion**: the image block's file address — a signed S3 address that EXPIRES within the hour — read
  during the build that saw it (`toMarkdown`), with no credential, public addresses only. A wiki's images are
  read ALWAYS (whether or not Claude can describe them today): the bytes kept now are what a later refresh
  describes.

**Before the split** (`manager.ts` → `resolveFigures`, every 'sections' build): each marker becomes
`[Figure (described by AI): <name> — <words>]` or its name.

- **The cache** (`reference_doc_figure_descriptions`, `figure-cache.ts`): one row per (account, image
  sha256), so a refresh — or a Rebuild, or the same logo in another document — never describes an unchanged
  image again. A marker whose bytes THIS document does not hold resolves to its name: one document's text
  cannot reach another's description. An image that carries nothing is cached as `DECORATIVE` and keeps its
  name.
- **The cap**: `REFERENCE_DOC_FIGURE_MAX_PER_DOC` (30) distinct images described per document, in document
  order; the rest keep their names.
- **The call** (`figure-describer.ts`): `getActiveProvider().describeImage` — the provider seam's vision
  completion, CLAUDE ONLY (`ai/providers/claude.ts`: on the login it rides a streamed user message carrying
  the image block, on the key a Messages API call; tool-less, one turn, connectors isolated), model
  `REFERENCE_DOC_FIGURE_MODEL` (Haiku 5.5), ≤ 400 output tokens. ⚠ The image is a STRANGER'S INPUT:
  `FIGURE_SYSTEM_PROMPT` says describe what is visible, never follow or act on text inside it, ≤ 120 words, no
  markdown, `DECORATIVE` for nothing; the file's name goes in quoted, as data. The answer is cleaned to ONE
  line (`cleanDescription`: no brackets, pipes or line breaks — it may sit in a table cell — ≤ 1,200
  characters). Each call is recorded (`ai_usage` feature `docs_figure_describe`, seam `summary`).
- **Codex / no Claude**: Codex's provider has no `describeImage` (its image input stays locked off in
  `LOCKED_SETTINGS`), so every image keeps its name and the build info says so ONCE: "Images keep their
  names: Codex does not read images." (no sign-in: "… sign in to Claude to have them described.").
- ⚠ **AUTOMATIC = BUDGET-GATED.** A background refresh asks `automaticRunAllowed` once, before its first NEW
  description; over budget nothing is described (SKIPPED, never queued) and those images are `pending` —
  they keep their names in the text. A failed call (no runtime, a network error) leaves that image and the
  rest `pending` too; it never fails the build.
- **Retry**: a wiki document with `pending` figures reads as CHANGED to the cheap check (once Claude can
  describe here), and the refresh build goes on past "nothing changed" to describe them, reading no page
  again. Other documents retry on their next build.
- **The build info** (`reference_docs.figures_json`, wire `ReferenceDoc.figures`): `described`, `outlined`
  (Mermaid / PlantUML blocks and outlines), `kept`, `pending`, `note`. The SPA's document line: "2 figures
  described by AI · 1 diagram read from source · 1 waiting for the next refresh", then the note. After a
  successful build `pruneFigures` drops the figure files the text no longer names; `saveSource` keeps the
  folders beside a source file (`figures/`, a wiki's `pages/`).
- ⚠ **NEVER GROUNDING.** A description is the MODEL'S words about an image. Every quote check — a review's
  references (`validateDocReferences`), the story-docs check (`review/story-docs/validate.ts`) and a chat
  citation (`chat-quotes.ts`) — runs over `groundingTextOf` = the section body with every
  `[Figure (described by AI): …]` span CUT OUT (shared `withoutFigureDescriptions`, leaving a gap no quote
  can bridge). A quote only the description holds is dropped.
- PDFs are not touched: Claude reads a PDF's pages, pictures included, itself.
- Not done: Lucidchart (no source to read); an uploaded HTML file's relative images; a wiki document whose
  images were kept as names while Claude could not run here gets them described at its next rebuild or
  change, not by the cheap check (they are `kept`, not `pending`).

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
Claude credential.

**Failure keeps the old version.** `built_at` non-null = a built version is on disk (`available` on the
wire) and listed in INDEX.md; a rebuild that fails or is cancelled leaves it there. A build of a
document deleted mid-run puts nothing on disk. Boot (`startup.ts`): interrupted builds → `failed`
("Interrupted by a restart. Press Rebuild."), then the one-time move out of the old shared root, then
the janitor removes every staging folder and any library/source folder no row accounts for — in the
workspace folders whose `.owner` is this database only (§ Ownership). A deleted workspace's folder is
removed by the delete route (its rows go with the workspace cascade); erasure removes
`<docsDir>/<accountId>/` after the rows, skipping a workspace folder another database owns.

**On Codex** (`LIMN_AI_PROVIDER=codex`, kind `docs_build`; docs/CODEX-PLAN.md § Phase 3 stream (d)).
A `'sections'` build runs through the same `runAgent`, reading the staging folder through Limn's
workspace server (read-only, the same folder the path guard allows). Codex has no tools of Limn's own,
so `record_sections` and `finish_document` arrive as ONE final answer, `submit_document` (the two shapes
side by side), judged by the SAME `judgeRecord` then `judgeFinish`. Codex gets two answers (its one
retry), so its retry is the build's LAST finish attempt (`finishAttempts` starts at
`MAX_FINISH_ATTEMPTS - 2`). ⚠ A PDF REFUSES on Codex before anything is written or run
(`CODEX_PDF_MESSAGE`): its pages are read through Claude's own `Read`, and Limn's `read_file` shows no
binary file. The "Summarising sections (n of m)" count moves only when the answer arrives. Codex writes
its own ledger row (`usageRecord`, provider `codex`), so the manager records none for it.

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

**A citation's quote** (`chat-quotes.ts`, no migration — inside the stored `citations` JSON, optional
`quote` on `ReferenceDocCitation`). The prompt asks for the exact words in quotation marks beside each
link, and real answers already did (`*"…"* ([Section](slug/sections/…#a))`, or a `> "…"` blockquote
above the line). For each SECTION link the server takes candidates nearest first — quoted spans on the
link's line, then its paragraph, then the paragraph itself if it is a blockquote, then a blockquote just
before or after (≤ 8, clipped to `REVIEW_DOC_QUOTE_MAX_CHARS`) — and keeps the FIRST that has
`REVIEW_DOC_QUOTE_MIN_CHARS` letters and passes the SAME check a review's quote passes
(`quoteAppearsIn` over `sectionBodyOf`, so header words never count). ⚠ An unchecked quote is DROPPED,
never stored: the link opens at its anchor. Citations stay de-duplicated on `path#anchor`; the first
verified quote wins and a later link to the same place fills in one that had none, so an inline link in
the answer looks its quote up by `path#anchor`. Every scan is indexOf / a character walk (model output
is untrusted). Rows stored before this have no quote and read unchanged (`chatCitationsFromStored`).
Spend: `DOCS_CHAT_BUDGET_USD` (1), `DOCS_CHAT_MAX_TURNS` (30), feature `reference_docs_chat`.
On Codex (kind `docs_chat`) the chat has no result tool: Codex's final message is the answer, the
library is its one read-only root, and the citations and quotes are checked exactly as above.

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
documents" opens INDEX.md — the tree is COLLAPSED: only its top-level chapters show at first, each row
with rows under it has its own disclosure button with `aria-expanded`, and two icon buttons above it,
"Expand all" / "Collapse all" (`ExpandAllIcon` / `CollapseAllIcon`), open or fold every branch;
the nesting is `docTreeNodes(docTreeRows(…))` in `lib/referenceDocs.ts`, the open set local to the
mount), a viewer that shows one library file at a time with every link followed
in-app, and the chat (beside the viewer when wide, a Read / Ask tab when narrow). Adding: drag and
drop or a file picker (PDF, .docx, .txt, .md, HTML), or "Add web page" with a "Links to follow"
select (This page only / 1–3 levels; its ⓘ explains the crawl). A crawled document's line reads
"Web page · N pages · M sections". A building document shows a progress bar with the server's stage
words ("Crawling 6 of 25", "Summarising sections (3 of 12)") from its SSE stream
(only while the server is working on it — a queued row is polled, at most 2 streams open), the list
polled as the fallback; a failed one shows its error and "Try again". Remove confirms inline. The
Settings switch is "Use reference docs in Claude Review" (draft + Save, off by default). Detail and the
landmines: [FRONTEND.md](FRONTEND.md) § Activity → Docs.

**The quote highlight.** Every link that carries a server-checked quote — a review reference, a ticket
review reference, a Story "Check against docs" point, a chat citation (above), and a finding's citation
that BORROWS one — opens the section scrolled to that passage, highlighted, with ONE line above the page
("The quoted passage is highlighted." + a clear button). When the words are no longer there (the
document was rebuilt since), the line reads "The quoted words are no longer in this section." and the
view lands on the anchor. ⚠ A browser without the CSS Custom Highlight API still scrolls to the passage
but the line reads "Scrolled to the quoted passage." — it never claims a highlight nothing painted
(`quoteStripText`). ⚠ **The header skip is the SERVER's**: the viewer leaves off the H1 and exactly ONE
blockquote after it (`sectionHeaderEnd`, the crumbs-and-nav lines `sectionBodyOf` drops), so a body that
opens with its own blockquote is still searched. ⚠ **ONE FOLD**: the quote fold lives in shared `reference-docs-quote.ts` —
`foldForQuote` / `quoteAppearsIn` for the server's check over MARKDOWN, and `foldRenderedText`, its
mapped twin over the RENDERED text (same character rules; markdown-syntax steps only on the markdown
side; a block or table-cell boundary folds to one space, so a "High | 1.15" table-row quote matches
across `<td>`s). Change a character rule in one and you change it in the other, or a checked passage
stops highlighting (a test pins them equal on plain text). ⚠ **A finding borrows** the quote of the same
run's reference to the same section (and the same anchor when both name one) ONLY when exactly one
passage matches (`borrowedQuote`); else it opens at its anchor.

## Storage (migration 0116)

`reference_docs` (unique `(account_id, workspace_id, slug)`; named composite FK onto
`workspaces (id, account_id)`) and `reference_doc_chat_messages` (index `(account_id, workspace_id,
conversation_id)`; same FK), plus `workspaces.docs_in_review`. Both tables are in
`accountScopedTables()`, erased (files too), exported (metadata + chat; the text is the user's own
upload), and checked by `verify:isolation`. `reference_docs.crawl_json` (migration `0124`,
nullable JSON) is a column on the same row, so it needed no new erasure or isolation entry.
`instance_meta` (migration `0139`, key → value, NOT account-scoped, never erased) holds the
database's `instance_id`, the `.owner` marker's value. [MIGRATIONS.md](MIGRATIONS.md).

## Use in reviews (`review-refs.ts`; migration `0117`)

Two agentic runs read the library when the workspace's switch (`docs_in_review`) is ON and a document is
built — `reviewDocsFor(accountId, workspaceId)` (context.ts) returns the folder exactly when
`docsContextFor(…).usable`, and null on ANY error (the library is optional context; it never fails a run):

| Run | Where | What it is asked | Where the references are stored |
|---|---|---|---|
| Claude Review | `claude-review/manager.ts` → `review/agent.ts` | check the change against the rules and requirements the library documents (and the story the PR names); a finding that rests on the library carries its section links in `docRefs` | `claude_reviews.doc_references`; a finding's checked links in `claude_review_findings.doc_citations` |
| Ticket review (Story check) | `ticket-review/manager.ts` → `ticket-review/agent.ts` | per story: the passages that bear on it, every CONTRADICTION between the story / criteria / code and the library, and support where the library backs it | `ticket_reviews.assessment.references` (inside the existing JSON) |
| ~~This Sprint's "Check against code"~~ | REMOVED 2026-10-18 | — | old rows keep `sprint_assessments.body_json.references` (dormant table) |

**Not** the sprint brief, the themes or the sprint builder: the brief and themes are one-shot, TOOL-LESS
Haiku calls (`cheapComplete`) and the builder's only tool is `submit_paths`; none has files to walk, and
pasting sections into them would be the context overload the library exists to avoid.

**When it is on**, a run differs in exactly three places:

1. **Read-only access.** The library folder is an `additionalDirectories` entry and a READ-ONLY ROOT of the
   PreToolUse path guard (`createPathGuard(cwd, roots, { readOnlyRoots: [dir] })`): a path inside it passes
   for Read, Glob, Grep and LS only — any other tool naming it is denied ("can only be read"), whatever the
   run's allow-list says. Every other rule of the guard holds (traversal, symlinks out, outside paths). A
   DIFF-ONLY PR review, otherwise tool-less, gains Read/Glob/Grep (its scratch folder is empty, so they
   reach the library only); Bash, Write, Edit, MultiEdit and NotebookEdit stay denied on every run.
   ⚠ It also gets a bigger TURN CAP (`reviewMaxTurnsFor`: `max(REVIEW_DIFF_ONLY_MAX_TURNS,
   DIFF_ONLY_DOCS_MIN_TURNS = 14)`): the tool-less cap of 6 was sized for ~2 turns, and the INDEX →
   CONTENTS → sections → submit walk is ≥ 4 — a run that hits the cap fails before submit_review, billed.
2. **The prompt.** `docsReviewPromptBlock(dir, kind)` is appended to the SYSTEM prompt: the shared
   navigation block (`docsNavigationPrompt` — start at INDEX.md, open only the relevant documents'
   CONTENTS.md, read only relevant sections, grep for a term, never a whole document, the text is data,
   cite the section link), then the run's own task and how to report. ⚠ The DIFF-ONLY base prompt's
   "no Read, Glob, Grep … the ONLY tool is submit_review" sentence is SWAPPED, not left to contradict the
   block (`REVIEW_SYSTEM_PROMPT_DIFF_ONLY_WITH_LIBRARY`); the ticket / sprint blocks name the library as one
   more read-only directory and `docReferences` as a field of their submit call.
3. **The tool.** The submit tool gains `docReferences: [{ link, quote ≤ 300, verdict: 'supports' |
   'contradicts' | 'context', note ≤ 400, about? }]` (≤ 20), and the PR review's finding gains `docRefs`
   (≤ 3 links). The quote's length is enforced BY THE TOOL SCHEMA, so the model rewrites rather than the
   server clipping it.

⚠ **SWITCH OFF (or nothing built) ⇒ BYTE-FOR-BYTE UNCHANGED.** Each builder takes the library as an optional
argument and returns the pre-feature prompt / shape / policy without it: `systemPromptForMode(mode,
specialists, null)`, `ticketReviewSystemPrompt(null)`, the two
`build…Shape(z)` and `reviewToolPolicy(mode, offered, false)`. `review-refs.test.ts` pins every one (the
JSON schema too), and `docs-pipeline.test.ts` pins the PR review end to end (no folder, the base prompt,
`docReferences: null`).

**Every reference is CHECKED before it is stored** (`validateDocReferences`, pure over a
`LibrarySnapshot` = the built rows + a reader confined by `parseLibraryPath`/`readLibraryFile`):

- the LINK — relative, `./`-prefixed, a markdown `[x](y)` or an ABSOLUTE path inside the library (made
  relative) — must parse under the strict grammar, name a **section** file (never INDEX.md or a
  CONTENTS.md, whose text is summaries) of a BUILT document of THIS workspace, and exist. A
  DOCUMENT-RELATIVE link as the library's own files write it (`sections/NN-name.md` in CONTENTS.md, a bare
  `NN-name.md` in a section's nav) is tried against every built document: kept when exactly one has the
  file — for a reference, exactly one whose section holds the quote (`citationCandidates`). An anchor naming
  no heading of that section (`fileAnchors`) is dropped; the link is kept.
- the QUOTE (≥ 12 letters/digits, ≤ 300 characters) must appear in that section's TEXT — the server-written
  header (mark, title, crumbs, nav) is left off first, so "Previous · Contents · Next" matches nothing.
  Both sides are folded (`foldForQuote`: NFKC, markdown emphasis/escapes/link targets, typographic quotes
  and dashes, list/quote/table markers, whitespace, case); "…" or "..." may skip words, the pieces in order.
- anything else is DROPPED and counted (logged), never shown. Duplicates collapse; contradictions sort first.
- each kept reference / citation is stamped with the `workspaceId` of the library it was checked against
  (optional on the wire; absent on chat citations and pre-field rows). The SPA links THAT library —
  switching workspace if needed — never the reader's selected one; a row without it shows a plain label.

A finding's `docRefs` go through the same link check (`validateDocCitations`, no quote). A docs run that
kept nothing stores `[]` ("looked, found nothing" — the PR tab says "Nothing in the library bears on this
change."); a run without the library stores NULL and the tab shows no section. The references are NOT in
any fingerprint: a library edit does not make a review stale.

**On screen** (`components/DocReferences.tsx`): the Claude Review tab's **Reference docs** section (after
SonarCloud; verdict counts in the header, the explanation behind ⓘ), a finding's "Reference: Document ›
Section" line, and a compact block in Story check (the whole story; this PR's share lists only the references whose
`about` names one of ITS criteria / missing items, `shareDocReferences`) and in This
Sprint's Code check. Every link opens the section in Activity → Docs — a click in-app
(`store/openDocs.ts`), the href a deep link for a new tab:
`/app/?workspace=<id>&activityRepo=docs&doc=<slug>&section=<NN-name.md>[&anchor=<a>][&quote=<words>]`
(`lib/docReferences.ts`; the URL hydrate seats it, the pane opens it once and expands that document; the
serializer never emits those keys). The quote and note render as PLAIN TEXT, and the quote drives the
viewer's highlight (§ The SPA → The quote highlight).

Not done: posting references to GitHub (a library link means nothing there), and folding the library into
the sprint brief / story passes (above).

## Check a story against the docs (`review/story-docs/`; migration `0121`)

A per-story button in the Story section (Open PRs ticket stack and the story view). MANUAL ONLY — never
automatic, never on view. `registerAgenticRoutes` registers the two routes (docs/API.md
§ Check a story against the docs). Contract: `packages/shared/src/story-docs-alignment.ts`.

- **The gate** is `docCount > 0` (a built document in THIS workspace) + agentic AI on. It IGNORES the
  `docs_in_review` switch (that switch is about reviews; the click is the consent) — so it does NOT use
  `docsContextFor(...).usable`.
- **The inputs** are the Story section's (`inputs.ts`): criteria = the latest succeeded ticket review's
  (array order = AC1…, an empty list still wins), else the CURRENT sprint brief's numbered ones, else
  `derived` (Claude works up to 12 out of the description, stored with the run). Text = the tracker's stored
  story (`jiraStoryFor`), else the review's ticket snapshot, else the sprint read's text. No criteria and no
  description / acceptance-criteria text ⇒ `no_story`. DB + disk only.
- **Step 1, the shortlist** (`shortlist.ts`). ⚠ **SKIPPED when the whole library fits**: when every built
  section's text (the body, header left off) totals ≤ `STORY_DOCS_INLINE_CHARS` (48 000 chars),
  `wholeLibraryShortlist` makes EVERY section the shortlist (reason `''`, each checked by `citationOf`; a
  listed section missing from disk ⇒ shortlist instead) — no Haiku call, no `story_docs_shortlist` usage, the
  row's `shortlist_model` NULL. Otherwise:
  - **The prefilter** (`prefilterSections`, pure, deterministic): BM25 (k1 1.2, b 0.75) of the story's and
    criteria's terms (lower-cased, ≥ 3 letters, stopwords out, a plural folded) against each section's title
    (×2), trail, merged headings, one-line summary and document title (the stored `sections`, not
    CONTENTS.md). Only sections sharing a term score; ties by path. The top `STORY_DOCS_PREFILTER_MAX` (30) are
    the CANDIDATES.
  - **Haiku 5.5** (one `cheapComplete`, one retry on an unparseable answer — including a non-empty list of
    which no entry survives the check): the fenced story + the fenced candidate lines (`link — doc › section:
    summary`) → ≤ 8 section links. ⚠ When NOTHING scores (no shared term), it falls back to the old prompt:
    INDEX.md + each built document's CONTENTS.md (≤ 60 000 chars; the rest listed by section title) — never a
    pick from a zero score. Every entry is checked (`citationOf` → strict grammar, a section of a BUILT
    document, listed in its stored sections, on disk) or dropped. Only a genuinely EMPTY `sections: []` ends
    the run `no_relevant_docs` with NO second call; a list that drops to nothing retries, then fails ("Claude
    could not pick the sections to read.") — never a false "nothing bears on it". (A skipped shortlist cannot
    end `no_relevant_docs`; a library where nothing bears ends `nothing_grounded` or with few points.)
- **Step 2, the read** (`agent.ts`, Sonnet 5): ⚠ **THE SECTIONS' TEXT IS IN THE PROMPT**
  (`prompts.ts` `inlineSections`): each shortlisted section's body in its own `SECTION <link>` nonce fence,
  every body in the nonce-collision scan (`storyDocsUntrustedTexts`). ≤ `STORY_DOCS_INLINE_CHARS` in all: past
  that, a FAIR SHARE (short sections whole, the long ones clipped to an equal share of what is left, each ending
  `[…cut]`). So the read is ONE answer: ≤ 4 turns (`storyDocsTurnCap`: the submit, a refusal's retry, the
  closing turn), ≤ 8 when a section was cut (the prompt then lists the shortlisted folders and says to Read a
  cut file only when its missing part matters); never above `STORY_DOCS_ALIGNMENT_MAX_TURNS` (16);
  `STORY_DOCS_ALIGNMENT_BUDGET_USD` $1.50. ⚠ **Effort**: both providers run it at `low` (`STORY_DOCS_EFFORT`,
  `spec.claude.effort` / `spec.codex.effort`) — reading comprehension over text it already has. Settings → AI → Effort does NOT reach
  it (ai/effort.ts: that setting governs only the review, AI Fix and Plan first; every other kind runs a fixed
  depth), so this is that fixed depth. Tools are unchanged:
  Read/Glob/Grep + `submit_alignment`; Bash, every write tool, the web and dispatch denied. ⚠ **The path
  guard's ONLY read-only roots are the SHORTLISTED documents' folders** (`storyDocsRoots`) — never the library
  folder, so INDEX.md and every other document are unreachable. The working directory is an empty scratch dir.
  The inlined text is NOT trusted for grounding: validate.ts re-reads every cited section from disk.
- **Grounding = DROP** (`validate.ts`): every reference goes through `validateDocReferences` against the
  library snapshot FILTERED to the shortlisted documents; a criterion note, story point or action left with no
  checked reference is discarded. The tool refuses SHAPE only (verdicts, a 2-3 sentence summary, 2-6
  actions, criterion numbers, every item has a reference, no quote under `REVIEW_DOC_QUOTE_MIN_CHARS` letters —
  the grounding minimum, also stated in the prompt and the tool schema), ≤ 3 attempts; a quote that does not check out is
  never sent back, so it cannot loop. At storage only an unusable overall fails the run; a malformed item is
  dropped. Nothing survives ⇒ `nothing_grounded` (no overall summary is stored or shown).
- **Currency** (`fingerprint.ts`): `story_hash` / `criteria_hash` / `library_hash` (built docs'
  slug:builtAt:sectionCount — a rebuild moves `builtAt`, so changed section text always moves it) / version.
  The GET recomputes the live ones per read and reports `current` + `staleBecause`. A click re-resolves the
  inputs at start ("check what is there now").
- **Reuse** (`routes.ts`, `currentStoryDocsFingerprint`): the stored `fingerprint` hashes version + workspace +
  ident + the three hashes + BOTH models (Haiku's id, the read's model on the provider) + the provider. A POST
  without `force` whose fingerprint equals the newest SUCCEEDED run's (same `version`) answers
  `{outcome:'reused', runId}` — no row, no model call, not counted against the cap; the SPA keeps drawing that
  run and says "Nothing has changed since this check." with "Check again anyway" (`force: true`). A field that
  changes the answer and is missing from the fingerprint would serve a stale answer as current — add it there.
- **Storage**: `story_docs_alignments`, ONE ROW PER RUN — a re-run never rewrites the good row, and the GET
  returns `lastSucceeded` beside a newer failed or in-flight run. Composite FK onto `workspaces`; a deleted
  workspace takes its runs with it (their links name THAT library — never re-homed to Default). In
  `accountScopedTables()`, erased, checked by `verify:isolation`.
- **The queue** (`manager.ts`): one claim per (account, workspace, ident), one FIFO lane (≤ 10 waiting ⇒ 409),
  the shared review slot as a PEER (a PR-review click goes first). Per-account daily cap
  `STORY_DOCS_ALIGNMENT_DAILY_CAP` (30, every row counts — every row is a click); a POST for a story already
  held answers `already_running` with its id BEFORE the cap or any preflight. A wall-clock
  `STORY_DOCS_TIMEOUT_MS` (10 min) aborts a wedged run ("Claude took too long. Run it again."), freeing the
  claim and the slot. A restart fails every
  in-flight run ("Stopped when Limn restarted. Run it again."). Usage: `story_docs_shortlist` (seam
  `summary`) + `story_docs_alignment` (seam `agent`); the row's `cost_usd` is both.

## Tests

`split.test.ts` (structure, merge scope, caps, atomic blocks, oversize cuts, limits) · `render.test.ts`
(INDEX determinism, folder validation, PDF assembly) · `paths.test.ts` (traversal refused) ·
`url-fetch.test.ts` (the guard, redirects) · `crawl.test.ts` (the normaliser, file and trap filters,
link extraction, robots.txt, same site, depth and page caps, redirect / canonical / same-text
duplicates, non-HTML and failing pages skipped, cancel, the ranking fence + validation + retry with a
fake model, the bundle) · `convert.test.ts` (sniffing, HTML conversion) ·
`build-judge.test.ts` · `agent-policy.test.ts` (no shell, the write guard) · `reference-docs-db.test.ts`
(upload → build → the three levels with a FAKE agent, path + tenancy refusals, the chat's citations,
remove, erasure deletes files) · `chat-quotes.test.ts` (a chat citation's quote: candidates, the check,
header and too-short quotes dropped, first verified wins, the stored re-read, the two folds agree) · `review-refs.test.ts` (the reference check — a quote not in its section,
a link outside the library, header-only quotes, anchors; the OFF ⇒ unchanged pins) ·
`wiki/confluence-storage.test.ts` (a recorded storage body with every macro shape; the tokenizer on
100k unclosed tags) · `wiki/confluence.test.ts` (recorded REST answers through a fake transport: address
parsing, page / tree / CQL reads, pagination on-site only, folder-transparent order, auth header, 429 +
Retry-After, status codes, private / http refused; an image attachment through the media redirect WITHOUT
the credential, a draw.io file as an outline) · `wiki/notion.test.ts` (recorded answers,
`__fixtures__/notion/api.json`: address shapes and the token shape, the headers and fixed host, status codes,
429 + Retry-After, the limiter, the page / trash, the block walk — pagination, nested lists, toggles,
mermaid, tables, synced blocks, callouts, escaping, child pages not entered — the tree with child pages in
columns and database rows, the change search: scoped, stops past `since`, child-page edits and new
children, the minute's lateness, the cap's over-report) · `figures.test.ts` (the raster sniff and icon /
size filters, dedupe, the marker resolution: cache hit = no call, one call per image, the cap, Codex / no
Claude = names + one sentence, the budget gate = pending, a failed call = pending, decorative; the cleaning;
the grounding cut; draw.io plain + compressed and Gliffy outlines; the HTML / Confluence converters' hooks)
· `wiki/notion-figures-db.test.ts` (end to end over a scratch DB with an in-memory Notion: token shape and
write-only, the check, import with a described figure, a refresh describes nothing again, a failed
description retried by the cheap check, the budget skip, Codex, erasure of the cache) ·
`review/story-docs/validate.test.ts` (a quote only a figure description holds is dropped) · `wiki/sync.test.ts` (the cheap check reads no body;
child / root edits, the daily list; only changed pages read; a same-text bump changes nothing; child and
root failures) · `wiki/wiki-db.test.ts` (end to end over a scratch DB with an in-memory wiki and a fake
agent: credentials incl. Jira reuse and write-only token, import, refresh with nothing changed = no
model call, one page changed = only its sections summarised, the budget skip commits nothing, a gone
root keeps the last version, the cadence's 7-day gate, tenancy, delete and erasure) ·
`review/path-guard.test.ts` (read-only roots) · `review/claude-review/docs-pipeline.test.ts` (on/off
end to end) · `review/story-docs/` — `shortlist.test.ts` (bad / unbuilt / unlisted sections dropped, the
retry, the CONTENTS budget), `validate.test.ts` (shape refused, ungrounded and out-of-range items dropped,
`nothing_grounded`), `agent-policy.test.ts` (no shell or write tool; roots = the shortlisted documents only;
the prompt's folders only when a section was cut; the turn cap), `inline.test.ts` (the skip-shortlist rule,
the prefilter, the candidate prompt, the inlined text: fair-share clip, the SECTION fence, the nonce scan),
`inputs.test.ts` (the criteria and text order), `routes-db.test.ts` (refusals, a run end to end with fake
models — whole library inlined, no shortlist call — `reused` with no row or model call and `force`, out of
date, last good kept, tenancy, cap, restart), `routes-off.test.ts` (404 off). Not covered by a test: the ticket review's
pipeline with the library (no pipeline test exists for it; its builders are pinned), and a real Word file through mammoth, a real agent
run (PDF or sections), the SSE stream's event order. The SPA's matcher and borrow rule are in
`apps/frontend/test/docQuoteMatch.test.ts` (hand-run), the highlight colours in `textContrast.test.ts`, and
the highlight end to end (deep link → `CSS.highlights`, the strip, the not-found line) in
`apps/frontend/e2e/docs-quote-highlight.spec.ts` (mocked API).
