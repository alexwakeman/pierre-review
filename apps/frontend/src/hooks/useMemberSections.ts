import type { User } from '@pierre-review/shared';
import type { MemberSection } from '../components/UserSelectPanel.js';

// The Members-dropdown section builder, extracted from FilterBar's useMemo so the Reports
// People picker can reuse it with a different SCOPE and a different BOT VERDICT without a
// second spelling of the fold (a sibling fold is a second predicate that can drift — the
// tile-number-vs-hydration lesson, applied to a member list).
//
// PURE: the two call sites keep their own useMemo and pass plain data in. FilterBar passes
// exactly the inputs it always computed, so its output is byte-identical to the pre-extraction
// useMemo (pinned by test/memberSections.test.ts); the picker passes the whole workspace's
// membership, the UNION bot predicate and `includeRosterRemainder: false` — which is where the
// account-wide "No recent activity" bleed (every workspace's humans under every workspace's
// Reports pane) dies.
//
// The input shapes are STRUCTURAL slices of the real responses (TimelineResponse / OpenPrsResponse
// / MergersResponse assign to them directly): the fold reads exactly these fields, and the slices
// keep it unit-testable without fabricating whole wire payloads.

export interface MemberSectionsInput {
  /** The account roster (useUsers). The `isBot` predicate decides which cohort each row joins. */
  users: User[] | undefined;
  /** The account's repos (useRepos) — drives section ORDER; only in-scope repos section. */
  repos: Array<{ id: number; name: string }> | undefined;
  /** Member-AGNOSTIC window activity (useSearchTimeline) — events + PRs. */
  searchTimeline:
    | {
        events?: Array<{ repoId: number; actorId: number | null }>;
        prs?: Array<{ repoId: number; authorId: number | null }>;
      }
    | undefined;
  /** Member-agnostic open PRs (useSearchOpenPrs). */
  searchOpenPrs: { prs?: Array<{ repoId: number; authorId: number | null }> } | undefined;
  /** Per-repo merge-rights inference (useMergers) — account-wide, so the scope set below is
   *  what keeps other workspaces' maintainers out. */
  mergers: Array<{ repoId: number; userIds: number[] }> | undefined;
  /** The repo ids in scope — FilterBar passes its Timeline narrowing ∩ workspace membership;
   *  the report picker passes the WHOLE workspace membership (the repo picker is Timeline-only). */
  inScopeRepoIds: Set<number>;
  /** Whether an explicit repo narrowing is active (drives the Other/remainder label). */
  repoScoped: boolean;
  /** Already-selected ids that must stay visible even with no window activity ("Other"). */
  selectedIds: number[];
  /** Bots kept visible under excludeBots — floats un-placed ones into "Other bots". */
  allowedBotIds: number[];
  /** The bot verdict. FilterBar passes `(u) => u.isBot` (today's behaviour, byte-identical);
   *  the picker passes the UNION predicate (workspace `automated` ∪ users.isBot, a manual
   *  "human" winning both ways — the PeriodPeopleSection/Feed rule). The two cohorts partition:
   *  whatever this rejects from the member sections is exactly what botSections may hold. */
  isBot: (u: User) => boolean;
  /** FilterBar: true (the full non-bot roster becomes the remainder when unscoped). Picker:
   *  FALSE — the account-wide "No recent activity" remainder is exactly the cross-workspace
   *  bleed, so only placed + selected members can appear at all. */
  includeRosterRemainder: boolean;
}

export interface MemberSectionsResult {
  sections: MemberSection[];
  botSections: MemberSection[];
  maintainerIds: Set<number>;
}

export function buildMemberSections(input: MemberSectionsInput): MemberSectionsResult {
  const {
    users,
    repos,
    searchTimeline,
    searchOpenPrs,
    mergers,
    inScopeRepoIds,
    repoScoped,
    selectedIds,
    allowedBotIds,
    isBot,
    includeRosterRemainder,
  } = input;

  const byId = new Map((users ?? []).map((u) => [u.id, u] as const));
  const usable = (id: number | null): User | null => {
    if (id == null) return null;
    const u = byId.get(id);
    return u && !isBot(u) ? u : null;
  };
  const botOf = (id: number | null): User | null => {
    if (id == null) return null;
    const u = byId.get(id);
    return u && isBot(u) ? u : null;
  };

  // Per-repo membership, derived from the member-agnostic window activity.
  // Limited to in-scope repos (the selected repos, or the whole scope when no repo filter).
  const repoMembers = new Map<number, Set<number>>();
  const addMember = (repoId: number, userId: number | null): void => {
    if (userId == null) return;
    if (!inScopeRepoIds.has(repoId)) return;
    let set = repoMembers.get(repoId);
    if (!set) repoMembers.set(repoId, (set = new Set()));
    set.add(userId);
  };
  for (const e of searchTimeline?.events ?? []) addMember(e.repoId, e.actorId);
  for (const p of searchTimeline?.prs ?? []) addMember(p.repoId, p.authorId);
  for (const p of searchOpenPrs?.prs ?? []) addMember(p.repoId, p.authorId);

  // Maintainers (merge rights) in the relevant repo(s). They also count as
  // members of their repo, so a maintainer surfaces under their repo section
  // even without any activity in the window. Bots/unknowns are skipped so the
  // "Maintainers" quick-select only stages real, selectable members.
  const maintainers = new Set<number>();
  for (const m of mergers ?? []) {
    if (!inScopeRepoIds.has(m.repoId)) continue;
    for (const uid of m.userIds) {
      if (!usable(uid)) continue;
      maintainers.add(uid);
      addMember(m.repoId, uid);
    }
  }

  const byName = (a: User, b: User): number =>
    (a.displayName || a.githubLogin).localeCompare(b.displayName || b.githubLogin);
  const maintainerFirst = (a: User, b: User): number => {
    const rank = (maintainers.has(a.id) ? 0 : 1) - (maintainers.has(b.id) ? 0 : 1);
    return rank !== 0 ? rank : byName(a, b);
  };

  const sections: MemberSection[] = [];
  const placed = new Set<number>();

  // One section per in-scope repo (kept in the repo-chip order). Maintainers are
  // sorted first within each repo (and badged), but get no section of their own —
  // the "Maintainers" quick-select in the panel covers them across all repos.
  for (const r of repos ?? []) {
    if (!inScopeRepoIds.has(r.id)) continue;
    const ids = repoMembers.get(r.id);
    if (!ids || ids.size === 0) continue;
    const members = [...ids]
      .map(usable)
      .filter((u): u is User => u != null)
      .sort(maintainerFirst);
    if (!members.length) continue;
    sections.push({ key: `repo:${r.id}`, label: r.name, members });
    for (const u of members) placed.add(u.id);
  }

  // Selectable universe: the full non-bot roster when the caller wants the roster remainder and
  // there's no repo filter, else the placed (active/maintainer) members plus any selected ones.
  // Whatever isn't already in a section above falls into "Other" — labelled "No recent activity"
  // only on the roster-remainder path, where it genuinely holds the inactive rest of the account.
  const universe =
    includeRosterRemainder && !repoScoped
      ? new Set<number>((users ?? []).filter((u) => !isBot(u)).map((u) => u.id))
      : new Set<number>([...placed, ...selectedIds]);
  const other = [...universe]
    .map(usable)
    .filter((u): u is User => u != null)
    .filter((u) => !placed.has(u.id))
    .sort(byName);
  if (other.length) {
    sections.push({
      key: 'other',
      label: repoScoped || !includeRosterRemainder ? 'Other' : 'No recent activity',
      members: other,
    });
  }

  // Per-repo Bots sections (item 3): the bot contributors active in each in-scope repo,
  // so the user can allow-list the important ones. Derived from the same (bot-inclusive)
  // window activity as members — repoMembers already holds bot ids (usable() filtered
  // them out of the member sections). Any bot with no repo activity but already allow-
  // listed still needs to be togglable, so it's floated into an "Other bots" section.
  const botSections: MemberSection[] = [];
  const placedBots = new Set<number>();
  for (const r of repos ?? []) {
    if (!inScopeRepoIds.has(r.id)) continue;
    const ids = repoMembers.get(r.id);
    if (!ids) continue;
    const bots = [...ids]
      .map(botOf)
      .filter((u): u is User => u != null)
      .sort(byName);
    if (!bots.length) continue;
    botSections.push({ key: `bot:${r.id}`, label: r.name, members: bots });
    for (const u of bots) placedBots.add(u.id);
  }
  const allowedNotShown = allowedBotIds
    .map(botOf)
    .filter((u): u is User => u != null)
    .filter((u) => !placedBots.has(u.id))
    .sort(byName);
  if (allowedNotShown.length) {
    botSections.push({ key: 'bot:other', label: 'Other bots', members: allowedNotShown });
  }

  return { sections, botSections, maintainerIds: maintainers };
}
