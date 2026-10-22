// The scoring PROCESS. Tokenising, the marker regexes and ONNX inference all run here — not in a
// worker thread — because CPU priority is per PROCESS on macOS: local-scorer.ts starts this one at
// background priority, so any foreground work wins the CPU. A process that exits also returns all
// of its memory to the OS, which a terminated thread does not. One request at a time.
import type { ScoreItem, ScoreResult } from './decode.js';
import { loadLocalModel, type LocalModel } from './model.js';
import { loadOrt, loadTokenizers } from './runtime.js';
import { throttleDelayMs } from './throttle.js';

export interface ScorerInit {
  modelsDir: string;
  intraOpThreads: number;
  /** Average share of one core to stay under (throttle.ts). */
  cpuShare: number;
}
export type ScorerRequest = { id: number; items: ScoreItem[] };
export type ScorerReply =
  | { id: number; ok: true; results: ScoreResult[]; modelVersion: string }
  | { id: number; ok: false; error: string; loadFailed: boolean };

const init = JSON.parse(process.env.LIMN_ML_SCORER_INIT ?? '{}') as ScorerInit;
const send = (r: ScorerReply): void => {
  process.send?.(r);
};

let model: Promise<LocalModel> | null = null;
function getModel(): Promise<LocalModel> {
  model ??= (async () =>
    loadLocalModel(init.modelsDir, await loadOrt(), await loadTokenizers(), { intraOpThreads: init.intraOpThreads }))();
  return model;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Requests run strictly one after another (the parent may send two batches at once).
let queue: Promise<void> = Promise.resolve();
process.on('message', (req: ScorerRequest) => {
  queue = queue.then(() => handle(req));
});
// The parent went away: nothing will read our answers.
process.on('disconnect', () => process.exit(0));

async function handle(req: ScorerRequest): Promise<void> {
  let loaded: LocalModel;
  try {
    loaded = await getModel();
  } catch (err) {
    model = null; // the next request tries again (the reader may have just set it up)
    send({ id: req.id, ok: false, error: (err as Error).message, loadFailed: true });
    return;
  }
  try {
    let resumed = performance.now();
    const results = await loaded.score(req.items, async () => {
      // The duty cycle: rest in proportion to the work just done.
      await sleep(throttleDelayMs(performance.now() - resumed, init.cpuShare));
      resumed = performance.now();
    });
    send({ id: req.id, ok: true, results, modelVersion: loaded.modelVersion });
  } catch (err) {
    send({ id: req.id, ok: false, error: (err as Error).message, loadFailed: false });
  }
}
