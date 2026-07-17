import { useState } from 'react';
import { useClaudeKeyStatus, useSetClaudeKeyGlobal } from '../../hooks/useClaudeReview.js';
import { SectionShell, Field, inputCls } from './ui.js';

// BYO Anthropic API key — used STRICTLY for the advanced-AI agentic workflows (Claude Review
// + AI Fix), never for summaries/digests. Stored locally only (~/.pierre-review/config.json);
// the backend never returns it, so the input always renders empty and is never echoed. The
// section is shown only when advanced AI is enabled (see SettingsModal's gate). Write-only,
// mirroring the pattern the Claude Review tab used before this moved to Settings.
export function AnthropicKeySection(): JSX.Element {
  const { data: status } = useClaudeKeyStatus();
  const setKey = useSetClaudeKeyGlobal();
  const [value, setValue] = useState('');
  const hasUserKey = status?.hasUserKey ?? false;

  const save = (v: string): void => {
    setKey.mutate(v, { onSuccess: () => setValue('') });
  };

  return (
    <SectionShell
      title="Anthropic API key"
      desc="Used only for the advanced AI workflows — Claude Review and AI Fix — so they bill to your own Anthropic account. Not used for summaries or digests. Stored on this machine only; never sent anywhere but Anthropic."
    >
      {hasUserKey && (
        <div className="text-xs text-green-700 dark:text-green-400">
          ✓ Using your stored Anthropic key
        </div>
      )}
      <Field
        label="API key"
        htmlFor="anthropic-key"
        hint="Leave blank to use the ambient Claude session / environment key instead."
      >
        <input
          id="anthropic-key"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={hasUserKey ? 'Replace stored key…' : 'sk-ant-…'}
          autoComplete="off"
          spellCheck={false}
          className={`${inputCls} font-mono`}
        />
      </Field>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => save(value)}
          disabled={setKey.isPending || value.trim() === ''}
          className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {setKey.isPending ? 'Saving…' : 'Save'}
        </button>
        {hasUserKey && (
          <button
            type="button"
            onClick={() => save('')}
            disabled={setKey.isPending}
            className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-500 hover:border-gray-400 disabled:opacity-40 dark:border-gray-700 dark:hover:border-gray-500"
          >
            Clear
          </button>
        )}
      </div>
      {setKey.isError && (
        <div className="text-xs text-red-500">
          {(setKey.error as Error)?.message ?? 'Failed to save the key.'}
        </div>
      )}
    </SectionShell>
  );
}
