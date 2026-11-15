// The "ENSEMBLE" banner shown by the CLI on launch — figlet's plain "Big" letters, 6 lines,
// 56 columns, so it renders cleanly in any terminal. Built from plain strings (not String.raw):
// the N carries a backtick.
//
// The letterforms ARE the name, so each rename redraws the banner rather than editing it (a
// cursive "Pierre", then a square "LIMN"). The constant keeps its old identifier on purpose
// (packages/shared/src/product.ts: identifiers are never renamed).
export const LIMN_ASCII = [
  '',
  '  ______ _   _  _____ ______ __  __ ____  _      ______',
  ' |  ____| \\ | |/ ____|  ____|  \\/  |  _ \\| |    |  ____|',
  ' | |__  |  \\| | (___ | |__  | \\  / | |_) | |    | |__',
  ' |  __| | . ` |\\___ \\|  __| | |\\/| |  _ <| |    |  __|',
  ' | |____| |\\  |____) | |____| |  | | |_) | |____| |____',
  ' |______|_| \\_|_____/|______|_|  |_|____/|______|______|',
  '',
].join('\n');

export const TAGLINE =
  "Local-only dashboard for your team's GitHub PR activity.";
