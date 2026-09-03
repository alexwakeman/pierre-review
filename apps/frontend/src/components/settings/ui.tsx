import type { ReactNode } from 'react';

// Shared, READ-ONLY presentational helpers for the config-modal sections. Kept in one small
// file so each section component stays self-contained (sections never edit this file → the
// features touch disjoint files).
//
// ⚠ THERE IS NO `SectionProps` ANY MORE, AND THAT IS A GRAIN FACT, NOT A TIDY-UP. It was
// `{settings, save, saving}` — the ACCOUNT's `ProSettings` plus the modal's one shared account
// mutation, threaded down into whichever sections wrote at that grain. No section does: the last
// account-grained control in this modal, the comparison-window mode, moved onto the workspace row
// in plugin migration 0032, and the bot Slack-digest toggle onto the delivery row in 0033. Every
// remaining section owns its OWN scoped query and mutation, which is what makes a Save's blast
// radius a property of the section rather than of a prop somebody passed it.

export function SectionShell({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="border-b border-gray-100 pb-4 last:border-b-0 dark:border-gray-800">
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
      {desc != null && (
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{desc}</p>
      )}
      <div className="mt-2.5 space-y-2.5">{children}</div>
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-gray-600 dark:text-gray-300">{label}</span>
      {children}
      {hint != null && <span className="text-[11px] text-gray-400">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-sky-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100';

export function SaveButton({
  dirty,
  saving,
  onClick,
}: {
  dirty: boolean;
  saving: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!dirty || saving}
      className="self-start rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {saving ? 'Saving…' : 'Save'}
    </button>
  );
}
