import { useEffect, useRef, useState } from 'react';
import { Checkbox } from '../ui/index.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { CaretIcon, CloseIcon } from '../Icons.js';

// Repo filter for a drill-down list (the Flow-metric sub-tabs and the workspace-wide open-PRs
// tab) — matches the header FilterBar dropdowns (pill trigger + popover + checkbox rows).
// "All Workspace repos" flattens the list across every repo the drill-down covers; ticking
// individual repos filters to just those. The selection is `null` = all (the canonical
// "everything" state) or an explicit id array. Multi-select; LOCAL client-side state owned by
// the parent (MetricsDetail keys it per WorkspaceMetricKey) — it must never write
// `filters.repoIds`, the Timeline board's picker.
export function MetricRepoFilter({
  repos,
  selected,
  onChange,
}: {
  repos: { id: number; fullName: string }[]; // the repos with data in the drill-down
  selected: number[] | null; // null = every repo in the drill-down (i.e. the whole Workspace)
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
      <span className="inline-flex items-center whitespace-nowrap rounded-full text-meta text-ui-mute">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          className={`inline-flex items-center gap-1 py-0.5 pl-2.5 ${isAll ? 'pr-2.5' : 'pr-1'}`}
        >
          {isAll ? 'All Workspace repos' : `Repos (${shown}/${total})`}
          <CaretIcon dir="down" />
        </button>
        {!isAll && (
          <button
            type="button"
            onClick={() => onChange(null)}
            title="Show all Workspace repos"
            aria-label="Show all Workspace repos"
            className="flex items-center self-stretch py-0.5 pl-0.5 pr-2 opacity-60 hover:opacity-100"
          >
            <CloseIcon size={11} />
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="Filter by repo"
          className="absolute right-0 top-full z-[60] mt-1 w-64 rounded-ui bg-ui-surface p-2 shadow-lg"
        >
          <Checkbox
            className="w-full rounded-ui px-1 py-1 font-medium hover:bg-ui-hover"
            checked={isAll}
            onChange={() => onChange(null)}
            label="All Workspace repos"
          />
          <div className="my-1" />
          <div className="max-h-72 overflow-y-auto">
            {total === 0 ? (
              <div className="px-1 py-2 text-meta text-ui-mute">No repos with data.</div>
            ) : (
              repos.map((r) => {
                // "only" is a no-op / hidden when this repo is already the sole selection
                // (or there's just one repo) — mirrors the header FilterBar's RepoSelectPanel.
                const soleSelected =
                  selected != null && selected.length === 1 && selected[0] === r.id;
                return (
                  <div
                    key={r.id}
                    className="group flex items-center gap-2 rounded-ui px-1 py-1 text-meta hover:bg-ui-hover"
                  >
                    <Checkbox
                      className="min-w-0 flex-1"
                      checked={isChecked(r.id)}
                      onChange={() => toggle(r.id)}
                      label={
                        <span className="block min-w-0 truncate" title={r.fullName}>
                          {r.fullName}
                        </span>
                      }
                    />
                    {/* Quick-isolate: scope this drill-down to just this one repo (deselect the
                        rest) — the same affordance as the header Repos dropdown. Hidden when it's
                        already the sole repo shown. */}
                    {total > 1 && !soleSelected && (
                      <button
                        type="button"
                        onClick={() => onChange([r.id])}
                        title={`Show only ${r.fullName}`}
                        aria-label={`Show only ${r.fullName}`}
                        className="shrink-0 rounded-ui px-1.5 py-0.5 text-meta font-medium text-ui-faint opacity-0 hover:bg-ui-hover hover:text-ui-ink focus:opacity-100 group-hover:opacity-100"
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
