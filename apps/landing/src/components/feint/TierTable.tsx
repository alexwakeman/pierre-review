import { INSTALL_COMMAND, SITE_NAME } from '../../lib/site';
import { InkButton, MonoLabel, RailGrid, Section, SignalButton } from './primitives';
import { ShotFrame } from './ShotFrame';

// ---------------------------------------------------------------------------
// The free-vs-Pro comparison and the sign-up block — ONE component, rendered at
// the bottom of every page on the site.
//
// WHY IT REPEATS. The site is four pages and two of them are addressed to
// different readers. Each one has to be able to answer "so what do I pay for?"
// at the point the reader finishes reading, without a nav hop — a reader who has
// just decided they want it should not have to go looking for the price.
//
// WHY THE ROWS ARE ORGANISED BY QUESTION, not by feature. A feature list invites
// counting; what actually separates the tiers is a change of GRAIN. Free answers
// everything about one pull request. Pro answers what a fortnight of them adds
// up to across a set of repositories. Every row below is a question, with the
// free answer and the paid one side by side, so the line reads as one rule
// rather than as forty items somebody chose to withhold.
//
// ⚠ CHECKOUT IS NOT WIRED, AND THE PAID BUTTON GOES TO /contact. There is no
// Stripe integration, so the offer on the page is the true one: ask, and Pro is
// switched on free for a month. That is not a placeholder for a missing checkout
// — it is deliberately how Pro is obtained right now, because what is wanted at
// this stage is people running it and saying what is wrong, which a form gets
// and a silent card payment does not.
//
// Do not quietly repoint this at a checkout URL, and do not remove the sentence
// explaining the month. A button that takes money it cannot take is the one
// thing on this page that would be a lie, and an offer whose terms are not
// stated is the second.
// ---------------------------------------------------------------------------

interface Row {
  q: string;
  free: string;
  pro: string;
}

const ROWS: Row[] = [
  {
    q: 'What is waiting on me?',
    free: 'The whole worklist, ranked. My Turn, review requests, red builds, conflicts — across every repository.',
    pro: 'Same list, with a written reason on each of the top items and a line saying what can safely wait.',
  },
  {
    q: 'What happened on this pull request?',
    free: 'Every thread triaged — untouched, replied, likely addressed, resolved. Blast radius, blockers, merge verdict.',
    pro: 'A short written summary, a read on what a red build means, and a check on whether a comment was really addressed.',
  },
  {
    q: 'Can I act without leaving?',
    free: 'Reply, resolve, approve, merge, merge-when-ready, update from trunk, resolve conflicts hunk by hunk.',
    pro: 'Everything free does. Acting on a pull request is never the paid part.',
  },
  {
    q: 'Which review bots are worth their seat?',
    free: 'Detect every bot, name it, set its role and record what it costs — and an independent severity grade on every comment it leaves.',
    pro: 'The per-bot scoreboard: keep / tune / noisy, dollars per comment your team acted on, over-calling as a weekly line.',
  },
  {
    q: 'How does that compare to other teams?',
    free: '—',
    pro: 'Your bots placed against a 2,204-repository cohort, with a written refusal wherever the cohort is too thin to answer.',
  },
  {
    q: 'How is the team doing?',
    free: 'Flow metrics for the workspace, activity and reach by repository, open pull requests and trunk health.',
    pro: 'A stored report per sprint or month, compared like-for-like against the last one, with the coverage stated.',
  },
  {
    q: 'Is a repository about to bite us?',
    free: 'Default-branch health across every repository, the commit that broke it, and the pull request that landed it.',
    pro: 'Everything free does. Trunk health is never the paid part — it is the thing you need at the worst moment.',
  },
  {
    q: 'Where is the time actually going?',
    free: '—',
    pro: 'Chronology: every open hour attributed to a reviewer, an author, or waiting to land. Nobody is named.',
  },
  {
    q: 'What do I take into a one-to-one?',
    free: '—',
    pro: 'A report with a section per person you pick. Preparation, not a ranking — there is no leaderboard anywhere in it.',
  },
  {
    q: 'Can I keep the noise down?',
    free: 'Bots hidden by default, notifications only for work that is personally yours, and a per-repository mute.',
    pro: 'Everything free does, plus a Slack digest per workspace if you would rather read it there.',
  },
  {
    q: 'Where does it run?',
    free: `${INSTALL_COMMAND} on your machine, or the hosted service. No repository limit, no user limit.`,
    pro: 'The same two places. Pro unlocks on whichever one you already use.',
  },
];

export function TierTable(): JSX.Element {
  return (
    <>
      <Section divider="ink" pad="none" className="py-14" id="pricing">
        <RailGrid rail={{ word: 'Free vs Pro' }} cols="one">
          <div>
            <h2 className="mb-6 max-w-[30ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Free answers one pull request. Pro answers the fortnight.
            </h2>
            <p className="mb-10 max-w-[62ch] text-pretty text-lede text-ink-soft">
              {SITE_NAME} is open core. The free tier is the product, not a trial — it has
              no repository limit, no user limit and no expiry, and every action you take
              on a pull request lives in it. Pro is what happens when you need the same
              truth one grain up: across repositories, across people, across a period.
            </p>

            {/* Ruled rows, not cards. Three columns on the rail breakpoint, stacked
                below it — where each row becomes a question with two labelled
                answers under it, which is the only form that stays readable narrow. */}
            <div className="border-t border-ink">
              <div className="hidden gap-grid-gutter border-b border-rule-strong py-3 rail:grid rail:grid-cols-[1.1fr_1.3fr_1.3fr]">
                <MonoLabel className="text-secondary">Question</MonoLabel>
                <MonoLabel className="text-secondary">Free · open core</MonoLabel>
                <MonoLabel className="text-signal-text">Pro · free for a month</MonoLabel>
              </div>

              {ROWS.map((r) => (
                <div
                  key={r.q}
                  className="grid gap-x-grid-gutter gap-y-2 border-b border-rule-hair py-[18px] rail:grid-cols-[1.1fr_1.3fr_1.3fr]"
                >
                  <p className="font-display text-list font-semibold text-ink">{r.q}</p>
                  <div>
                    <MonoLabel className="mb-1 text-secondary rail:hidden">Free</MonoLabel>
                    <p className="text-list text-ink-body">{r.free}</p>
                  </div>
                  <div>
                    <MonoLabel className="mb-1 text-signal-text rail:hidden">Pro</MonoLabel>
                    <p className="text-list text-ink-body">{r.pro}</p>
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-6 max-w-[62ch] font-mono text-mono-caption text-secondary">
              Pro lists at $25 per user, and is free for a month to anyone who asks for it.
              A user is someone who signs in — bots never count, and there is no
              per-repository charge.
            </p>

            <ShotFrame
              src="/shots/free-reports.png"
              alt="The Reports pane on a free account: the flow metrics render in full, and the paid period-report panel below them is listed, badged and locked rather than hidden"
              caption="limn · reports, free account"
              height={460}
              fit="cover"
              className="mt-10"
              note="What a free account actually sees. The paid panes are listed and locked rather than hidden, so you can tell what you are not buying before you buy it — and the free metrics above them are the ones that moved here off another tab."
            />
          </div>
        </RailGrid>
      </Section>

      <Section divider="none" pad="lg">
        <RailGrid rail={{ word: 'Start' }} cols="one">
          <div>
            <h2 className="mb-5 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2-major">
              Start free. Every repository, nothing missed.
            </h2>
            <p className="mb-9 max-w-[56ch] text-pretty text-lede text-ink-soft">
              Sign in with GitHub and the first repositories are on screen in a couple of
              minutes, or run the whole free tier on your own machine and keep the data
              there. For Pro, send a message — it is free for a month, for asking.
            </p>

            <div className="mb-5 flex flex-wrap items-center gap-3.5">
              <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
              <SignalButton to="/contact?topic=pro">Ask for a free month of Pro</SignalButton>
            </div>

            <p className="max-w-reassure font-mono text-mono-nav text-secondary">
              Card payments are not switched on yet, so Pro is not sold from this page — it
              is given, a month at a time, to anyone who asks. No card, nothing to cancel.
              Or run the free tier locally: <span className="text-ink">{INSTALL_COMMAND}</span>
            </p>
          </div>
        </RailGrid>
      </Section>
    </>
  );
}
