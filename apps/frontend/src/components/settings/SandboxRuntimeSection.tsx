import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  SANDBOX_RUNNING_KEY,
  SANDBOX_RUNTIME_KEY,
  useSandboxRunning,
  useSandboxRuntime,
  useStopAllSandboxes,
} from "../../hooks/useStoryBuild.js";
import { InfoButton } from "../InfoModal.js";
import { Button } from "../ui/index.js";
import {
  SandboxRuntimeLine,
  SandboxSetupLink,
} from "../StoryBuild/SandboxSetupHelp.js";
import { SectionShell } from "./ui.js";

// SETTINGS → SANDBOX, the GLOBAL part (the computer's, not a workspace's): the container runtime's ONE
// line (`GET /api/sandbox/runtime`), "How to set up", and Check again; then how many of this Limn's
// sandboxes run now (`GET /api/sandbox/running`, read when the section opens and on Check again — never
// polled) with "Stop all" (`POST /api/sandbox/stop-all`).

const SECONDARY_BTN =
  "inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:cursor-not-allowed disabled:opacity-40";

export function SandboxRuntimeSection(): JSX.Element {
  const runtime = useSandboxRuntime();
  const qc = useQueryClient();
  return (
    <SectionShell
      title="Container runtime"
      desc="Implement and AI Fix run the AI in a container on this computer."
      info={
        <InfoButton title="Container runtime" width="lg">
          <div className="space-y-2">
            <p>
              Each Implement session is a sandbox: a container with the
              workspace’s repositories, your notes and the ticket.
            </p>
            <p>
              The AI has a full shell there, but no GitHub sign-in and no route
              to the internet except the hosts you allow.
            </p>
          </div>
        </InfoButton>
      }
    >
      <div
        data-testid="sandbox-runtime-section"
        className="flex flex-wrap items-center gap-3"
      >
        <SandboxRuntimeLine
          status={runtime.data}
          loading={runtime.isLoading}
          testId="sandbox-runtime-status"
        />
        {runtime.isError && (
          <p className="text-meta text-ui-danger">
            Could not check the container runtime.
          </p>
        )}
        {!runtime.isLoading && (
          <button
            type="button"
            className={SECONDARY_BTN}
            disabled={runtime.isFetching}
            onClick={() => {
              void qc.invalidateQueries({ queryKey: SANDBOX_RUNTIME_KEY });
              void qc.invalidateQueries({ queryKey: SANDBOX_RUNNING_KEY });
            }}
          >
            {runtime.isFetching ? "Checking…" : "Check again"}
          </button>
        )}
        {runtime.data?.available === true && <SandboxSetupLink />}
      </div>
      <SandboxRunningLine />
    </SectionShell>
  );
}

/** "2 Limn sandboxes are running." in the reader's words. Pure. */
export function runningLine(n: number): string {
  if (n === 0) return "No Limn sandboxes are running.";
  return n === 1
    ? "1 Limn sandbox is running."
    : `${n} Limn sandboxes are running.`;
}

/** The count and "Stop all". Hidden while the runtime does not answer (the line above says why). */
function SandboxRunningLine(): JSX.Element | null {
  const running = useSandboxRunning();
  const stop = useStopAllSandboxes();
  const [confirming, setConfirming] = useState(false);
  const n = running.data?.running ?? null;
  if (n == null) return null;
  return (
    <div className="mt-3 space-y-2" data-testid="sandbox-running">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-body text-ui-ink" data-testid="sandbox-running-line">
          {runningLine(n)}
        </p>
        {n > 0 && !confirming && (
          <Button
            size="sm"
            disabled={stop.isPending}
            onClick={() => setConfirming(true)}
          >
            Stop all
          </Button>
        )}
      </div>
      {confirming && n > 0 && (
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Confirm stop all"
        >
          <p className="text-meta text-ui-ink">
            Stop {n === 1 ? "it" : `all ${n}`}? Stored changes are kept. A
            running turn stops.
          </p>
          <Button
            size="sm"
            variant="danger"
            busy={stop.isPending}
            disabled={stop.isPending}
            onClick={() =>
              stop.mutate(undefined, { onSettled: () => setConfirming(false) })
            }
          >
            Stop all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={stop.isPending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      )}
      {stop.data?.problem != null && (
        <p className="text-meta text-ui-danger">{stop.data.problem}</p>
      )}
      {stop.isError && (
        <p className="text-meta text-ui-danger">{stop.error.message}</p>
      )}
    </div>
  );
}
