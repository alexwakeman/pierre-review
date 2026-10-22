// The local severity scorer, in-process: the ONNX head + the marker parse + the decode, behind
// the same items-in / results-out contract the HTTP service had. worker.ts runs it off the main
// thread; tests run it directly.
import { open, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Blake2b } from './blake2b.js';
import { buildResult, decodeSeverity, modelText, sanitize, softmax, type ScoreItem, type ScoreResult } from './decode.js';
import { loadSeverityHead, type HeadOptions, type SeverityHead } from './onnx-head.js';
import { SEVERITY_HEAD_SUBDIR, type OrtModule, type TokenizersModule } from './runtime.js';

export interface LocalModel {
  readonly modelVersion: string;
  readonly head: SeverityHead;
  /** Scores each item ALONE; `between` runs after each one (the CPU throttle). */
  score(items: readonly ScoreItem[], between?: () => Promise<void>): Promise<ScoreResult[]>;
  release(): Promise<void>;
}

export async function loadLocalModel(
  modelsDir: string,
  ort: OrtModule,
  tokenizers: TokenizersModule,
  opts: HeadOptions = {},
): Promise<LocalModel> {
  const headDir = join(modelsDir, SEVERITY_HEAD_SUBDIR);
  const head = await loadSeverityHead(headDir, ort, tokenizers, opts);
  const modelVersion = await modelVersionFor(modelsDir, head.spec.classWeights !== null);

  // ⚠ ONE COMMENT PER RUN, never a padded batch. The int8 export's activation scales see the
  // padding, so a batched comment's label depends on which OTHER comments shared its batch —
  // measured on 397 real comments: 29 changed severity, probabilities moved by up to 0.84. Alone
  // it is also FASTER (0.90 vs 0.71 comments/s on one core: no work on padding) and lighter (0.8
  // vs 1.5 GB peak). The head can still batch; the parity tests use that to replay the service.
  async function score(items: readonly ScoreItem[], between?: () => Promise<void>): Promise<ScoreResult[]> {
    const out: ScoreResult[] = [];
    for (const raw of items) {
      const it = sanitize(raw);
      const [logits] = await head.logits([modelText(it, head.spec.pathInText)]);
      const { severity, prob } = decodeSeverity(head.spec, softmax(logits!));
      out.push(buildResult(it, severity, prob));
      if (between) await between();
    }
    return out;
  }

  return { modelVersion, head, score, release: () => head.release() };
}

// ---- identity: the service's `model_version`, byte for byte ----------------------------------
//
// `taxonomy-composite-v1.sev-<digest>[-cal].cat-marker`, where <digest> is the first 8 hex of a
// BLAKE2b-128 over the artifact files actually loaded. Stored on every label row, so the same
// artifact must carry the same name whichever process scored it.

const WEIGHT_FILES = ['model_quantized.onnx', 'model.onnx', 'model.safetensors', 'pytorch_model.bin'];
const META_FILES = ['config.json', 'calibration.json', 'input_format.json'];
/** Bytes sampled from each end of a large weights file (the service's `_DIGEST_SAMPLE_BYTES`). */
const SAMPLE = 1 << 20;

async function digestFile(h: Blake2b, key: string, path: string): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return false;
  }
  const fh = await open(path, 'r');
  try {
    h.update(Buffer.from(`${key}:${size}:`, 'utf8'));
    const read = async (offset: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    };
    if (size <= 2 * SAMPLE) h.update(await read(0, size));
    else {
      h.update(await read(0, SAMPLE));
      h.update(await read(size - SAMPLE, SAMPLE));
    }
  } finally {
    await fh.close();
  }
  return true;
}

/** The service's `artifact_digest(*dirs)`: each file keyed by its directory's NAME. */
export async function artifactDigest(dirs: readonly string[]): Promise<string | null> {
  const h = new Blake2b(16);
  let found = false;
  for (const dir of dirs) {
    for (const name of [...WEIGHT_FILES, ...META_FILES]) {
      if (await digestFile(h, `${basename(dir)}/${name}`, join(dir, name))) found = true;
    }
  }
  return found ? h.hexdigest().slice(0, 8) : null;
}

export async function modelVersionFor(modelsDir: string, calibrated: boolean): Promise<string> {
  const root = join(modelsDir, 'modernbert-onnx');
  const digest = await artifactDigest([root, join(root, 'severity')]);
  const sev = digest === null ? 'na' : calibrated ? `${digest}-cal` : digest;
  return `taxonomy-composite-v1.sev-${sev}.cat-marker`;
}
