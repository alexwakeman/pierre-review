import { COLOR_SCHEMES, type ColorScheme, type SchemeId } from '../../lib/colorSchemes.js';
import { setColorScheme, useColorScheme } from '../../hooks/useColorScheme.js';
import { Select, type SelectOption } from '../ui/Select.js';
import { Field, SectionShell } from './ui.js';

// SETTINGS → APPEARANCE: the colour scheme (docs/FRONTEND.md § Colour schemes). Per browser, no
// server call; a pick applies at once.
//
// Each option's name is painted IN ITS OWN SCHEME: the chip carries `data-scheme`, so index.css's
// block for that scheme sets the `--ui-*` values on the chip alone, and `bg-ui-bg text-ui-ink`
// resolve to that scheme's page and ink. Measured: every scheme's ink clears AA on its own page
// (test/colorSchemes.test.ts), so the chip is legible whatever the app is wearing.

function SchemeChip({ scheme }: { scheme: ColorScheme }): JSX.Element {
  return (
    <span
      data-scheme={scheme.id}
      className="inline-flex items-center gap-2 rounded-ui bg-ui-bg px-2 py-0.5 text-ui-ink ring-1 ring-inset ring-ui-line"
    >
      {scheme.label}
      <span className="flex items-center gap-1" aria-hidden>
        <span className="h-2 w-2 rounded-full bg-ui-accent" />
        <span className="h-2 w-2 rounded-full bg-ui-success" />
        <span className="h-2 w-2 rounded-full bg-ui-danger" />
        <span className="h-2 w-2 rounded-full bg-ai-signal" />
      </span>
    </span>
  );
}

const OPTIONS: SelectOption<SchemeId>[] = COLOR_SCHEMES.map((s) => ({
  value: s.id,
  text: s.label,
  label: <SchemeChip scheme={s} />,
  hint: s.mode === 'light' ? 'Light' : 'Dark',
}));

export function AppearanceSection(): JSX.Element {
  const scheme = useColorScheme();
  return (
    <SectionShell title="Colour scheme" desc="Saved in this browser.">
      <Field label="Scheme" group>
        <Select<SchemeId>
          label="Colour scheme"
          value={scheme.id}
          onChange={setColorScheme}
          options={OPTIONS}
          className="w-64 max-w-full"
        />
      </Field>
    </SectionShell>
  );
}
