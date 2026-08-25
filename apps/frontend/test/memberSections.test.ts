// The Members-dropdown section builder, extracted from FilterBar's useMemo so the Reports
// People picker can reuse it (hooks/useMemberSections.ts). Two claims pinned here:
//
//  1. THE FILTERBAR SPELLING IS BYTE-IDENTICAL to the pre-extraction inline fold — same
//     sections, same order, same maintainer-first sort, same Other/No-recent-activity
//     remainder, same botSections. The fixture below covers every branch that fold had
//     (per-repo grouping, maintainer add-without-activity, roster remainder, repo-scoped
//     universe, allow-listed bot float), so a refactor that changes any of them fails loudly.
//
//  2. THE PICKER SPELLING KILLS THE CROSS-WORKSPACE BLEED: with `inScopeRepoIds` = one
//     workspace's membership and `includeRosterRemainder: false`, a member whose only
//     activity is in another workspace's repos CANNOT appear — while a chipped-but-inactive
//     member keeps a visible "Other" row, and the UNION bot predicate partitions the roster
//     (a comment-only detected bot leaves the member sections; a manual "human" re-enters
//     them despite users.isBot).
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { User } from '@pierre-review/shared';
import {
  buildMemberSections,
  type MemberSectionsInput,
} from '../src/hooks/useMemberSections.js';

const user = (id: number, login: string, opts?: { name?: string; isBot?: boolean }): User => ({
  id,
  githubLogin: login,
  displayName: opts?.name ?? null,
  avatarUrl: null,
  isBot: opts?.isBot ?? false,
});

// The roster: workspace A humans (1–3), a workspace-B human (4), an inactive account-roster
// human (5), two bots (6 flag-bot, 7 comment-only reviewer the GLOBAL flag misses), and a
// manual-human (8) the global flag wrongly calls a bot.
const alice = user(1, 'alice', { name: 'Alice' });
const bob = user(2, 'bob', { name: 'Bob' });
const carol = user(3, 'carol'); // maintainer of repo 10, no window activity
const dave = user(4, 'dave'); // active ONLY in workspace B's repo 30
const erin = user(5, 'erin'); // no activity anywhere (roster remainder)
const flagBot = user(6, 'dependabot[bot]', { isBot: true });
const stealthBot = user(7, 'sonar-enterprise', { isBot: false }); // union-only bot
const manualHuman = user(8, 'jenkins-jane', { isBot: true }); // manual "human" wins

const USERS = [alice, bob, carol, dave, erin, flagBot, stealthBot, manualHuman];
const REPOS = [
  { id: 10, name: 'api' },
  { id: 20, name: 'web' },
  { id: 30, name: 'other-ws-repo' },
];

// Window activity: repo 10 — alice (event) + flagBot (event) + bob (PR); repo 20 — bob
// (open PR) + stealthBot (event) + manualHuman (event); repo 30 (workspace B) — dave.
const SEARCH_TIMELINE = {
  events: [
    { repoId: 10, actorId: 1 },
    { repoId: 10, actorId: 6 },
    { repoId: 20, actorId: 7 },
    { repoId: 20, actorId: 8 },
    { repoId: 30, actorId: 4 },
    { repoId: 10, actorId: null }, // actor-less rows are skipped, never crash
  ],
  prs: [{ repoId: 10, authorId: 2 }],
};
const SEARCH_OPEN_PRS = { prs: [{ repoId: 20, authorId: 2 }] };
// carol has merge rights in repo 10 (no activity — the maintainer add), dave in repo 30
// (must NOT leak into workspace A's maintainer set — the account-wide mergers trap).
const MERGERS = [
  { repoId: 10, userIds: [3, 1] },
  { repoId: 30, userIds: [4] },
];

const WORKSPACE_A = new Set([10, 20]);

function filterBarInput(overrides?: Partial<MemberSectionsInput>): MemberSectionsInput {
  return {
    users: USERS,
    repos: REPOS,
    searchTimeline: SEARCH_TIMELINE,
    searchOpenPrs: SEARCH_OPEN_PRS,
    mergers: MERGERS,
    inScopeRepoIds: WORKSPACE_A,
    repoScoped: false,
    selectedIds: [],
    allowedBotIds: [],
    isBot: (u) => u.isBot, // the FilterBar spelling: the global flag alone
    includeRosterRemainder: true,
    ...overrides,
  };
}

const sectionByKey = (r: ReturnType<typeof buildMemberSections>, key: string) =>
  r.sections.find((s) => s.key === key);
const ids = (members: User[] | undefined): number[] => (members ?? []).map((u) => u.id);

describe('buildMemberSections — the FilterBar spelling (byte-identical to the old inline fold)', () => {
  it('groups per in-scope repo, maintainers first within each section', () => {
    const r = buildMemberSections(filterBarInput());
    // repo 10: carol (maintainer, no activity — added by the mergers pass) and alice
    // (maintainer) sort ahead of bob; within ranks, alphabetical by display name/login.
    expect(ids(sectionByKey(r, 'repo:10')?.members)).toEqual([1, 3, 2]);
    // repo 20: bob + stealthBot (a human under the global-flag verdict — exactly today's
    // dropdown behaviour); manualHuman is flag-bot here, so it lands in botSections instead.
    expect(ids(sectionByKey(r, 'repo:20')?.members)).toEqual([2, 7]);
    // repo 30 is out of scope: no section, and dave's repo-30 merge rights never make him
    // a workspace-A maintainer.
    expect(sectionByKey(r, 'repo:30')).toBeUndefined();
    expect([...r.maintainerIds].sort()).toEqual([1, 3]);
  });

  it('unscoped: the remainder is the whole non-bot roster, labelled "No recent activity"', () => {
    const r = buildMemberSections(filterBarInput());
    const other = sectionByKey(r, 'other');
    expect(other?.label).toBe('No recent activity');
    // dave (other-workspace) and erin (inactive) — the account-wide remainder the dropdown
    // deliberately keeps offering. THIS is the bleed the picker spelling kills below.
    expect(ids(other?.members)).toEqual([4, 5]);
  });

  it('repo-scoped: the universe collapses to placed ∪ selected, labelled "Other"', () => {
    const r = buildMemberSections(
      filterBarInput({
        inScopeRepoIds: new Set([10]),
        repoScoped: true,
        selectedIds: [5], // a selected-but-inactive member must stay visible
      }),
    );
    expect(ids(sectionByKey(r, 'repo:10')?.members)).toEqual([1, 3, 2]);
    const other = sectionByKey(r, 'other');
    expect(other?.label).toBe('Other');
    expect(ids(other?.members)).toEqual([5]);
    // Nobody from repo 20/30 activity appears anywhere.
    expect(r.sections).toHaveLength(2);
  });

  it('botSections list per-repo flag-bots (an already-placed allow-listed bot never doubles)', () => {
    const r = buildMemberSections(filterBarInput({ allowedBotIds: [8] }));
    // repo 10's flag-bot; stealthBot is NOT here (isBot false under the global flag);
    // manualHuman (8) is flag-bot with repo-20 activity → bot:20, and being allow-listed
    // must NOT also float it into 'bot:other'.
    expect(r.botSections.map((s) => s.key)).toEqual(['bot:10', 'bot:20']);
    expect(ids(r.botSections[0]?.members)).toEqual([6]);
    expect(ids(r.botSections[1]?.members)).toEqual([8]);
  });

  it('floats an allow-listed bot with no window activity into "Other bots"', () => {
    const quietBot = user(9, 'quiet-bot', { isBot: true });
    const r = buildMemberSections(
      filterBarInput({ users: [...USERS, quietBot], allowedBotIds: [9] }),
    );
    const otherBots = r.botSections.find((s) => s.key === 'bot:other');
    expect(ids(otherBots?.members)).toEqual([9]);
  });
});

describe('buildMemberSections — the picker spelling (workspace-scoped, union verdict)', () => {
  // The union predicate the picker derives from the detected-reviewers listing: stealthBot is
  // automated (comment-only reviewer), manualHuman is a manual "human" override.
  const unionIsBot = (u: User): boolean => {
    if (u.id === stealthBot.id) return true;
    if (u.id === manualHuman.id) return false;
    return u.isBot;
  };

  const pickerInput = (selectedIds: number[] = []): MemberSectionsInput =>
    filterBarInput({
      inScopeRepoIds: WORKSPACE_A,
      repoScoped: false,
      selectedIds,
      isBot: unionIsBot,
      includeRosterRemainder: false,
    });

  it('kills the cross-workspace bleed: no roster remainder, so dave and erin cannot appear', () => {
    const r = buildMemberSections(pickerInput());
    const everyone = r.sections.flatMap((s) => ids(s.members));
    expect(everyone).not.toContain(4); // active only in workspace B
    expect(everyone).not.toContain(5); // inactive roster remainder
    expect(sectionByKey(r, 'other')).toBeUndefined();
  });

  it('keeps a chipped-but-inactive member visible under "Other" (never "No recent activity")', () => {
    const r = buildMemberSections(pickerInput([5]));
    const other = sectionByKey(r, 'other');
    expect(other?.label).toBe('Other');
    expect(ids(other?.members)).toEqual([5]);
  });

  it('partitions by the union verdict: a comment-only bot leaves the member sections, a manual human re-enters', () => {
    const r = buildMemberSections(pickerInput());
    const members = r.sections.flatMap((s) => ids(s.members));
    expect(members).not.toContain(7); // stealthBot: union-automated despite isBot false
    expect(members).toContain(8); // manualHuman: manual override beats the global flag
    // …and the union botSections mirror the same partition (repo 20 now holds stealthBot).
    const bot20 = r.botSections.find((s) => s.key === 'bot:20');
    expect(ids(bot20?.members)).toEqual([7]);
  });
});
