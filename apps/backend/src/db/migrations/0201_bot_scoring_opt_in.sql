-- BOT COMMENT SCORING IS OPT-IN PER REPO (Repos & workspaces → a repo's panel → Bot scoring).
-- Default 0: no repo is scored until the reader switches it on, existing repos included.
-- `bot_scoring_excluded` (0200) is DORMANT: kept, never read.
ALTER TABLE repos ADD COLUMN bot_scoring_enabled integer DEFAULT 0 NOT NULL;
