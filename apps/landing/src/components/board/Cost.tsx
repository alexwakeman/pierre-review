import initialN from '../../assets/board/img/initial-n.jpg';
import { Link } from '../../router';
import { Worksheet } from './Worksheet';

// "No extra seat": the madder band beside the illuminated initial N, then the
// savings worksheet (Worksheet.tsx) full width under them.

export function Cost() {
  return (
    <section className="section board cost" aria-labelledby="cost-h">
      <div className="tile c1 madder rise">
        <h2 id="cost-h">No extra seat</h2>
        <div className="c1-txt">
          <p style={{ fontSize: 'var(--step-lead)', maxWidth: '32ch' }}>
            No per-review fee, no new bot to pay for. Limn runs on the AI agent you already have: Claude Code or Codex,
            both ready out of the box.
          </p>
          <p className="c1-budget">
            Want a ceiling? Give Limn a share of your weekly AI usage, 50% unless you change it, and automatic
            reviews stop when it's used.{' '}
            <Link to="/getting-started#budget-h">Set a budget</Link>
          </p>
        </div>
      </div>
      <div className="tile ph c2 rise">
        <img src={initialN} width={1200} height={1668} alt="Illuminated initial N with acanthus leaves" loading="lazy" />
      </div>
      <Worksheet />
    </section>
  );
}
