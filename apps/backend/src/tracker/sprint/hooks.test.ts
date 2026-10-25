import { afterEach, describe, expect, it } from 'vitest';
import { afterSprintRead, noteManualSprintRead, setAfterSprintRead } from './hooks.js';

describe('afterSprintRead: the reader’s Refresh is marked manual, once', () => {
  afterEach(() => setAfterSprintRead(null));

  it('a scheduled read is not manual; a Refresh marks the NEXT read only; a stale mark is ignored', () => {
    const seen: boolean[] = [];
    setAfterSprintRead((_a, _w, manual) => seen.push(manual));
    afterSprintRead(1, 2, 1_000);
    noteManualSprintRead(1, 2, 2_000);
    afterSprintRead(1, 3, 2_100); // another workspace: not this mark
    afterSprintRead(1, 2, 2_100);
    afterSprintRead(1, 2, 2_200); // consumed
    noteManualSprintRead(1, 2, 3_000);
    afterSprintRead(1, 2, 3_000 + 11 * 60 * 1000); // the read never landed in time
    expect(seen).toEqual([false, false, true, false, false]);
  });
});
