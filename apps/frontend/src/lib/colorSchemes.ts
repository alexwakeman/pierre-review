// ── COLOUR SCHEMES (docs/FRONTEND.md § Colour schemes) ───────────────────────────────────────────
//
// Two defaults and seven named schemes. Each is ONE block of `--ui-*` + `--ai-*` channel values in
// index.css, keyed `[data-scheme='<id>']`; this file is the list of them (id, name, mode) and the
// browser-storage rule. `test/colorSchemes.test.ts` proves every id here has its CSS block and every
// block passes the same contrast floors as the defaults.
//
// ⚠ THE `.dark` CLASS STAYS. A scheme picks values; its MODE still sets `.dark` on <html>, so every
// `dark:` utility, the vendor-ink pick and the code colours keep following light/dark.
//
// ⚠ public/theme-boot.js APPLIES THE SAME RULE BEFORE FIRST PAINT. It is a plain script (CSP allows
// `'self'` scripts, never inline ones) and cannot import this file, so it repeats the three storage
// keys; the test reads it and pins them.

export type SchemeMode = 'light' | 'dark';

export const COLOR_SCHEMES = [
  { id: 'light', label: 'Limn Light', mode: 'light' },
  { id: 'solarized-light', label: 'Solarized Light', mode: 'light' },
  { id: 'github-light', label: 'GitHub Light', mode: 'light' },
  { id: 'gruvbox-light', label: 'Gruvbox Light', mode: 'light' },
  { id: 'dark', label: 'Limn Dark', mode: 'dark' },
  { id: 'solarized-dark', label: 'Solarized Dark', mode: 'dark' },
  { id: 'dracula', label: 'Dracula', mode: 'dark' },
  { id: 'nord', label: 'Nord', mode: 'dark' },
  { id: 'tokyo-night', label: 'Tokyo Night', mode: 'dark' },
] as const satisfies readonly { id: string; label: string; mode: SchemeMode }[];

export type ColorScheme = (typeof COLOR_SCHEMES)[number];
export type SchemeId = ColorScheme['id'];

/** The default of each mode. Its id is also the legacy `localStorage.theme` value. */
export const DEFAULT_SCHEME: Record<SchemeMode, SchemeId> = { light: 'light', dark: 'dark' };

/** ⚠ `theme` keeps its old meaning (`'light'` | `'dark'`, absent = dark), so a browser that set it
 *  before schemes existed opens on the same default, and e2e scripts that write it still work. The
 *  per-mode keys remember the last scheme used in each mode, so the sun/moon toggle swaps back to it. */
export const SCHEME_STORAGE = {
  mode: 'theme',
  light: 'theme-scheme-light',
  dark: 'theme-scheme-dark',
} as const;

export function schemeById(id: string | null | undefined): ColorScheme | null {
  return COLOR_SCHEMES.find((s) => s.id === id) ?? null;
}

export interface SchemeState {
  mode: SchemeMode;
  /** The last scheme used in each mode. */
  light: SchemeId;
  dark: SchemeId;
}

/** Reads the stored choice. A missing, unknown or wrong-mode id falls back to that mode's default. */
export function readSchemeState(get: (key: string) => string | null): SchemeState {
  const mode: SchemeMode = get(SCHEME_STORAGE.mode) === 'light' ? 'light' : 'dark';
  const pick = (m: SchemeMode): SchemeId => {
    const s = schemeById(get(SCHEME_STORAGE[m]));
    return s != null && s.mode === m ? s.id : DEFAULT_SCHEME[m];
  };
  return { mode, light: pick('light'), dark: pick('dark') };
}

export function currentScheme(state: SchemeState): ColorScheme {
  return schemeById(state[state.mode])!;
}

/** Choosing a scheme also chooses its mode. */
export function withScheme(state: SchemeState, id: SchemeId): SchemeState {
  const s = schemeById(id);
  if (s == null) return state;
  return { ...state, mode: s.mode, [s.mode]: s.id };
}

/** The sun/moon toggle: the other mode, on the scheme last used there. */
export function toggledMode(state: SchemeState): SchemeState {
  return { ...state, mode: state.mode === 'dark' ? 'light' : 'dark' };
}

export function writeSchemeState(set: (key: string, value: string) => void, state: SchemeState): void {
  set(SCHEME_STORAGE.mode, state.mode);
  set(SCHEME_STORAGE.light, state.light);
  set(SCHEME_STORAGE.dark, state.dark);
}

/** Puts the scheme on <html>: the mode's `.dark` class and the `data-scheme` the CSS keys on. */
export function applyScheme(root: HTMLElement, scheme: ColorScheme): void {
  root.classList.toggle('dark', scheme.mode === 'dark');
  root.setAttribute('data-scheme', scheme.id);
}

/**
 * THE GROUNDS VENDOR INK IS MEASURED AGAINST (`lib/ui.ts` `vendorInk`). `--ink-light` must clear AA
 * on every light scheme's page and `--ink-dark` on every dark one's, and the CSS picks between the
 * two by `.dark` alone. So each is fitted against the HARDEST page of its mode: the darkest light
 * page (Gruvbox Light) and the lightest dark page (Nord). A darker ink clears every lighter page,
 * and a lighter ink every darker one. `test/vendorInk.test.ts` checks these are those pages.
 */
export const INK_GROUNDS: Record<SchemeMode, string> = { light: '#fbf1c7', dark: '#2e3440' };
