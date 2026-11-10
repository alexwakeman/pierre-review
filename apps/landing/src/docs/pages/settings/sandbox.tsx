import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, SettingsRow, TextBox, Toggle, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Sandbox',
  summary: 'Where AI Fix and Implement run: the container runtime, the local folder, notes and services.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        AI Fix and Implement story are the only Limn features where the AI can run commands. They run it inside a
        sandbox: a container on your computer that holds the workspace&rsquo;s repositories, your notes and the task.
        The AI has a full shell there, but no GitHub sign-in and no route to the internet except the hosts you allow.
        The <Ui>Sandbox</Ui> tab checks the container runtime on this computer and sets what each session gets.
      </p>

      <H2 id="container-runtime">Container runtime</H2>
      <p>
        This part applies to the whole computer. It shows one line: <Ui>Runs in</Ui> and the runtime&rsquo;s name, or{' '}
        <Ui>No container runtime is running on this computer.</Ui> Select <Ui>Check again</Ui> after you start one, and{' '}
        <Ui>How to set up</Ui> for the steps.
      </p>
      <Illustration label="The container runtime line reporting Colima is running." caption="The runtime line when a runtime is found.">
        <SettingsRow label="Container runtime" hint="Runs in Colima on this computer." control={<Pill tone="green">Check again</Pill>} />
      </Illustration>
      <p>
        Free runtimes: Colima on a Mac, Docker Engine or Podman on Linux, and Docker Engine inside WSL2 on Windows.
        Docker Desktop also works, under its own licence terms. Give the runtime at least 8 GB of memory. Step-by-step
        setup is in <DocLink to="integrations/sandbox-runtimes">Docker and microsandbox</DocLink>.
      </p>

      <H2 id="workspace-sandbox">What a session gets</H2>
      <p>The rest of the tab applies to the current workspace.</p>
      <H3>Your local folder</H3>
      <p>
        The folder that holds your own clones of the repositories. Leave it empty to put each repository under{' '}
        <code>/workspace</code>. The code always comes from Limn&rsquo;s own copy of each repository, synced from
        GitHub: your folder only decides where each repository sits inside the sandbox, so your Claude notes and the
        paths they name still work. Repositories are matched by their git remote. A clone of a repository outside this
        workspace is named and left out.
      </p>
      <H3>Claude notes to bring</H3>
      <p>
        Tick the projects whose Claude notes the session may read. You can also tick{' '}
        <Ui>Bring your ~/.claude/CLAUDE.md</Ui> and <Ui>Bring your Claude skills</Ui>. They are copied in; the
        originals are never changed. Past AI sessions are never copied in.
      </p>
      <H3>Starting folder</H3>
      <p>
        The folder the AI starts in. Empty means the project with the most notes, else your folder.
      </p>
      <H3>Hosts always allowed</H3>
      <p>
        The sandbox reaches the internet only through Limn&rsquo;s network filter. Add a host here to allow it for
        every session in this workspace. During a session, a blocked request shows in the session&rsquo;s <Ui>Network</Ui> list with{' '}
        <Ui>Allow for this session</Ui> and <Ui>Always allow</Ui>. <Ui>Always allow</Ui> adds the host here.
      </p>
      <p>
        <Ui>Set HTTP_PROXY for every program</Ui>: off by default. When off, only npm, pnpm, yarn, pip and git use the
        network filter, so the code under test still reaches local services.
      </p>
      <Illustration label="Two always-allowed hosts and the HTTP proxy switch off." caption="Allowed hosts for one workspace.">
        <SettingsRow label="Hosts always allowed" control={<TextBox value="registry.acme.dev" mono />} />
        <SettingsRow label="Set HTTP_PROXY for every program" control={<Toggle on={false} />} />
      </Illustration>
      <H3>Services</H3>
      <p>
        Compose files Limn may start for a session, for integration tests (a database, a queue). Add the repository and
        the compose file. The AI asks Limn to start them; it never gets Docker itself. A file that asks for privileged
        mode, extra system rights, host folders or the Docker socket is refused, and the session says why. Services
        reach the internet only when you name them under <Ui>Online</Ui>.
      </p>
      <H3>Resources</H3>
      <p>
        <Ui>CPUs</Ui>, <Ui>Memory (GB)</Ui> and <Ui>Disk (GB)</Ui> for each session. The defaults are 4 CPUs, 8 GB of
        memory and 30 GB of disk.
      </p>
      <Warning>
        Anything you allow can be reached by code the AI runs, and the AI reads text written by other people (tickets,
        pull requests, comments). Allow only the hosts a build really needs.
      </Warning>
      <Note>
        Sandboxes use disk space. Stop Limn, then run <code>limn sandbox prune</code> to remove what is left over. See{' '}
        <DocLink to="security/ai-and-the-sandbox">AI agents and the sandbox</DocLink>.
      </Note>
    </>
  );
}
