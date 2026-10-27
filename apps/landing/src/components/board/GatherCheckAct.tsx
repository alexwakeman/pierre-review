export function GatherCheckAct() {
  return (
    <section className="section gca" aria-labelledby="gca-h">
      <h2 id="gca-h">Gather. Check. Act.</h2>
      <div className="board">
        <div className="tile lapis rise">
          <b>Gather</b>
          <p>The pull request, its story and your docs, in one place.</p>
        </div>
        <div className="tile verdigris rise">
          <b>Check</b>
          <p>Your own AI agent reviews the change against all three, on your machine.</p>
        </div>
        <div className="tile madder rise">
          <b>Act</b>
          <p>Reviews, fixes and posts run on their own. You merge.</p>
        </div>
      </div>
      <p className="lead rise">
        Limn is an advanced harness for code review: your tools, your AI agent and one clear screen, working
        as one. It does the checking, so your team ships faster, for no extra cost.
      </p>
    </section>
  );
}
