-- AI FIX RESOLVES MERGE CONFLICTS IN THE SANDBOX (docs/SANDBOX.md § AI Fix sessions, "The merge"). CORE,
-- additive, both nullable (NULL = the run had no "Resolve merge conflicts" item).
--
--   ai_fixes.merge_json    the merge: base ref + commit, the merge base, the files in conflict, Limn's check
--                          of the agent's merge commit (pending / valid / invalid / missing + reason), the
--                          resolution diff shown to the reader. No secret.
--   ai_fixes.merge_bundle  the agent's commits (the merge commit and the fix on top), as a git bundle in
--                          base64, read out of the sandbox after each build turn. Push re-checks it and
--                          rebuilds the commits from its trees. Removed when the fix is pushed or discarded.
ALTER TABLE `ai_fixes` ADD `merge_json` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `merge_bundle` text;
