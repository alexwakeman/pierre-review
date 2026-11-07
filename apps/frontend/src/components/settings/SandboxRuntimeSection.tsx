import { useQueryClient } from "@tanstack/react-query";
import {
  SANDBOX_RUNTIME_KEY,
  useSandboxRuntime,
} from "../../hooks/useStoryBuild.js";
import { InfoButton } from "../InfoModal.js";
import {
  SandboxRuntimeLine,
  SandboxSetupLink,
} from "../StoryBuild/SandboxSetupHelp.js";
import { SectionShell } from "./ui.js";

// SETTINGS → SANDBOX, the GLOBAL part (the computer's, not a workspace's): the container runtime's ONE
// line (`GET /api/sandbox/runtime`), "How to set up", and Check again.

const SECONDARY_BTN =
  "inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:cursor-not-allowed disabled:opacity-40";

export function SandboxRuntimeSection(): JSX.Element {
  const runtime = useSandboxRuntime();
  const qc = useQueryClient();
  return (
    <SectionShell
      title="Container runtime"
      desc="Implement runs the AI in a container on this computer."
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
            }}
          >
            {runtime.isFetching ? "Checking…" : "Check again"}
          </button>
        )}
        {runtime.data?.available === true && <SandboxSetupLink />}
      </div>
    </SectionShell>
  );
}
