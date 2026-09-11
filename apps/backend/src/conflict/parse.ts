/**
 * The `git merge-tree --write-tree -z` output parser.
 *
 * THE SHAPE. Three NUL-delimited sections:
 *
 *   1. the written tree oid, one record;
 *   2. zero or more stage records `<mode> SP <oid> SP <stage> TAB <path>`, terminated by ONE
 *      EMPTY record — absent entirely on a clean merge, where the whole output is 41 bytes
 *      (the oid plus its NUL) and section 2 never begins;
 *   3. zero or more informational records, each `<n> NUL <path₁…ₙ> NUL <type> NUL <message>`.
 *
 * ⚠ SECTION 3 IS FIELD-DRIVEN OFF `<n>`, NEVER LINE-DRIVEN. Messages contain newlines, and
 * `<n>` is the only thing that says how many of the following records are paths.
 *
 * ⚠ A NON-ZERO EXIT WITH EMPTY STDOUT IS AN ERROR; a non-zero exit with a leading tree oid is
 * conflicts. `merge-tree` exits 1 both when it finds conflicts and when it is handed a
 * revision it cannot resolve, and 128 on unrelated histories. Branching on the code alone
 * turns "not something we can merge" into a model with no files in it.
 */

export interface MergeTreeStage {
  mode: string;
  oid: string;
  /** 1 = merge base (VIRTUAL on a criss-cross history), 2 = ours, 3 = theirs. */
  stage: 1 | 2 | 3;
  path: string;
}

export interface MergeTreeMessage {
  paths: string[];
  /** e.g. `CONFLICT (contents)`, `CONFLICT (binary)`, `Auto-merging`. */
  type: string;
  message: string;
}

export interface MergeTreeOutput {
  treeOid: string;
  stages: MergeTreeStage[];
  messages: MergeTreeMessage[];
}

export class MergeTreeParseError extends Error {
  constructor(message: string) {
    super(`merge-tree output: ${message}`);
    this.name = 'MergeTreeParseError';
  }
}

const OID_RE = /^[0-9a-f]{40,64}$/;

/**
 * Parse the raw bytes. Throws `MergeTreeParseError` on anything it cannot account for —
 * a truncated or garbled buffer must never become a half model, because a half model reads
 * on screen as "these are all your conflicts".
 */
export function parseMergeTree(stdout: Buffer): MergeTreeOutput {
  if (stdout.length === 0) throw new MergeTreeParseError('empty');

  // Decoding here is safe in a way it is NOT anywhere else in this pipeline: this buffer
  // holds oids, modes and git's own English messages, plus paths. No file CONTENT ever
  // passes through it — blobs come from `cat-file` and go through the strict UTF-8 gate.
  //
  // The output always ends with a NUL, so the split leaves one trailing empty element that
  // is a delimiter artefact rather than a record.
  const raw = stdout.toString('utf8').split('\0');
  if (raw[raw.length - 1] === '') raw.pop();

  const treeOid = raw[0];
  if (treeOid === undefined || !OID_RE.test(treeOid)) {
    throw new MergeTreeParseError(`expected a tree oid, got ${JSON.stringify(treeOid ?? null)}`);
  }

  const stages: MergeTreeStage[] = [];
  let i = 1;
  // Section 2 exists only when the merge conflicted. On a clean merge the buffer ends here.
  let sawStageTerminator = raw.length === 1;
  for (; i < raw.length; i++) {
    const rec = raw[i] as string;
    if (rec === '') {
      sawStageTerminator = true;
      i++;
      break;
    }
    stages.push(parseStage(rec));
  }
  if (!sawStageTerminator) {
    throw new MergeTreeParseError('stage section is not terminated');
  }

  const messages: MergeTreeMessage[] = [];
  while (i < raw.length) {
    const countRec = raw[i] as string;
    // Some git versions emit a trailing empty record after the last message.
    if (countRec === '') {
      i++;
      continue;
    }
    const count = Number(countRec);
    if (!Number.isInteger(count) || count < 1 || count > 64) {
      throw new MergeTreeParseError(`bad path count ${JSON.stringify(countRec)}`);
    }
    // paths at i+1 … i+count, then the type, then the message.
    if (i + count + 2 > raw.length - 1) {
      throw new MergeTreeParseError('truncated message record');
    }
    const paths: string[] = [];
    for (let k = 0; k < count; k++) {
      const p = raw[i + 1 + k];
      if (p === undefined) throw new MergeTreeParseError('truncated message paths');
      paths.push(p);
    }
    const type = raw[i + 1 + count];
    const message = raw[i + 2 + count];
    if (type === undefined || message === undefined) {
      throw new MergeTreeParseError('truncated message record');
    }
    messages.push({ paths, type, message });
    i += count + 3;
  }

  return { treeOid, stages, messages };
}

function parseStage(rec: string): MergeTreeStage {
  const tab = rec.indexOf('\t');
  if (tab < 0) throw new MergeTreeParseError(`stage record has no TAB: ${rec.slice(0, 80)}`);
  const head = rec.slice(0, tab);
  const path = rec.slice(tab + 1);
  const bits = head.split(' ');
  const mode = bits[0];
  const oid = bits[1];
  const stageText = bits[2];
  if (bits.length !== 3 || mode === undefined || oid === undefined || stageText === undefined) {
    throw new MergeTreeParseError(`stage record is not "<mode> <oid> <stage>": ${head}`);
  }
  if (!/^[0-7]{6}$/.test(mode)) throw new MergeTreeParseError(`bad mode ${mode}`);
  if (!OID_RE.test(oid)) throw new MergeTreeParseError(`bad oid ${oid}`);
  if (stageText !== '1' && stageText !== '2' && stageText !== '3') {
    throw new MergeTreeParseError(`bad stage ${stageText}`);
  }
  if (path.length === 0) throw new MergeTreeParseError('empty stage path');
  return { mode, oid, stage: Number(stageText) as 1 | 2 | 3, path };
}

/**
 * Undo merge-tree's collision mangling: when a directory is in the way of a file, git records
 * the file at `<path>~<committish>` and says so in a `CONFLICT (file/directory)` message.
 *
 * ⚠ ONLY the two committishes we passed are stripped. A real filename containing `~` —
 * `we~ird.txt` is a legal path and appeared in the fixture — must survive untouched, so this
 * matches the suffix against the shas rather than against `~.*`.
 */
export function stripMangledSuffix(path: string, committishes: readonly string[]): string {
  const tilde = path.lastIndexOf('~');
  if (tilde <= 0) return path;
  const suffix = path.slice(tilde + 1);
  for (const c of committishes) {
    // git abbreviates in some messages, so an unambiguous prefix counts — but only of a real
    // sha we handed it, never of arbitrary text.
    if (suffix.length >= 7 && (c === suffix || c.startsWith(suffix))) return path.slice(0, tilde);
  }
  return path;
}
