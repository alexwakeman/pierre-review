import type { ReactNode } from 'react';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { SITE_NAME } from '../lib/site';
import { ALIEN_META, ALIEN_NAMES } from '../lib/sprites';
import type { SpriteRank } from '../lib/sprites';
import {
  InkButton,
  MonoLabel,
  RailGrid,
  RuledItem,
  Section,
  UnderlineLink,
} from '../components/feint/primitives';
import { Sprite, SPRITE_PALETTE } from '../components/feint/Sprite';
import { Cabinet } from '../components/feint/Cabinet';

// ---------------------------------------------------------------------------
// /arcade — "Inbox Invaders".
//
// An ORDINARY MARKETING ROUTE. The site Nav stays above it and the Footer below;
// the cabinet is a bordered frame between them, carrying its own chrome. There is
// no takeover, no modal, no autoplay and no sound until asked. The game is
// optional and subordinate: it is not in the nav, and it never obstructs "Sign in
// with GitHub".
//
// THE PROSE ON THIS PAGE IS LOAD-BEARING, not padding. prerender.mjs renders each
// route with renderToStaticMarkup and throws below 1,000 bytes of markup per
// route and 12,000 bytes for the smallest final file — and a <canvas> renders as
// exactly nothing in Node. What clears those floors is the attract overlay (which
// is the phase at SSR, so its title, subtitle, five sprites and prompt are real
// DOM), the cabinet's two chrome rows, and §02 below: twelve ruled rows, each
// carrying an inline <svg> of coalesced <rect> runs. Deleting §02 to "tidy the
// page" would break the build, silently, in CI.
//
// ESC AND THE SCROLL POSITION. The requirement is that Esc returns the player to
// the exact place they left. That is implemented in useGame's `exit()` as
// history.back(), NOT as a scrollY captured when this page mounts: the router
// pushes the new entry and only then scrolls to the top, so the browser has
// already snapshotted the previous page's scroll offset against its own history
// entry. Capturing scrollY here would capture zero. useGame also asserts
// history.scrollRestoration === 'auto' for the life of the route.
// ---------------------------------------------------------------------------

/** An inline key name in running copy. */
function Key({ children }: { children: string }): JSX.Element {
  return <span className="font-mono text-[16px] text-ink">{children}</span>;
}

const RANK_LABEL: Record<SpriteRank, string> = {
  1: 'Rank 1 · Chatter · 10 points',
  2: 'Rank 2 · Comms & calendar · 25 points',
  3: 'Rank 3 · Engineering · 50 points',
  boss: 'Boss · 250 points, three hits',
};

const CONTROLS: ReactNode[] = [
  <>
    <Key>←</Key> <Key>→</Key> or <Key>A</Key> / <Key>D</Key> move the craft. It is a caret,
    not a ship.
  </>,
  <>
    <Key>Space</Key> fires — and there is only ever one shot of yours on screen. That single
    constraint is the whole game: every shot you take is a shot you are not taking somewhere
    else.
  </>,
  <>
    Hold <Key>F</Key> for half a second to spend a focus segment and clear an entire column at
    once. Let go early and it costs you nothing.
  </>,
  <>
    Focus refills from exactly one thing: clearing a review request. The work that matters is
    what buys you the ability to batch the rest.
  </>,
  <>
    Four filters sit between you and the rack. They erode from alien fire, from your own fire,
    and from the rack descending through them.
  </>,
  <>
    <Key>P</Key> pauses, <Key>M</Key> toggles sound. Sound is off until you ask for it, and the
    game pauses itself the moment the tab loses focus.
  </>,
  <>
    <Key>Esc</Key> returns you to the site, at the scroll position you left.
  </>,
];

export default function Arcade(): JSX.Element {
  useSeo(seoFor('/arcade'));

  return (
    <>
      {/* ---------- lead-in ---------- */}
      <Section divider="none" pad="none" className="pb-10 pt-20">
        <MonoLabel wide className="mb-6 text-secondary">
          Optional · no sign-up
        </MonoLabel>
        <h1 className="mb-6 max-w-[24ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-page-title">
          {'Ninety seconds of the thing '}
          {SITE_NAME}
          {' takes off your desk.'}
        </h1>
        <p className="max-w-lede text-lede text-ink-soft">
          Inbox Invaders is a small arcade game about a Tuesday. Twelve kinds of notification
          descend in four ranks — channel pings, group chats, calendar invites, @-mentions, repo
          events, CI failures, a review bot — and you clear what you can with one beam and five
          units of focus. It is unwinnable, on purpose. Keyboard only, no sign-up, about ninety
          seconds. Press Esc to come back.
        </p>
      </Section>

      {/* ---------- the cabinet ----------
          Full canvas width, between the Nav and the Footer, carrying its own
          header and HUD rows. Not letterboxed, not a takeover. */}
      <div className="mx-gutter mb-16">
        <Cabinet />
      </div>

      {/* ---------- 01 · play ---------- */}
      <Section id="how-to-play">
        <RailGrid rail={{ n: '01', word: 'Play' }} cols="one">
          <div>
            <h2 className="mb-5 font-display text-h2-sm font-semibold text-ink type:text-h2">
              One beam, three lives, no win state.
            </h2>
            <p className="mb-9 max-w-[64ch] text-lede">
              The physics are the 1978 original’s, faithfully: one alien is advanced per frame,
              so the rack accelerates as you thin it out; the march drops and reverses the moment
              it touches a wall; and the instant it reaches your row, it is over. What is new is
              what the sprites are.
            </p>
            <ul className="flex max-w-answer flex-col">
              {CONTROLS.map((item, i) => (
                <RuledItem key={i} last={i === CONTROLS.length - 1}>
                  {item}
                </RuledItem>
              ))}
            </ul>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 02 · the rack ----------
          Twelve ruled rows, each with its bitmap. This is also the section that
          carries the page over the prerender byte floor — see the header note. */}
      <Section id="the-twelve" tone="alt">
        <RailGrid rail={{ n: '02', word: 'The rack' }} cols="one">
          <div>
            <h2 className="mb-5 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Twelve kinds of interruption.
            </h2>
            <p className="mb-9 max-w-[64ch] text-lede">
              Every sprite is an original bitmap and every one behaves differently — the way the
              real thing does. Nothing here is a re-skin of a shared enemy; the group chat splits,
              the email takes two hits, the meeting freezes you, and the notebook simply refuses
              to leave.
            </p>

            <ul className="border-t border-ink">
              {ALIEN_NAMES.map((name, i) => {
                const meta = ALIEN_META[name];
                const previousName = i === 0 ? undefined : ALIEN_NAMES[i - 1];
                const newRank = !previousName || ALIEN_META[previousName].rank !== meta.rank;

                return (
                  <li key={name} className="border-b border-rule-strong">
                    {newRank && (
                      <MonoLabel className="pt-5 text-secondary">
                        {RANK_LABEL[meta.rank]}
                      </MonoLabel>
                    )}
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
                      <span className="flex w-[44px] shrink-0 justify-center">
                        <Sprite name={name} cell={3} {...SPRITE_PALETTE.onPaper} />
                      </span>
                      <span className="w-[160px] shrink-0">
                        <span className="block font-display text-[17px] font-semibold text-ink">
                          {meta.label}
                        </span>
                        <MonoLabel className="text-secondary">{meta.source}</MonoLabel>
                      </span>
                      <span className="min-w-[24ch] flex-1 text-list">
                        {meta.behaviour}
                        {/* The joke that has to be noticed. */}
                        {name === 'notebook' && (
                          <MonoLabel className="mt-1.5 text-ink">Cannot be cleared</MonoLabel>
                        )}
                      </span>
                      <span className="shrink-0 font-mono text-mono-caption text-secondary">
                        {meta.points} pts
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 03 · why ---------- */}
      <Section id="why">
        <RailGrid rail={{ n: '03', word: 'Why' }} cols="one">
          <div>
            <h2 className="mb-5 font-display text-h2-sm font-semibold text-ink type:text-h2">
              The game is the argument, played badly on purpose.
            </h2>
            <div className="flex max-w-[64ch] flex-col gap-5 text-body-sm">
              <p>
                Every sprite is a real interruption: a channel ping, a group chat that becomes two
                group chats, a meeting that freezes you mid-thought, a review bot that files forty
                comments of which three are worth reading. You can clear a column at a time, but
                only by spending focus you earned doing the work that mattered — and the rack
                still lands.
              </p>
              <p>
                {SITE_NAME} is the version where that does not happen. Same firehose, sorted
                before it reaches you: what is stalled, whose turn it is, and which of the bot’s
                comments a human still needs to read. The game ends in defeat because the point is
                that the firehose wins. The dashboard is the part where it does not.
              </p>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- closing CTA ---------- */}
      <Section divider="ink" pad="lg">
        <div className="flex flex-col gap-10 rail:flex-row rail:items-end rail:justify-between rail:gap-14">
          <h2 className="max-w-[22ch] font-display text-h2-sm font-semibold text-ink type:text-cta">
            The real version sorts it before you see it.
          </h2>
          <div className="flex shrink-0 flex-wrap items-center gap-6">
            <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
            <UnderlineLink to="/features">See what’s free</UnderlineLink>
          </div>
        </div>
      </Section>
    </>
  );
}
