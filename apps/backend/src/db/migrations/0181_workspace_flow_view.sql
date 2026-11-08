-- CHRONOLOGY'S TWO VIEWS (docs/BOTTLENECKS.md § Two views). CORE, additive.
--
--   workspaces.flow_view   who moves the ball on Reports → Chronology, for this workspace:
--                          'people' (only people's reviews and comments) or 'people_bots' (Limn's
--                          and the AI review bots' too). NULL = the default ('people_bots',
--                          shared `resolveFlowActorView`). A READING setting: it changes what is
--                          measured, never what is stored. Read and written ONLY by
--                          db/flow-settings.ts.
ALTER TABLE `workspaces` ADD COLUMN `flow_view` text;
