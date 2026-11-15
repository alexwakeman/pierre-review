import type { CSSProperties } from 'react';
import github from '../../assets/board/logos/github.svg';
import claude from '../../assets/board/logos/claude.svg';
import openai from '../../assets/board/logos/openai.svg';
import confluence from '../../assets/board/logos/confluence.svg';
import notion from '../../assets/board/logos/notion.svg';
import jira from '../../assets/board/logos/jira.svg';
import linear from '../../assets/board/logos/linear.svg';
import sonar from '../../assets/board/logos/sonarqubecloud.svg';
import coderabbit from '../../assets/board/logos/coderabbit.svg';
import copilot from '../../assets/board/logos/githubcopilot.svg';
import cursor from '../../assets/board/logos/cursor.svg';

// "Works with what you have": the tools Ensemble reads, each with what it reads there.

function maskStyle(src: string): CSSProperties {
  // Quoted: Vite inlines small SVGs as data URIs containing single quotes, which an
  // unquoted url() cannot hold (the whole declaration would be dropped).
  return { ['--src' as string]: `url("${src.replace(/"/g, '%22')}")` } as CSSProperties;
}

const TOOLS: { name: string; note: string; logos: string[] }[] = [
  { name: 'GitHub', note: 'Code, CI, issues', logos: [github] },
  { name: 'Claude', note: 'Your login', logos: [claude] },
  { name: 'Codex', note: 'Your ChatGPT plan', logos: [openai] },
  { name: 'Jira · Linear', note: 'Stories', logos: [jira, linear] },
  { name: 'Confluence · Notion', note: 'Docs', logos: [confluence, notion] },
  { name: 'SonarCloud', note: 'Quality gate', logos: [sonar] },
  { name: 'Slack', note: 'Team digest', logos: [] },
  { name: 'CodeRabbit · Copilot · Cursor', note: '+14 review bots', logos: [coderabbit, copilot, cursor] },
];

export function WorksWith(): JSX.Element {
  return (
    <section className="board strip" aria-labelledby="ww-h">
      <div className="tile lapis ww-say rise">
        <h2 id="ww-h">Works with what you have</h2>
        <p>Nothing to migrate. Ensemble reads each tool where it lives.</p>
      </div>
      <ul className="tile ww-tools rise">
        {TOOLS.map((t) => (
          <li key={t.name}>
            <span className="ww-mk" aria-hidden="true">
              {t.logos.map((src) => (
                <span key={src} className="logo-mk" style={maskStyle(src)} />
              ))}
            </span>
            <span className="ww-nm">
              {t.name}
              <small>{t.note}</small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
