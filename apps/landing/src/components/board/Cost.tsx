import initialN from '../../assets/board/img/initial-n.jpg';

// "No extra seat": the madder band beside the illuminated initial N.

export function Cost() {
  return (
    <section className="section board cost" aria-labelledby="cost-h">
      <div className="tile c1 madder rise">
        <h2 id="cost-h">No extra seat</h2>
        <p style={{ fontSize: 'var(--step-lead)', maxWidth: '32ch' }}>
          No per-review fee, no new bot to pay for. Limn runs on the Claude Code login you already have.
        </p>
      </div>
      <div className="tile ph c2 rise">
        <img src={initialN} width={1200} height={1668} alt="Illuminated initial N with acanthus leaves" loading="lazy" />
      </div>
    </section>
  );
}
