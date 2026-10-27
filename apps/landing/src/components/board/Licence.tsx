import { Link } from '../../router';

/** "Free to use": the two-column licence table (stacks on phones via board.css). */
export function Licence(): JSX.Element {
  return (
    <section id="licence" className="section lic" aria-labelledby="lic-h">
      <h2 id="lic-h">Free to use</h2>
      <table className="plans">
        <thead>
          <tr>
            <th></th>
            <th className="rec">
              Up to 3 people<small>Free</small>
            </th>
            <th>
              4 or more<small>Commercial licence</small>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Every feature</th>
            <td className="rec">Included</td>
            <td>Included</td>
          </tr>
          <tr>
            <th scope="row">Model usage</th>
            <td className="rec">Your own AI agent</td>
            <td>Your own AI agent</td>
          </tr>
          <tr>
            <th scope="row">Runs on</th>
            <td className="rec">Your machine</td>
            <td>Your machine</td>
          </tr>
          <tr>
            <th scope="row"></th>
            <td className="rec">
              <a className="btn" href="#run">
                Run it now
              </a>
            </td>
            <td>
              <Link className="btn" to="/contact">
                Get in touch
              </Link>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
