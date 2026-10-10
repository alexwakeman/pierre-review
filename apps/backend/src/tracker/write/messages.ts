import {
  SPRINT_PROVIDER_LABEL,
  SPRINT_WRITE_MAYBE_SENTENCE,
  sprintNoWriteSentence,
  type TrackerProvider,
} from '@pierre-review/shared';
import type { TrackerWriteRow } from '../../db/sprint-store.js';

// The sentence a write-back record shows on its ticket. Names the provider; never echoes anything the
// tracker sent back (the record stores a code, not a body).

const providerOf = (raw: string): TrackerProvider =>
  raw === 'linear' || raw === 'github' ? raw : 'jira';

/** no_write_permission → sprintNoWriteSentence(provider); maybe_written → SPRINT_WRITE_MAYBE_SENTENCE;
 *  written / writing → null; every other failure → its own short sentence. */
export function trackerWriteMessage(r: Pick<TrackerWriteRow, 'status' | 'errorCode' | 'provider'>): string | null {
  if (r.status === 'written' || r.status === 'writing') return null;
  if (r.status === 'maybe_written') return SPRINT_WRITE_MAYBE_SENTENCE;
  const provider = providerOf(r.provider);
  const name = SPRINT_PROVIDER_LABEL[provider];
  switch (r.errorCode) {
    case 'no_write_permission':
      return sprintNoWriteSentence(provider);
    case 'not_found':
      return `${name} has no such ticket, or the token can’t see it.`;
    case 'rate_limited':
      return `${name} is limiting requests. Try again in a few minutes.`;
    case 'rejected':
      return `${name} refused the update.`;
    default:
      return `The update to ${name} failed.`;
  }
}
