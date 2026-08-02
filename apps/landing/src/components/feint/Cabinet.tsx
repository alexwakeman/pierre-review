import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { SITE_NAME } from '../../lib/site';
import type { AlienName } from '../../lib/sprites';
import { Sprite, SPRITE_PALETTE } from './Sprite';
import { InkButton } from './primitives';
import { useGame } from '../../game/useGame';
import {
  CRAFT_H,
  CRAFT_Y,
  FIELD_H,
  FOCUS_MAX,
  WAVE_BREAK_TICKS,
  WAVE_LINES,
} from '../../game/constants';
import type { GameSummary } from '../../game/types';

// ---------------------------------------------------------------------------
// The Inked cabinet — toolkit layout B, transposed to paper.
//
// Four stacked rows inside one 1px #DCDCD6 frame: header, HUD, play field, and
// the gutter (which is drawn INSIDE the field, in field coordinates, because it
// changes per tick). Every measurement here is a literal from the toolkit's
// inline styles, not an approximation — 14/22 padding, 0.16em on the game name
// against 0.14em on the Esc note, 12px focus segments at a 3px gap, a 240x3
// progress rule, 44px of game-over padding with a 48px column gap.
//
// ONLY THE PLAY FIELD IS CANVAS. The frame, both chrome rows, the two captions
// and all three non-playing screen states are DOM overlays absolutely positioned
// over it. That is a deliberate structural decision with four consequences worth
// keeping: every word is selectable and translatable; the attract screen (which
// is the phase at SSR) lands in the PRERENDERED HTML, where the byte guardrails
// can see it; a screen reader gets real text instead of a blank <canvas>; and the
// game-over "Sign in with GitHub" is a real <a> in the tab order.
//
// TYPE: Archivo 600 for titles and every numeric value, JetBrains Mono uppercase
// for all HUD and system text, and exactly ONE Newsreader sentence on game over.
// NO PIXEL TYPEFACE ANYWHERE — the sprites carry the arcade, the typography stays
// the product's. That is the single most likely well-intentioned regression here.
//
// VERMILION: #C13A20 for anything that carries text, #E2492C for fills only, and
// it means a hit, a miss or "needs you" — never decoration. The complete legal
// inventory in this component is: the wordmark's full stop, the UNREAD value, the
// filled focus segments, PRESS SPACE, "for four seconds", THE INBOX WON, the
// MISSED stat, the miss crosses, and the two "needs you" tags.
//
// PLAY AGAIN KEEPS EQUAL WEIGHT WITH THE CTA. Both closing actions are real
// buttons, same size, same colour, same tracking, same row, no hierarchy between
// them. The moment that stops being true the game becomes a toll gate and the
// whole device backfires.
// ---------------------------------------------------------------------------

// The tracking asymmetry is real and intentional: 0.16em on the game name, the
// attract subtitle and the section kickers; 0.14em on HUD labels, list tags,
// footer hints and PRESS SPACE. Do not unify them.
const MONO = 'font-mono text-[10px] uppercase tracking-[0.14em] text-secondary';
const MONO_11 = 'font-mono text-[11px] uppercase tracking-[0.14em] text-secondary';
const MONO_WIDE = 'font-mono text-[11px] uppercase tracking-[0.16em] text-secondary';
const FOCUS_RING =
  'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

/** Deterministic thousands separators — `toLocaleString` is locale-dependent and
 *  this string is baked into prerendered HTML as well as rendered in the browser. */
function formatNumber(n: number): string {
  return String(Math.max(0, Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The two types the product would surface as "your turn", spelled for a count. */
const NEEDS_YOU_NOUN: Record<string, [string, string]> = {
  review: ['review request', 'review requests'],
  at: ['@-mention', '@-mentions'],
};

function needsYouLabel(name: AlienName, count: number, fallback: string): string {
  const nouns = NEEDS_YOU_NOUN[name];
  if (!nouns) return `${count} ${fallback}`;
  return `${count} ${count === 1 ? nouns[0] : nouns[1]}`;
}

/* ------------------------------------------------------------ HUD parts ---- */

/**
 * One HUD field: a bare mono label inheriting the row's register, with the value
 * opting back out into Archivo. `signal` is UNREAD and nothing else — it is the
 * only vermilion value on the whole screen.
 */
function HudField({
  label,
  value,
  signal = false,
}: {
  label: string;
  value: string;
  signal?: boolean;
}): JSX.Element {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      {label}
      <span
        className={`font-display text-[14px] normal-case tracking-[-0.01em] ${
          signal ? 'text-signal-text' : 'text-ink'
        }`}
      >
        {value}
      </span>
    </span>
  );
}

/**
 * The FOCUS meter. Layout B's single-line HUD omits it; the brief requires it, so
 * it takes §03's position — immediately before LIVES — collapsed inline.
 *
 * Filled and empty segments differ in FILL as well as border colour, and the
 * segment about to be spent takes a 1px inset rather than a blink: state is never
 * signalled by colour alone, and nothing here may animate under reduced motion.
 */
function FocusMeter({ focus, charging }: { focus: number; charging: boolean }): JSX.Element {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      Focus
      <span className="flex gap-[3px]" role="img" aria-label={`Focus ${focus} of ${FOCUS_MAX}`}>
        {Array.from({ length: FOCUS_MAX }, (_, i) => {
          const filled = i < focus;
          const spending = charging && i === focus - 1;
          return (
            <span
              key={i}
              className={`block h-[12px] w-[12px] border ${
                filled ? 'border-signal-text bg-signal-text' : 'border-ink-body'
              }`}
            >
              {spending && <span className="block h-full w-full border border-paper" />}
            </span>
          );
        })}
      </span>
    </span>
  );
}

function LivesMeter({ lives }: { lives: number }): JSX.Element {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      Lives
      <span
        className="flex gap-2"
        role="img"
        aria-label={lives === 1 ? '1 life remaining' : `${lives} lives remaining`}
      >
        {Array.from({ length: Math.max(0, lives) }, (_, i) => (
          <Sprite key={i} name="craft" cell={2} {...SPRITE_PALETTE.onPaper} />
        ))}
      </span>
    </span>
  );
}

/* ------------------------------------------------------- screen states ----- */

/** The shared overlay box: the same 470px field, centred, never its own panel. */
function Overlay({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`absolute inset-0 flex flex-col items-center justify-center text-center ${className}`}
    >
      {children}
    </div>
  );
}

const ATTRACT_SPRITES: AlienName[] = ['channel', 'email', 'meeting', 'bot', 'at'];
const WAVE_SPRITES: AlienName[] = ['repo', 'review', 'ci'];

function AttractScreen({ reducedMotion }: { reducedMotion: boolean }): JSX.Element {
  return (
    <Overlay className="gap-5 px-6">
      <h2 className="font-display text-[36px] font-semibold tracking-[-0.025em] text-ink">
        Inbox Invaders
      </h2>
      <p className={`${MONO_WIDE} leading-[2.1]`}>
        Ninety seconds of the thing
        <br />
        {SITE_NAME} takes off your desk
      </p>
      <div className="flex items-end gap-[18px]">
        {ATTRACT_SPRITES.map((name) => (
          <Sprite key={name} name={name} cell={4} {...SPRITE_PALETTE.onPaper} />
        ))}
      </div>
      {/* steps(1, end) at 1.1s — the site's existing caret keyframe, reused. Under
          reduced motion it renders solid; index.css also kills it in CSS, but the
          class is dropped here so the two agree. */}
      <p
        className={`font-mono text-[12px] tracking-[0.14em] text-signal-text ${
          reducedMotion ? '' : 'animate-limn-caret'
        }`}
      >
        PRESS SPACE
      </p>
      <p className={MONO}>Click the field, or Tab to it, to play</p>
      <p className={`absolute bottom-4 ${MONO}`}>
        ← → move · space fire · F focus · esc exits
      </p>
    </Overlay>
  );
}

/**
 * The wave transition. `hud.wave` during `waveBreak` is the wave just CLEARED —
 * the engine emits `waveStart` when the break ends — so the next-wave line is
 * indexed at `wave & 7`, which is `(nextWave - 1) & 7`.
 */
function WaveScreen({
  wave,
  ticksLeft,
  reducedMotion,
}: {
  wave: number;
  ticksLeft: number;
  reducedMotion: boolean;
}): JSX.Element {
  const progress = reducedMotion
    ? 1
    : Math.min(1, Math.max(0, (WAVE_BREAK_TICKS - ticksLeft) / WAVE_BREAK_TICKS));
  const next = WAVE_LINES[wave & 7] ?? WAVE_LINES[0] ?? '';

  return (
    <Overlay className="gap-[18px] p-6">
      <p className={MONO_WIDE}>Wave {pad2(wave)} cleared</p>
      <h2 className="font-display text-[30px] font-semibold leading-[1.25] tracking-[-0.025em] text-ink">
        Inbox zero
        <br />
        {/* The second line only. That contrast is the joke. */}
        <span className="text-signal-text">for four seconds</span>
      </h2>
      <div className="h-[3px] w-[240px] bg-rule" role="presentation">
        <div className="h-full bg-ink" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <p className={`${MONO_11} max-w-[36ch] leading-[2.1]`}>Next: {next}</p>
      <div className="flex items-end gap-[14px]">
        {WAVE_SPRITES.map((name) => (
          <Sprite key={name} name={name} cell={3} {...SPRITE_PALETTE.onPaper} />
        ))}
      </div>
    </Overlay>
  );
}

/** The game-over gutter is a reminder, not an inventory — the MISSED stat above
 *  it already carries the number, so the drawn pile is capped rather than allowed
 *  to wrap the 470px field out of shape. */
const GAME_OVER_MARK_CAP = 24;

function GameOverScreen({
  summary,
  onPlayAgain,
  onExit,
}: {
  summary: GameSummary;
  onPlayAgain: () => void;
  onExit: () => void;
}): JSX.Element {
  const missed = summary.unread;
  const marks = Math.min(missed, GAME_OVER_MARK_CAP);

  return (
    <div
      className="absolute inset-0 overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
      role="group"
      aria-label="Game over"
    >
      <div className="grid items-center gap-[48px] p-[44px] rail:grid-cols-2">
        {/* ---------------- left: the player's own numbers ---------------- */}
        <div>
          <p className={`mb-[22px] ${MONO_WIDE} text-signal-text`}>The inbox won</p>

          <div className="mb-[26px] flex flex-wrap gap-x-10 gap-y-5">
            <Stat label="Score" value={formatNumber(summary.score)} />
            <Stat label="Threads cleared" value={formatNumber(summary.cleared)} />
            <Stat label="Missed" value={formatNumber(missed)} signal />
          </div>

          {marks > 0 && (
            <div
              className="mb-[26px] flex flex-wrap items-center gap-[14px]"
              role="img"
              aria-label={`${missed} notifications reached you unread`}
            >
              {Array.from({ length: marks }, (_, i) => (
                <Sprite key={i} name="miss" cell={2} fill="#C13A20" accent="#E2492C" />
              ))}
            </div>
          )}

          {/* The only Newsreader on the entire game route. */}
          <p className="max-w-[46ch] font-serif text-[19px] leading-[1.55] text-ink-body">
            You cleared {formatNumber(summary.cleared)} and missed {formatNumber(missed)}. That
            ratio is roughly a real week. {SITE_NAME} is the version where the{' '}
            {formatNumber(missed)} arrive pre-sorted.
          </p>
        </div>

        {/* ------ right: the product performing its own behaviour on the mess ------ */}
        <div className="border-t border-rule pt-[48px] rail:border-l rail:border-t-0 rail:pl-[48px] rail:pt-0">
          <p className={`mb-4 ${MONO}`}>What you missed, sorted</p>

          <ul className="mb-[26px] flex flex-col">
            {summary.needsYou.map((row) => (
              <li
                key={row.name}
                className="flex items-center gap-3 border-b border-rule py-[9px]"
              >
                <Sprite name={row.name} cell={2} {...SPRITE_PALETTE.onPaper} />
                <span className="flex-1 text-left font-serif text-[16px] text-ink">
                  {needsYouLabel(row.name, row.count, row.label)}
                </span>
                <span className="font-mono text-[11px] text-signal-text">needs you</span>
              </li>
            ))}

            {summary.digestible > 0 && (
              <li className="flex items-center gap-3 border-b border-rule py-[9px]">
                {/* The 0.5 wrapper and the demoted label colour are how
                    "digestible" is SHOWN rather than merely labelled. */}
                <span className="flex opacity-50">
                  <Sprite name="channel" cell={2} {...SPRITE_PALETTE.onPaper} />
                </span>
                <span className="flex-1 text-left font-serif text-[16px] text-secondary">
                  {formatNumber(summary.digestible)} everything else
                </span>
                <span className="font-mono text-[11px] text-secondary">digestible</span>
              </li>
            )}

            {summary.needsYou.length === 0 && summary.digestible === 0 && (
              <li className="border-b border-rule py-[9px] text-left font-serif text-[16px] text-secondary">
                Nothing reached you unread. The rack landed instead.
              </li>
            )}
          </ul>

          <div className="mb-[18px]">
            <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
          </div>

          {/* Equal weight, both real controls, both in the tab order. */}
          <div className="flex flex-wrap gap-[22px]">
            <button type="button" onClick={onPlayAgain} className={`${MONO} whitespace-nowrap ${FOCUS_RING}`}>
              Space · play again
            </button>
            <button type="button" onClick={onExit} className={`${MONO} whitespace-nowrap ${FOCUS_RING}`}>
              Esc · back to site
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  signal = false,
}: {
  label: string;
  value: string;
  signal?: boolean;
}): JSX.Element {
  return (
    <div className="text-left">
      <div className={`mb-2 ${MONO}`}>{label}</div>
      <div
        className={`font-display text-[30px] font-semibold tracking-[-0.025em] ${
          signal ? 'text-signal-text' : 'text-ink'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ cabinet ------ */

export function Cabinet(): JSX.Element {
  const {
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
  } = useGame();

  const playing = phase === 'playing' || phase === 'waveBreak';
  const showPause = playing && paused;

  // The live region announces transitions only. Wiring it to the score would
  // interrupt a screen-reader user roughly fifteen times a second.
  const announcement = useMemo(() => {
    if (phase === 'attract') return 'Inbox Invaders. Press space to play.';
    if (phase === 'waveBreak') return `Wave ${hud.wave} cleared. Score ${hud.score}.`;
    if (phase === 'gameOver') {
      return `Game over. Score ${hud.score}. Cleared ${hud.cleared}. Missed ${hud.unread}.`;
    }
    return `Wave ${hud.wave}. ${hud.lives} lives remaining.`;
  }, [hud.cleared, hud.lives, hud.score, hud.unread, hud.wave, phase]);

  return (
    <div className="border border-rule-strong bg-paper">
      {/* ---------------------------- header row ---------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-x-[22px] gap-y-2 border-b border-rule px-[22px] py-[14px]">
        <div className="flex items-baseline">
          <span className="font-display text-[15px] font-semibold tracking-[-0.01em] text-ink">
            {SITE_NAME}
            <span className="text-signal-text">.</span>
          </span>
          <span className="ml-[10px] font-mono text-[10px] uppercase tracking-[0.16em] text-secondary">
            Inbox Invaders
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-[22px] gap-y-1">
          {reducedMotion && <span className={MONO}>Reduced motion · stepped play</span>}
          {showPause && <span className={MONO}>Paused</span>}
          <button
            type="button"
            onClick={toggleSound}
            aria-pressed={soundOn}
            className={`${MONO} transition-colors duration-hover ease-standard hover:text-ink ${FOCUS_RING}`}
          >
            Sound {soundOn ? 'on' : 'off'}
          </button>
          <span className={MONO}>Esc · back to the site</span>
        </div>
      </div>

      {/* ------------------------------ HUD row ------------------------------ */}
      <div
        className={`flex flex-wrap items-center justify-between gap-x-9 gap-y-3 border-b border-rule px-[22px] py-[14px] ${MONO}`}
      >
        <div className="flex flex-wrap items-center gap-x-9 gap-y-2">
          <HudField label="Score" value={formatNumber(hud.score)} />
          <HudField label="Wave" value={pad2(hud.wave)} />
          <HudField label="Cleared" value={formatNumber(hud.cleared)} />
          <HudField label="Unread" value={formatNumber(hud.unread)} signal />
        </div>
        <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
          <FocusMeter focus={hud.focus} charging={hud.focusCharging} />
          <LivesMeter lives={hud.lives} />
        </div>
      </div>

      {/* ----------------------------- play field ---------------------------- */}
      <div
        onClick={() => {
          fieldRef.current?.focus({ preventScroll: true });
          if (phase === 'attract') start();
        }}
        className="relative overflow-hidden"
        style={{
          height: fieldHeight,
          // The hatch is a background-image on the field itself, exactly as the
          // mock draws it — the canvas above stays transparent so it shows
          // through. 135deg, a 12px period, 50/50 duty, no opacity layer.
          backgroundImage:
            'repeating-linear-gradient(135deg, #F4F4EF 0 6px, #FAFAF8 6px 12px)',
        }}
      >
        {/* role="application" IS SCOPED TO THE CANVAS AND NOTHING ELSE. It tells
            assistive technology to stop intercepting keys and leave browse mode
            for every descendant, which is exactly right for a play surface driven
            by arrow keys and exactly wrong for the three overlay screens — the
            attract copy, the wave line and, above all, the game-over panel, whose
            Newsreader sentence, sorted "what you missed" list and Sign-in CTA are
            the conversion moment and must be arrowed through like any other prose.
            They are therefore SIBLINGS of this element, not children of it.
            fieldRef points here: the keyboard handlers, the focus() call and the
            width measurement all follow the ref, so play is unchanged. */}
        <div
          ref={fieldRef}
          tabIndex={0}
          role="application"
          aria-label="Inbox Invaders play field"
          aria-describedby="arcade-controls"
          className="absolute inset-0 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink focus-visible:[outline-offset:-2px]"
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="Notifications descend in four ranks toward your craft."
            className="block h-full w-full"
            style={{ imageRendering: 'pixelated' }}
          />
        </div>

        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>

        {phase === 'attract' && <AttractScreen reducedMotion={reducedMotion} />}

        {phase === 'waveBreak' && (
          <WaveScreen
            wave={hud.wave}
            ticksLeft={hud.waveBreakTicks}
            reducedMotion={reducedMotion}
          />
        )}

        {phase === 'gameOver' && summary && (
          <GameOverScreen summary={summary} onPlayAgain={start} onExit={exit} />
        )}

        {/* The meeting invite landed. Words, not just an alpha — state is never
            signalled by colour or opacity alone. */}
        {phase === 'playing' && hud.frozen && (
          <p
            className={`pointer-events-none absolute left-0 right-0 ${MONO}`}
            style={{ bottom: (FIELD_H - CRAFT_Y + CRAFT_H + 8) * scale }}
          >
            In a meeting
          </p>
        )}

        {/* The bonus award, held in place for half a second where it was hit. */}
        {phase === 'playing' && hud.saucerScore && (
          <span
            className="pointer-events-none absolute -translate-x-1/2 font-mono text-[11px] tracking-[0.14em] text-signal-text"
            style={{ left: hud.saucerScore.x * scale, top: hud.saucerScore.y * scale }}
          >
            {formatNumber(hud.saucerScore.points)}
          </span>
        )}

        {/* A silently frozen game reads as a bug. Say which pause it is, because
            "press P" is wrong advice for a player who has tabbed away. */}
        {showPause && (
          <p className={`pointer-events-none absolute inset-x-0 top-1/2 text-center ${MONO}`}>
            {focused ? 'Paused · press P to resume' : 'Paused · click the field to resume'}
          </p>
        )}
      </div>

      <p id="arcade-controls" className="sr-only">
        Arrow keys or A and D move. Space fires. Hold F to spend a focus segment and clear a
        column. P pauses. M toggles sound. Escape returns to the site.
      </p>
    </div>
  );
}
