-- A REPOSITORY WHOSE FILES CAN'T BE READ (2026-11-02; docs/REFERENCE-DOCS.md § A repository whose files
-- can't be read). CORE, additive, no backfill.
--
--   repos.docs_offer_failed_at   NEW: when the docs-offer look at the repository's tree last FAILED. NULL =
--                                the last look succeeded (or none failed). While set, the repository is not
--                                looked at again until DOCS_OFFER_FAILURE_RETRY_HOURS have passed (then at
--                                most once a day). Cleared by the next look that succeeds.
--   repos.docs_offer_failure     NEW: why, as a code: 'no_access' | 'empty' | 'not_found' | 'unavailable'.
--                                Set and cleared with `docs_offer_failed_at`. Never touches the PR sync.
ALTER TABLE `repos` ADD `docs_offer_failed_at` integer;
--> statement-breakpoint
ALTER TABLE `repos` ADD `docs_offer_failure` text;
