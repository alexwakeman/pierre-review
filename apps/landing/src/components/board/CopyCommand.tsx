import { useEffect, useRef, useState } from 'react';
import { INSTALL_COMMAND } from '../../lib/site';
import { copyText } from './copyText';

/**
 * The copy button for `npx limn-review`. The command itself is always printed
 * beside it by the caller, so a failed copy (or no JS) still leaves it readable.
 */
export function CopyCommand({ label = 'Copy the command', className = 'btn' }: { label?: string; className?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = (): void => {
    void copyText(INSTALL_COMMAND).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <button className={className} type="button" onClick={copy}>
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </button>
  );
}
