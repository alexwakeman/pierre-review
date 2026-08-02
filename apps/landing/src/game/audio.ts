import { FLEET_COUNTS, FLEET_DELAYS, TICK_MS } from './constants';

// ---------------------------------------------------------------------------
// The cabinet's sound, synthesised.
//
// ZERO ASSET BYTES. Every sound here is oscillators, gain envelopes and one
// procedurally generated noise buffer — there is no audio file anywhere in the
// bundle. That is not only a weight decision: the landing's CSP has no
// `media-src`, so it falls back to `default-src 'self'` and an
// `<audio src="data:…">` would be BLOCKED outright. An AudioContext touches no
// URL and is unaffected.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE
//
//   1. SOUND IS OFF BY DEFAULT, and no AudioContext may exist before a user
//      gesture. `setSoundEnabled(true)` is therefore the ONLY constructor call
//      site, and it must be reached synchronously from the cabinet's toggle
//      button — Safari and Chrome both refuse a context created outside one, and
//      an autoplaying arcade cabinet on a marketing page is exactly the thing the
//      brief forbids.
//
//   2. NOTHING HERE MAY THROW. Both APIs it touches fail in the real world:
//      localStorage throws outright in some private-browsing modes, and
//      AudioContext construction fails on locked-down or exhausted devices. A
//      muted game is a fine outcome; a game that crashes because the speaker
//      icon was clicked is not. Every entry point is wrapped.
//
//   3. NO MODULE-SCOPE BROWSER ACCESS. The landing is prerendered with
//      react-dom/server in a bare Node process; a `new AudioContext()` or a
//      `localStorage.getItem` at import time would kill `pnpm build`.
//
// THE CENTREPIECE is the four-note descending bass loop, whose period comes from
// the live alien count via the original's own tempo table. It is deliberately
// NOT synchronised to the march: the original runs its tempo table on a separate
// clock from its one-alien-per-frame cursor, which is exactly why the two drift
// against each other and why the loop reads as mounting pressure rather than as
// a metronome for the rack.
// ---------------------------------------------------------------------------

export type SoundName =
  | 'fire'
  | 'clear'
  | 'damage'
  | 'playerHit'
  | 'freeze'
  | 'unread'
  | 'focusCharge'
  | 'focusFire'
  | 'saucer'
  | 'waveClear'
  | 'gameOver'
  | 'extraLife';

export const SOUND_STORAGE_KEY = 'limn:arcade-sound';

/** Everything is mixed well under unity — this is a marketing page, not a cabinet. */
const MASTER_GAIN = 0.22;

/** The four descending bass notes: A2, G2, F2, D2. */
const MARCH_NOTES = [110, 98, 87.31, 73.42] as const;
const MARCH_NOTE_MS = 90;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

let enabled = false;
let marching = false;
let marchTimer: ReturnType<typeof setTimeout> | null = null;
let marchStep = 0;
let marchDelay = FLEET_DELAYS[0] ?? 52;

// ---- storage ----------------------------------------------------------------

/**
 * Reads localStorage. Returns `false` on the server and never throws.
 *
 * When storage is UNREADABLE (it throws outright in some private-browsing
 * modes) the in-memory flag is returned instead of a hard `false`. On the server
 * that is still `false` — nothing can have set it, because setting it requires a
 * user gesture — but in a private window it means the toggle keeps working for
 * the session instead of snapping back to off the moment React re-reads it.
 */
export function isSoundEnabled(): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(SOUND_STORAGE_KEY);
    if (stored !== null && stored !== undefined) enabled = stored === '1';
  } catch {
    // Keep whatever the session already chose.
  }
  return enabled;
}

/**
 * Persists the choice.
 *
 * `true` CONSTRUCTS the AudioContext, so this must be called synchronously from
 * a user gesture. `false` stops the march loop and closes the context outright
 * rather than leaving a suspended one around — a muted cabinet should cost
 * nothing at all.
 */
export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    globalThis.localStorage?.setItem(SOUND_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Private browsing. The setting simply will not survive a reload.
  }
  if (on) ensureContext();
  else disposeAudio();
}

// ---- the context ------------------------------------------------------------

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  if (!enabled) return null;
  try {
    const g = globalThis as typeof globalThis & {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctor) return null;
    const created = new Ctor();
    const gain = created.createGain();
    gain.gain.value = MASTER_GAIN;
    gain.connect(created.destination);
    ctx = created;
    master = gain;
    void created.resume().catch(() => undefined);
    return ctx;
  } catch {
    ctx = null;
    master = null;
    return null;
  }
}

/** The live context, or null if sound is off, unavailable, or paused. */
function live(): AudioContext | null {
  if (!enabled || !ctx || !master) return null;
  if (ctx.state === 'suspended' || ctx.state === 'closed') return null;
  return ctx;
}

function getNoise(c: AudioContext): AudioBuffer | null {
  if (noiseBuffer) return noiseBuffer;
  try {
    const frames = Math.floor(c.sampleRate * 0.4);
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    // A tiny xorshift rather than Math.random: the noise floor of a hit should
    // be identical between two recordings of the same session.
    let seed = 0x1a2b3c4d;
    for (let i = 0; i < frames; i += 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 0x80000000 - 1) * 0.9;
    }
    noiseBuffer = buf;
    return noiseBuffer;
  } catch {
    return null;
  }
}

// ---- voices -----------------------------------------------------------------

type ToneSpec = {
  type: OscillatorType;
  from: number;
  /** Sweep target. Omitted = a flat tone. */
  to?: number;
  /** Seconds. */
  dur: number;
  gain: number;
  /** Seconds from now. */
  at?: number;
};

function tone(c: AudioContext, out: GainNode, spec: ToneSpec): void {
  const start = c.currentTime + (spec.at ?? 0);
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = spec.type;
  osc.frequency.setValueAtTime(spec.from, start);
  if (spec.to !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), start + spec.dur);
  }
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(spec.gain, start + Math.min(0.012, spec.dur / 3));
  env.gain.exponentialRampToValueAtTime(0.0001, start + spec.dur);
  osc.connect(env);
  env.connect(out);
  osc.start(start);
  osc.stop(start + spec.dur + 0.02);
}

type NoiseSpec = {
  dur: number;
  gain: number;
  /** Band-pass centre, swept to `toHz` when given. */
  hz: number;
  toHz?: number;
  at?: number;
};

function noise(c: AudioContext, out: GainNode, spec: NoiseSpec): void {
  const buf = getNoise(c);
  if (!buf) return;
  const start = c.currentTime + (spec.at ?? 0);
  const src = c.createBufferSource();
  const filter = c.createBiquadFilter();
  const env = c.createGain();
  src.buffer = buf;
  filter.type = 'bandpass';
  filter.Q.value = 1.1;
  filter.frequency.setValueAtTime(spec.hz, start);
  if (spec.toHz !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, spec.toHz), start + spec.dur);
  }
  env.gain.setValueAtTime(spec.gain, start);
  env.gain.exponentialRampToValueAtTime(0.0001, start + spec.dur);
  src.connect(filter);
  filter.connect(env);
  env.connect(out);
  src.start(start);
  src.stop(start + spec.dur + 0.02);
}

// ---- the public voice -------------------------------------------------------

/** No-op when sound is off or no context exists. Never throws. */
export function playSound(name: SoundName): void {
  const c = live();
  const out = master;
  if (!c || !out) return;
  try {
    switch (name) {
      case 'fire':
        // The craft fires ONE deliberate beam, never spray — so this is a single
        // clean downward blip, not a laser.
        tone(c, out, { type: 'square', from: 880, to: 220, dur: 0.09, gain: 0.18 });
        break;
      case 'clear':
        noise(c, out, { dur: 0.16, gain: 0.3, hz: 1400, toHz: 300 });
        tone(c, out, { type: 'triangle', from: 320, to: 120, dur: 0.14, gain: 0.12 });
        break;
      case 'damage':
        // Deliberately duller and shorter than `clear`: a hit that did not clear
        // must not sound like a reward.
        noise(c, out, { dur: 0.07, gain: 0.16, hz: 700, toHz: 420 });
        break;
      case 'playerHit':
        tone(c, out, { type: 'sawtooth', from: 220, to: 45, dur: 0.55, gain: 0.24 });
        noise(c, out, { dur: 0.45, gain: 0.22, hz: 900, toHz: 90 });
        break;
      case 'freeze':
        // The meeting invite. Two flat clunks, no sweep — the sound of nothing
        // happening for a second and a half.
        tone(c, out, { type: 'sine', from: 196, dur: 0.12, gain: 0.16 });
        tone(c, out, { type: 'sine', from: 147, dur: 0.3, gain: 0.14, at: 0.11 });
        break;
      case 'unread':
        tone(c, out, { type: 'sine', from: 130, to: 82, dur: 0.2, gain: 0.16 });
        break;
      case 'focusCharge':
        tone(c, out, { type: 'sine', from: 220, to: 660, dur: 0.5, gain: 0.1 });
        break;
      case 'focusFire':
        tone(c, out, { type: 'square', from: 523.25, dur: 0.07, gain: 0.14 });
        tone(c, out, { type: 'square', from: 659.25, dur: 0.07, gain: 0.14, at: 0.06 });
        tone(c, out, { type: 'square', from: 987.77, dur: 0.16, gain: 0.14, at: 0.12 });
        noise(c, out, { dur: 0.3, gain: 0.18, hz: 400, toHz: 3000 });
        break;
      case 'saucer':
        // The warble: two detuned triangles sweeping in opposite directions.
        tone(c, out, { type: 'triangle', from: 620, to: 940, dur: 0.32, gain: 0.1 });
        tone(c, out, { type: 'triangle', from: 940, to: 620, dur: 0.32, gain: 0.09 });
        break;
      case 'waveClear':
        tone(c, out, { type: 'square', from: 392, dur: 0.11, gain: 0.13 });
        tone(c, out, { type: 'square', from: 523.25, dur: 0.11, gain: 0.13, at: 0.1 });
        tone(c, out, { type: 'square', from: 783.99, dur: 0.22, gain: 0.13, at: 0.2 });
        break;
      case 'gameOver':
        for (let i = 0; i < MARCH_NOTES.length; i += 1) {
          const hz = MARCH_NOTES[i];
          if (hz === undefined) continue;
          tone(c, out, { type: 'square', from: hz, dur: 0.3, gain: 0.16, at: i * 0.22 });
        }
        break;
      case 'extraLife':
        tone(c, out, { type: 'triangle', from: 659.25, dur: 0.09, gain: 0.14 });
        tone(c, out, { type: 'triangle', from: 987.77, dur: 0.18, gain: 0.14, at: 0.08 });
        break;
      default:
        break;
    }
  } catch {
    // A single failed voice must never take the frame with it.
  }
}

// ---- the march loop ---------------------------------------------------------

/**
 * PURE, exported for testing: the first FLEET_COUNTS entry that is ≤ liveCount
 * wins, and its FLEET_DELAYS twin is the tick period between bass notes.
 *
 * Both tables are the ROM's (0x1A11 and 0x1A21), paired index for index, so the
 * loop accelerates on exactly the schedule the original does: 52 ticks apart at
 * full strength, 5 apart on the last alien.
 */
export function marchDelayTicks(liveCount: number): number {
  for (let i = 0; i < FLEET_COUNTS.length; i += 1) {
    const threshold = FLEET_COUNTS[i];
    if (threshold !== undefined && threshold <= liveCount) return FLEET_DELAYS[i] ?? 52;
  }
  return FLEET_DELAYS[FLEET_DELAYS.length - 1] ?? 5;
}

export function setMarchTempo(liveCount: number): void {
  marchDelay = marchDelayTicks(liveCount);
}

function clearMarchTimer(): void {
  if (marchTimer !== null) {
    clearTimeout(marchTimer);
    marchTimer = null;
  }
}

function scheduleMarch(): void {
  clearMarchTimer();
  if (!marching) return;
  marchTimer = setTimeout(
    () => {
      marchTimer = null;
      if (!marching) return;
      const c = live();
      const out = master;
      if (c && out) {
        const hz = MARCH_NOTES[marchStep % MARCH_NOTES.length] ?? MARCH_NOTES[0];
        try {
          tone(c, out, { type: 'square', from: hz, dur: MARCH_NOTE_MS / 1000, gain: 0.2 });
        } catch {
          // Ignore — the loop keeps its cadence even if one note fails.
        }
      }
      marchStep = (marchStep + 1) % MARCH_NOTES.length;
      scheduleMarch();
    },
    // The period is expressed in SIMULATION TICKS and converted here, so the
    // tempo table stays the ROM's numbers rather than a set of milliseconds
    // nobody can check against it.
    Math.max(16, marchDelay * TICK_MS),
  );
}

export function startMarch(): void {
  if (marching) return;
  if (!ensureContext()) return;
  marching = true;
  marchStep = 0;
  scheduleMarch();
}

export function stopMarch(): void {
  marching = false;
  clearMarchTimer();
}

// ---- lifecycle --------------------------------------------------------------

/**
 * Pause-on-blur / tab-hidden.
 *
 * The march timer is cancelled as well as the context suspended, deliberately:
 * a suspended context's `currentTime` stops advancing, so notes scheduled while
 * it is asleep all carry the same start time and fire as one blast on resume.
 */
export function suspendAudio(): void {
  clearMarchTimer();
  try {
    void ctx?.suspend().catch(() => undefined);
  } catch {
    // Some implementations throw synchronously on a closed context.
  }
}

export function resumeAudio(): void {
  try {
    void ctx?.resume().catch(() => undefined);
  } catch {
    // As above.
  }
  if (marching) scheduleMarch();
}

/** Effect cleanup. Idempotent — StrictMode double-invokes it in development. */
export function disposeAudio(): void {
  stopMarch();
  const closing = ctx;
  ctx = null;
  master = null;
  noiseBuffer = null;
  if (!closing) return;
  try {
    if (closing.state !== 'closed') void closing.close().catch(() => undefined);
  } catch {
    // Nothing left to do — the reference is already dropped.
  }
}
