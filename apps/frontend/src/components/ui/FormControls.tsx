import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { CheckIcon, MinusIcon } from '../Icons.js';
import { cx, FOCUS_RING } from './cx.js';

// CHECKBOX · RADIO · SWITCH (docs/redesign/DESIGN.md § Controls).
//
// ⚠ EACH IS A REAL <input>, RESTYLED (`appearance-none`), never a div pretending. So a <form>,
// `name`/`value`, `checked`, a <label>, the browser's own keyboard handling and every existing
// selector keep working — scripts/verify-demo.mjs clicks `input[name=ai-provider][value=codex]`, and
// Playwright can only click what is a real, visible input. The mark (✓, the dot, the thumb) is
// drawn by CSS or an Icons.tsx glyph laid over the box with `pointer-events-none`.
//
// The whole row (box + words) is the label, so the click target is the line, ≥ 40px on touch.

type BaseProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> & {
  /** The words. Omit only when an outer <label> already names the control. */
  label?: ReactNode;
  /** A second, quieter line under the label. */
  hint?: ReactNode;
  className?: string;
};

const ROW = 'group/ctl inline-flex cursor-pointer items-start gap-2 text-body text-ui-ink touch:min-h-10 touch:items-center has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50';

function Words({ label, hint }: { label?: ReactNode; hint?: ReactNode }): JSX.Element | null {
  if (label == null && hint == null) return null;
  return (
    <span className="min-w-0">
      {label != null && <span className="block">{label}</span>}
      {hint != null && <span className="block text-meta text-ui-faint">{hint}</span>}
    </span>
  );
}

export const Checkbox = forwardRef<HTMLInputElement, BaseProps & { indeterminate?: boolean }>(function Checkbox(
  { label, hint, className, indeterminate = false, ...rest },
  ref,
) {
  return (
    <label className={cx(ROW, className)}>
      <span className="relative mt-0.5 flex h-4 w-4 shrink-0 touch:mt-0">
        <input
          ref={(el) => {
            if (el) el.indeterminate = indeterminate;
            if (typeof ref === 'function') ref(el);
            else if (ref) ref.current = el;
          }}
          type="checkbox"
          aria-checked={indeterminate ? 'mixed' : undefined}
          className={cx(
            'peer h-4 w-4 cursor-[inherit] appearance-none rounded-ui bg-ui-raise ring-1 ring-inset ring-ui-line',
            'checked:bg-ui-accent-fill checked:ring-0 indeterminate:bg-ui-accent-fill indeterminate:ring-0',
            'motion-safe:transition-colors motion-safe:duration-ui-fast',
            FOCUS_RING,
          )}
          {...rest}
        />
        <span className="pointer-events-none absolute inset-0 hidden items-center justify-center text-ui-on-accent peer-checked:flex">
          {!indeterminate && <CheckIcon size={12} />}
        </span>
        {indeterminate && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-ui-on-accent">
            <MinusIcon size={12} />
          </span>
        )}
      </span>
      <Words label={label} hint={hint} />
    </label>
  );
});

/**
 * The checkbox BOX alone — the same restyled real <input> as `Checkbox`, without its own <label> —
 * for a row that is ALREADY a label holding more than words (an avatar, a colour dot, a shield: the
 * Timeline's filter panels). Never nest it in another `Checkbox`.
 */
export const CheckboxBox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'>>(function CheckboxBox(
  { className, ...rest },
  ref,
) {
  return (
    <span className={cx('relative flex h-4 w-4 shrink-0', className)}>
      <input
        ref={ref}
        type="checkbox"
        className={cx(
          'peer h-4 w-4 cursor-[inherit] appearance-none rounded-ui bg-ui-bg ring-1 ring-inset ring-ui-line',
          'checked:bg-ui-accent-fill checked:ring-0 disabled:opacity-50',
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

export const Radio = forwardRef<HTMLInputElement, BaseProps>(function Radio({ label, hint, className, ...rest }, ref) {
  return (
    <label className={cx(ROW, className)}>
      <input
        ref={ref}
        type="radio"
        className={cx(
          'relative mt-0.5 h-4 w-4 shrink-0 cursor-[inherit] appearance-none rounded-full bg-ui-raise ring-1 ring-inset ring-ui-line touch:mt-0',
          "checked:ring-[5px] checked:ring-ui-accent-fill",
          'motion-safe:transition-[box-shadow] motion-safe:duration-ui-fast',
          FOCUS_RING,
        )}
        {...rest}
      />
      <Words label={label} hint={hint} />
    </label>
  );
});

/** A titled group of radios (`role="radiogroup"`). Arrow keys move between them natively. */
export function RadioGroup({
  label,
  children,
  className,
  orientation = 'vertical',
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  orientation?: 'vertical' | 'horizontal';
}): JSX.Element {
  return (
    <fieldset className={cx('m-0 border-0 p-0', className)}>
      <legend className="mb-1.5 p-0 text-meta font-medium text-ui-mute">{label}</legend>
      <div role="radiogroup" className={cx('flex gap-x-4 gap-y-1.5', orientation === 'vertical' ? 'flex-col' : 'flex-wrap')}>
        {children}
      </div>
    </fieldset>
  );
}

/** An on/off setting that takes effect at once (`role="switch"`). For a choice saved by a Save button, use Checkbox. */
export const Switch = forwardRef<HTMLInputElement, BaseProps>(function Switch({ label, hint, className, ...rest }, ref) {
  return (
    <label className={cx(ROW, className)}>
      <input
        ref={ref}
        type="checkbox"
        role="switch"
        className={cx(
          'relative mt-px h-[18px] w-8 shrink-0 cursor-[inherit] appearance-none rounded-full bg-ui-hover ring-1 ring-inset ring-ui-line touch:mt-0',
          'before:absolute before:left-[2px] before:top-[2px] before:h-[14px] before:w-[14px] before:rounded-full before:bg-ui-mute before:content-[""]',
          'checked:bg-ui-accent-fill checked:ring-0 checked:before:translate-x-[14px] checked:before:bg-ui-on-accent',
          'motion-safe:transition-colors motion-safe:duration-ui motion-safe:before:transition-transform motion-safe:before:duration-ui',
          FOCUS_RING,
        )}
        {...rest}
      />
      <Words label={label} hint={hint} />
    </label>
  );
});
