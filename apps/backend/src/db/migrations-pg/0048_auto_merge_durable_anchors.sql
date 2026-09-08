-- Two anchors the auto-merge watcher DISARMS on, moved out of process memory onto the row.
-- The SQLite twin is migrations/0061_auto_merge_durable_anchors.sql.
--
-- WHY. Both facts lived in module-level Maps in `merge/auto-merge-runner.ts` (`pendingUpdates`,
-- and the retarget guard's implicit reliance on a synced column read at run time). A Map is fine
-- for a hint. It is not fine for a fact the watcher ends an intent on, because losing it does not
-- read as "I forgot" — it reads as "something unexplained happened to this branch", and the safe
-- response to an unexplained head move is to disarm. Under `pnpm dev` that is every file save;
-- in cloud it is every deploy. Measured on the author's own account, 3 of 21 intents died and a
-- further 2 were at risk from exactly this class of bookkeeping loss.
--
-- ⚠ BOTH ARE NULLABLE WITH NO DEFAULT, AND NULL MEANS "NOT RECORDED", NEVER A VALUE.
-- "expected_base_ref" is null on every row armed before this migration; the retarget guard falls
-- back to the synced base ref for those, which is exactly what it did before, so no already-armed
-- intent changes behaviour. A DEFAULT here would assert the user consented to a branch nobody
-- asked them about.

-- The base branch the SPA was showing when the user armed. The head pin cannot see a retarget
-- (PATCH pulls/{n} with a new `base` leaves head.sha alone), so consent to "merge into main"
-- needs its own anchor. It was being approximated by reading `pull_requests.base_ref_name` at RUN
-- time — a value the sync owns and may correct at any moment, at which point the watcher reports
-- a retarget that never happened.
ALTER TABLE "auto_merge_requests" ADD COLUMN IF NOT EXISTS "expected_base_ref" text;--> statement-breakpoint
-- The head SHA an in-flight update-branch was issued AGAINST. GitHub's update-branch returns 202
-- with no handle to poll, so the head move it causes arrives on a later tick; without this the
-- watcher cannot tell its OWN merge commit from a human push and disarms with "the branch moved".
ALTER TABLE "auto_merge_requests" ADD COLUMN IF NOT EXISTS "update_issued_against_oid" text;
