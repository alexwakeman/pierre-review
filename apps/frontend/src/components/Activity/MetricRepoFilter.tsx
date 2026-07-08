import { useEffect, useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';

// Repo filter for a Flow-metric drill-down list — matches the header FilterBar dropdowns
// (pill trigger + popover + checkbox rows). "All team repos" flattens the list across every
// repo; ticking individual repos filters to just those. The selection is `null` = all (the
// canonical "everything" state) or an explicit id array. Multi-select; each metric tab owns
// its own selection (the parent keys this per TeamMetricKey).
export function MetricRepoFilter({
  repos,
  selected,
  onChange,
}: {
  repos: { id: number; fullName: string }[]; // the repos with data in the drill-down
  selected: number[] | null; // null = all team repos
  onChange: (sel: number[] | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const allIds = repos.map((r) => r.id);
  const total = allIds.length;
  const isAll = selected == null;
  const isChecked = (id: number): boolean => isAll || selected!.includes(id);

  // Toggle one repo. Working from the effective set (all when null), then canonicalise:
  // back to `null` when everything ends up selected so the trigger reads "all" again.
  const toggle = (id: number): void => {
    const cur = isAll ? allIds : selected!;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    onChange(next.length === total ? null : next);
  };

  const shown = isAll ? total : selected!.length;

  return (
    <div ref={rootRef} className="relative">
      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-gray-300 text-xs text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          className={`inline-flex items-center gap-1 py-0.5 pl-2.5 ${isAll ? 'pr-2.5' : 'pr-1'}`}
        >
          {isAll ? 'All team repos' : `Repos (${shown}/${total})`}
          <span aria-hidden className="text-[9px]">
            ▾
          </span>
        </button>
        {!isAll && (
          <button
            type="button"
            onClick={() => onChange(null)}
            title="Show all team repos"
            aria-label="Show all team repos"
            className="py-0.5 pl-0.5 pr-2 opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="Filter by repo"
          className="absolute right-0 top-full z-[60] mt-1 w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs font-medium hover:bg-gray-100 dark:hover:bg-gray-800">
            <input type="checkbox" checked={isAll} onChange={() => onChange(null)} />
            <span className="text-gray-800 dark:text-gray-100">All team repos</span>
          </label>
          <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
          <div className="max-h-72 overflow-y-auto">
            {total === 0 ? (
              <div className="px-1 py-2 text-xs text-gray-500">No repos with data.</div>
            ) : (
              repos.map((r) => {
                // "only" is a no-op / hidden when this repo is already the sole selection
                // (or there's just one repo) — mirrors the header FilterBar's RepoSelectPanel.
                const soleSelected =
                  selected != null && selected.length === 1 && selected[0] === r.id;
                return (
                  <div
                    key={r.id}
                    className="group flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={isChecked(r.id)} onChange={() => toggle(r.id)} />
                      <span className="min-w-0 truncate text-gray-800 dark:text-gray-100" title={r.fullName}>
                        {r.fullName}
                      </span>
                    </label>
                    {/* Quick-isolate: scope this drill-down to just this one repo (deselect the
                        rest) — the same affordance as the header Repos dropdown. Hidden when it's
                        already the sole repo shown. */}
                    {total > 1 && !soleSelected && (
                      <button
                        type="button"
                        onClick={() => onChange([r.id])}
                        title={`Show only ${r.fullName}`}
                        aria-label={`Show only ${r.fullName}`}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400 opacity-0 hover:bg-gray-200 hover:text-gray-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                      >
                        only
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
