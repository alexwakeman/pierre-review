// THE SERVICE-RUN LOG (docs/SANDBOX.md § Services → The run log). Every `limn-svc run <service> [command …]`
// is executed by the HOST (controller.ts), which sees every output line. The host keeps a bounded record of
// each run, so a plan's `data_run` evidence (docs/SANDBOX.md § The plan and its checks) is checked against
// what LIMN saw, never against output the agent pasted (the agent controls the sandbox).
//
//   id        'svc-<n>', printed to the agent as the run's last line: `limn-svc: run recorded as svc-3`;
//   output    stdout + stderr as the host received it, the TAIL kept (≤ 64 KB);
//   egress    the service is one the reader opened to the internet: its data may not be local, so a
//             plan cannot cite it (plan-verify.ts).
//
// ≤ 100 records per session (the oldest go). Pure apart from the clock it is handed.

export const SERVICE_RUN_LOG_MAX = 100;
export const SERVICE_RUN_OUTPUT_MAX = 64 * 1024;
/** The output a record keeps when the session state is saved (`session_json.serviceRuns`). */
export const SERVICE_RUN_STORED_OUTPUT_MAX = 16 * 1024;

export interface ServiceRunRecord {
  id: string;
  stack: string;
  service: string;
  command: string[];
  startedAt: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  egress: boolean;
}

export const runRecordedLine = (id: string): string => `limn-svc: run recorded as ${id}`;

/** The tail of `text` within `max` bytes (a UTF-8 boundary kept). */
export function tailOf(text: string, max: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= max) return { text, cut: false };
  const buf = Buffer.from(text, 'utf8');
  let from = buf.length - max;
  while (from < buf.length && (buf[from]! & 0xc0) === 0x80) from += 1;
  return { text: buf.subarray(from).toString('utf8'), cut: true };
}

export class ServiceRunLog {
  private readonly records: ServiceRunRecord[] = [];
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** A run starts: its record (filled by `append`, closed by `finish`). */
  begin(o: { stack: string; service: string; command: readonly string[]; egress: boolean }): ServiceRunRecord {
    this.seq += 1;
    const rec: ServiceRunRecord = {
      id: `svc-${this.seq}`,
      stack: o.stack,
      service: o.service,
      command: [...o.command],
      startedAt: new Date(this.now()).toISOString(),
      exitCode: null,
      output: '',
      truncated: false,
      egress: o.egress,
    };
    this.records.push(rec);
    if (this.records.length > SERVICE_RUN_LOG_MAX) this.records.splice(0, this.records.length - SERVICE_RUN_LOG_MAX);
    return rec;
  }

  append(rec: ServiceRunRecord, text: string): void {
    const t = tailOf(rec.output + text, SERVICE_RUN_OUTPUT_MAX);
    rec.output = t.text;
    rec.truncated ||= t.cut;
  }

  finish(rec: ServiceRunRecord, code: number | null): void {
    rec.exitCode = code;
  }

  list(): ServiceRunRecord[] {
    return this.records.map((r) => ({ ...r, command: [...r.command] }));
  }

  get(id: string): ServiceRunRecord | null {
    const r = this.records.find((x) => x.id === id.trim());
    return r ? { ...r, command: [...r.command] } : null;
  }

  /** The ids so far (the checker's `ctx.runs`). */
  ids(): string[] {
    return this.records.map((r) => r.id);
  }

  /** `limn-svc runs`: one line per run, newest last. */
  describe(): string {
    if (this.records.length === 0) return 'No `limn-svc run` yet in this session.';
    return this.records
      .map((r) => `${r.id}  ${r.stack}/${r.service}  exit ${r.exitCode ?? '…'}  ${r.command.length > 0 ? r.command.join(' ') : '(default command)'}${r.egress ? '  (opened to the internet: not evidence)' : ''}`)
      .join('\n');
  }
}

/** The records as saved on the row: the output clipped further. */
export function storedServiceRuns(records: readonly ServiceRunRecord[]): ServiceRunRecord[] {
  return records.map((r) => {
    const t = tailOf(r.output, SERVICE_RUN_STORED_OUTPUT_MAX);
    return { ...r, output: t.text, truncated: r.truncated || t.cut };
  });
}
