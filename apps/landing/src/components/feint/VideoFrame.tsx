import { useCallback, useEffect, useRef, useState } from 'react';
import { MonoLabel } from './primitives';

// ---------------------------------------------------------------------------
// The walkthrough player: one screen recording, framed exactly like a
// screenshot, with its chapters beside it as real HTML text.
//
// The frame is `ShotFrame`'s: a 1px hairline plus an 11–12px mono caption bar.
// No window chrome, no play-button chrome borrowed from a video site, no
// rounded corners, no shadow. Same argument as the stills — the product has to
// look like real software, not like a marketing render of software.
//
// ---------------------------------------------------------------------------
// WHY THE CHAPTERS ARE TEXT AND NOT PIXELS. The captions used to be burned into
// the frames by the capture script. Burned-in text is unreadable to a screen
// reader, unselectable, unsearchable, untranslatable, and it is stuck at
// whatever size the encoder happened to render it. The capture now emits a cue
// file beside the clip, and this component renders those cues as a list the
// page owns: readable before play, readable with JavaScript off, readable by a
// crawler, and lit as playback reaches each one.
//
// That also makes the reduced-motion fallback a genuinely good one rather than
// a concession. A reader who has asked their system for less motion gets the
// poster still plus every word the clip would have shown them, and a Play
// button if they want it anyway.
//
// ---------------------------------------------------------------------------
// ⚠ THIS COMPONENT OWNS THE SITE'S MOTION POLICY, because a <video> escapes the
// one that was already there.
//
// The standing rule is that the site does not move. The blanket in index.css
// kills `animation` and `transition`, and a playing video is NEITHER — exactly
// the hole the hero rain already had to fill for a rAF canvas loop. So:
//
//   · the clip reads `matchMedia('(prefers-reduced-motion: reduce)')` itself,
//     subscribes to its `change` event, and under reduced motion mounts NO
//     <video> at all: the poster still, the chapter list, and a Play button.
//     No element, no bytes, nothing playing until somebody asks.
//   · it is `muted` + `playsInline`, and the file carries no audio track
//     whatsoever — the mute is belt and braces, not the guarantee.
//   · ⚠ `loop` IS NEVER SET. The clip plays ONCE. A looping screen recording on
//     a page is motion the reader never asked to have repeated, and it is the
//     one thing a reduced-motion setting is most obviously about. Ending is the
//     feature; the Replay button is how it repeats.
//
// ⚠ DO NOT RELY ON A HEADER TO ENFORCE ANY OF THAT. `Permissions-Policy:
// autoplay=(...)` is the server's opinion about whether autoplay is ALLOWED; it
// says nothing about what the reader asked for, and it is not delivered at all
// by the Vite dev server. The check has to be in the page.
//
// ---------------------------------------------------------------------------
// ⚠ NOTHING HERE MAY READ `video.duration`. The file is a FRAGMENTED MP4
// straight out of MediaRecorder with no `sidx` and no total duration in its
// header, so `duration` reads Infinity or NaN until enough of it has buffered —
// and on a server with no Range support it settles on a figure that is simply
// wrong. Every position in this component is an ABSOLUTE `currentTime` in
// seconds compared against an absolute cue start in milliseconds. No fractions
// of a duration, no progress bars of our own, nothing gated on the duration
// being finite.
//
// ⚠ THE LAST CUE'S `endMs` OVERSHOOTS THE FILE. The cue file is generated from
// the capture timeline, which ends a frame or so past where the container
// actually stops (28,123 ms of cues against 28,013 ms of video). So `endMs` is
// NEVER consulted: the active chapter is the LAST one whose `startMs` has been
// passed, which makes the final cue "until the end" by construction, and
// nothing ever seeks to an `endMs`.
//
// ⚠ SEEKING NEEDS HTTP RANGE, AND IT FAILS SILENTLY WITHOUT IT. Served through
// `@fastify/static` — which is what `app.ts` serves this site with — the file
// answers `accept-ranges: bytes` and a ranged GET returns `206` with a correct
// `content-range`, so the chapter list seeks.
//
// ⚠ AND `seekable.length === 0` IS NOT THE TELL. MEASURED in Chromium against a
// server that ignores Range: `seekable.length` is 1, not 0 — it just ends at
// 8.32 s on a 28 s clip, because the decoder never got past the first fragment,
// and `duration` reports that same 8.32 s with no error anywhere. A click on a
// later chapter then moves the playhead BACKWARDS. So the empty-range check
// below is belt and braces; what actually catches it is VERIFYING after the
// fact that the playhead landed where it was sent. A control that did not move
// it stops rendering as a button, because a dead control that still looks
// clickable is worse than no control.
// ---------------------------------------------------------------------------

/** One chapter of the clip. Written by the capture pipeline, read here. */
export type VideoCue = {
  id: string;
  /** Absolute offset from the start of the clip, in milliseconds. */
  startMs: number;
  /** Present in the cue file and deliberately unused here — see the header. */
  endMs: number;
  title: string;
  text: string;
};

/** How far past a seek target playback may have run before we believe the seek landed. */
const SEEK_TOLERANCE_S = 2;
/** Long enough for a seek to complete, short enough that a dead control stops lying quickly. */
const SEEK_VERIFY_MS = 600;

/** A chapter's start as mm:ss. */
function stamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  return `${Math.floor(total / 60)}:${s < 10 ? '0' : ''}${s}`;
}

/** The last cue whose start has been passed. `endMs` is never consulted — see the header. */
function cueIndexAt(cues: readonly VideoCue[], ms: number): number {
  let idx = 0;
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    if (!cue || ms < cue.startMs) break;
    idx = i;
  }
  return idx;
}

const FOCUS =
  'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink';

export function VideoFrame({
  src,
  poster,
  alt,
  caption,
  meta,
  width,
  height,
  cues,
  className = '',
}: {
  /** The .mp4, from `public/demo/`. */
  src: string;
  /** The still shown before play, and instead of play under reduced motion. */
  poster: string;
  /** What the recording shows, for a reader who cannot see it. */
  alt: string;
  /** The left-hand label in the caption bar, e.g. "limn · the walkthrough". */
  caption: string;
  /** The right-hand fact in the caption bar, e.g. "28 seconds · no sound". */
  meta: string;
  /**
   * The RECORDING's own pixel dimensions, used as an aspect ratio only.
   *
   * ⚠ A VIDEO GETS AN ASPECT RATIO, NOT A FIXED HEIGHT, and that is the one place
   * this frame departs from `ShotFrame`. A still is cropped to a design height by
   * `object-cover` and loses only the bottom of a long panel; cropping a clip
   * would cut the app's own interface off mid-screen for its whole length.
   */
  width: number;
  height: number;
  /** The chapters, in order, from the clip's cue file. */
  cues: readonly VideoCue[];
  className?: string;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const seekToken = useRef(0);

  const [mounted, setMounted] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [started, setStarted] = useState(false);
  const [playFailed, setPlayFailed] = useState(false);
  const [ended, setEnded] = useState(false);
  const [active, setActive] = useState(0);
  /** Turned off for good the first time a seek provably does not take. */
  const [canSeek, setCanSeek] = useState(true);

  // ⚠ `mounted` IS LOAD-BEARING, NOT CEREMONY. The landing is PRERENDERED per
  // route, so without it the static HTML carries a <video> — written before
  // anything has been able to ask about reduced motion, onto a page a reader
  // with JS off never hydrates. The first paint is the still and the chapter
  // list; the clip is a decision the browser makes afterwards.
  useEffect(() => {
    setMounted(true);
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(q.matches);
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    q.addEventListener('change', onChange);
    return () => q.removeEventListener('change', onChange);
  }, []);

  /** Is a <video> element on the page at all? Everything live keys off this. */
  const hasVideo = mounted && (!reduced || started);

  useEffect(() => {
    if (!hasVideo) return;
    const el = videoRef.current;
    if (!el) return;
    el.play().catch(() => setPlayFailed(true));
  }, [hasVideo]);

  /** The Play / Replay overlay. `started` covers the reduced-motion first press. */
  const requestPlay = useCallback((): void => {
    setStarted(true);
    setPlayFailed(false);
    const el = videoRef.current;
    if (!el) return; // Under reduced motion there is no element yet; the effect above plays it.
    if (el.ended) el.currentTime = 0;
    setEnded(false);
    el.play().catch(() => setPlayFailed(true));
  }, []);

  const seekTo = useCallback((startMs: number): void => {
    const el = videoRef.current;
    if (!el) return;
    const target = startMs / 1000;
    // The highlight is NOT moved here. It follows `timeupdate` and nothing else, so
    // it always states where playback actually is rather than where it was asked to go.
    el.currentTime = target;
    setEnded(false);
    el.play().catch(() => setPlayFailed(true));

    seekToken.current += 1;
    const token = seekToken.current;
    window.setTimeout(() => {
      // A later click owns the playhead now; this verification is stale.
      if (seekToken.current !== token) return;
      const now = videoRef.current;
      if (!now) return;
      if (now.seekable.length === 0 || Math.abs(now.currentTime - target) > SEEK_TOLERANCE_S) {
        setCanSeek(false);
      }
    }, SEEK_VERIFY_MS);
  }, []);

  const seekable = hasVideo && canSeek;
  const activeCue = cues[active];

  return (
    <div className={className}>
      <div className="grid gap-8 rail:grid-cols-[minmax(0,1fr)_280px] rail:items-start">
        <figure className="border border-rule">
          <figcaption className="flex items-center justify-between border-b border-rule px-4 py-[11px] font-mono text-mono-caption text-secondary">
            <span>{caption}</span>
            <span>{meta}</span>
          </figcaption>

          {/* The ratio lives on this span, not on the media, so the frame reserves
              its space before either loads and never reflows when the poster is
              swapped for the video. */}
          <span
            style={{ aspectRatio: `${width} / ${height}` }}
            className="relative block w-full overflow-hidden bg-paper"
          >
            {hasVideo ? (
              <video
                ref={videoRef}
                src={src}
                poster={poster}
                muted
                playsInline
                controls
                preload="auto"
                aria-label={alt}
                className="h-full w-full object-cover"
                onTimeUpdate={(e) => setActive(cueIndexAt(cues, e.currentTarget.currentTime * 1000))}
                onPlaying={() => {
                  setEnded(false);
                  setPlayFailed(false);
                }}
                // ⚠ The playhead is LEFT WHERE IT STOPPED. Rewinding to 0 here would
                // throw the reader back to the first screen the moment the last one
                // finished, and un-light the chapter they were just reading.
                onEnded={() => setEnded(true)}
              />
            ) : (
              <img
                src={poster}
                alt={alt}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            )}

            {/* Play, or Replay once it has run. A real <button> over the frame — not a
                glyph painted into the poster — so it is reachable by keyboard. The
                wrapper passes clicks through to the native controls underneath it.
                ⚠ Gated on `mounted` for the same reason the seek control is gated on a
                seek having worked: with JavaScript off this button could do nothing, and
                the static HTML must not offer a control that cannot act. */}
            {mounted && (ended || !hasVideo || playFailed) && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <button
                  type="button"
                  onClick={requestPlay}
                  className={`pointer-events-auto border border-ink bg-paper px-5 py-2.5 font-mono text-mono-nav text-ink transition-colors duration-hover ease-standard hover:bg-ink hover:text-paper ${FOCUS}`}
                >
                  {ended ? 'Replay the walkthrough' : 'Play the walkthrough'}
                </button>
              </span>
            )}
          </span>
        </figure>

        <div>
          <MonoLabel className="mb-4 text-secondary">Chapters</MonoLabel>

          {/* Announced once per chapter — six times across the clip, and only while
              a video is actually mounted and moving. */}
          <p aria-live="polite" className="sr-only">
            {hasVideo && activeCue ? `Now showing: ${activeCue.title}` : ''}
          </p>

          <ol className="border-t border-rule">
            {cues.map((cue, i) => {
              const isActive = hasVideo && i === active;
              // Before anything plays — the static HTML, the poster, reduced motion —
              // no chapter is "current", so nothing is dimmed. Dimming starts only
              // once there is a playhead for it to mean something against.
              const dim = hasVideo && !isActive;

              const body = (
                <>
                  <span className="flex items-baseline justify-between gap-3">
                    <span
                      className={`font-mono text-mono-nav ${isActive ? 'text-ink' : 'text-ink-body'}`}
                    >
                      {cue.title}
                    </span>
                    <span className="font-mono text-mono-caption tabular-nums text-secondary">
                      {stamp(cue.startMs)}
                    </span>
                  </span>
                  <span
                    className={`mt-1 block text-[13px] leading-[1.5] ${dim ? 'text-muted' : 'text-ink-body'}`}
                  >
                    {cue.text}
                  </span>
                </>
              );

              const frame = `block w-full border-b border-l-2 border-b-rule py-3 pl-3.5 pr-1 text-left ${
                isActive ? 'border-l-signal-fill' : 'border-l-transparent'
              }`;

              return (
                <li key={cue.id}>
                  {seekable ? (
                    <button
                      type="button"
                      onClick={() => seekTo(cue.startMs)}
                      aria-current={isActive ? 'true' : undefined}
                      className={`${frame} transition-colors duration-hover ease-standard hover:bg-paper-alt ${FOCUS}`}
                    >
                      {body}
                    </button>
                  ) : (
                    // Not a button: nothing here can move the playhead, so nothing
                    // here may look as though it could.
                    <span className={frame} aria-current={isActive ? 'true' : undefined}>
                      {body}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
