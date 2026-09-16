// THE WALKTHROUGH — the ONE demo clip, and the hero of the landing page.
//
// A SCENARIO IS DATA. Everything specific to this particular tour lives in this
// file; `scripts/capture-demo-video.mjs` knows nothing about the Feed or the Bots
// rail. A DIFFERENT TOUR IS A DIFFERENT FILE IN THIS FOLDER, never a flag on the
// script — see apps/landing/README.md § Demo video.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED, AND WHY EACH OF IT
//
// ONE CLIP, NOT TWO. `scenario.hero.mjs` is deleted. It was an eight-second loop
// of the Pending board playing by itself under the headline, and Pending is the
// screen that needs the most context to make sense of — a ranked queue reads as a
// list of rows until you know what ranked it. The walkthrough is the hero now, it
// autoplays, and NOTHING LOOPS: a reader who wants it again presses play.
//
// NO PENDING SCENE AT ALL. Its explanation moved to the landing copy, where
// sentences are cheap. A board is a bad opening argument.
//
// SIX SCREENS, AND THE EDIT IS SNAPPY ON PURPOSE. Nobody reads a UI in a
// marketing clip; they check whether it looks like a real tool. So each scene is
// a wide establishing beat, ONE short push-in on the thing that scene is about,
// and a beat to look at it — then a hard cut. That is also, exactly, what the
// byte budget wants: motion costs tens of times what a held frame costs, so the
// clip can afford six keyframes and a few seconds of movement, and nothing else.
// The two pressures agree here. Read the MOTION IS THE BUDGET section at the top
// of capture-demo-video.mjs before lengthening any `ms` below.
//
// NO SCROLLS. A scroll is priced like a zoom in BITRATE and far worse in phase 1:
// every frame is its own 3540x1992 screenshot, decoded all at once in phase 2. A
// `set` step repositions a screen for free and the next hold cuts to it.
//
// EVERY SCENE'S CUT IS HARD. A cross-fade changes every pixel in the frame for
// its whole duration, which is the single most expensive thing you can ask of an
// inter-frame codec: five dissolves would cost more than every zoom here.
//
// ---------------------------------------------------------------------------
// CAPTIONS ARE CUES NOW. `title` + `text` per scene become
// `limn-walkthrough.cues.json` beside the video — the landing page renders them
// as HTML, as a clickable chapter list. The strings are still product voice:
// plain English, shortest honest version, and NAME THE THING.
// ---------------------------------------------------------------------------

/** The overlay that every Activity-console screen scrolls inside. */
const CONSOLE = '[data-testid="activity-overlay"] .overflow-y-auto';
/** The pull-request detail pane's own scroller. */
const PANE = '[data-testid="detail-pane"] .overflow-auto';

export default {
  name: 'limn-walkthrough',
  /** Hard ceiling, asserted after the timeline is built. The script caps it at 45s too. */
  budgetMs: 45_000,
  width: 1180,
  height: 664,

  scenes: [
    // ---- 1. the stream ----------------------------------------------------
    // The feed rows are ~560px below the fold on load (the brief strip and the
    // trunk-status panel come first), so `before` puts them in the frame rather
    // than the clip spending three seconds scrolling to them.
    {
      id: 'feed',
      title: 'Feed',
      text: 'Every repository in one stream: pull requests, reviews, comments and builds.',
      url: '?view=activity&activityRepo=feed&feedTab=feed',
      ready: '[data-testid="feed-view"]',
      settleMs: 4000,
      // ⚠ 1950, NOT 560, AND THE REASON IS THE DATA. At 560 the frame lands on two
      // rows carrying the SAME comment body — a human "Review: Comment" and the
      // Claude Review echo of it, one minute apart — and under them the same
      // billing-service thread three times. Verbatim repetition on screen reads as
      // a bug in the product, not as a stream. 1950 lands on a resolved thread with
      // a real reply, two Request-Changes reviews on different pull requests, and
      // two PRs opened: five event kinds, four people, five repositories.
      before: async (page) => {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.scrollTop = 1950;
        }, CONSOLE);
        await page.waitForTimeout(700);
      },
      expect: { selector: '[data-testid="feed-view"] li', min: 4 },
      steps: [
        { hold: 1900 },
        // One row, close up — and `width`, not `maxWidth`, because a feed row is
        // a PARAGRAPH. At the tightest legal framing (590 CSS px) the comment ran
        // off both edges mid-word. 900 keeps whole lines and still reads as a
        // push-in.
        // Anchored on an EVENT-KIND CHIP, not on a row. `li:has-text(...)` matches
        // the feed's own outer <li> container first — every row is inside it — so a
        // row-level text anchor zooms to the whole frame and the script refuses it.
        // A chip is a leaf. `offset` then walks the frame back to the feed column's
        // left edge, which no element of its own describes.
        {
          zoom: {
            selector: '[data-testid="feed-view"] span:text-is("Review: Request Changes")',
            ms: 480,
            width: 900,
            anchor: 'left',
            offset: [-245, 60],
          },
        },
        { hold: 2000 },
      ],
    },

    // ---- 2. the board -----------------------------------------------------
    // ⚠ THE TIMELINE IS THE SCENE THAT CAN FILM ITSELF EMPTY. vis-timeline
    // positions its bars inside `requestAnimationFrame`, so a renderer Chromium
    // considers backgrounded paints 47 correct group rows with every bar at x=0
    // and reports no error. Two defences, both required: the app browser carries
    // CAPTURE_LAUNCH_ARGS (scripts/lib/demo-browser.mjs), and this scene REFUSES
    // to film unless the bars are actually there.
    // ⚠ `?preset=30d` is not decoration — the 14d default leaves 8 bars on the
    // board and the shot reads as an empty product.
    {
      id: 'timeline',
      title: 'Timeline',
      text: 'The same work on a clock. Who opened what, when a review landed, what has been sitting.',
      url: '?view=timeline&preset=30d',
      ready: '.vis-timeline',
      settleMs: 9000,
      expect: { selector: '.vis-item.vis-range', min: 8 },
      steps: [
        { hold: 1900 },
        // Anchored on a GROUP LABEL down the left, because the labels are what
        // make the bars legible as people and repositories. `offset` drops the
        // frame onto the board itself instead of the filter bar above it.
        {
          zoom: {
            selector: '.vis-labelset .vis-label >> nth=1',
            ms: 480,
            width: 780,
            anchor: 'left',
            offset: [0, 110],
          },
        },
        { hold: 2100 },
      ],
    },

    // ---- 3. one pull request ----------------------------------------------
    // ⚠ PR 2348 (acme/search-service#648), NOT #113. #113's four likely-addressed
    // threads all carry `addressed_confidence = 'none'`, and the confidence pill
    // renders nothing for `none` — so the screen the caption describes was not on
    // screen. 2348 has 17 threads from three vendors and five likely-addressed
    // threads ALL at medium confidence.
    {
      id: 'pr-detail',
      title: 'One pull request',
      text: 'Review standing, every bot that has looked at it, and whether it can land.',
      url: '?pr=2348',
      ready: '[data-testid="detail-pane"]',
      settleMs: 5000,
      pane: 430,
      steps: [
        { hold: 1900 },
        // ⚠ THE ANCHOR IS THE PANE'S OWN CHROME, NOT ANYTHING IN ITS CONTENT, and
        // both content elements tried first cost a failed run: `reviewer-provenance`
        // and `bot-triage-card` are present on most loads and absent when the query
        // behind them 502s against a demo stack with no GitHub behind it. The tab
        // strip is structural — if it is missing, the pane did not open and the
        // scene deserves to fail.
        //
        // `offset` then shifts the FRAME, not the anchor: without it the zoom
        // centres on a 77px tab and shows the board above the pane. And the LEFT
        // edge matters — a centred frame guillotines the row labels into "TUS",
        // "EWS", "ONS", which reads as a broken capture.
        {
          zoom: {
            selector: '[data-testid="detail-pane"] button:has-text("Overview")',
            ms: 480,
            pad: 14,
            maxWidth: 760,
            anchor: 'left',
            offset: [0, 150],
          },
        },
        { hold: 2100 },
      ],
    },

    // ---- 4. was the comment actually dealt with? --------------------------
    // The stored `addressed` judgement on thread 38336 of PR 2348, read back
    // through the cached-read path — no model call, no billing, nothing live.
    // ⚠ IT IS SEEDED DATA AND THE SCENE SAYS SO BY FAILING WITHOUT IT: `expect`
    // refuses the run if the panel is not on screen, rather than filming a thread
    // with no verdict under a caption promising one.
    {
      id: 'addressed',
      title: 'Was it dealt with?',
      text: 'A bot raised a concern and the branch moved on. This reads the diff since, and says what is still open.',
      url: '?pr=2348',
      ready: '[data-testid="detail-pane"]',
      settleMs: 5000,
      pane: 520,
      before: async (page) => {
        await page
          .getByTestId('detail-pane')
          .getByRole('button', { name: /^Threads\d*$/ })
          .first()
          .click();
        await page.waitForTimeout(2600);
        // ⚠ THE JUDGED THREAD IS FOUND, NOT COUNTED TO. It is the 12th of 17 on
        // this pull request and sits 3,050px down a 3,707px scroller, so a
        // hard-coded `scrollTop` is a number that is right until somebody reseeds
        // the demo estate and then silently films a different thread. This scrolls
        // until the panel's own heading is at a chosen height instead, which is
        // wrong only if the panel is absent — and `expect` already refuses that.
        // ⚠ 430 IS INSIDE THE SCROLLER, NOT INSIDE THE VIEWPORT. The pane's own
        // sticky tab strip and state chips end around y=370, so a heading parked
        // at y=260 reports a healthy bounding box and is invisible — the capture
        // script refuses that now, but the number still has to be right.
        await page.evaluate(([sel, top]) => {
          const btn = [...document.querySelectorAll('button')].find((b) =>
            /Addressed check/.test(b.textContent ?? ''),
          );
          const scroller = document.querySelector(sel);
          if (btn && scroller) scroller.scrollTop += btn.getBoundingClientRect().top - top;
        }, [PANE, 430]);
        await page.waitForTimeout(800);
      },
      expect: { selector: 'button:has-text("Addressed check")', min: 1 },
      steps: [
        { hold: 2000 },
        {
          zoom: {
            selector: 'button:has-text("Addressed check")',
            ms: 480,
            width: 940,
            anchor: 'left',
            offset: [0, 90],
          },
        },
        { hold: 2300 },
      ],
    },

    // ---- 5. what the bots cost, and whether they are honest ---------------
    // ⚠ THE ROI TABLE IS 1680px WIDE INSIDE AN 868px PANEL. Its Inflation column
    // sits 375px outside a 1180px frame until something sets `scrollLeft`, and the
    // capture script REFUSES a zoom onto an off-frame target rather than clamping
    // the shot back into view and framing the wrong thing. So this scene opens on
    // the vendor names and volumes, then CUTS (a free `set`, no motion) down to
    // the severity-inflation charts, which carry the bot names with them — the
    // table's own Inflation column cannot show a name and a count in one frame.
    {
      id: 'bots',
      title: 'Bots',
      // ⚠ NO "what it costs" IN THIS LINE. The $/acted-on column exists, but it
      // sits at the far right of a 1680px table and neither of this scene's two
      // positions has it on screen — a caption may not claim what the picture
      // beside it does not show.
      text: 'Every review bot: how much it says, how much your team acts on, and how often it overstated a finding.',
      url: '?view=activity&activityRepo=bots&botsTab=roi',
      ready: '[data-testid="bot-roi-panel"]',
      settleMs: 5500,
      before: async (page) => {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.scrollTop = 420;
        }, CONSOLE);
        await page.waitForTimeout(700);
      },
      expect: { selector: '[data-testid="bot-roi-panel"] tbody tr', min: 5 },
      steps: [
        { hold: 1900 },
        { set: { selector: CONSOLE, scrollTop: 1225 } },
        { hold: 900 },
        // `ChartCard` renders its title as an <h4>, which is a narrow, stable
        // anchor in a panel whose every other box is full-width.
        {
          zoom: {
            selector: 'h4:text-is("Severity inflation")',
            ms: 480,
            width: 900,
            anchor: 'left',
            offset: [0, 130],
          },
        },
        { hold: 2100 },
      ],
    },

    // ---- 6. the numbers a manager asks for --------------------------------
    {
      id: 'reports',
      title: 'Reports',
      text: 'Throughput, lead time and review load, with people counted apart from automation.',
      url: '?view=activity&activityRepo=insights',
      ready: '[data-testid="workspace-flow-metrics"]',
      settleMs: 5000,
      steps: [
        { hold: 1900 },
        {
          zoom: {
            selector: '[data-testid="workspace-flow-metrics"]',
            ms: 480,
            pad: 0,
            maxWidth: 760,
            anchor: 'left',
            offset: [0, 40],
          },
        },
        { hold: 2100 },
      ],
    },
  ],
};
