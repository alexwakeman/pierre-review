import { useQuery } from '@tanstack/react-query';
import type { ProSettings } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useProCapabilities } from './useTriage.js';

// Whether opening the config modal can involve `pro_settings` AT ALL — the gate on the
// `/api/pro/settings` fetch (which 404s without the plugin) and on the avatar menu's Settings
// entry. `botTriage` is true whenever the plugin is loaded, even with every paid flag off.
//
// ⚠ THIS IS NOT AN INVENTORY OF SECTIONS, AND IT IS NO LONGER THE SETTINGS MENU GATE. It used to
// carry the warning "every cap listed here must still own a section", which was the right rule
// while every section was Pro.
//
// ⚠ IT ALSO USED TO GATE THE MENU ENTRY IN App.tsx, AND THAT WAS A REAL BUG: every cap below is
// false when the plugin is ABSENT — the public `npx pierre-review` release — so the large-PR
// threshold, which is CORE and ungated on every tier, sat behind a menu item that never rendered.
// A comment here once claimed "there is no configuration in which it opens empty"; that was true
// of the MODAL and false of the ENTRY POINT, which is how the two drifted apart. App.tsx now opens
// Settings unconditionally, so do not reintroduce a capability gate on that path.
//
// Sole remaining consumer: BotRoiPanel's `useProSettings` enable flag, reading the deprecated
// legacy cost blob. It is asking "is there a plugin to answer me", not "which sections exist" —
// `useHasProWorkspaceSettings` below is the section inventory; keep the two apart.
export function useHasProSettings(): boolean {
  const caps = useProCapabilities();
  return (
    caps.workspaceInsights ||
    caps.slackDigest ||
    caps.issueLinks ||
    caps.claudeReview ||
    caps.aiFix ||
    caps.botTriage
  );
}

// Whether the modal's "Workspace" half has anything in it — the ONE list where every cap must
// still own a section, and the gate on the Workspace heading itself (a heading over nothing is
// noise, and reads as a section that failed to load).
//
// ⚠ THREE CAPS CAME OFF THIS LIST WITH THEIR SECTIONS, and none of them may drift back:
//   • `botTriage` — the account-wide "Review bots" section is DELETED. Its explainer pointed at
//     Activity → Bots → Settings (where a bot's judgement, identity and price actually live, all
//     CORE/free) and its last knob, the Slack bot digest, is now a per-DELIVERY field folded into
//     the Slack section (plugin migration 0033). A `botTriage`-only account would otherwise get a
//     "Workspace" heading with nothing under it.
//   • `claudeReview` / `aiFix` — the BYO Anthropic-key section is DELETED (the stored key is
//     retired), and it was account-global anyway, never workspace-scoped.
// (`activityDigest` came off earlier, with the "AI summary updates" policy section.)
export function useHasProWorkspaceSettings(): boolean {
  const caps = useProCapabilities();
  return caps.workspaceInsights || caps.slackDigest || caps.issueLinks;
}

// Per-account Pro settings. ⚠ WHAT IS LEFT ON THIS ROUTE IS THE COMPARISON-WINDOW MODE AND THE BOT
// TOGGLES. Three settings moved to the WORKSPACE grain and none kept an account default beneath
// it: the Slack digest (plugin 0030), and the sprint cadence + the Jira/Linear tracker (plugin
// 0031) — all three now read/write `useWorkspaceProSettings` / `useSlackTarget`.
// `ProSettings.sprint.cadenceDays`, `.startDate` and `.issue` still ride the wire but are ALWAYS
// empty, so nothing may branch on them; the PUT schema silently STRIPS them.
// Fetched only when `enabled`. Consumers: the config modal (open AND a Pro section exists) and
// `BotRoiPanel`, which reads the deprecated legacy cost blob. One shared key + a 60s staleTime.
export function useProSettings(enabled: boolean) {
  return useQuery<ProSettings>({
    queryKey: ['pro-settings'],
    queryFn: api.proSettings,
    enabled,
    staleTime: 60_000,
  });
}

// ⚠ THERE IS NO `useUpdateProSettings` ANY MORE, AND ITS ABSENCE IS THE POINT. The
// comparison-window MODE was the last live field on the account patch and moved to the workspace
// row in plugin migration 0032 (`useUpdateWorkspaceProSettings`, `comparisonMode`); the bot
// Slack-digest flag moved to the delivery row in 0033 (`useUpdateSlackTarget`, `botDigest`).
// Every remaining key in `ProSettingsUpdate` is silently STRIPPED by the PUT schema, so the hook
// would have been a mutation that always succeeds and never changes anything — the worst shape a
// settings write can have, because the UI reads back "saved".
//
// ⚠ THE INVALIDATION IT OWNED MOVED WITH THE SETTING, NOT WITH THE HOOK. It swept
// `['workspace-insights']` / `['workspace-metrics-detail']` on a `sprint` patch because the
// comparison window re-frames the flow metrics and those queries otherwise only refetch on the
// 5-min sync cadence. `useUpdateWorkspaceProSettings` now fires that sweep for a `comparisonMode`
// patch as well as a `sprint` one — dropping it there would have made Save look inert until the
// next sync.
