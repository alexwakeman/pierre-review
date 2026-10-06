-- AUTO AI FIX IS OFF BY DEFAULT. 0083 added `workspaces.auto_fix_enabled` DEFAULT 1 so nothing
-- changed on upgrade; the product decision since is OFF until someone switches it on. Every
-- existing workspace is switched off once here (the switch shipped one release earlier, so no one
-- has had time to choose it). SQLite cannot change a column default in place, so the 0083 DDL
-- default stays 1; both workspace inserts in db/queries.ts write `autoFixEnabled: false`
-- explicitly. The Postgres twin is migrations-pg/0071_auto_fix_off_by_default.sql.
UPDATE `workspaces` SET `auto_fix_enabled` = 0;
