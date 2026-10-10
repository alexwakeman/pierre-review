-- REPORTS → THIS SPRINT: the tracker SITE a stored sprint list was read from (the Postgres twin is
-- migrations-pg/0088_sprint_reads_api_root.sql). With `provider`, it tells the GET that the
-- workspace has since moved to another tracker or site, so the page says "Reading…" and a new read
-- is made due, instead of showing the old read's time over an empty list. NULL = before this column
-- (treated as "not this site": one extra read).
ALTER TABLE `sprint_reads` ADD `api_root` text;
