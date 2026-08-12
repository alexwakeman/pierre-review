-- Auto-merge ("merge when ready") learns GitHub's native merge queue. SQLite / local mode;
-- Postgres twin: migrations-pg/0038_auto_merge_queue.sql. Two additive columns, no index,
-- no backfill (existing intents are direct-merge intents — via_merge_queue defaults false).
--
-- `via_merge_queue` — stamped at arm time when the PR's base branch had a merge queue: the
-- watcher's terminal action is then "add to the queue" (GraphQL enqueuePullRequest, pinned
-- to the consented head) instead of a direct merge, which GitHub refuses on a
-- queue-protected branch. The runner re-checks the queue live each tick, so a queue
-- disabled after arming degrades to the direct merge rather than stranding the intent.
--
-- `enqueued_at` — when the WATCHER enqueued the PR; null until then. This is the
-- attribution record: a PR that merges while it is set resolves 'merged' (the watcher's
-- doing — the landed toast fires), one a human queued resolves 'disarmed_blocked' like any
-- outside merge, and a disarm with it set also dequeues the entry the watcher created.
ALTER TABLE `auto_merge_requests` ADD `via_merge_queue` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `auto_merge_requests` ADD `enqueued_at` integer;
