/**
 * Maintainer shield — shown next to a contributor who has merged a PR in the
 * repo in context (our proxy for "has merge rights"). Purple to echo the
 * pr_merged marker. Mirrors the inline-SVG shield used on the timeline row
 * labels (`Timeline/userRow.ts` SHIELD_GLYPH) for a consistent visual language.
 */
export function MaintainerShield({
  className,
}: {
  className?: string;
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      aria-hidden="true"
      className={['inline-block shrink-0', className].filter(Boolean).join(' ')}
    >
      <title>Has merge rights — has merged a PR in this repo</title>
      <path
        fill="#8957e5"
        d="M8 .8 2.2 2.9v4.2c0 3.3 2.5 6.4 5.8 7.3 3.3-.9 5.8-4 5.8-7.3V2.9L8 .8Z"
      />
      <path
        d="M5.2 8 7.1 9.9 10.9 6"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
