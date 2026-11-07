// A WORKSPACE SESSION'S SERVICES (docs/SANDBOX.md § Services): the compose files the reader picked,
// which Limn runs on the HOST for the session, policed, on the session's internal network. The agent
// asks for them with `limn-svc`; it never holds Docker.
//
// Stored per WORKSPACE in Settings → Workspace → Sandbox (`SandboxWorkspaceSettings.services`).

/** One compose file the reader picked. Limn never runs a file the reader did not pick. */
export interface SandboxServiceStackChoice {
  /** The workspace repository, `owner/name`. */
  repo: string;
  /** The compose file's path inside the repository (`compose.yml`, `docker/compose.test.yml`). */
  file: string;
  /** Services in that file allowed to reach the internet through the session's proxy (default none). */
  egress: string[];
}

export const SANDBOX_SERVICE_STACKS_MAX = 8;
export const SANDBOX_SERVICE_FILE_MAX = 300;

export type SandboxServiceStackState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' | 'refused';

/** A localhost port inside the sandbox that reaches a service (its published port, dropped). */
export interface SandboxServiceForward {
  port: number;
  service: string;
  target: number;
}

export interface SandboxServiceStackStatus {
  /** The name `limn-svc` uses for the file (the repository's name). */
  key: string;
  /** `bng-metric-backend/compose.yml`. */
  from: string;
  state: SandboxServiceStackState;
  /** Why the file was refused, or why the last command failed: one plain line each. */
  reasons: string[];
  /** What was dropped or changed when it was started. */
  notes: string[];
  services: string[];
  forwards: SandboxServiceForward[];
  /** Images built from the agent's code this session, by service. */
  builtImages: { service: string; tag: string }[];
}

/** The Services panel: every picked file, newest state. Sent over the session stream. */
export interface SandboxServicesStatus {
  stacks: SandboxServiceStackStatus[];
}
