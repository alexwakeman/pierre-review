import { TEAM, prLabel } from '../../mock/acme';
import { CheckRow, Chip, Group, MockFrame } from './kit';

// The /teams page's mocks. Words and numbers: src/mock/acme.ts (TEAM). Both are STILL
// pictures: what they show is a state GitHub holds, not something the reader clicks.
// The app surfaces they mirror are listed in apps/landing/README.md.

/** The checks on a teammate's pull request: CI, then one Limn line per provider. */
export function ClaimLinesMock(): JSX.Element {
  const c = TEAM.claims;
  return (
    <MockFrame
      title={prLabel(c.pr)}
      meta={`Checks on ${c.sha}`}
      label={`Checks on pull request ${c.pr.num}: build and test-web passed; limn/review-claude says sam reviewed it with 2 comments; limn/review-codex says dana is reviewing with Codex. The Limn lines are not CI.`}
    >
      {c.checks.map((k) => (
        <CheckRow
          key={k.name}
          name={
            <>
              {k.name}
              {k.limn ? (
                <span className="mk-limn" title={c.limnTitle}>
                  Limn
                </span>
              ) : null}
            </>
          }
          state={k.state}
          tone={k.tone}
          note={k.note ?? undefined}
        />
      ))}
      <p className="mk-note">
        On dana’s Open PRs: <Chip>{c.skip}</Chip>
      </p>
    </MockFrame>
  );
}

/** "Where this PR stands" on the reader's own pull request: a teammate's approval, the reader's comment. */
export function TeamStandingMock(): JSX.Element {
  const s = TEAM.standing;
  return (
    <MockFrame
      title={prLabel(s.pr)}
      meta="AI Review"
      label="Where pull request 612 stands: Priya approved on 3 Nov and her approval stands on GitHub; your own review, on your own pull request, is a comment."
    >
      <Group first>Where this PR stands</Group>
      {s.rows.map((r) => (
        <div key={r.name} className="mk-stand">
          <b>{r.name}</b>
          <Chip tone={r.tone}>{r.verdict}</Chip>
          <span>
            {[r.day, r.sha, r.note].filter((x): x is string => x != null).join(' · ')}
          </span>
        </div>
      ))}
    </MockFrame>
  );
}
