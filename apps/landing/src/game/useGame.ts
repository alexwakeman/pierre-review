import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { navigate } from '../router';
import {
  MAX_CATCH_UP,
  TICK_MS,
  fieldCssHeight,
  fieldScale,
  logicalWidth,
} from './constants';
import type { GameEvent, GameSummary, HudSnapshot, Input, Phase, World } from './types';
import {
  createWorld,
  drainEvents,
  hudOf,
  resizeWorld,
  setReducedMotion,
  skipWaveBreak,
  startGame,
  summarise,
  tick,
} from './engine';
import {
  disposeAudio,
  isSoundEnabled,
  playSound,
  resumeAudio,
  setMarchTempo,
  setSoundEnabled,
  startMarch,
  stopMarch,
  suspendAudio,
} from './audio';
import type { SoundName } from './audio';
import { clearField, paintField } from './render';

// ---------------------------------------------------------------------------
// The React glue: one rAF loop, one keyboard host, one canvas.
//
// WHAT LIVES HERE AND NOWHERE ELSE
//   · the FIXED-TIMESTEP accumulator. The simulation runs at exactly 60 Hz
//     regardless of the display's refresh rate, and a long stall (a background
//     tab waking, a GC pause) is CLAMPED rather than caught up — MAX_CATCH_UP
//     ticks, then the accumulator is dropped on the floor. Without that clamp a
//     2-second stall would try to run 120 ticks in one frame, which takes longer
//     than a frame, which grows the accumulator further: the spiral of death.
//     There is NO interpolation between ticks. The visible ripple of the rack —
//     aliens ahead of the march cursor still at the old origin — IS the march,
//     and smoothing it away is the one thing that would stop it reading as the
//     original.
//   · keyboard binding ON THE FIELD ELEMENT, never on document. The page around
//     the cabinet is ordinary marketing prose and Space must still scroll it.
//     preventDefault is therefore scoped to the element that has focus. The one
//     exception is Escape, which is bound at document level once the player has
//     actually started, because "Esc gets me out" must work even if focus has
//     wandered to the game-over CTA.
//   · the audio bridge. Engine events are drained every tick batch and mapped to
//     one-shot sounds; the march tempo follows the live alien count.
//
// WHAT DOES NOT HAPPEN HERE
//   · no simulation while attracting or after game over (the brief's "~2% CPU
//     while attracting"). The loop is armed only for `playing` and `waveBreak` —
//     the break is a two-second engine countdown, so it needs ticks, but nothing
//     else in the world moves during it.
//   · nothing at module scope touches window/document/matchMedia/rAF. This page
//     is prerendered with renderToStaticMarkup in Node; a stray global would
//     take out `pnpm build`, not just the browser.
//
// prefers-reduced-motion is read in JS via matchMedia AND subscribed to, because
// index.css's blanket `animation: none` rule cannot reach a rAF loop.
// ---------------------------------------------------------------------------

const INITIAL_HUD: HudSnapshot = {
  phase: 'attract',
  wave: 1,
  score: 0,
  cleared: 0,
  unread: 0,
  lives: 3,
  focus: 2,
  focusCharging: false,
  frozen: false,
  saucerScore: null,
  waveBreakTicks: 0,
};

/** React re-renders at most every 4th tick (~15 Hz), never once per rack step. */
const HUD_PERIOD = 4;

/** Engine event -> one-shot sound. Events with no entry are silent by design. */
const EVENT_SOUND: Partial<Record<GameEvent['type'], SoundName>> = {
  fire: 'fire',
  alienCleared: 'clear',
  alienDamaged: 'damage',
  playerHit: 'playerHit',
  playerFrozen: 'freeze',
  unread: 'unread',
  focusCharging: 'focusCharge',
  focusSpent: 'focusFire',
  focusGained: 'saucer',
  saucerSpawn: 'saucer',
  saucerHit: 'saucer',
  extraLife: 'extraLife',
  waveCleared: 'waveClear',
  gameOver: 'gameOver',
};

export type UseGame = {
  fieldRef: RefObject<HTMLDivElement>;
  canvasRef: RefObject<HTMLCanvasElement>;

  hud: HudSnapshot;
  phase: Phase;
  summary: GameSummary | null;

  fieldHeight: number;
  scale: number;

  reducedMotion: boolean;
  focused: boolean;
  paused: boolean;

  soundOn: boolean;
  toggleSound: () => void;

  start: () => void;
  skipBreak: () => void;
  exit: () => void;
};

export function useGame(): UseGame {
  const fieldRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const worldRef = useRef<World | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const inputRef = useRef<Input>({ left: false, right: false, fire: false, focus: false });

  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [phase, setPhase] = useState<Phase>('attract');
  const [summary, setSummary] = useState<GameSummary | null>(null);
  const [fieldHeight, setFieldHeight] = useState(470);
  const [scale, setScale] = useState(1);
  const [reducedMotion, setReducedMotionState] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const soundOnRef = useRef(false);

  // Losing focus IS a pause: the keys are bound to the field, so a player who
  // has tabbed away cannot steer and must not be shot at meanwhile.
  const paused = hidden || userPaused || !focused;

  /** Republish the HUD/phase into React state and hand the summary over on death. */
  const publish = useCallback((world: World): void => {
    const next = hudOf(world);
    setHud(next);
    setPhase(next.phase);
    setSummary(next.phase === 'gameOver' ? summarise(world) : null);
  }, []);

  /** Resize the backing store for the world's current logical size and repaint. */
  const syncCanvas = useCallback((world: World): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // INTEGER, not merely clamped. render.ts blits at a 3-unit sprite cell and
    // states as a precondition that the backing store is an integer multiple of a
    // logical unit; at Windows' 125/150/175 % scaling a raw ratio makes a cell
    // 3.75/4.5/5.25 device pixels and `fillRect` antialiases the fractional edge
    // (imageSmoothingEnabled only governs drawImage). Flooring gives whole device
    // pixels per cell, and `image-rendering: pixelated` on the canvas element
    // scales the result up with hard edges.
    const dpr = Math.max(1, Math.min(2, Math.floor(window.devicePixelRatio || 1)));
    const w = Math.round(world.width * dpr);
    const h = Math.round(world.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // One logical unit == one CSS pixel for render.ts, whatever the display does.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctxRef.current = ctx;
  }, []);

  /* ---------------------------------------------------- world + observers -- */

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const measured = field.clientWidth;
    const world = createWorld({
      width: logicalWidth(measured),
      reducedMotion: media.matches,
    });
    worldRef.current = world;
    setReducedMotionState(media.matches);
    setFieldHeight(fieldCssHeight(measured));
    setScale(fieldScale(measured));
    syncCanvas(world);

    const onMotionChange = (): void => {
      setReducedMotionState(media.matches);
      const w = worldRef.current;
      if (w) setReducedMotion(w, media.matches);
    };
    media.addEventListener('change', onMotionChange);

    const observer = new ResizeObserver(() => {
      const w = worldRef.current;
      const el = fieldRef.current;
      if (!w || !el) return;
      const px = el.clientWidth;
      if (px <= 0) return;
      resizeWorld(w, logicalWidth(px));
      setFieldHeight(fieldCssHeight(px));
      setScale(fieldScale(px));
      syncCanvas(w);
      // Repaint immediately: a resize while paused or between waves must not
      // leave a stretched frame on screen until the loop happens to run again.
      const ctx = ctxRef.current;
      if (ctx) {
        if (w.phase === 'playing' || w.phase === 'waveBreak') paintField(ctx, w);
        else clearField(ctx, w.width, w.height);
      }
    });
    observer.observe(field);

    return () => {
      media.removeEventListener('change', onMotionChange);
      observer.disconnect();
    };
  }, [syncCanvas]);

  /* --------------------------------------------------------------- audio --- */

  useEffect(() => {
    const stored = isSoundEnabled();
    soundOnRef.current = stored;
    setSoundOn(stored);
    return () => disposeAudio();
  }, []);

  const toggleSound = useCallback(() => {
    // MUST run synchronously inside the click/keydown handler: `true` is what
    // constructs the AudioContext, and a context created outside a user gesture
    // starts suspended and never recovers.
    //
    // The next value comes off a ref rather than a setState updater on purpose —
    // StrictMode invokes updaters twice, which would toggle the real setting
    // back to where it started while the rendered label flipped.
    const next = !soundOnRef.current;
    soundOnRef.current = next;
    setSoundEnabled(next);
    setSoundOn(next);
  }, []);

  /* ------------------------------------------------- visibility + blur ----- */

  useEffect(() => {
    // `visibilitychange` ONLY. A window-level `blur` listener looks like the same
    // thing and is not: it also fires when focus moves to the browser's own
    // chrome, to devtools, or to another window on the same screen, and the
    // matching `focus` does not always come back — which strands the game paused
    // with no way in. Losing the FIELD's focus is already a pause (see `paused`),
    // and that is the case the brief actually means by "pause on blur".
    const onVisibility = (): void => setHidden(document.hidden);
    setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (paused) {
      // Drop every held key. Otherwise the craft resumes still travelling in
      // whatever direction it was going when the tab lost focus.
      inputRef.current = { left: false, right: false, fire: false, focus: false };
      suspendAudio();
    } else {
      resumeAudio();
    }
  }, [paused]);

  /* ---------------------------------------------------------- navigation --- */

  const exit = useCallback(() => {
    // history.back() is what restores the EXACT scroll position the player came
    // from: the router pushes state before it scrolls to the top, so the browser
    // snapshotted the previous page's scrollY against that entry. A manual
    // scrollTo here would be strictly worse, and capturing scrollY when /arcade
    // mounts would capture 0.
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
      return;
    }
    navigate('/');
  }, []);

  useEffect(() => {
    // Nothing on this site sets scrollRestoration, but the whole Esc contract
    // rests on it being 'auto', so assert it for the life of the route.
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'auto';
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  /* --------------------------------------------------------- transitions --- */

  const start = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    startGame(world);
    drainEvents(world);
    publish(world);
    setUserPaused(false);
    // preventScroll: focusing the field must never jump the page to the cabinet.
    fieldRef.current?.focus({ preventScroll: true });
  }, [publish]);

  const skipBreak = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    skipWaveBreak(world);
    publish(world);
  }, [publish]);

  /* ------------------------------------------------------------ keyboard --- */

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;

    const onKeyDown = (e: KeyboardEvent): void => {
      // MODIFIED CHORDS BELONG TO THE BROWSER. `e.code` is the PHYSICAL key, so
      // without this Cmd/Ctrl+F swallowed find-in-page and Cmd/Ctrl+A swallowed
      // select-all while the field had focus — and worse, macOS does not deliver
      // keyup for a character key held with Cmd, so Cmd+A set `left` and nothing
      // ever cleared it: the craft travelled left forever. `onKeyUp` stays
      // deliberately UNGUARDED — it must always be able to release a flag.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const world = worldRef.current;
      switch (e.code) {
        case 'ArrowLeft':
        case 'KeyA':
          e.preventDefault();
          inputRef.current.left = true;
          break;
        case 'ArrowRight':
        case 'KeyD':
          e.preventDefault();
          inputRef.current.right = true;
          break;
        case 'KeyF':
          e.preventDefault();
          inputRef.current.focus = true;
          break;
        case 'Space':
          e.preventDefault();
          if (!world) break;
          if (world.phase === 'attract' || world.phase === 'gameOver') start();
          else if (world.phase === 'waveBreak') skipBreak();
          else inputRef.current.fire = true;
          break;
        case 'KeyM':
          e.preventDefault();
          toggleSound();
          break;
        case 'KeyP':
          e.preventDefault();
          setUserPaused((p) => !p);
          break;
        case 'Escape':
          exit();
          break;
        default:
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      switch (e.code) {
        case 'ArrowLeft':
        case 'KeyA':
          inputRef.current.left = false;
          break;
        case 'ArrowRight':
        case 'KeyD':
          inputRef.current.right = false;
          break;
        case 'KeyF':
          inputRef.current.focus = false;
          break;
        case 'Space':
          inputRef.current.fire = false;
          break;
        default:
          break;
      }
    };

    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);

    field.addEventListener('keydown', onKeyDown);
    field.addEventListener('keyup', onKeyUp);
    field.addEventListener('focus', onFocus);
    field.addEventListener('blur', onBlur);
    return () => {
      field.removeEventListener('keydown', onKeyDown);
      field.removeEventListener('keyup', onKeyUp);
      field.removeEventListener('focus', onFocus);
      field.removeEventListener('blur', onBlur);
    };
  }, [exit, skipBreak, start, toggleSound]);

  // Escape at document level, but only once the player has left the attract
  // screen — before that, Esc belongs to the page. This is what makes "Esc
  // gets me out" work when focus has moved to the game-over CTA.
  //
  // THE FIELD IS EXCLUDED, and that exclusion is not tidiness. The field's own
  // keydown handler above already calls exit() for Escape, and a keydown on the
  // field BUBBLES to document — so without this guard the normal case (playing,
  // field focused) fires exit() twice, which queues two history traversals and
  // sends the player back TWO entries instead of one. Nothing throws; they just
  // land on the wrong page.
  useEffect(() => {
    if (phase === 'attract') return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape') return;
      const field = fieldRef.current;
      if (field && e.target instanceof Node && field.contains(e.target)) return;
      exit();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [exit, phase]);

  /* ---------------------------------------------------------- the loop ----- */

  const simulating = phase === 'playing' || phase === 'waveBreak';

  useEffect(() => {
    if (!simulating || paused) return;
    const world = worldRef.current;
    const ctx = ctxRef.current;
    if (!world || !ctx) return;

    let raf = 0;
    let last = performance.now();
    let accumulator = 0;
    let sincePublish = 0;
    let running = true;

    if (soundOn) {
      setMarchTempo(world.liveCount);
      startMarch();
    }

    const loop = (now: number): void => {
      if (!running) return;
      raf = requestAnimationFrame(loop);

      accumulator += now - last;
      last = now;

      let steps = 0;
      while (accumulator >= TICK_MS && steps < MAX_CATCH_UP) {
        tick(world, inputRef.current);
        accumulator -= TICK_MS;
        steps += 1;
      }
      // A stall must not spiral: throw the backlog away rather than trying to
      // simulate it, which would take longer than the frame it is owed.
      if (steps === MAX_CATCH_UP) accumulator = 0;

      if (steps > 0) {
        for (const event of drainEvents(world)) {
          const sound = EVENT_SOUND[event.type];
          if (sound) playSound(sound);
        }
        setMarchTempo(world.liveCount);

        sincePublish += steps;
        if (sincePublish >= HUD_PERIOD || world.phase !== phase) {
          sincePublish = 0;
          publish(world);
        }

        // INSIDE the guard. paintField is a pure function of the world, so with
        // steps === 0 the frame would be byte-identical to the one already on
        // screen — and the simulation is pinned to 60 Hz while rAF runs at the
        // display rate, so on a 120 Hz panel that is half of all frames clearing
        // and re-blitting the whole field for nothing.
        paintField(ctx, world);
      }
    };

    // One frame up front, because the first rAF callback almost always simulates
    // zero ticks (its delta is ~0) and would now paint nothing.
    paintField(ctx, world);
    raf = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      stopMarch();
      // The engine may have ended the game inside the final batch; make sure
      // React sees the terminal phase even though the loop is being torn down.
      publish(world);
    };
  }, [paused, phase, publish, simulating, soundOn]);

  // Two cases the loop cannot cover, because the loop is not running in either:
  // leaving play clears the field so the attract and game-over overlays sit on
  // clean hatch rather than on a frozen last frame; and a PAUSED game must still
  // show the frame it stopped on, or a player who tabs away comes back to an
  // empty box and assumes it broke.
  useEffect(() => {
    const world = worldRef.current;
    const ctx = ctxRef.current;
    if (!world || !ctx) return;
    if (!simulating) clearField(ctx, world.width, world.height);
    else if (paused) paintField(ctx, world);
  }, [paused, simulating]);

  return useMemo(
    () => ({
      fieldRef,
      canvasRef,
      hud,
      phase,
      summary,
      fieldHeight,
      scale,
      reducedMotion,
      focused,
      paused,
      soundOn,
      toggleSound,
      start,
      skipBreak,
      exit,
    }),
    [
      exit,
      fieldHeight,
      focused,
      hud,
      paused,
      phase,
      reducedMotion,
      scale,
      skipBreak,
      soundOn,
      start,
      summary,
      toggleSound,
    ],
  );
}
