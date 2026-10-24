import type { CSSProperties } from 'react';
import github from '../../assets/board/logos/github.svg';
import claude from '../../assets/board/logos/claude.svg';
import jira from '../../assets/board/logos/jira.svg';
import linear from '../../assets/board/logos/linear.svg';
import sonar from '../../assets/board/logos/sonarqubecloud.svg';
import coderabbit from '../../assets/board/logos/coderabbit.svg';
import copilot from '../../assets/board/logos/githubcopilot.svg';
import cursor from '../../assets/board/logos/cursor.svg';

function maskStyle(src: string): CSSProperties {
  // Quoted: Vite inlines small SVGs as data URIs containing single quotes, which an
  // unquoted url() cannot hold (the whole declaration would be dropped).
  return { ['--src' as string]: `url("${src.replace(/"/g, '%22')}")` } as CSSProperties;
}

function LogoTile({ src, name, note }: { src: string; name: string; note: string }) {
  return (
    <div className="tile l rise">
      <span className="mk" style={maskStyle(src)} />
      <span className="nm">
        {name}
        <span>{note}</span>
      </span>
    </div>
  );
}

function WordmarkTile({ word, note }: { word: string; note: string }) {
  return (
    <div className="tile l rise">
      <svg className="wm" viewBox="0 0 120 52" aria-hidden="true">
        <text
          x="0"
          y="38"
          fontFamily="Albert Sans"
          fontWeight="600"
          fontSize="30"
          letterSpacing="-1"
          fill="#f1f1ef"
        >
          {word}
        </text>
      </svg>
      <span className="nm">
        <span>{note}</span>
      </span>
    </div>
  );
}

export function Gather() {
  return (
    <section id="gather" className="section" aria-labelledby="g-h">
      <div className="chap rise">
        <h2 id="g-h">
          <span className="tag" style={{ background: 'var(--lapis)' }} />
          Gather
        </h2>
        <p>Limn reads each tool where it already lives and keeps a copy on your disk.</p>
      </div>
      <div className="board lg">
        <div className="tile l lapis wide rise">
          <p style={{ fontSize: 20, lineHeight: 1.3, maxWidth: '26ch' }}>
            Keep the review bots you already pay for. Limn reads all 17 and ranks them beside Claude.
          </p>
        </div>
        <LogoTile src={github} name="GitHub" note="Code, CI, issues" />
        <LogoTile src={claude} name="Claude" note="Your own login" />
        <LogoTile src={jira} name="Jira" note="Stories" />
        <LogoTile src={linear} name="Linear" note="Stories" />
        <LogoTile src={sonar} name="SonarCloud" note="Quality gate" />
        <WordmarkTile word="Slack" note="Team digest" />
        <WordmarkTile word="Codex" note="Coming soon" />
        <LogoTile src={coderabbit} name="CodeRabbit" note="Review bot" />
        <LogoTile src={copilot} name="GitHub Copilot" note="Review bot" />
        <LogoTile src={cursor} name="Cursor" note="And 14 more bots" />
      </div>
    </section>
  );
}
