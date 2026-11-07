// A successful Codex app-server turn, built from the 0.164 protocol schema (`codex app-server
// generate-json-schema`): no successful turn could be RECORDED yet (the ChatGPT account was over its
// usage limit during the spikes). Shared by the fold's and the driver's tests.
export const T = 'th-1';
export const usage = (total: [number, number, number], last: [number, number, number]) => ({
  method: 'thread/tokenUsage/updated',
  params: {
    threadId: T,
    turnId: 'tu-1',
    tokenUsage: {
      total: { inputTokens: total[0], cachedInputTokens: total[1], outputTokens: total[2], reasoningOutputTokens: 0, totalTokens: 0 },
      last: { inputTokens: last[0], cachedInputTokens: last[1], outputTokens: last[2], reasoningOutputTokens: 0, totalTokens: 0 },
    },
  },
});

/** A successful build turn: a shell command, a file edit, a streamed answer, two model requests. */
export const SUCCESS_TURN: Array<{ method: string; params: unknown }> = [
  { method: 'turn/started', params: { threadId: T, turn: { id: 'tu-1', status: 'inProgress' } } },
  { method: 'item/started', params: { threadId: T, turnId: 'tu-1', item: { type: 'commandExecution', id: 'c1', command: 'npm test', status: 'inProgress' } } },
  usage([1000, 200, 50], [1000, 200, 50]),
  {
    method: 'item/completed',
    params: { threadId: T, turnId: 'tu-1', item: { type: 'commandExecution', id: 'c1', command: 'npm test', status: 'completed', exitCode: 1, aggregatedOutput: '1 failing' } },
  },
  { method: 'item/started', params: { threadId: T, turnId: 'tu-1', item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/w/a.ts', kind: { type: 'update' }, diff: '' }] } } },
  { method: 'item/completed', params: { threadId: T, turnId: 'tu-1', item: { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/w/a.ts', kind: { type: 'update' }, diff: '' }] } } },
  { method: 'item/completed', params: { threadId: T, turnId: 'tu-1', item: { type: 'reasoning', id: 'r1', summary: ['thinking'] } } },
  { method: 'item/agentMessage/delta', params: { threadId: T, turnId: 'tu-1', itemId: 'm1', delta: 'Fixed ' } },
  { method: 'item/agentMessage/delta', params: { threadId: T, turnId: 'tu-1', itemId: 'm1', delta: 'it.' } },
  { method: 'item/completed', params: { threadId: T, turnId: 'tu-1', item: { type: 'agentMessage', id: 'm1', text: 'Fixed it.' } } },
  usage([2500, 1200, 90], [1500, 1000, 40]),
  { method: 'turn/completed', params: { threadId: T, turn: { id: 'tu-1', status: 'completed', error: null } } },
];

