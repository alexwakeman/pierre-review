// ---------------------------------------------------------------------------
// The dark command panel.
//
// This and the arcade game are the ONLY dark surfaces on the site. That scarcity
// is the point: the panel reads as a literal terminal rather than as a styled
// box, because nothing else on the page is dark.
//
// Inside a #16161A panel the palette shifts — vermilion becomes `signal-on-dark`
// (#F26B4E) and small grey text bottoms out at `on-dark-secondary` (#9A9A94,
// 6.3:1). Do not reuse the on-paper stops here.
// ---------------------------------------------------------------------------

export function TerminalPanel({
  label,
  command,
  size = 'lg',
  cursor = false,
  className = '',
}: {
  /** The chrome line above the prompt, e.g. "zsh · ~/work". */
  label?: string;
  command: string;
  /** `lg` is the standalone Local section; `sm` is the inline pricing block. */
  size?: 'sm' | 'lg';
  /** Show the blinking block cursor after the command. */
  cursor?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`bg-ink font-mono ${size === 'lg' ? 'px-[26px] py-7' : 'px-[18px] py-4'} ${className}`}
    >
      {label && (
        <div className="mb-4 text-mono-label uppercase text-on-dark-secondary">{label}</div>
      )}
      <div
        className={`${size === 'lg' ? 'text-mono-term' : 'text-[16px]'} text-on-dark-primary`}
      >
        <span className="select-none text-signal-on-dark">$</span> {command}
        {cursor && (
          <span
            aria-hidden="true"
            // A real block caret, sized in px from the design. `steps(1, end)`
            // is a hard on/off — a fading cursor is a decoration, a blinking one
            // is a terminal. Under prefers-reduced-motion the global rule in
            // index.css kills the animation and it renders solid, which is the
            // brief's stated fallback.
            className="ml-1.5 inline-block h-[18px] w-[9px] animate-limn-caret bg-signal-fill align-[-3px]"
          />
        )}
      </div>
    </div>
  );
}
