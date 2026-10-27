import type { CheckRunState } from '@pierre-review/shared';
import type { GqlCheckContext } from './queries.js';

// Exported because sync/branch-status.ts maps the SAME contexts union for default-branch
// commits. The CheckRun status/conclusion → CheckRunState table must not exist twice: if trunk
// and PR surfaces disagreed about what "failing" means, the same check would render differently
// depending on where you looked at it.
export function checkContextState(c: GqlCheckContext): CheckRunState {
  if (c.__typename === 'StatusContext') {
    switch ((c.state ?? '').toUpperCase()) {
      case 'SUCCESS':
        return 'success';
      case 'FAILURE':
        return 'failure';
      case 'ERROR':
        return 'error';
      case 'PENDING':
      case 'EXPECTED':
        return 'pending';
      default:
        return 'unknown';
    }
  }
  // CheckRun: outcome is meaningful only once completed.
  if ((c.status ?? '').toUpperCase() !== 'COMPLETED') return 'pending';
  switch ((c.conclusion ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
    case 'ACTION_REQUIRED':
      return 'failure';
    case 'CANCELLED':
    case 'STALE':
    case 'NEUTRAL':
      return 'neutral';
    case 'SKIPPED':
      return 'skipped';
    default:
      return 'unknown';
  }
}

