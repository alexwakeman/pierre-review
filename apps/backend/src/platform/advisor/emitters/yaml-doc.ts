// Shared eemeli `yaml` Document round-trip helpers. The Document API is the load-bearing
// choice: comments, ordering, anchors and odd indentation SURVIVE a parse→edit→stringify
// cycle, which is the hard requirement for editing a user's hand-written config (the
// merge-never-regenerate rule). Every helper is additive: get-or-create a collection node,
// append a scalar if absent — nothing rewrites what the user wrote.
//
// Input is REPO-AUTHORED: size-capped by the caller (MAX_CONFIG_BYTES), parsed with the CORE
// schema only (no custom tag execution — `yaml` core tags are data-only), and a document
// with parse errors is a refusal, never a best-effort edit.
import { Document, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { YAMLMap, YAMLSeq } from 'yaml';

export function parseYamlConfig(
  text: string,
): { ok: true; doc: Document } | { ok: false; reason: string } {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0) {
    return { ok: false, reason: `YAML parse error: ${doc.errors[0]!.message}` };
  }
  return { ok: true, doc };
}

export function emptyYamlDoc(): Document {
  return new Document({});
}

// Get-or-create the map at a dotted path (['reviews'] → the reviews map), creating plain
// block maps along the way. Refuses (returns null) when an intermediate node exists but is
// not a map — that is the user's structure and not ours to rewrite.
export function ensureMapAt(doc: Document, path: string[]): YAMLMap | null {
  if (!doc.contents) doc.contents = doc.createNode({});
  let node: unknown = doc.contents;
  for (const key of path) {
    if (!isMap(node)) return null;
    let next: unknown = node.get(key, true);
    if (next == null) {
      const created = doc.createNode({});
      node.set(doc.createNode(key), created);
      next = created;
    }
    node = next;
  }
  return isMap(node) ? node : null;
}

// Get-or-create the sequence at `key` under the map at `path`. Same refusal rule.
export function ensureSeqAt(doc: Document, path: string[], key: string): YAMLSeq | null {
  const map = ensureMapAt(doc, path);
  if (!map) return null;
  let seq: unknown = map.get(key, true);
  if (seq == null) {
    const created = doc.createNode([]);
    map.set(doc.createNode(key), created);
    seq = created;
  }
  return isSeq(seq) ? (seq as YAMLSeq) : null;
}

// Append a string scalar unless an equal scalar is already present. Returns whether the
// value is in the sequence afterwards BECAUSE OF US (false = it was already there — a noop,
// which the plan reports rather than double-appending on a re-run).
export function appendUniqueString(doc: Document, seq: YAMLSeq, value: string): boolean {
  for (const item of seq.items) {
    if (isScalar(item) && item.value === value) return false;
  }
  // An EMPTY flow seq (`[]` — ours from a bootstrap template, or a user's placeholder)
  // switches to block style before the first entry: multi-entry flow renders as an unreadable
  // one-liner, and there are no existing entries whose formatting could be disturbed.
  if (seq.items.length === 0) seq.flow = false;
  seq.add(doc.createNode(value));
  return true;
}

// Read a scalar at map path (null when absent or not a scalar).
export function scalarAt(doc: Document, path: string[], key: string): string | null {
  let node: unknown = doc.contents;
  for (const k of path) {
    if (!isMap(node)) return null;
    node = node.get(k, true);
  }
  if (!isMap(node)) return null;
  const v = node.get(key, true);
  return isScalar(v) && (typeof v.value === 'string' || typeof v.value === 'number')
    ? String(v.value)
    : null;
}

export function setScalar(doc: Document, path: string[], key: string, value: string): boolean {
  const map = ensureMapAt(doc, path);
  if (!map) return false;
  map.set(doc.createNode(key), doc.createNode(value));
  return true;
}

export function docToString(doc: Document): string {
  return doc.toString();
}
