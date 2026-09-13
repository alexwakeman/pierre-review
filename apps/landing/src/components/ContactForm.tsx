import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { MonoLabel } from './feint/primitives';

// ---------------------------------------------------------------------------
// The contact form.
//
// ⚠ IT IS PART OF THE DESIGN SYSTEM, WHICH HAS NO FORM PRIMITIVES because until
// now the site had no form. What is here follows the same rules as everything
// else: square corners, 1px hairlines, no shadow, no fill on a resting input, no
// icons. An input is a line of type on a rule — the same object the tier table's
// rows are.
//
// ---- Three things a marketing form usually gets wrong, and how this one does not
//
// 1. IT SAYS WHETHER IT WORKS BEFORE YOU WRITE. On mount it asks the server for a
//    submission ticket, which doubles as the readiness probe: no Slack webhook
//    configured means a 503 and the form renders an honest "not available" state
//    instead of taking two hundred words it cannot deliver. A form that accepts a
//    message into nothing is worse than no form.
//
// 2. THE HONEYPOT IS REACHABLE, NOT `display:none`. It is positioned off-canvas
//    and marked aria-hidden + tabIndex={-1} + autoComplete="off", so a screen
//    reader skips it and the keyboard never lands on it, while a form-filling bot
//    still finds it in the DOM. A `display:none` input is the version some bots
//    already know to skip.
//
// 3. FAILURE KEEPS WHAT YOU TYPED. Every error path leaves the fields populated
//    and shows what happened. The one thing this form must never do is lose a
//    message somebody spent five minutes writing.
//
// The fourth spam layer — a signed minimum fill time — is invisible here on
// purpose. See apps/backend/src/api/routes/contact.ts for what the ticket is and
// why the age is signed rather than sent by the client.
// ---------------------------------------------------------------------------

const TOPICS: { value: string; label: string }[] = [
  { value: 'pro_trial', label: 'Start a free month of Pro' },
  { value: 'question', label: 'A question about the product' },
  { value: 'problem', label: 'Something is broken' },
  { value: 'other', label: 'Something else' },
];

type Ready = 'checking' | 'ready' | 'unavailable';
type Phase = 'idle' | 'sending' | 'sent';

const FOCUS =
  'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

// An input is a rule with type on it. `bg-transparent` rather than a fill, because
// paper is the ground everywhere else on this site and a grey box here would be the
// only filled rectangle in the whole design.
const FIELD =
  `w-full border-b border-rule-strong bg-transparent py-2.5 font-display text-body-sm text-ink ` +
  `placeholder:text-secondary hover:border-ink focus:border-ink transition-colors duration-hover ` +
  `ease-standard ${FOCUS}`;

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mb-7">
      <label htmlFor={id} className="mb-2 block">
        <MonoLabel>{label}</MonoLabel>
      </label>
      {children}
      {hint && <p className="mt-2 font-mono text-mono-caption text-secondary">{hint}</p>}
    </div>
  );
}

export function ContactForm(): JSX.Element {
  const [ready, setReady] = useState<Ready>('checking');
  const [ticket, setTicket] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  // `?topic=pro` is what every Pro call-to-action on the site links to, so the
  // reader arrives with the right thing already selected and one less decision.
  const [topic, setTopic] = useState('pro_trial');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('topic');
    if (t === 'pro') setTopic('pro_trial');
    else if (t && TOPICS.some((o) => o.value === t)) setTopic(t);
  }, []);

  // Fetch the ticket. Also the readiness probe — see the header note.
  useEffect(() => {
    let live = true;
    fetch('/api/contact/ticket', { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as { ticket?: string };
      })
      .then((data) => {
        if (!live) return;
        if (typeof data.ticket === 'string' && data.ticket !== '') {
          setTicket(data.ticket);
          setReady('ready');
        } else {
          setReady('unavailable');
        }
      })
      .catch(() => {
        if (live) setReady('unavailable');
      });
    return () => {
      live = false;
    };
  }, []);

  const submit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (phase === 'sending') return;
      setPhase('sending');
      setError('');
      try {
        const res = await fetch('/api/contact', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, email, topic, message, ticket, website }),
        });
        if (res.ok) {
          setPhase('sent');
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setError(
          data.message ??
            (res.status === 429
              ? 'That is a few messages in a short time. Try again in a little while.'
              : 'That did not send. Please try again in a minute.'),
        );
        setPhase('idle');
      } catch {
        // A network failure, not a server one — the message is still in the fields.
        setError('That did not send — check your connection and try again.');
        setPhase('idle');
      }
    },
    [email, message, name, phase, ticket, topic, website],
  );

  if (phase === 'sent') {
    return (
      <div className="max-w-answer border-t border-ink pt-8">
        <h2 className="mb-4 font-display text-h3 font-semibold text-ink">
          That’s with us.
        </h2>
        <p className="mb-2 text-body-sm text-ink-body">
          You’ll get a reply at <span className="text-ink">{email}</span>, usually the same
          day.
        </p>
        <p className="font-mono text-mono-caption text-secondary">
          If you asked for a Pro month, the reply carries the details of how it is switched
          on for your account.
        </p>
      </div>
    );
  }

  if (ready === 'unavailable') {
    return (
      <div className="max-w-answer border-t border-ink pt-8">
        <h2 className="mb-4 font-display text-h3 font-semibold text-ink">
          The form isn’t taking messages right now.
        </h2>
        <p className="text-body-sm text-ink-body">
          Rather than accept something it cannot deliver, it says so. Open an issue on{' '}
          <a
            href="https://github.com/alexwakeman/pierre-review/issues"
            target="_blank"
            rel="noreferrer noopener"
            className={`border-b border-signal-fill text-ink hover:text-signal-text ${FOCUS}`}
          >
            GitHub
          </a>{' '}
          and it will reach the same person.
        </p>
      </div>
    );
  }

  const busy = phase === 'sending' || ready === 'checking';

  return (
    <form onSubmit={submit} className="max-w-answer border-t border-ink pt-8" noValidate={false}>
      <Field id="contact-topic" label="What is this about">
        <select
          id="contact-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className={`${FIELD} appearance-none`}
        >
          {TOPICS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      <Field id="contact-name" label="Your name">
        <input
          id="contact-name"
          name="name"
          type="text"
          required
          maxLength={120}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={FIELD}
        />
      </Field>

      <Field
        id="contact-email"
        label="Email"
        hint="Used to reply to you, and for nothing else. It is not added to a list."
      >
        <input
          id="contact-email"
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={FIELD}
        />
      </Field>

      <Field
        id="contact-message"
        label="Message"
        hint="How many repositories, and which review bots you run, is the useful part — it is usually what the reply turns on."
      >
        <textarea
          id="contact-message"
          name="message"
          required
          rows={6}
          maxLength={2500}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className={`${FIELD} resize-y`}
        />
      </Field>

      {/* The honeypot. Off-canvas rather than display:none — see the header note.
          It is a real, reachable input that no person will ever type into. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="contact-website">Website</label>
        <input
          id="contact-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="mb-6 border-l border-signal-fill pl-4 text-body-sm text-signal-text"
        >
          {error}
        </p>
      )}

      {/* ⚠ THE PRERENDERED HTML IS A DISABLED FORM, and that is correct rather than a
          bug to paper over. The site is prerendered (prerender.mjs), so this component's
          markup ships in the static page — but the submission ticket is fetched on mount
          and the submit itself is a fetch, so with JavaScript off the form genuinely
          cannot send. Saying so, with a route that does work, beats a form that silently
          swallows a message. For a visitor with JavaScript the checking state lasts one
          round trip and is never seen. */}
      <noscript>
        <p className="mb-6 border-l border-signal-fill pl-4 text-body-sm text-ink-body">
          This form needs JavaScript to send. With it switched off, open an issue at
          github.com/alexwakeman/pierre-review/issues instead — it reaches the same person.
        </p>
      </noscript>

      <button
        type="submit"
        disabled={busy}
        className={`inline-block bg-ink px-6 py-[15px] font-display text-[16px] font-semibold text-paper hover:bg-[#08080A] disabled:cursor-not-allowed disabled:bg-muted transition-colors duration-hover ease-standard ${FOCUS}`}
      >
        {phase === 'sending' ? 'Sending…' : 'Send'}
      </button>

      <p className="mt-5 max-w-reassure font-mono text-mono-nav text-secondary">
        Your message goes to one person, not a ticketing queue. What the form collects and
        how long it is kept is in the{' '}
        <a href="/privacy" className={`border-b border-signal-fill text-ink hover:text-signal-text ${FOCUS}`}>
          privacy policy
        </a>
        .
      </p>
    </form>
  );
}
