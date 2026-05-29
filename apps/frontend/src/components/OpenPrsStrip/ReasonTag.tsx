import type { ReasonTag as ReasonTagT } from '@gh-team-monitor/shared';
import { REASON_META } from '../../lib/ui.js';

export function ReasonTag({ tag }: { tag: ReasonTagT }): JSX.Element {
  const meta = REASON_META[tag];
  return (
    <span
      className="inline-flex items-center gap-1 truncate text-[11px] font-medium"
      style={{ color: meta.color }}
      title={meta.label}
    >
      <span aria-hidden>⏵</span>
      {meta.label}
    </span>
  );
}
