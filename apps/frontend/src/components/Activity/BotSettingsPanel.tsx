import { useEffect } from 'react';
import { NO_TEAM_KEY } from '@pierre-review/shared';
import { useFilters } from '../../store/filters.js';
import { useTeams } from '../../hooks/useTeams.js';
import { DetectedReviewersTable } from '../settings/DetectedReviewersTable.js';

// The Bots rail's "Settings" sub-tab — **who counts as a review bot HERE, and what it costs
// HERE**.
//
// Why per TEAM: teams define bots differently. One org funnels an AI reviewer through
// `githubactions[bot]`; in another that same login is plain CI. A single account-wide answer
// can't serve both, so the classification (automated? which vendor? review or quality check?)
// is keyed by team — and so is the monthly cost, because per-seat billing split across squads,
// an enterprise contract allocated by department, and one team on the vendor's free tier are all
// ordinary and a per-login map cannot express any of them.
//
// "No team (default)" is a FIRST-CLASS key (shared's NO_TEAM_KEY = 0), not an absence. It is
// simultaneously the No-team scope AND the inheritance ROOT: a team with no explicit row for a
// reviewer uses the default's answer, so an account that never opens this tab behaves exactly as
// it always did, and a team created later inherits the account default for free.
//
// THE SPLIT, stated once so the two surfaces can't drift:
//   • "who is a bot HERE, and what it costs HERE" → per TEAM   (this tab)
//   • "how we DETECT bots, how we attribute
//      Limn's own reviews, the Slack digest"      → per ACCOUNT (Settings → Review bots)
// Detection heuristics and Limn attribution are global policy about our own behaviour, not
// judgements about a particular team's tooling. Both surfaces carry a pointer at the other.
//
// ⚠ THE LISTING BELOW IS REPO-SCOPED to this team (see DetectedReviewersTable), which is what
// makes its empty state legible — but a reviewer priced at the default can still be absent from
// the TEAM tabs that inherit that price. That is why every inherited value names its source on the
// row rather than merely saying "inherited". The No-team tab itself is exempt: it is the
// inheritance ROOT, so the server degrades a 0-repo root scope back to the whole account roster
// rather than leaving the row every team reads uneditable (listDetectedReviewers).
//
// Rendered ONLY from the cross-repo Bots rail (`repoId == null`). A per-repo Bots tab cannot
// express a team key: `team_repos` is many-to-many, so one repo can sit in several teams and
// there is no single team whose answer it should edit.
export function BotSettingsPanel(): JSX.Element {
  const { data: teams } = useTeams();
  const teamScope = useFilters((s) => s.teamScope);
  const picked = useFilters((s) => s.botSettingsTeamId);
  const setPicked = useFilters((s) => s.setBotSettingsTeamId);

  // Seed the picker from the FilterBar scope the first time the tab opens this session — but ONLY
  // when that scope names exactly one team (or 'none', which IS the No-team key). A union scope
  // ('all' / 'teams' / a multi-team set) cannot own an override, so it seeds the default instead
  // of picking one team's answer arbitrarily.
  //
  // `picked` is `number | null` rather than a 0-defaulted number precisely so this can run once:
  // null means "the user hasn't chosen this session", which is distinguishable from a deliberate
  // choice of "No team (default)" (0). Guarded on null so it never overwrites a real choice.
  useEffect(() => {
    if (picked != null) return;
    if (typeof teamScope === 'number') setPicked(teamScope);
    else setPicked(NO_TEAM_KEY);
  }, [picked, teamScope, setPicked]);

  const liveIds = new Set((teams ?? []).map((t) => t.id));
  // A team can be deleted while this tab still names it. Fall back to the default rather than
  // querying a dead id (which would silently resolve to the default anyway, but with a picker
  // showing a team that no longer exists).
  const teamId = picked != null && liveIds.has(picked) ? picked : NO_TEAM_KEY;
  const teamName = (teams ?? []).find((t) => t.id === teamId)?.name ?? null;

  return (
    <div className="space-y-3" data-testid="bot-settings-panel">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Who counts as a review bot in{' '}
          <span className="text-sky-600 dark:text-sky-300">
            {teamName ?? 'No team (default)'}
          </span>
          , and what it costs
        </h3>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <span>Team</span>
          <select
            className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-sky-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            value={String(teamId)}
            onChange={(e) => setPicked(Number(e.target.value))}
            aria-label="Team whose bot classification to edit"
          >
            {/* 0 is a real, selectable key — not "unset". Labelled so the conflation with the
                inheritance root is visible rather than surprising. */}
            <option value={String(NO_TEAM_KEY)}>No team (default)</option>
            {(teams ?? []).map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-[11px] text-gray-400">
        {teamId === NO_TEAM_KEY ? (
          <>
            This is the account <span className="font-medium">default</span>: every team that
            hasn&apos;t set its own answer — or its own price — for a reviewer inherits from here.
            Editing it changes those teams too. The list is scoped to the repos in{' '}
            <span className="font-medium">no team</span> — unless there are none, in which case it
            falls back to every reviewer in the account, so the row each team inherits from always
            stays editable.
          </>
        ) : (
          <>
            Rows marked <span className="font-medium">inherited</span> are using the{' '}
            <span className="font-medium">No team (default)</span> answer. Editing one creates an
            override for this team only; <span className="font-medium">Reset to default</span>{' '}
            removes it again. <span className="font-medium">Cost inherits separately</span> — a
            team override can still be using the default&apos;s price until you type one here, and
            clearing the box hands it back.
          </>
        )}
      </p>

      <DetectedReviewersTable teamId={teamId} />

      <p className="border-t border-gray-200 pt-2.5 text-[11px] text-gray-400 dark:border-gray-800">
        Bot <span className="font-medium">detection</span> heuristics, the{' '}
        <span className="font-medium">Limn attribution</span> markers and the Slack bot digest are
        account-wide policy, not per team — they live in{' '}
        <span className="font-medium">Settings → Review bots (account-wide)</span>. Per-bot{' '}
        <span className="font-medium">cost</span> used to live there too; it is set per team, on
        the rows above.
      </p>
    </div>
  );
}
