// Best-effort detection of a review bot's OWN "I re-checked and this is handled" follow-up
// comment inside a thread. Vendor-specific + intentionally CONSERVATIVE: a match only RAISES the
// deterministic addressed-confidence / promotes a thread to `likely_addressed` (see
// derive-thread-state.ts). It is NEVER the sole basis for a blind auto-resolve — every resolve
// path still requires `likely_addressed` + unresolved + an explicit user (or rule) selection.
//
// Kept small and covered by the derive-thread-state fixtures; extend per vendor as real phrasings
// are captured. `kind` is a `ReviewBotKind` string (from bot-detection.reviewBotKind).

// Phrasings common across bots when they acknowledge a comment was resolved by a later change.
const GENERIC_MARKERS: RegExp[] = [
  /\b(addressed|resolved|fixed|handled)\s+(in|by)\s+(commit\s+)?[0-9a-f]{7,40}\b/i,
  /(^|\s)✅\s*(addressed|resolved|done|fixed)\b/i,
  /\bthis (has been|is now|was) (addressed|resolved|fixed)\b/i,
  /\bmarking (this|the thread|as)\b.*\bresolved\b/i,
  /\bno longer (applies|relevant)\b/i,
];

// Optional per-vendor additions, keyed by ReviewBotKind. Absent kind = generic only.
const VENDOR_MARKERS: Record<string, RegExp[]> = {
  coderabbit: [/\b(verified|confirmed)\b.*\b(addressed|resolved)\b/i],
};

// True when a review-bot comment body reads as the bot confirming the point was handled.
export function matchBotResolutionMarker(kind: string, body: string): boolean {
  if (!body) return false;
  if (GENERIC_MARKERS.some((re) => re.test(body))) return true;
  const extra = VENDOR_MARKERS[kind];
  return extra ? extra.some((re) => re.test(body)) : false;
}
