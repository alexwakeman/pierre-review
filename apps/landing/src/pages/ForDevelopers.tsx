import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { INSTALL_COMMAND, SITE_NAME } from '../lib/site';
import {
  DashItem,
  InkButton,
  MonoLabel,
  RailGrid,
  Section,
  Story,
  UnderlineLink,
} from '../components/feint/primitives';
import { FeatureShot } from '../components/feint/FeatureShot';
import { ShotFrame } from '../components/feint/ShotFrame';
import { TierTable } from '../components/feint/TierTable';

// ---------------------------------------------------------------------------
// For developers — one of the site's two role pages.
//
// THE SHAPE IS FIXED AND SHARED WITH /for-managers: everything free, in full,
// first; then what Pro adds and why; then the comparison table and the sign-up.
// The order is the argument. A page that leads with the paid tier asks for a
// decision the reader has no basis for yet, and here the free tier is genuinely
// the thing that gets used every day.
//
// The developer's claim is narrow and concrete: your work is scattered across
// repositories you cannot all watch, and the review bots piled more on top.
// Every section names a specific screen and shows a close crop of it. Nothing
// here talks about visibility, insights or velocity — that is the manager's
// page, and only some of it is even true.
//
// ⚠ THE MULTI-REPO PROBLEM LEADS AND THE BOTS ARE A PEER SECTION (§05 of seven).
// An earlier cut opened with "every pull request is read by three or four review
// bots", which described the automation as the problem and narrowed the page to
// readers who already feel they have a bot problem. The larger, plainer truth is
// that six repositories do not fit in one head whether or not a bot is involved.
//
// ⚠ AND THE PROMISE IS ORDERING, NOT IDENTIFICATION. This page used to open
// "Three of the fifty are yours", which is a solved problem — GitHub already tells
// you that. What nothing holds is the ORDER: at any moment several of your own
// pull requests want something different (a build to fix, a review to answer, a
// thread to reply to, a conflict to clear), they arrive in no sequence at all, and
// they are spread across repositories you switch between all day. Narrowing to
// "what is most relevant to you, right now" is the product.
//
// ⚠ STATE THAT POSITIVELY. A first attempt at the fix ran the H2 "Knowing what's
// yours was never the hard part", which corrects the reader on something they
// never claimed and spends the page's opening line conceding rather than offering.
// Describe what the product does; never open by telling a developer what they
// already know.
// ---------------------------------------------------------------------------

// The competing demands, not a list of what is his. Each line is a DIFFERENT KIND
// of job, because the point is that they do not queue themselves.
const DAY = [
  'A build went red on the branch you pushed before you logged off.',
  'Someone answered a thread on a pull request you had already moved on from.',
  'Two reviews are waiting on you in a repository you only maintain.',
  'One of yours is ready to land and has been green since yesterday.',
  'And a conflict appeared overnight on the one you most wanted to finish.',
];

export default function ForDevelopers(): JSX.Element {
  useSeo(seoFor('/for-developers'));

  return (
    <>
      {/* ---------- hero ---------- */}
      <header className="px-gutter pt-hero-y">
        <MonoLabel wide className="mb-[26px] text-secondary">
          For developers
        </MonoLabel>
        <h1 className="mb-7 max-w-[20ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-hero">
          Everything that&rsquo;s yours, in order.
        </h1>
        <p className="mb-[34px] max-w-lede text-pretty text-lede text-ink-soft">
          A red build on one branch. Two reviews waiting on another. Six bot comments on the
          pull request you thought was finished, and a conflict that appeared overnight on
          the one that was ready to land. All of it is yours, and none of it tells you which
          to do first. {SITE_NAME} ranks the lot across every repository you work in — and
          lets you finish the top of it without leaving the page.
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-3.5">
          <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
          <UnderlineLink to="/for-managers">If you run the team →</UnderlineLink>
        </div>
        <p className="mb-11 max-w-reassure font-mono text-mono-nav text-secondary">
          Everything in the next six sections is free, with no repository limit. Run it on
          your own machine with <span className="text-ink">{INSTALL_COMMAND}</span> and it
          keeps no credentials at all.
        </p>
      </header>

      {/* ---------- 01 · the day ---------- */}
      <Section divider="ink">
        <RailGrid rail={{ n: '01', word: 'The day' }}>
          <div className="rail:col-span-2">
            <h2 className="mb-[30px] max-w-[28ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2-major">
              Your day arrives out of order.
            </h2>
            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <div>
                <p className="mb-6">
                  At any moment five different jobs want five different things from you — a
                  build to fix, a review to answer, a thread to reply to, a conflict to clear,
                  one sitting green and ready to land. They are all open, they all have your
                  name on them, and nothing puts them in a sequence.
                </p>
                <p className="mb-6">
                  Spread that across six repositories — a reviewer on some, an author on
                  others, a maintainer on a couple you rarely open — and layer three or four
                  review bots reading every pull request on top. The volume is not the problem
                  on its own. The problem is that none of it arrives sorted by how much it has
                  to do with you, today.
                </p>
                <p>
                  GitHub will tell you that something happened. It will not tell you what to
                  do first.
                </p>
              </div>
              <div>
                <ul className="flex flex-col gap-3.5">
                  {DAY.map((d) => (
                    <DashItem key={d}>{d}</DashItem>
                  ))}
                </ul>
                <Story moment="Free, always">
                  everything in sections 01 to 06 is in the open-core tier.
                </Story>
              </div>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 02 · Pending ---------- */}
      <FeatureShot
        rail={{ n: '02', word: 'Pending' }}
        tone="alt"
        heading="One queue, and the next thing at the top of it."
        src="/shots/pending-board.png"
        alt="The Pending board across four repositories: ready-to-merge, your-turn and in-your-repos cards, each with its CI state, file counts, reach chip and merge actions"
        caption="limn · pending"
        height={640}
      >
        <p className="mb-6">
          Review requests, threads somebody answered, red builds on your branches, conflicts
          you can clear, pull requests sitting green and ready to land — five different kinds
          of job, from every repository, in one list with the most actionable at the top.
        </p>
        <p className="mb-6">
          The ordering is the point, and it is code rather than a model. It weighs how close a
          job is to <em>finished</em> — an approved pull request outranks one still waiting on
          a review, a two-file change outranks a forty-file one, and a conflict or a wall of
          unanswered threads pushes a job down rather than up — then how long it has been
          sitting, then how directly it is tied to you. The rank is free on every tier; only
          the sentence explaining each row is Pro.
        </p>
        <p className="mb-6">
          A card exists only while you genuinely owe an action and have not taken it. There
          is nothing to tick off and nothing to dismiss, because the list is worked out fresh
          on every read rather than stored: act, and the card leaves on its own.
        </p>
        <p>
          The labels are careful about what they claim.{' '}
          <span className="text-ink">Your turn</span> means the work is tied to you.{' '}
          <span className="text-ink">In your repos</span> means somebody opened something on
          ground you maintain — orbit, not ownership. A card will not tell you a
          stranger&rsquo;s pull request is yours.
        </p>
        <Story moment="09:04">
          sixty-one items across five repositories, and the first three are the ones you can
          finish before standup.
        </Story>
      </FeatureShot>

      {/* ---------- 03 · threads ---------- */}
      <FeatureShot
        rail={{ n: '03', word: 'The threads' }}
        heading="Every review thread already triaged."
        src="/shots/pr-threads.png"
        alt="A pull request's thread list: each thread carrying a derived state, the vendor that opened it and a severity badge"
        caption="limn · threads"
        height={640}
      >
        <p className="mb-6">
          Each review thread carries a state worked out from the repository itself: resolved,
          replied but still open, untouched — or{' '}
          <span className="text-ink">likely addressed</span>, which means a commit touched
          that file after the comment landed.
        </p>
        <p className="mb-6">
          That last one is a heuristic and the interface says so wherever it appears. A
          rename or an unrelated edit can trip it. It is offered as a shortcut through forty
          bot threads, never as a verdict.
        </p>
        <p>
          Bot comments also arrive already graded for severity, by a classifier trained for
          this one job — free, and never the vendor&rsquo;s own badge, which is stored to be
          shown and not to be believed.
        </p>
        <Story moment="09:11">
          fifteen threads on one pull request; three still need you, and one button clears
          the rest.
        </Story>
      </FeatureShot>

      {/* ---------- 04 · act in place ---------- */}
      <FeatureShot
        rail={{ n: '04', word: 'Act in place' }}
        tone="alt"
        heading="Reply, approve, merge — from the board."
        src="/shots/pr-detail.png"
        alt="A pull request in detail: the merge verdict and its blockers, the reach chip, approve and merge controls, the bot triage grade and the review threads"
        caption="limn · pull request"
        height={640}
      >
        <p className="mb-6">
          One verdict answers &ldquo;can this land?&rdquo; and the action sits on the same
          row. Merge, or arm <span className="text-ink">merge when ready</span> and it lands
          the moment checks go green — pinned to the exact commit you looked at, so a new
          push disarms it rather than merging code you never saw.
        </p>
        <p className="mb-6">
          When GitHub refuses and will not say why, the pull request carries a ranked list of
          what is actually holding it, each line marked{' '}
          <span className="text-ink">proven</span> or{' '}
          <span className="text-ink">inferred</span> — because only some of it is knowable
          from what GitHub returns, and pretending otherwise is how a tool loses your trust.
        </p>
        <p className="mb-6">
          Conflicts are resolved in the app, hunk by hunk, with no worktree and no free
          typing anywhere in the flow. Running locally, that is free too.
        </p>
        <p>
          The header carries how far the change reaches — low, medium or high, with the
          reasons written out. It refuses rather than guesses: where GitHub truncated the
          file list it will assert &ldquo;high&rdquo; but never &ldquo;low&rdquo;, because a
          truncated list is always a floor.
        </p>
        <Story moment="09:19">
          two merged, one armed for when the build finishes, one conflict cleared.
        </Story>
      </FeatureShot>

      {/* ---------- 05 · what the bots said ----------
          ⚠ THIS SECTION USED TO BE THE DIFF, and it was changed because the
          screenshot could not be taken honestly: the Changes tab hydrates its
          patches from GitHub on demand, so against the seeded demo repositories
          it correctly renders "inline diffs aren't available". Rather than ship a
          picture of an empty state under a paragraph describing a file tree, the
          section now shows the screen that IS real here — and the blast-radius
          claim moved up to §04, where the chip is visible in the header. */}
      <FeatureShot
        rail={{ n: '05', word: 'The bots' }}
        heading="And the bot comments, graded before you read them."
        src="/shots/severity-strip.png"
        alt="What the bots are flagging across the workspace: total findings, the share graded high severity, the share that are nits, and the top categories"
        caption="limn · what the bots are flagging"
        height={520}
        fit="contain"
      >
        <p className="mb-6">
          Every bot-written comment is graded for severity — nit, minor, major, critical — by
          a purpose-trained ModernBERT classifier, served as an int8 ONNX artifact. It runs on
          the CPU you already have: no GPU, no API call, no comment leaving the machine, and
          nothing metered. Its eight categories come from a separate deterministic pass, so a
          category is reproducible rather than sampled.
        </p>
        <p className="mb-6">
          It is measured, not asserted. We hid every label a batch of real bot comments already
          carried and had them graded from scratch by a human expert. The model picked the same
          severity <strong>seven times in ten</strong> — which is exactly how often two human
          experts agreed with <em>each other</em> on the same comments, so it is reading them
          about as well as the job allows. CodeRabbit&rsquo;s own badge matched the expert fewer
          than five times in ten.
        </p>
        <p className="mb-6">
          Which is why the vendor&rsquo;s badge is stored and shown beside ours and never used
          as an input. Tuning towards agreement with it measurably moves the model away from
          ground truth, so the two are drawn apart rather than reconciled.
        </p>
        <p>
          Where two bots flagged the same lines, the pull request says so, so you read the
          finding once.
        </p>
        <Story moment="Nothing auto-acts">
          on a grade. Critical is under-recalled, so the product buckets major and critical
          together as &ldquo;high&rdquo; and leaves the decision with you.
        </Story>
      </FeatureShot>

      {/* ---------- 06 · the rest of the free tier ---------- */}
      <Section tone="alt">
        <RailGrid rail={{ n: '06', word: 'Also free' }}>
          <div className="rail:col-span-2">
            <h2 className="mb-[30px] max-w-[30ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              And the rest of it, still without paying.
            </h2>
            <div className="grid gap-grid-gutter rail:grid-cols-3">
              <div>
                <h3 className="mb-3 font-display text-h4 font-semibold text-ink">
                  The stream
                </h3>
                <p className="text-list text-ink-body">
                  One chronological feed across every repository in the workspace, with
                  automated accounts left out until you ask for them. Lenses for red builds
                  and for the kinds of pull-request event you care about.
                </p>
              </div>
              <div>
                <h3 className="mb-3 font-display text-h4 font-semibold text-ink">
                  Search and the board
                </h3>
                <p className="text-list text-ink-body">
                  Full-text search over titles, bodies and comments in every repository you
                  track, and a timeline that plots a fortnight of work per person per
                  repository so a catch-up is one picture.
                </p>
              </div>
              <div>
                <h3 className="mb-3 font-display text-h4 font-semibold text-ink">
                  Quiet by default
                </h3>
                <p className="text-list text-ink-body">
                  Notifications fire only for work that is personally yours, and a repository
                  you do not want claiming your turn can be muted without changing what
                  anybody else sees.
                </p>
              </div>
            </div>
          </div>
        </RailGrid>
        <ShotFrame
          src="/shots/feed.png"
          alt="The cross-repository activity feed: one chronological stream of opens, reviews, merges and comments across every repository in the workspace"
          caption="limn · feed"
          height={520}
          fit="cover"
          strong
          className="mt-10"
        />
      </Section>

      {/* ---------- 07 · what Pro adds ---------- */}
      <Section divider="ink">
        <RailGrid rail={{ n: '07', word: 'Pro' }}>
          <div>
            <MonoLabel className="mb-4 text-signal-text">Pro · $25 per user</MonoLabel>
            <h2 className="mb-6 max-w-[26ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              The reading, when the list gets long.
            </h2>
            <p className="mb-6 max-w-[58ch] text-pretty">
              Pro does not unlock an action. Everything you can do to a pull request you can
              already do for nothing, and that is deliberate — a tool that held back the
              merge button would be holding your work hostage.
            </p>
            <p className="mb-6 max-w-[58ch] text-pretty">
              What it adds is writing. A short summary at the top of a long pull request. A
              read on what a red build actually broke, rather than a link to a log. A reason
              on each of the top items in your worklist and a line saying what can wait. A
              check on whether a review comment was really addressed, judged from the commits
              since the thread started rather than from whether somebody clicked resolve.
            </p>
            <p className="max-w-[58ch] text-pretty">
              On a quiet week you will not miss it. On the week you come back to two hundred
              threads, it is the difference between reading them and triaging them.
            </p>
          </div>
          <ShotFrame
            src="/shots/pending-card.png"
            alt="A single Pending card showing its kind, the review standing, the merge verdict and the actions available on it"
            caption="limn · one card"
            height={300}
            fit="contain"
            note="Free ranks the list. Pro writes the reason on it."
          />
        </RailGrid>
      </Section>

      <TierTable />
    </>
  );
}
