-- @pierre/pro plugin migration (Postgres / cloud mode). Twin of
-- migrations/0037_auto_review_to_core.sql, where the contract lives. No journal, no
-- statement-breakpoint.
--
-- Auto review never runs in cloud (Claude Review is local-only), so this usually copies nothing;
-- it exists so the two dialects stay one history.
--
-- ⚠ A PLUGIN pg MIGRATION THAT FAILS IS DOWNGRADED TO A WARNING here, never raised: a raise drops
-- the WHOLE plugin to OSS mode. The worst case of a skipped copy is a workspace whose auto review
-- reads OFF until someone switches it on again.
DO $$
BEGIN
  UPDATE workspaces w
  SET auto_review_enabled = true,
      auto_review_enabled_at = p.auto_review_enabled_at
  FROM pro_workspace_settings p
  WHERE p.workspace_id = w.id
    AND p.account_id = w.account_id
    AND p.auto_review_enabled = true
    AND p.auto_review_enabled_at IS NOT NULL
    AND w.auto_review_enabled IS NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'pro 0037: auto review switches NOT copied to core workspaces (%). Affected workspaces read auto review OFF until it is switched on again.', SQLERRM;
END $$;
