import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { Button, cx, FOCUS_RING } from '../ui/index.js';
import { CheckIcon } from '../Icons.js';

// Shared, READ-ONLY presentational helpers for the config-modal sections. Kept in one small
// file so each section component stays self-contained (sections never edit this file → the
// features touch disjoint files).
//
// THE REDESIGN (docs/redesign/DESIGN.md): sections are separated by SPACE, never a rule; a
// section's heading is the one `text-title`, its consequence line `text-meta`, its controls
// `text-body`; fields are a raised tone with a hairline ring; the Save is the section's ONE primary
// button; checkboxes and radios are real <input>s, restyled (`CheckInput` / `RadioInput` below for
// rows that lay out their own label; the `Checkbox` / `Radio` primitives in ui/ otherwise).
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
  info,
  headingId,
  children,
}: {
  title: string;
  // Set on a section the modal can be OPENED AT (`SettingsFocus`): the heading gets this id and is
  // focusable from script (tabIndex -1), so the modal can scroll to it and move focus there.
  headingId?: string;
  // The control's own one-line consequence. Stays visible.
  desc?: ReactNode;
  // An <InfoButton> beside the title: how the setting works, examples, caveats that apply to every
  // reading. Multi-sentence methodology goes here, never in `desc`.
  info?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="pb-6 text-body text-ui-ink last:pb-0">
      <div className="flex items-center gap-1">
        <h3
          id={headingId}
          tabIndex={headingId != null ? -1 : undefined}
          className="scroll-mt-4 text-title text-ui-ink outline-none"
        >
          {title}
        </h3>
        {info}
      </div>
      {desc != null && <p className="mt-0.5 text-meta text-ui-mute">{desc}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  group = false,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  /** A <div>, not a <label>: for a custom `Select` (its button names itself with `label`). A
   *  <label> around a listbox re-clicks the button on every option click and reopens it. */
  group?: boolean;
  children: ReactNode;
}): JSX.Element {
  if (group) {
    return (
      <div className="flex flex-col items-start gap-1 text-body">
        <span className="text-meta font-medium text-ui-mute">{label}</span>
        {children}
        {hint != null && <span className="text-meta text-ui-faint">{hint}</span>}
      </div>
    );
  }
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1 text-body">
      <span className="text-meta font-medium text-ui-mute">{label}</span>
      {children}
      {hint != null && <span className="text-meta text-ui-faint">{hint}</span>}
    </label>
  );
}

/** A text field (input, textarea, a native time/date/number input): a raised tone with a hairline
 *  ring, the accent ring on focus, 40px tall on touch. */
export const inputCls =
  'w-full rounded-ui bg-ui-raise px-2.5 py-1.5 text-body text-ui-ink ring-1 ring-inset ring-ui-line placeholder:text-ui-faint outline-none focus:ring-2 focus:ring-ui-accent disabled:opacity-50 touch:py-2.5 [color-scheme:light] dark:[color-scheme:dark]';

export function SaveButton({
  dirty,
  saving,
  onClick,
}: {
  dirty: boolean;
  saving: boolean;
  onClick: () => void;
}): JSX.Element {
  // The section's ONE primary action, disabled until something changed — so a glance says which
  // section holds an unsaved draft.
  return (
    <Button variant="primary" size="sm" onClick={onClick} disabled={!dirty || saving} className="self-start">
      {saving ? 'Saving…' : 'Save'}
    </Button>
  );
}

type BareInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * A bare checkbox for a row that already has its own <label> (most sections lay out the words, the
 * hint and an ⓘ themselves). The shared `Checkbox` look — a REAL <input>, restyled, with the
 * Icons.tsx check laid over it — so forms, `name`/`value` selectors and Playwright clicks still work.
 */
export const CheckInput = forwardRef<HTMLInputElement, BareInputProps>(function CheckInput({ className, ...rest }, ref) {
  return (
    <span className={cx('relative inline-flex h-4 w-4 shrink-0 align-[-3px]', className)}>
      <input
        ref={ref}
        type="checkbox"
        className={cx(
          'peer h-4 w-4 cursor-pointer appearance-none rounded-ui bg-ui-raise ring-1 ring-inset ring-ui-line',
          'checked:bg-ui-accent-fill checked:ring-0 disabled:cursor-not-allowed disabled:opacity-50',
          'motion-safe:transition-colors motion-safe:duration-ui-fast',
          FOCUS_RING,
        )}
        {...rest}
      />
      <span className="pointer-events-none absolute inset-0 hidden items-center justify-center text-ui-on-accent peer-checked:flex">
        <CheckIcon size={12} />
      </span>
    </span>
  );
});

/** A bare radio, the shared `Radio` look, for a row that already has its own <label>. */
export const RadioInput = forwardRef<HTMLInputElement, BareInputProps>(function RadioInput({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      type="radio"
      className={cx(
        'relative h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-full bg-ui-raise align-[-3px] ring-1 ring-inset ring-ui-line',
        'checked:ring-[5px] checked:ring-ui-accent-fill disabled:cursor-not-allowed disabled:opacity-50',
        'motion-safe:transition-[box-shadow] motion-safe:duration-ui-fast',
        FOCUS_RING,
        className,
      )}
      {...rest}
    />
  );
});
