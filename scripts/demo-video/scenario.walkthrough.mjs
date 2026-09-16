// THE 30-SECOND WALKTHROUGH — the click-to-play clip on the landing page.
//
// A SCENARIO IS DATA. Everything specific to this particular tour lives in this
// file; `scripts/capture-demo-video.mjs` knows nothing about the Feed or the
// Pending board. A DIFFERENT TOUR IS A DIFFERENT FILE IN THIS FOLDER, never a
// flag on the script — see apps/landing/README.md § Demo video.
//
// ---------------------------------------------------------------------------
// FOUR SCREENS, NOT FIVE. "Check the changes" was in the brief and is NOT here.
// The Changes tab hydrates its patches from GitHub on demand and the demo's
// repositories do not exist there, so against this database it correctly renders
// "inline diffs aren't available for this PR" — the same reason there is no
// `pr-changes.png` still. Filming an empty state is not filming a feature. Do
// not re-add the scene without first giving the demo a real diff to render.
//
// SEVEN AND A HALF SECONDS A SCREEN, not six. At six the reader is still reading
// the caption when the screen changes; the extra 1.5s is the difference between
// a screen that has settled and one that has not.
//
// EVERY SCENE'S CUT IS HARD. A cross-fade changes every pixel in the frame for
// its whole duration, which is the single most expensive thing you can ask of an
// inter-frame codec: the four dissolves this clip does not have would have cost
// more bitrate than the four scroll passes it does.
// ---------------------------------------------------------------------------

/** @type {import('../capture-demo-video.mjs').Scenario} */
export default {
  name: 'limn-walkthrough',
  /** Hard ceiling, asserted after the timeline is built. The user asked for 30s. */
  budgetMs: 30_000,
  width: 1180,
  height: 664,
  /** Captions are burned below the app's pixels, never over them. */
  captionBarHeight: 46,
  /** H.264 cap. Static screens undershoot it by an order of magnitude. */
  videoBitsPerSecond: 700_000,

  scenes: [
    // ---- 1. the stream ----------------------------------------------------
    {
      id: 'feed',
      caption: 'Feed — every repository, one stream',
      url: '?view=activity&activityRepo=feed&feedTab=feed',
      ready: '[data-testid="feed-view"]',
      settleMs: 3200,
      steps: [
        { hold: 2600 },
        { scroll: { selector: '[data-testid="activity-overlay"] .overflow-y-auto', to: 1150, ms: 3000 } },
        { hold: 1750 },
      ],
    },

    // ---- 2. the free metrics ---------------------------------------------
    {
      id: 'flow-metrics',
      caption: 'Reports — throughput and lead time, people counted apart from bots',
      url: '?view=activity&activityRepo=insights',
      ready: '[data-testid="workspace-flow-metrics"]',
      settleMs: 3800,
      steps: [
        { hold: 2600 },
        { scroll: { selector: '[data-testid="activity-overlay"] .overflow-y-auto', to: 900, ms: 3000 } },
        { hold: 1750 },
      ],
    },

    // ---- 3. the worklist --------------------------------------------------
    {
      id: 'pending',
      caption: 'Pending — one ranked queue, and the top of it is finishable here',
      url: '?view=activity&activityRepo=attention',
      ready: '[data-testid="attention-view"]',
      settleMs: 3400,
      steps: [
        { hold: 2600 },
        { scroll: { selector: '[data-testid="activity-overlay"] .overflow-y-auto', to: 1000, ms: 3000 } },
        { hold: 1750 },
      ],
    },

    // ---- 4. one pull request, close up -----------------------------------
    // ⚠ CAPTURED AT deviceScaleFactor 2, and that is what makes the zoom honest.
    // Zooming a 1x capture is upscaling a raster — the detail you appear to move
    // closer to is invented by the interpolator. At 2x the wide frame is a
    // supersampled downscale and the close frame is drawn 1:1 from native pixels,
    // so the picture gets SHARPER as it closes rather than softer. The zoom may
    // therefore never ask for a region smaller than width/scale CSS px; the
    // script asserts it.
    {
      id: 'pr-detail',
      caption: 'One pull request — review standing, threads, and what is blocking it',
      url: '?pr=113',
      ready: '[data-testid="detail-pane"]',
      settleMs: 4000,
      scale: 2,
      pane: 430,
      steps: [
        { hold: 2400 },
        // The provenance chip is a NARROW element, and that is why it is the
        // target: every panel in this app is full-width at 1180px, and a zoom to
        // a full-width element is a zoom to the whole frame. The script refuses
        // one rather than holding still for 1.5s and calling it a push-in.
        // ⚠ THE ANCHOR IS THE PANE'S OWN CHROME, NOT ANYTHING IN ITS CONTENT,
        // and both of the content elements tried first cost a failed run:
        // `reviewer-provenance` and `bot-triage-card` are each present on most
        // loads and absent when the query behind them 502s against a demo stack
        // that has no GitHub behind it. The tab strip is structural — if it is
        // missing, the pane did not open and the scene deserves to fail.
        //
        // `offset` then shifts the FRAME, not the anchor. Without it the zoom
        // centres on a 77px tab near the top and shows the board above the pane;
        // with it, the frame is the block underneath — status, reviews, bots,
        // actions. And the LEFT edge matters: a centred frame guillotines the row
        // labels into "TUS", "EWS", "ONS", which reads as a broken capture.
        {
          zoom: {
            selector: '[data-testid="detail-pane"] button:has-text("Overview")',
            ms: 1500,
            pad: 14,
            maxWidth: 620,
            anchor: 'left',
            offset: [0, 138],
          },
        },
        { hold: 2400 },
        { zoomOut: { ms: 1000 } },
        { hold: 200 },
      ],
    },
  ],
};
