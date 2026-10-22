// The severity head: one int8 ModernBERT ONNX session + its tokenizer, texts in, raw logits out.
// A port of the severity service's `_OnnxHead` (packages/ml `models/taxonomy.py`); decode lives
// in decode.ts. The two runtime packages are HANDED IN (ml/runtime.ts loads them), so nothing
// here imports onnxruntime-node or the tokenizer by name.
//
// Artifact layout (one directory per head): `model_quantized.onnx` + `config.json` (id2label,
// pad_token_id) + `tokenizer.json`, with `calibration.json` beside them and `input_format.json` in
// the parent — exactly the service's `serving_assets/modernbert-onnx/severity/`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tokenBudgetChunks, type SeverityHeadSpec } from './decode.js';
import type { OrtModule, TokenizersModule } from './runtime.js';

export const HEAD_FILES = ['model_quantized.onnx', 'config.json', 'tokenizer.json'] as const;

export interface HeadOptions {
  maxLength?: number;
  batchSize?: number;
  /** Padded tokens (rows × widest row) per mini-batch. ⚠ Moves the logits: keep the service's. */
  tokenBudget?: number;
  intraOpThreads?: number;
  /** Escalate MAJOR to CRITICAL at this P(CRITICAL). Off, as in the service. */
  criticalEscalationThreshold?: number | null;
}

export interface SeverityHead {
  readonly spec: SeverityHeadSpec;
  readonly maxLength: number;
  readonly batchSize: number;
  readonly tokenBudget: number;
  /** Token ids per text, truncated to `maxLength` keeping the final special token. */
  encode(texts: readonly string[]): number[][];
  /** Raw logits per text, in INPUT order (the length-sorted batching is undone). */
  logits(texts: readonly string[]): Promise<number[][]>;
  release(): Promise<void>;
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));

export function headAvailable(headDir: string): boolean {
  return HEAD_FILES.every((f) => existsSync(join(headDir, f)));
}

/** The artifact's own description of the head: label map, calibration, text format. */
export function readHeadSpec(headDir: string, threshold: number | null = null): SeverityHeadSpec & { padId: number } {
  const cfg = readJson(join(headDir, 'config.json'));
  const id2label: Record<number, string> = {};
  for (const [k, v] of Object.entries((cfg.id2label ?? {}) as Record<string, unknown>)) id2label[Number(k)] = String(v);
  const critical = Object.entries(id2label).find(([, n]) => n.trim().toUpperCase() === 'CRITICAL');

  let classWeights: Record<string, number> | null = null;
  const calPath = join(headDir, 'calibration.json');
  if (existsSync(calPath)) {
    try {
      const raw = readJson(calPath).severity_class_weights;
      if (raw && typeof raw === 'object') {
        classWeights = Object.fromEntries(
          Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k.toUpperCase(), Number(v)]),
        );
      }
    } catch {
      classWeights = null; // the service ignores an unreadable calibration file the same way
    }
  }

  let pathInText = false;
  const fmtPath = join(dirname(headDir), 'input_format.json');
  if (existsSync(fmtPath)) {
    try {
      pathInText = readJson(fmtPath).path_in_text === true;
    } catch {
      pathInText = false;
    }
  }

  return {
    id2label,
    criticalIndex: critical ? Number(critical[0]) : null,
    criticalEscalationThreshold: threshold,
    classWeights,
    pathInText,
    padId: Number(cfg.pad_token_id ?? 0) || 0,
  };
}

export async function loadSeverityHead(
  headDir: string,
  ort: OrtModule,
  tokenizers: TokenizersModule,
  opts: HeadOptions = {},
): Promise<SeverityHead> {
  const maxLength = opts.maxLength ?? 512;
  const batchSize = opts.batchSize ?? 32;
  const tokenBudget = opts.tokenBudget ?? 4096;
  const { padId, ...spec } = readHeadSpec(headDir, opts.criticalEscalationThreshold ?? null);

  const tokenizer = new tokenizers.Tokenizer(readJson(join(headDir, 'tokenizer.json')), {});
  const session = await ort.InferenceSession.create(join(headDir, 'model_quantized.onnx'), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: opts.intraOpThreads ?? 4,
    // ⚠ NO ARENA. With one, ORT keeps the largest working set it ever needed for the life of the
    // process (the service went 0.65 → 4.71 GB after one backlog). The service shrinks its arena
    // after each run; the Node binding cannot set that run option, so it has no arena at all.
    enableCpuMemArena: false,
  });
  const inputNames = new Set(session.inputNames);

  function encode(texts: readonly string[]): number[][] {
    return texts.map((t) => {
      const ids = tokenizer.encode(t).ids.map(Number);
      // The artifact's own truncation (right, 512) keeps the template's closing [SEP].
      return ids.length > maxLength ? [...ids.slice(0, maxLength - 1), ids[ids.length - 1]!] : ids;
    });
  }

  async function logits(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const encs = encode(texts);
    const rows: (number[] | undefined)[] = new Array(texts.length);
    for (const idx of tokenBudgetChunks(encs.map((e) => e.length), batchSize, tokenBudget)) {
      const width = Math.max(1, ...idx.map((i) => encs[i]!.length));
      const ids = new BigInt64Array(idx.length * width);
      const mask = new BigInt64Array(idx.length * width);
      idx.forEach((i, r) => {
        const e = encs[i]!;
        for (let c = 0; c < width; c++) {
          ids[r * width + c] = BigInt(c < e.length ? e[c]! : padId);
          mask[r * width + c] = c < e.length ? 1n : 0n;
        }
      });
      const dims = [idx.length, width];
      const feeds: Record<string, InstanceType<OrtModule['Tensor']>> = {};
      if (inputNames.has('input_ids')) feeds.input_ids = new ort.Tensor('int64', ids, dims);
      if (inputNames.has('attention_mask')) feeds.attention_mask = new ort.Tensor('int64', mask, dims);
      if (inputNames.has('token_type_ids')) {
        feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(idx.length * width), dims);
      }
      const out = await session.run(feeds);
      const t = out[session.outputNames[0]!]!;
      const data = t.data as Float32Array;
      const classes = Number(t.dims[1]);
      idx.forEach((i, r) => {
        rows[i] = Array.from(data.subarray(r * classes, (r + 1) * classes));
      });
    }
    // Never fewer rows than came in: the caller zips results onto comments BY POSITION.
    const filled = rows.filter((r): r is number[] => r !== undefined);
    if (filled.length !== texts.length) {
      throw new Error(`severity head returned ${filled.length} rows for ${texts.length} inputs`);
    }
    return filled;
  }

  return {
    spec,
    maxLength,
    batchSize,
    tokenBudget,
    encode,
    logits,
    release: () => session.release(),
  };
}
