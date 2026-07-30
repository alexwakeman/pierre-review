import type { AnnotationRunResponse } from '@pierre-review/shared';

// What a finished "Check review" run has to SAY for itself.
//
// The invariant this exists to hold: a click on "✨ Check review" must never be silent. The run
// route answers 200 for every non-error outcome — including the two that produce nothing at all
// (no AI credential on the server, and the account's monthly AI credits spent) — so a 200 alone
// tells the reader nothing. Before the sweep bar was removed, those two states arrived as SSE
// `{type:'error'}` events and as the bar's `· out of credits` suffix; with the SSE path and the
// bar both gone, `state.error` is only ever set by a non-2xx (the 429 gate), and every 200 with
// zero output rendered as the button flipping back to its idle label with nothing beside it.
//
// `noAuth` is the server saying outright that it has no usable Anthropic credential. The counter
// arithmetic below predates that flag and is kept as a FALLBACK, because the flag is optional on
// the wire (an older plugin build omits it) and because it still catches any future early return
// that produces nothing without announcing itself:
//   requested = units it considered (including the ones it refused as ineligible)
//   skipped   = units it refused before costing anything
//   cached    = units whose stored judgement still matched their payload hash ($0)
//   generated / failed = units a model call actually produced / lost
// so `requested - cached - skipped` is the number of units that NEEDED a billed call. When that is
// positive and neither `generated` nor `failed` accounts for any of them, the run bailed before the
// loop. That inference is worded with "may" precisely because it is an inference; the flag path
// above it is not, and says so plainly.
//
// Returns null when the panels themselves are the feedback (something was generated) — an extra
// "done" line next to a freshly rendered judgement is noise.
export function annotationRunMessage(result: AnnotationRunResponse | null): string | null {
  if (result == null) return null;

  // A hard stop: the loop broke mid-run, so anything already generated is only part of the answer.
  if (result.creditsExhausted) {
    return result.generated > 0
      ? `AI credits exhausted — only ${result.generated} of the checks ran.`
      : 'AI credits exhausted this month.';
  }

  if (result.noAuth) return 'No AI credential is configured on the server.';

  const needed = result.requested - result.cached - result.skipped;
  if (needed > 0 && result.generated === 0 && result.failed === 0) {
    return 'Nothing was produced — the server may have no AI credential configured.';
  }

  if (result.failed > 0) {
    return result.generated > 0
      ? `${result.generated} checked · ${result.failed} failed.`
      : `${result.failed} check${result.failed === 1 ? '' : 's'} failed.`;
  }

  if (result.generated > 0) return null;
  if (result.cached > 0) return 'Already up to date.';
  return 'Nothing here to check.';
}
