import type { AddressedConfidence } from '@pierre-review/shared';
import { CONFIDENCE_META, vendorInk } from '../lib/ui.js';

// A compact "how sure are we it was addressed?" pill rendered beside a thread's StateBadge for
// likely_addressed threads. DETERMINISTIC (free) — distinct from the Pro ✨ verdict marker. Hidden
// for `none` (nothing to say). The `reason` machine tag (e.g. 'outdated+commit') shows in the tooltip.
export function ConfidenceBadge({
  confidence,
  reason,
}: {
  confidence: AddressedConfidence;
  reason?: string | null;
}): JSX.Element | null {
  if (confidence === 'none') return null;
  const meta = CONFIDENCE_META[confidence];
  const title = reason ? `${meta.description}\nSignal: ${reason}` : meta.description;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ backgroundColor: `${meta.color}1a`, ...vendorInk(meta.color) }}
      title={title}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      {meta.label} confidence
    </span>
  );
}
