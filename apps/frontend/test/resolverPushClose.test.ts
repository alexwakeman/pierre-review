// The conflict resolver's ways out after a push — `store/conflictResolver.ts`.
//
// WHAT THIS PINS: once a push MAY have landed, every way out of the resolver files as
// `'committed'`. The reopen toast offered after a `'user'` close ends "nothing pushed", and the
// shell's close-time refetch (the second chance to clear the Pending conflicts card) hangs off the
// same fact. The window that used to be missed is the commit POST still on the wire: the server
// can push a body it accepted after the reader has closed the overlay.
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { ConflictCommitState } from '@pierre-review/shared';
import { closeReasonAfterPush, pushMayHaveLanded } from '../src/store/conflictResolver.js';

const idle = { isPending: false, isSuccess: false };
const onTheWire = { isPending: true, isSuccess: false };
const accepted = { isPending: false, isSuccess: true };
const commit = (status: ConflictCommitState['status']) => ({ status });

describe('could a push have landed?', () => {
  it('no: nothing sent', () => {
    expect(pushMayHaveLanded(null, idle)).toBe(false);
  });

  it('yes: the POST is on the wire, before any 202', () => {
    expect(pushMayHaveLanded(null, onTheWire)).toBe(true);
  });

  it("yes: a retry's POST is on the wire while the session still shows the last failure", () => {
    expect(pushMayHaveLanded(commit('failed'), onTheWire)).toBe(true);
  });

  it('yes: the 202 arrived, or the stream says running, or done', () => {
    expect(pushMayHaveLanded(null, accepted)).toBe(true);
    expect(pushMayHaveLanded(commit('running'), idle)).toBe(true);
    expect(pushMayHaveLanded(commit('done'), idle)).toBe(true);
  });

  it('no: the stream said it failed (a refusal is a known outcome — nothing was pushed)', () => {
    expect(pushMayHaveLanded(commit('failed'), accepted)).toBe(false);
    expect(pushMayHaveLanded(commit('failed'), idle)).toBe(false);
  });
});

describe('the reason a way out files', () => {
  it("is 'committed' after a push, whatever the gesture", () => {
    expect(closeReasonAfterPush(true, 'user')).toBe('committed');
    expect(closeReasonAfterPush(true, 'navigated')).toBe('committed');
  });

  it("keeps the gesture's own reason otherwise, so the reopen toast is still offered", () => {
    expect(closeReasonAfterPush(false, 'user')).toBe('user');
    expect(closeReasonAfterPush(false, 'navigated')).toBe('navigated');
  });
});
