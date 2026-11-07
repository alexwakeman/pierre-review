import type { SandboxRuntimeStatus } from '@pierre-review/shared';
import { ClickPopover } from '../InfoModal.js';
import { cx } from '../ui/cx.js';

// "HOW TO SET UP" (docs/SANDBOX.md § Setting up a runtime): a workspace session runs in a container on
// this computer, so the reader needs a container runtime. The free routes come first; Docker Desktop's
// licence limit is stated. Behind a text trigger (the build tab's one line, Settings → Sandbox).

const CODE = 'rounded-ui bg-ui-raise px-1 font-mono text-meta text-ui-ink';

export function SandboxSetupSteps(): JSX.Element {
  return (
    <div className="space-y-3 text-body text-ui-ink">
      <p>Implement and AI Fix run the AI in a sandbox on this computer. The sandbox needs a container runtime. These are free:</p>
      <dl className="space-y-2">
        <div>
          <dt className="font-semibold">Mac (Apple Silicon or Intel)</dt>
          <dd>
            Colima: <code className={CODE}>brew install colima docker</code>, then{' '}
            <code className={CODE}>colima start --cpu 4 --memory 8 --disk 60</code>.
          </dd>
        </div>
        <div>
          <dt className="font-semibold">Linux</dt>
          <dd>
            Docker Engine or Podman, from your distribution’s packages. Add yourself to the <code className={CODE}>docker</code> group,
            or run Podman without root.
          </dd>
        </div>
        <div>
          <dt className="font-semibold">Windows</dt>
          <dd>Run Limn inside WSL2, and install Docker Engine in that Linux.</dd>
        </div>
      </dl>
      <p>
        Docker Desktop works too. It is free only for organisations under 250 employees and under US$10M a year in revenue.
      </p>
      <p>
        Limn finds the runtime by itself. To use Podman, start Limn with <code className={CODE}>SANDBOX_CLI=podman</code>. Give the
        runtime at least 8 GB of memory.
      </p>
      <p>
        Sandboxes use disk space. <code className={CODE}>limn sandbox prune</code> removes what is left over (stop Limn first).
      </p>
    </div>
  );
}

/** "How to set up" as a text link that opens the steps. */
export function SandboxSetupLink({ className }: { className?: string }): JSX.Element {
  return (
    <ClickPopover
      title="Set up a container runtime"
      width="lg"
      triggerLabel="How to set up a container runtime"
      triggerClassName={(open) => cx('hit text-meta font-medium underline underline-offset-2', open ? 'text-ui-ink' : 'text-ui-ink hover:text-ui-accent', className)}
      trigger={<span>How to set up</span>}
    >
      <SandboxSetupSteps />
    </ClickPopover>
  );
}

/** ONE line about the runtime: what runs (and its licence line), or what is wrong + How to set up. */
export function SandboxRuntimeLine({ status, loading, testId = 'sandbox-runtime-line' }: { status: SandboxRuntimeStatus | undefined; loading: boolean; testId?: string }): JSX.Element | null {
  if (loading) return <p className="text-meta text-ui-mute">Checking for a container runtime…</p>;
  if (status == null) return null;
  if (status.available) {
    return (
      <p data-testid={testId} data-available="true" className="text-meta text-ui-mute">
        Runs in {status.label ?? 'a container'} on this computer.
        {status.licenceNote != null && <> {status.licenceNote}</>}
      </p>
    );
  }
  return (
    <p data-testid={testId} data-available="false" className="flex flex-wrap items-baseline gap-x-2 text-meta text-ui-warn">
      <span>{status.problem ?? 'No container runtime is running on this computer.'}</span>
      <SandboxSetupLink />
    </p>
  );
}
