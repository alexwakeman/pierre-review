import { useState } from 'react';

const COMMAND = 'npx pierre-review';

function CommandBox() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — no-op */
    }
  };
  return (
    <div className="mx-auto flex max-w-xl items-center justify-between gap-4 rounded-xl border border-white/10 bg-gray-900/70 px-5 py-4 text-left font-mono text-sm shadow-2xl shadow-black/40 ring-1 ring-white/5">
      <code className="truncate text-gray-100">
        <span className="select-none text-brand-green">$ </span>
        {COMMAND}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy install command"
        className="shrink-0 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky"
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}

export default function LocalInstall() {
  return (
    <section aria-labelledby="local-heading" className="relative px-6 py-24">
      {/* soft glow */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute bottom-0 left-1/2 h-64 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-brand-green/10 blur-[130px]" />
      </div>

      <div className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold uppercase tracking-wider text-brand-sky">
          Run it locally
        </p>
        <h2
          id="local-heading"
          className="mt-3 text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl"
        >
          Prefer to keep it on your machine?
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-gray-400">
          One command — no accounts, no hosted backend, no stored credentials. It
          authenticates with your <code className="font-mono text-gray-300">gh</code>{' '}
          CLI, syncs to a local SQLite file, and opens straight to the timeline.
        </p>

        <div className="mt-8">
          <CommandBox />
        </div>

        <p className="mt-4 text-sm text-gray-500">
          Requires Node&nbsp;≥&nbsp;20 and an authenticated GitHub CLI (
          <code className="font-mono text-gray-400">gh auth login</code>). Installed
          globally? Use the short <code className="font-mono text-gray-400">pierre</code>{' '}
          command.
        </p>
      </div>
    </section>
  );
}
