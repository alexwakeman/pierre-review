-- THIS DATABASE'S OWN FACTS (key → value), not an account's. One row so far: `instance_id`, a random
-- id written once (db/instance-id.ts) that names THIS database file wherever it is moved. The
-- reference-docs janitor writes it into every workspace docs folder it creates (`.owner`) and never
-- deletes a folder another database's id is written in (docs/REFERENCE-DOCS.md § On disk).
CREATE TABLE `instance_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
