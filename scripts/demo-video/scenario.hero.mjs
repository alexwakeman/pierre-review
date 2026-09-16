// THE HERO LOOP — the short silent clip that plays by itself at the top of the
// home page.
//
// ⚠ IT CARRIES NO BURNED CAPTIONS (`captionBarHeight: 0`). A caption is a thing
// to read, and a thing to read that moves on its own, beside a headline, is a
// competitor to the headline. The hero clip's only job is to show that the board
// is a real screen full of real work; the words are the page's.
//
// ⚠ IT IS ALSO THE REASON THE SITE'S MOTION POLICY IS NOW A JS CHECK. The site's
// standing rule is that it does not move, and the CSS blanket in
// apps/landing/src/index.css kills `animation` and `transition` — neither of
// which reaches a <video>. `VideoFrame.tsx` therefore reads
// `matchMedia('(prefers-reduced-motion: reduce)')` itself and renders the poster
// still instead of playing. Same obligation the hero rain already carries.
//
// ONE SCREEN, ONE SLOW PASS. An eight-second loop that cuts three times reads as
// a slideshow; the same eight seconds spent scrolling one board reads as someone
// working. It is also far cheaper: one scene means one keyframe.
export default {
  name: 'limn-hero',
  budgetMs: 10_000,
  width: 1180,
  height: 664,
  captionBarHeight: 0,
  // Lower than the walkthrough on purpose: this one autoplays on every visit to
  // the home page, so its bytes are paid by every visitor rather than by the few
  // who press play.
  videoBitsPerSecond: 600_000,

  scenes: [
    {
      id: 'pending',
      caption: null,
      url: '?view=activity&activityRepo=attention',
      ready: '[data-testid="attention-view"]',
      settleMs: 3400,
      steps: [
        { hold: 1800 },
        // A SLOW drift, not a fast pan, and that is a size decision as much as a
        // tonal one: the encoder pays for how far the picture moves between
        // frames, so 700px over 4.2s costs roughly a third of 1300px over 3.2s.
        // It also happens to be the right register for a page whose argument is
        // that the noise settles.
        { scroll: { selector: '[data-testid="activity-overlay"] .overflow-y-auto', to: 700, ms: 4200 } },
        { hold: 1800 },
      ],
    },
  ],
};
