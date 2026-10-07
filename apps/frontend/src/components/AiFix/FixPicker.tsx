import type {
  AiFixPickerItem,
  AiFixPickerPreview,
  AiFixPickerSection,
  ClaudeFindingSeverity,
} from '@pierre-review/shared';

// THE FIX PICKER — what a manual "Fix from review" will hand the fixer, before it starts. One card
// per item, grouped by section, each ticked or not. The SERVER builds the list
// (`GET …/ai-fix/preview`) with stable keys and its defaults (everything except style-bot threads);
// the reader's ticks travel as `include` keys on the start, and the server applies the prompt
// budget AFTER that selection. The budget fold here mirrors the server's (`budgetCut`): items in
// the preview's order (already priority order), the first ticked one always fits.

export const PICKER_SECTION_ORDER: readonly AiFixPickerSection[] = [
  'findings',
  'earlier_findings',
  'judged_threads',
  'untouched_threads',
  'ci_failures',
  'style_bots',
  'story',
];

export const PICKER_SECTION_LABEL: Record<AiFixPickerSection, string> = {
  findings: 'Claude’s findings',
  earlier_findings: 'Earlier findings still open',
  judged_threads: 'Threads Claude says need a fix',
  untouched_threads: 'Unanswered threads',
  ci_failures: 'CI failures',
  style_bots: 'Style bot comments',
  story: 'Ticket gaps',
};

const SEVERITY_LABEL: Record<ClaudeFindingSeverity, string> = {
  blocker: 'Blocker',
  warning: 'Warning',
  nit: 'Nit',
  question: 'Question',
  praise: 'Praise',
};
const SEVERITY_CLASS: Partial<Record<ClaudeFindingSeverity, string>> = {
  blocker: 'bg-red-500/10 text-red-700 dark:text-red-300',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  nit: 'bg-gray-500/10 text-gray-600 dark:text-gray-300',
};

/** The reader's ticks: an override per key over the server's default. */
export type PickerOverrides = Record<string, boolean>;

export function isPicked(item: AiFixPickerItem, overrides: PickerOverrides): boolean {
  return overrides[item.key] ?? item.defaultIncluded;
}

/** The keys that will be sent, in the preview's order. */
export function pickedKeys(preview: AiFixPickerPreview, overrides: PickerOverrides): string[] {
  return preview.items.filter((i) => isPicked(i, overrides)).map((i) => i.key);
}

/** Which ticked keys the prompt budget will leave out — the server's fold over the same order. */
export function budgetCutKeys(preview: AiFixPickerPreview, overrides: PickerOverrides): Set<string> {
  const cut = new Set<string>();
  let used = 0;
  for (const i of preview.items) {
    if (!isPicked(i, overrides)) continue;
    if (used > 0 && used + i.chars > preview.budgetChars) {
      cut.add(i.key);
      continue;
    }
    used += i.chars;
  }
  return cut;
}

function where(path: string | null, line: number | null): string | null {
  if (!path) return null;
  return line != null ? `${path}:${line}` : path;
}

export function FixPicker({
  preview,
  overrides,
  onChange,
  disabled,
}: {
  preview: AiFixPickerPreview;
  overrides: PickerOverrides;
  onChange: (next: PickerOverrides) => void;
  disabled?: boolean;
}): JSX.Element {
  const cut = budgetCutKeys(preview, overrides);
  const bySection = new Map<AiFixPickerSection, AiFixPickerItem[]>();
  for (const i of preview.items) {
    const list = bySection.get(i.section) ?? [];
    list.push(i);
    bySection.set(i.section, list);
  }
  const set = (keys: string[], on: boolean): void => {
    const next = { ...overrides };
    for (const k of keys) next[k] = on;
    onChange(next);
  };

  if (preview.items.length === 0) {
    return <p className="text-xs text-gray-500 dark:text-gray-400">The review found nothing to fix.</p>;
  }

  return (
    <div className="space-y-3">
      {PICKER_SECTION_ORDER.filter((s) => bySection.has(s)).map((section) => {
        const items = bySection.get(section)!;
        const on = items.filter((i) => isPicked(i, overrides)).length;
        const all = on === items.length;
        return (
          <section key={section} aria-label={PICKER_SECTION_LABEL[section]}>
            <div className="mb-1 flex items-center gap-2">
              <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                {PICKER_SECTION_LABEL[section]}
              </h4>
              <span className="text-[11px] text-gray-500 dark:text-gray-400">
                {on} of {items.length}
              </span>
              <button
                type="button"
                className="ml-auto text-[11px] text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                disabled={disabled}
                onClick={() =>
                  set(
                    items.map((i) => i.key),
                    !all,
                  )
                }
              >
                {all ? 'Untick all' : 'Tick all'}
              </button>
            </div>
            <ul className="space-y-1">
              {items.map((i) => {
                const picked = isPicked(i, overrides);
                const loc = where(i.path, i.line);
                return (
                  <li key={i.key}>
                    <label
                      className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-xs ${
                        picked
                          ? 'border-blue-300 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20'
                          : 'border-gray-200 dark:border-gray-800'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={picked}
                        disabled={disabled}
                        onChange={(e) => set([i.key], e.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          {i.severity && SEVERITY_CLASS[i.severity] && (
                            <span
                              className={`rounded px-1 py-px text-[11px] font-medium ${SEVERITY_CLASS[i.severity]}`}
                            >
                              {SEVERITY_LABEL[i.severity]}
                            </span>
                          )}
                          <span className="break-words text-gray-800 dark:text-gray-100">{i.label}</span>
                          {picked && cut.has(i.key) && (
                            <span className="rounded bg-amber-500/10 px-1 py-px text-[11px] text-amber-700 dark:text-amber-300">
                              Won’t fit
                            </span>
                          )}
                        </span>
                        {(loc || i.detail) && (
                          <span className="mt-0.5 block break-words text-[11px] text-gray-500 dark:text-gray-400">
                            {loc && <span className="font-mono">{loc}</span>}
                            {loc && i.detail ? ' · ' : ''}
                            {i.detail}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {cut.size > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {cut.size} ticked {cut.size === 1 ? 'item does' : 'items do'} not fit in one fix and will be left out.
          Untick something to make room.
        </p>
      )}
    </div>
  );
}
