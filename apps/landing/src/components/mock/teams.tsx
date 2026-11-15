import { TEAM, prLabel } from '../../mock/acme';
import { CheckRow, Chip, Group, MockFrame } from './kit';

// The /teams page's mocks. Words and numbers: src/mock/acme.ts (TEAM). Both are STILL
// pictures: what they show is a state GitHub holds, not something the reader clicks.
// The app surfaces they mirror are listed in apps/landing/README.md.

/** The checks on a teammate's pull request: CI, then one Ensemble line per provider. */
export function ClaimLinesMock(): JSX.Element {
  const c = TEAM.claims;
  return (
    <MockFrame
      title={prLabel(c.pr)}
      meta={`Checks on ${c.sha}`}
      label={`Checks on pull request ${c.pr.num}: build and test-web passed; ensemble/review-claude says sam reviewed it with 2 comments; ensemble/review-codex says dana is reviewing with Codex. The Ensemble lines are not CI.`}
    >
      {c.checks.map((k) => (
        <CheckRow
          key={k.name}
          name={
            <>
              {k.name}
              {k.limn ? (
                <span className="mk-limn" title={c.limnTitle}>
                  Ensemble
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
      label="Where pull request 612 stands, at its latest commit 8a8ec14: Priya's approval, 3 Nov 14:20 at 1c4bd65, holds on GitHub; your own review, on your own pull request, is a comment."
    >
      <Group first>Where this PR stands</Group>
      <p className="mk-head">
        Latest commit <code>{s.head}</code>
      </p>
      {s.rows.map((r) => (
        <div key={r.name} className="mk-stand">
          <b>{r.name}</b>
          <span>{r.day}</span>
          <code>{r.sha}</code>
          <span className="mk-stand-v">{r.verdict}</span>
        </div>
      ))}
    </MockFrame>
  );
}
