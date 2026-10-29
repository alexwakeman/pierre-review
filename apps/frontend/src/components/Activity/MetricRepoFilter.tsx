import { useEffect, useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { CaretIcon, CloseIcon } from '../Icons.js';
import { Checkbox } from '../ui/index.js';

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
      <span className="inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise text-meta text-ui-mute hover:bg-ui-hover touch:h-10">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          className={`inline-flex h-full items-center gap-1 rounded-ui pl-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent ${isAll ? 'pr-2' : 'pr-1 font-medium text-ui-ink'}`}
        >
          {isAll ? (
            <>
              All <span className="max-sm:hidden">Workspace </span>repos
            </>
          ) : (
            `Repos (${shown}/${total})`
          )}
          <CaretIcon dir="down" />
        </button>
        {!isAll && (
          <button
            type="button"
            onClick={() => onChange(null)}
            title="Show all Workspace repos"
            aria-label="Show all Workspace repos"
            className="flex items-center self-stretch rounded-ui pl-0.5 pr-2 text-ui-faint hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:px-3"
          >
            <CloseIcon size={11} />
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="Filter by repo"
          className="absolute right-0 top-full z-[60] mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-ui bg-ui-raise p-1.5 shadow-lg ring-1 ring-ui-line motion-safe:animate-ui-pop"
        >
          <Checkbox
            checked={isAll}
            onChange={() => onChange(null)}
            label={<span className="font-medium">All Workspace repos</span>}
            className="flex w-full rounded-ui px-1.5 py-1.5 hover:bg-ui-hover"
          />
          <div aria-hidden className="mx-1.5 my-1 h-px bg-ui-line" />
          <div className="max-h-72 overflow-y-auto">
            {total === 0 ? (
              <div className="px-1.5 py-2 text-body text-ui-mute">No repos with data.</div>
            ) : (
              repos.map((r) => {
                // "only" is a no-op / hidden when this repo is already the sole selection
                // (or there's just one repo) — mirrors the header FilterBar's RepoSelectPanel.
                const soleSelected =
                  selected != null && selected.length === 1 && selected[0] === r.id;
                return (
                  <div
                    key={r.id}
                    className="group flex items-center gap-2 rounded-ui px-1.5 py-1 hover:bg-ui-hover"
                  >
                    <Checkbox
                      checked={isChecked(r.id)}
                      onChange={() => toggle(r.id)}
                      label={
                        <span className="block truncate" title={r.fullName}>
                          {r.fullName}
                        </span>
                      }
                      className="min-w-0 flex-1"
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
                        className="shrink-0 rounded-ui px-1.5 py-0.5 text-meta text-ui-mute opacity-0 hover:bg-ui-sel hover:text-ui-ink focus:opacity-100 group-hover:opacity-100 touch:opacity-100"
                      >
                        Only
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
