-- Bot-Triage Platform (WS1): capture the GitHub GraphQL __typename of an actor
-- ('Bot' | 'User' | 'Organization' | …) on the global users table. Plain text (no
-- enum — the __typename set varies), nullable. A 'Bot' typename is a hard
-- automated-reviewer signal for the classifier. users stays GLOBAL (no account_id).
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
ALTER TABLE `users` ADD `github_type` text;
