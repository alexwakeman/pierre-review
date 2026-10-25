import { useId, useState } from 'react';

// The savings worksheet: review-bot seats you pay for, the price per seat, the
// seats you'd drop → what dropping them saves in a year. Worked out in the
// browser; nothing is sent. The fields start EMPTY on purpose: any number we put
// there would read as our claim about your bill.
//
// Without JS (the prerendered HTML) the result reads as the formula itself, so
// the tile still says how to work it out.

const FORMULA = 'Seats you drop × price per seat × 12';

/** A non-negative number from a field, or null while it is blank or not a number. */
function num(raw: string): number | null {
  const t = raw.trim().replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const usd = (n: number): string =>
  `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0, minimumFractionDigits: 0 })}`;

type FieldProps = { id: string; label: string; value: string; onChange: (v: string) => void; step?: string };

function Field({ id, label, value, onChange, step }: FieldProps): JSX.Element {
  return (
    <div className="ws-f">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode={step ? 'decimal' : 'numeric'}
        min={0}
        step={step ?? '1'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function Worksheet(): JSX.Element {
  const id = useId();
  const [seats, setSeats] = useState('');
  const [price, setPrice] = useState('');
  const [drop, setDrop] = useState('');

  const s = num(seats);
  const p = num(price);
  const d = num(drop);

  let result: string = FORMULA;
  let note: string | null = null;
  if (s !== null && p !== null && d !== null) {
    if (d > s) {
      note = 'You can drop at most the seats you pay for.';
    } else {
      result = `${usd(d * p * 12)} a year`;
      note = `Out of ${usd(s * p * 12)} a year you pay now.`;
    }
  }

  return (
    <div className="tile ws rise">
      <h3 id={`${id}h`}>What dropping a review-bot seat saves</h3>
      <form className="ws-in" aria-labelledby={`${id}h`} onSubmit={(e) => e.preventDefault()}>
        <Field id={`${id}s`} label="Review-bot seats you pay for" value={seats} onChange={setSeats} />
        <Field id={`${id}p`} label="Price per seat a month (US$)" value={price} onChange={setPrice} step="0.01" />
        <Field id={`${id}d`} label="Seats you'd drop" value={drop} onChange={setDrop} />
      </form>
      <div className="ws-out">
        <output htmlFor={`${id}s ${id}p ${id}d`} aria-live="polite">
          {result}
        </output>
        {note ? <p>{note}</p> : null}
        <p className="muted">Worked out in your browser. Nothing is sent.</p>
      </div>
    </div>
  );
}
