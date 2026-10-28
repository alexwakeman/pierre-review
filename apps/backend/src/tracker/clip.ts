// One cut for every tracker text a server-side reader stores or hands a model (story fields, comment
// bodies): trim, drop the characters the validator refuses (C0 controls, lone surrogates), then cut to
// `cap` without splitting a surrogate pair. A leaf module, so the store and the worker can share it.

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Trim, drop unstorable characters, then cut to `cap` without splitting a surrogate pair. */
export function clipTicketField(value: string, cap: number): string {
  let s = value.replace(CONTROL_CHARS, '').replace(LONE_SURROGATES, '').trim();
  if (s.length > cap) {
    s = s.slice(0, cap);
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
    s = s.trimEnd();
  }
  return s;
}
