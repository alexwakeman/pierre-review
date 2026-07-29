// The "LIMN" banner shown by the CLI on launch — drawn in solid rules, 5 lines,
// max 30 columns, so it renders cleanly in any terminal. String.raw keeps the
// backslashes literal.
//
// This replaced a flowing cursive "Pierre" set in figlet's "Script" font. The
// letterforms WERE the old identity, and there is no way to string-replace a name
// out of ASCII art, so the banner had to be redrawn rather than edited. It is
// square and plain on purpose: the brand is now typographic — plain Archivo plus a
// vermilion full stop — and a handwriting-style banner would be the loudest thing
// in a system whose whole argument is restraint.
export const LIMN_ASCII = String.raw`
  _      _____ __  __ _   _
 | |    |_   _|  \/  | \ | |
 | |      | | | |\/| |  \| |
 | |___  _| |_| |  | | |\  |
 |_____||_____|_|  |_|_| \_|
`;

export const TAGLINE =
  "Local-only dashboard for your team's GitHub PR activity.";
