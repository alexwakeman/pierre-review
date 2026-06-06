import { useEffect, useState } from 'react';

// One-shot intro for the hero wordmark: the cursive "Pierre" resolves out of a
// terminal prompt. "PR" sits in a monospace prompt with a flickering block caret;
// the caret backspaces R then P; then the cursive wordmark fades in. Raw CSS/JS —
// no animation library. Respects prefers-reduced-motion (renders the final cursive
// immediately, no timers) and reserves the cursive's box (the in-flow span) so the
// rest of the hero never shifts. It runs once, on mount.
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false)
  );
}

export default function HeroWordmark() {
  // 0 = "PR", 1 = "P" (backspaced R), 2 = "" (bare caret), 3 = cursive "Pierre".
  const [step, setStep] = useState<number>(() => (prefersReducedMotion() ? 3 : 0));

  useEffect(() => {
    if (prefersReducedMotion()) return; // already initialised to the final state
    const timers = [
      window.setTimeout(() => setStep(1), 1300), // backspace R  → "P"
      window.setTimeout(() => setStep(2), 1750), // backspace P  → bare caret
      window.setTimeout(() => setStep(3), 2150), // clear prompt → cursive wordmark
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  const term = step === 0 ? 'PR' : step === 1 ? 'P' : '';
  const resolved = step === 3;

  return (
    <p
      className="relative mb-6 text-6xl text-gray-100 sm:text-8xl"
      aria-label="Pierre"
    >
      {/* In normal flow, so it sizes the box (no layout shift) and is the final,
          accessible state. Starts transparent, fades in once the prompt clears. */}
      <span
        aria-hidden="true"
        className={`brand-title block transition-opacity duration-1000 ease-out ${
          resolved ? 'opacity-100' : 'opacity-0'
        }`}
      >
        Pierre
      </span>

      {/* Terminal prompt overlay (decorative), centred over the cursive box; fades
          out as the cursive fades in. */}
      <span
        aria-hidden="true"
        className={`absolute inset-0 flex items-center justify-center font-mono text-5xl text-gray-100 transition-opacity duration-500 sm:text-7xl ${
          resolved ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <span>{term}</span>
        {/* Drop the caret the instant the prompt clears so it never lingers over
            the emerging cursive during the cross-fade. */}
        {!resolved && <span className="hero-caret" />}
      </span>
    </p>
  );
}
