// ONE SEEDED "Check review" RESULT, so the demo can film the addressed check.
//
// ============================================================================
// THIS IS SEEDED DATA. NO MODEL PRODUCED THE WORDS BELOW. A human wrote them.
// ============================================================================
//
// WHY THIS EXISTS. The `addressed` annotation ("was this review comment actually
// dealt with?") is a Haiku judgement, and the demo stack runs with
// ANTHROPIC_API_KEY=dummy — so pressing "Check review" on the demo estate
// produces an error, not a verdict. Without a stored row the feature is
// unfilmable: the button is on screen and nothing it does can be shown.
//
// WHAT IS AND IS NOT DONE ABOUT THAT. We write ONE row into the plugin's
// `pr_comment_annotations` table (two, counting the `validity` row the same
// button always writes alongside it). Nothing else changes. No route is stubbed,
// no component is special-cased, no fetch is intercepted: the SPA reads these
// rows through `GET /api/pro/prs/:id/annotations`, the PURE CACHED READ that
// every real user hits on their second view of a checked thread. This is the
// same thing the demo already does with 2,945 seeded `ml_comment_labels` rows
// that no ML service scored.
//
// THE PAYLOAD HASH IS THE WHOLE TRICK, AND IT IS NOT HAND-WRITTEN. A stored
// annotation is fresh only while its `payload_hash` still equals what the read
// path recomputes for that target; any other value renders a permanent "may be
// out of date" chip and invites a re-bill on every click. So the hash here comes
// from the PLUGIN'S OWN `currentHashFor` over the PLUGIN'S OWN `loadPrCorpus` —
// literally the function `projectAnnotations` calls to decide staleness — rather
// than from a constant or a re-implementation. If the plugin's hash formula
// moves, this seeder moves with it for free, and the row it writes is stale by
// exactly the same rule a real one would be.
//
// THE VERDICT IS WRITTEN LIKE OUTPUT, NOT LIKE MARKETING. It is `partial` at 70%
// on a thread the deterministic heuristic already grades `likely_addressed` /
// medium — the two agree, which is what a reader of that screen would expect.
// The prose names what the later diff covers AND what it does not, in the two
// sections `ADDRESSED_SYSTEM` mandates. A triumphant "Fixed!" would be a claim
// this product cannot make about an ambiguous thread, and the panel's job is
// precisely to be honest about that.
//
// THE EVIDENCE IS CONSISTENT WITH ITSELF. `baseSha`/`headSha` are the real shas
// the plugin's own window rule picks for this thread (base = the newest seeded
// commit at or before the thread's ROOT comment — never its last; see
// `addressedWindowFor`'s scar). The patch is fictional, like every other byte of
// the acme/* estate, and it is the patch the verdict actually argues about: the
// "Still open" bullet points at a line the diff visibly leaves alone. `anchor`
// is recorded as UNAVAILABLE because it genuinely is — `review_comments
// .diff_hunk` is NULL across this estate and there is no GitHub behind it — so
// the panel shows its own caveat about judging without the anchored code.
//
// GUARDED. Runs only against the demo estate: it resolves its target by
// repository, PR number and comment text, and does nothing at all if that thread
// is not there.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---- the target, addressed semantically (never by a raw id) ------------------
const REPO_OWNER = 'acme';
const REPO_NAME = 'search-service';
const PR_NUMBER = 648; // "Paginate the comment normaliser"
// The thread: Greptile on the segment reader swallowing a parse error. Matched on
// its file and its opening words rather than a thread id, so a re-shuffle of the
// estate's PRNG bands skips this cleanly instead of seeding a verdict onto some
// other conversation.
const THREAD_PATH_SUFFIX = 'segment.rs';
const THREAD_ROOT_PREFIX = 'The error from `parse()` is swallowed here';

const MODEL = 'claude-haiku-4-5'; // the plugin's own MODEL constant

// The later change the verdict is judged against. Fictional, like the estate it
// belongs to — and written so the verdict's two sections are both true OF IT:
// `comments()` now propagates the parse error, `warm_cache` still drops it.
// Line numbers are consistent with the hunk headers, because they are quoted in
// the verdict above: `comments` lands at 196, and `warm_cache`'s `let _ =` at 251
// once the first hunk's net +3 lines are counted.
const PATCH = `diff --git a/src/index/segment.rs b/src/index/segment.rs
--- a/src/index/segment.rs
+++ b/src/index/segment.rs
@@ -193,9 +193,12 @@ impl SegmentReader {
         self.store.len()
     }

-    pub fn comments(&self, page: Page) -> Vec<Comment> {
-        let raw = self.store.read(page.offset, page.len);
-        parse(&raw).unwrap_or_default()
-    }
+    pub fn comments(&self, page: Page) -> Result<Vec<Comment>, SegmentError> {
+        let raw = self.store.read(page.offset, page.len)?;
+        parse(&raw).map_err(|e| {
+            tracing::warn!(offset = page.offset, "segment payload failed to parse: {e}");
+            SegmentError::Malformed(page.offset)
+        })
+    }

     fn page_bounds(&self, n: usize) -> Page {
@@ -246,6 +249,6 @@ impl SegmentReader {
     fn warm_cache(&self, pages: &[Page]) {
         for page in pages {
-            let _ = parse(&self.store.read(page.offset, page.len));
+            let _ = self.comments(*page);
         }
     }
 }
`;

// The two sections ADDRESSED_SYSTEM requires, in its order, under ~140 words.
const ADDRESSED_BODY = `**Addressed:**
- \`SegmentReader::comments\` now returns \`Result<Vec<Comment>, SegmentError>\` instead of \`parse(&raw).unwrap_or_default()\`, so a malformed payload is no longer indistinguishable from an empty page (\`src/index/segment.rs:196\`).
- The failure is logged with the page offset before it becomes \`SegmentError::Malformed\`.

**Still open:**
- \`warm_cache\` (\`src/index/segment.rs:251\`) still discards the result with \`let _ =\`, so a malformed segment is skipped in silence on the warm path — the same swallow, one caller along.
- The diff does not show what the paginating caller does with \`SegmentError::Malformed\`, so whether it resurfaces as an empty result there is not settled here.`;

const VALIDITY_BODY = `The point holds up. \`unwrap_or_default()\` on a parse result is exactly the shape that turns a corrupt page into a successful empty read, and \`comments()\` is on the pagination path, so the failure would surface as "no more comments" rather than as an error. Worth acting on as written; the comment names the file and the mechanism and does not overstate the impact.`;

export interface AddressedCheckSeedCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  now: Date;
}

export interface AddressedCheckSeedResult {
  seeded: boolean;
  /** One line for the seeder's console summary. */
  note: string;
  /** The deep link the demo video/screenshots open, when seeded. */
  prId: number | null;
  threadId: number | null;
}

interface RawStmt {
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
}
interface RawClient {
  prepare(sql: string): RawStmt;
}

/**
 * Load the plugin's annotation target module BY PATH, the way `src/pro/bind.ts`
 * does — @pierre/pro is a private submodule and never a declared dependency, so
 * a bare specifier would not resolve in an OSS checkout. `src` is preferred over
 * `dist` for the same reason bind.ts prefers it: a stale dist silently shadows
 * the source you are reading.
 */
async function loadTargetsModule(
  proDir: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const candidates = [
    join(proDir, 'src', 'annotations', 'targets.ts'),
    join(proDir, 'dist', 'annotations', 'targets.js'),
  ];
  for (const file of candidates) {
    if (existsSync(file)) return await import(pathToFileURL(file).href);
  }
  return null;
}

export async function seedAddressedCheck(
  ctx: AddressedCheckSeedCtx,
): Promise<AddressedCheckSeedResult> {
  const { db, schema, now } = ctx;
  const miss = (note: string): AddressedCheckSeedResult => ({
    seeded: false,
    note,
    prId: null,
    threadId: null,
  });

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const mod = await loadTargetsModule(join(repoRoot, 'packages', 'pro'));
  if (mod == null) return miss('addressed check: SKIPPED (no packages/pro/src)');

  const raw = (db as { $client: RawClient }).$client;

  // ---- find the pull request, then the thread --------------------------------
  const pr = raw
    .prepare(
      `SELECT p.id AS id, p.repo_id AS repoId
         FROM pull_requests p JOIN repos r ON r.id = p.repo_id
        WHERE r.owner = ? AND r.name = ? AND p.number = ?`,
    )
    .get(REPO_OWNER, REPO_NAME, PR_NUMBER) as { id: number; repoId: number } | undefined;
  if (pr == null) {
    return miss(`addressed check: SKIPPED (${REPO_OWNER}/${REPO_NAME}#${PR_NUMBER} not seeded)`);
  }

  const thread = raw
    .prepare(
      `SELECT t.id AS threadId, c.id AS rootCommentId
         FROM review_threads t
         JOIN review_comments c ON c.thread_id = t.id
        WHERE t.pr_id = ?
          AND t.path LIKE ?
          AND t.derived_state = 'likely_addressed'
          AND t.is_resolved = 0
          AND c.body LIKE ?
        ORDER BY t.id
        LIMIT 1`,
    )
    .get(pr.id, `%${THREAD_PATH_SUFFIX}`, `${THREAD_ROOT_PREFIX}%`) as
    | { threadId: number; rootCommentId: number }
    | undefined;
  if (thread == null) {
    return miss('addressed check: SKIPPED (the Greptile parse-error thread is not in this estate)');
  }

  // ---- the hashes, from the reader's own code --------------------------------
  // A minimal ProContext: `loadPrCorpus` reads `db`, `schema` and the OPTIONAL
  // `queries.getBlastSignals` (only the `impact` kind needs it, and we write no
  // impact row), so this is the whole surface it touches.
  const corpus = await mod.loadPrCorpus({ db, schema, queries: {} }, 1, pr.id);
  if (corpus == null) return miss('addressed check: SKIPPED (loadPrCorpus found no corpus)');

  const addressedHash: string | null = mod.currentHashFor(
    corpus,
    'addressed',
    'thread',
    thread.threadId,
  );
  const validityHash: string | null = mod.currentHashFor(
    corpus,
    'validity',
    'review_comment',
    thread.rootCommentId,
  );
  if (addressedHash == null || validityHash == null) {
    return miss('addressed check: SKIPPED (the plugin could not hash this target)');
  }

  // The window the plugin itself would pick — base anchored on the thread's ROOT
  // comment. Read back off the hash's own inputs rather than recomputed here, so
  // the shas in the evidence and the shas in the hash cannot drift apart.
  const ordered = corpus.commentsByThread.get(thread.threadId) ?? [];
  const window = mod.addressedWindowFor(corpus.commits, corpus.headSha, ordered) as {
    baseSha: string;
    headSha: string;
  } | null;
  if (window == null) {
    return miss('addressed check: SKIPPED (no commit precedes the thread, so there is no window)');
  }

  const threadPath = corpus.threads.find(
    (t: { id: number }) => t.id === thread.threadId,
  )?.path as string | undefined;

  const evidence = JSON.stringify({
    v: 1,
    baseSha: window.baseSha,
    headSha: window.headSha,
    path: threadPath ?? '',
    outcome: 'changed',
    patch: PATCH,
    previousPath: null,
    note: null,
    // TRUE OF THIS DATABASE: diff_hunk is NULL across the estate (lean storage)
    // and there is no GitHub behind the demo to re-fetch it from. The panel
    // renders its own caveat off this, which is the honest thing to show.
    anchor: { available: false, reason: 'lean_storage' },
  });

  // ---- write ------------------------------------------------------------------
  // Plugin tables are outside the core drizzle schema, so this goes through the
  // raw better-sqlite3 handle — the same script-only path the pro block in
  // seed-demo.ts already uses. ON CONFLICT on the table's real unique index
  // (account_id, kind, target_kind, target_id) so a re-run overwrites.
  const createdAt = Math.floor((now.getTime() - 41 * 60_000) / 1000); // ~41 min ago
  const ins = raw.prepare(
    `INSERT INTO pr_comment_annotations (
       account_id, repo_id, pr_id, kind, target_kind, target_id,
       verdict, confidence, body, payload_hash, model,
       cost_usd, input_tokens, output_tokens, evidence, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, kind, target_kind, target_id) DO UPDATE SET
       verdict = excluded.verdict, confidence = excluded.confidence,
       body = excluded.body, payload_hash = excluded.payload_hash,
       model = excluded.model, evidence = excluded.evidence,
       created_at = excluded.created_at`,
  );

  // One combined "Check review" call, its cost split across the two judgements it
  // produced — the same double approximation the runner stores.
  ins.run(
    1, pr.repoId, pr.id, 'addressed', 'thread', thread.threadId,
    'partial', 70, ADDRESSED_BODY, addressedHash, MODEL,
    0.003_125, 2_030, 224, evidence, createdAt,
  );
  ins.run(
    1, pr.repoId, pr.id, 'validity', 'review_comment', thread.rootCommentId,
    'valid', null, VALIDITY_BODY, validityHash, MODEL,
    0.003_125, 2_030, 118, null, createdAt,
  );

  return {
    seeded: true,
    note:
      `addressed check: 1 thread on ${REPO_OWNER}/${REPO_NAME}#${PR_NUMBER} ` +
      `(pr ${pr.id}, thread ${thread.threadId}) — "Partially addressed · 70%" + a validity row`,
    prId: pr.id,
    threadId: thread.threadId,
  };
}
