import type { ReactNode } from 'react';
import {
  BotsWorthMock,
  ChronologyMiniMock,
  CiMock,
  ConflictsMock,
  FixMock,
  MergeWhenReadyMock,
  PendingListMock,
  ReviewMock,
  StoryCheckMock,
  TrunkMock,
  VerdictMock,
} from '../mock/home';

// ---------------------------------------------------------------------------
// The four chapters: Review, Fix, Ship, See. Each is a heading and one line,
// then three named features (See: two), each a heading, one sentence and a mock.
// The anchors (#review #fix #ship #see) are linked from the header and footer.
// ---------------------------------------------------------------------------

type Feature = { k: string; h: string; p: string; mock: ReactNode };

function Chapter({
  id,
  name,
  color,
  line,
  features,
  two = false,
}: {
  id: string;
  name: string;
  color: string;
  line: string;
  features: Feature[];
  two?: boolean;
}): JSX.Element {
  return (
    <section id={id} className="section chapter" aria-labelledby={`${id}-h`}>
      <div className="chap rise">
        <h2 id={`${id}-h`}>
          <span className="tag" style={{ background: color }} />
          {name}
        </h2>
        <p>{line}</p>
      </div>
      <div className={two ? 'board feat two' : 'board feat'}>
        {features.map((f) => (
          <div key={f.k} className="tile rise">
            <p className="k">{f.k}</p>
            <h3>{f.h}</h3>
            <p className="say">{f.p}</p>
            <div className="m">{f.mock}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Review(): JSX.Element {
  return (
    <Chapter
      id="review"
      name="Review"
      color="var(--lapis)"
      line="Check the decisions, not every line. Limn does the first read and tells you where to look."
      features={[
        {
          k: 'Pending',
          h: 'What needs you next',
          p: 'Every open pull request across every repo, sorted by whose turn it is.',
          mock: <PendingListMock />,
        },
        {
          k: 'AI Review',
          h: 'A review on every push',
          p: 'Your own agent reviews each new commit and posts it to GitHub, if you switch that on.',
          mock: <ReviewMock />,
        },
        {
          k: 'Story and docs check',
          h: 'Built what was asked',
          p: "Each change is checked against its ticket's criteria and your own docs. Every finding cites its source.",
          mock: <StoryCheckMock />,
        },
      ]}
    />
  );
}

export function Fix(): JSX.Element {
  return (
    <Chapter
      id="fix"
      name="Fix"
      color="var(--gold)"
      line="Findings, red CI and merge conflicts, fixed on your branch. Nothing is pushed until you say so."
      features={[
        {
          k: 'AI Fix',
          h: 'Fix what the review found',
          p: 'Pick the findings. Limn writes the change and shows you the diff.',
          mock: <FixMock />,
        },
        {
          k: 'CI diagnosis',
          h: 'Why the build is red',
          p: 'Limn reads the failing log and says whether it is your code or a flaky test.',
          mock: <CiMock />,
        },
        {
          k: 'Conflicts',
          h: 'Resolve conflicts in the app',
          p: 'Both sides in one view. You pick, or ask Claude for a proposal you can check.',
          mock: <ConflictsMock />,
        },
      ]}
    />
  );
}

export function Ship(): JSX.Element {
  return (
    <Chapter
      id="ship"
      name="Ship"
      color="var(--verdigris)"
      line="Know what can land, land it when it's ready, and keep main green."
      features={[
        {
          k: 'Merge verdict',
          h: 'What is blocking it',
          p: 'One answer to "can this land?", with the reasons in order.',
          mock: <VerdictMock />,
        },
        {
          k: 'Merge when ready',
          h: 'Lands on its own',
          p: 'Arm it once. Limn merges when checks pass, and stops if anyone pushes.',
          mock: <MergeWhenReadyMock />,
        },
        {
          k: 'Trunk',
          h: 'Is main green?',
          p: 'The state of each main branch, and the pull request that broke it.',
          mock: <TrunkMock />,
        },
      ]}
    />
  );
}

export function See(): JSX.Element {
  return (
    <Chapter
      id="see"
      name="See"
      color="var(--madder)"
      line="Where the work is, where it waits, and what your review bots are worth."
      two
      features={[
        {
          k: 'Chronology',
          h: 'Where every hour goes',
          p: 'Each open hour belongs to someone: waiting for review, with the author, or waiting to land.',
          mock: <ChronologyMiniMock />,
        },
        {
          k: 'Bots',
          h: 'What your bots are worth',
          p: "Each review bot's comments scored for how serious they are, and what they cost.",
          mock: <BotsWorthMock />,
        },
      ]}
    />
  );
}
