// A tiny WebAudio "review complete" chime — no bundled asset, no dependency.
//
// Browsers gate AudioContext behind a user gesture, so we lazily create (and
// resume) the context on the user's "Run review" click via `unlockReviewSound()`
// and reuse it for the later, gesture-less completion ding. EVERYTHING is wrapped
// in try/catch: an autoplay-policy rejection (or a browser with no WebAudio) must
// never throw into React render — the app has no error boundary.

const MUTE_KEY = 'pierre:reviewSoundMuted';

let ctx: AudioContext | null = null;

type WindowWithWebkitAudio = Window & {
  webkitAudioContext?: typeof AudioContext;
};

function getAudioContext(): AudioContext | null {
  try {
    if (ctx != null) return ctx;
    const w = window as WindowWithWebkitAudio;
    const Ctor = window.AudioContext ?? w.webkitAudioContext;
    if (Ctor == null) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

export function isReviewSoundMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setReviewSoundMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? 'true' : 'false');
  } catch {
    /* ignore storage failures (private mode, etc.) */
  }
}

// Create/resume the AudioContext during a user gesture so a later completion can
// play without one. Safe to call repeatedly.
export function unlockReviewSound(): void {
  try {
    const c = getAudioContext();
    if (c != null && c.state === 'suspended') void c.resume();
  } catch {
    /* autoplay policy / no WebAudio — ignore */
  }
}

// Schedule one short tone (gain ramped up then down to avoid a click).
function tone(
  c: AudioContext,
  freq: number,
  startAt: number,
  durationS: number,
): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const peak = 0.12;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationS);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + durationS + 0.02);
}

// Play a pleasant two-note "ding" (a rising perfect fifth: ~660Hz → ~990Hz).
// Respects the persisted mute flag. Never throws.
export function playReviewComplete(): void {
  try {
    if (isReviewSoundMuted()) return;
    const c = getAudioContext();
    if (c == null) return;
    if (c.state === 'suspended') void c.resume();
    const t0 = c.currentTime + 0.01;
    tone(c, 660, t0, 0.15);
    tone(c, 990, t0 + 0.13, 0.18);
  } catch {
    /* autoplay policy rejection / no WebAudio — never propagate into render */
  }
}
