import type { DocMeta } from '../../types';
import { Btn, DocLink, H2, H3, Illustration, MiniTable, Note, SettingsRow, Steps, TextBox, Tip, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Docker and microsandbox',
  summary: 'The container runtimes AI Fix and Implement run in, and what each one needs.',
};

function RuntimePicture(): JSX.Element {
  return (
    <Illustration
      label="Settings, Sandbox, Container runtime: Runs in Colima on this computer, with a Check again button, and the resources per session: 4 CPUs, 8 GB memory, 30 GB disk."
      caption="Settings → Sandbox: the runtime Limn found, and the resources each session may use."
      title="Container runtime"
      meta="Settings → Sandbox"
    >
      <p>
        Runs in Colima on this computer. <Btn>Check again</Btn>
      </p>
      <SettingsRow label="CPUs" control={<TextBox value="4" />} />
      <SettingsRow label="Memory (GB)" control={<TextBox value="8" />} />
      <SettingsRow label="Disk (GB)" control={<TextBox value="30" />} />
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        AI Fix and Implement story run their agent in a sandbox: a disposable container on your own computer. To make
        one, Limn needs a container runtime, such as Docker Engine, Colima or Podman. Every route on this page is free.
        Limn finds the runtime by itself; you install it once.
      </p>

      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>A container runtime that is running, from the table below.</li>
        <li>At least 8 GB of memory, 4 CPUs and 60 GB of disk given to the runtime.</li>
        <li>Network access to pull the sandbox image (about 1.3 GB) the first time.</li>
      </ul>
      <p>
        Nothing else in Limn needs a runtime. Without one, reviews, the CI review and the merge resolver work as normal;
        AI Fix and Implement show one line with <Ui>How to set up</Ui>.
      </p>

      <H2 id="set-it-up">Set it up</H2>
      <MiniTable
        cols={[
          { key: 'c', label: 'Computer' },
          { key: 'r', label: 'Recommended (free)' },
          { key: 's', label: 'Steps' },
        ]}
        rows={[
          {
            _key: 'mac',
            c: 'Mac (Apple Silicon or Intel)',
            r: 'Colima',
            s: (
              <>
                <code>brew install colima docker</code>, then <code>colima start --cpu 4 --memory 8 --disk 60</code>
              </>
            ),
          },
          {
            _key: 'linux',
            c: 'Linux',
            r: 'Docker Engine or Podman',
            s: 'Install from your distribution’s packages. Add yourself to the docker group, or run Podman without root.',
          },
          {
            _key: 'win',
            c: 'Windows',
            r: 'WSL2 with Docker Engine',
            s: 'Run Limn inside WSL2, and install Docker Engine in that Linux.',
          },
        ]}
      />
      <Steps>
        <li>Install and start the runtime for your computer.</li>
        <li>
          Open <Ui>Settings → Sandbox</Ui> and press <Ui>Check again</Ui>. Limn shows the runtime it found, for example{' '}
          <Ui>Runs in Colima on this computer.</Ui>
        </li>
        <li>Start an AI Fix or an Implement session. The first one downloads the sandbox image, which takes minutes; later ones start in seconds.</li>
      </Steps>
      <RuntimePicture />
      <Note>
        Docker Desktop works too. It is free only for organisations under 250 employees and under US$10M a year in
        revenue. OrbStack and Rancher Desktop also work; check their licences for commercial use.
      </Note>

      <H2 id="docker">Docker, Colima and Podman</H2>
      <p>
        These all run the sandbox as a Docker-style container. Limn finds the <code>docker</code> command and checks that
        it answers. On a Mac and on Windows the container also runs inside a virtual machine, which is a second wall
        around it. On Linux a container shares your computer's kernel.
      </p>
      <p>
        To use Podman, start Limn with <code>SANDBOX_CLI=podman</code>. Podman is less tested than Docker.
      </p>

      <H2 id="microsandbox">microsandbox</H2>
      <p>
        microsandbox runs each sandbox as a small virtual machine with its own kernel, on an Apple Silicon Mac or on Linux
        with KVM. It is a beta product, and Limn's support for it is new and less tested than Docker's.
      </p>
      <Warning>
        If microsandbox is installed and <code>msb doctor</code> passes, Limn uses it in place of Docker. Services for
        integration tests do not run on microsandbox yet. To keep Docker, start Limn with{' '}
        <code>SANDBOX_RUNTIME=docker</code>. To force microsandbox, use <code>SANDBOX_RUNTIME=microsandbox</code>.
      </Warning>
      <p>
        An Intel Mac cannot run microsandbox. On Linux it needs access to <code>/dev/kvm</code>. The choice is made when
        Limn starts and stays fixed until it restarts.
      </p>

      <H2 id="what-a-sandbox-can-do">What a sandbox can and cannot do</H2>
      <ul>
        <li>It holds copies of the workspace's repositories, and only the files Limn put in. It has no writable view of your own files.</li>
        <li>It has no GitHub credentials and no access to the Docker socket. The AI credential stays on your computer; Limn adds it to the AI provider's requests on the way out.</li>
        <li>
          Its only way to the network is Limn's allow-list: the AI provider, package registries and GitHub downloads by
          default. Every request is logged in the session's <Ui>Network</Ui> panel.
        </li>
        <li>Work leaves only as a set of changes that Limn checks and you push.</li>
      </ul>
      <H3>Allowing a host</H3>
      <p>
        When a tool in the sandbox needs a host that is not allowed, the <Ui>Network</Ui> panel lists it as blocked. Press{' '}
        <Ui>Allow for this session</Ui>, or <Ui>Always allow</Ui> to add it to the workspace's{' '}
        <Ui>Hosts always allowed</Ui> in <Ui>Settings → Sandbox</Ui>. See{' '}
        <DocLink to="settings/sandbox">Settings → Sandbox</DocLink> and{' '}
        <DocLink to="security/ai-and-the-sandbox">AI and the sandbox</DocLink>.
      </p>

      <H2 id="resources-and-clean-up">Resources and clean-up</H2>
      <ul>
        <li>
          Each session may use 4 CPUs, 8 GB of memory and 30 GB of disk by default. Change these per workspace in{' '}
          <Ui>Settings → Sandbox</Ui>, under <Ui>Resources</Ui>.
        </li>
        <li>At most two sessions are open on this computer at a time, and one of them builds.</li>
        <li>A session with nothing to do closes after 15 minutes; its changes are kept.</li>
        <li>
          When a session ends, for any reason, Limn removes its containers, network and volumes. Every few minutes, and
          when it starts, it also removes any of its own that no open session uses.
        </li>
        <li>
          <Ui>Settings → Sandbox</Ui> says how many Limn sandboxes are running, and <Ui>Stop all</Ui> stops them.
        </li>
      </ul>
      <Tip>
        Sandboxes use disk space. With Limn stopped, <code>limn sandbox prune</code> removes everything left over (add{' '}
        <code>--dry-run</code> to see what it would remove first). Limn keeps a copy of your repositories between sessions
        to start faster; <code>limn sandbox prune --store</code> removes that too.
      </Tip>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <MiniTable
        cols={[
          { key: 'w', label: 'What you see' },
          { key: 'd', label: 'What to do' },
        ]}
        rows={[
          { _key: '1', w: 'No container runtime is running on this computer.', d: 'Start the runtime (colima start, Docker Desktop, or sudo systemctl start docker), then press Check again in Settings → Sandbox.' },
          { _key: '2', w: 'permission denied … docker.sock (Linux)', d: 'Add yourself to the docker group and sign in again, or use Podman without root.' },
          { _key: '3', w: 'The first session waits a long time for the sandbox image', d: 'The image is about 1.3 GB. If the download fails, Limn builds it on your computer, which takes longer.' },
          { _key: '4', w: 'No space left on device', d: 'Stop Limn, run limn sandbox prune, and give the runtime more disk (colima start --disk 100).' },
          { _key: '5', w: 'A tool cannot reach a host', d: 'Allow the host in the Network panel.' },
          { _key: '6', w: 'Behind a company proxy or VPN', d: 'Set the runtime’s own proxy so it can pull images. Inside the sandbox, requests still go through Limn’s allow-list.' },
          { _key: '7', w: 'microsandbox is installed but not used', d: 'msb doctor must pass. An Intel Mac cannot run it; Linux needs /dev/kvm.' },
          { _key: '8', w: 'Sandboxes still running after you closed the tab', d: 'A session with nothing to do closes after 15 minutes. To stop them now, select Stop all in Settings → Sandbox.' },
        ]}
      />
      <p>
        For more, see <DocLink to="troubleshooting/troubleshooting">Troubleshooting</DocLink>.
      </p>
    </>
  );
}
