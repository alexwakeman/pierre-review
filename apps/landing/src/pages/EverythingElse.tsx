import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { useReveal } from '../components/board/useReveal';
import { OpenPrsMock } from '../components/mock/openPrs';
import { WhyEnsemble } from '../components/board/WhyEnsemble';
import { Tiers } from '../components/board/Tiers';
import { Faq } from '../components/board/Faq';
import { Close } from '../components/board/Close';
import { ReportingSection } from './Reporting';
import { HowWeMeasureSection } from './HowWeMeasure';
import './home.css';

// ---------------------------------------------------------------------------
// Everything else: what the home page no longer carries. A workspace's Open pull
// requests, grouped by ticket (#open-prs, a clickable mock with the drawer), Reporting
// and metrics (#reporting) and How we measure (#how-we-measure), then Why Ensemble,
// every feature free and the questions.
//
// Each part keeps its own page-scoped root (`.lb.home`, `.lb.rep`, `.lb.hwm`), so its
// CSS applies unchanged; each root reveals its own `.rise` tiles. /reporting and
// /how-we-measure 301 here to their anchors (apps/site MOVED).
// ---------------------------------------------------------------------------

export default function EverythingElse(): JSX.Element {
  useSeo(seoFor('/everything-else'));
  const top = useReveal<HTMLDivElement>();
  const tail = useReveal<HTMLDivElement>();
  return (
    <>
      <div className="lb home" ref={top}>
        {/* The page's first section carries its one h1 (the old "Everything else" header is gone). */}
        <section id="open-prs" className="section chapter ee-head" aria-labelledby="op-h">
          <div className="chap">
            <h1 id="op-h">Open pull requests</h1>
            <p>
              Every open pull request in the workspace, grouped by its ticket. Each row says whether it can land. Open
              one to see why.
            </p>
          </div>
          <div className="op-mock rise">
            <OpenPrsMock />
          </div>
        </section>
      </div>
      <ReportingSection />
      <HowWeMeasureSection />
      <div className="lb home" ref={tail}>
        <WhyEnsemble />
        <Tiers />
        <Faq />
        <Close />
      </div>
    </>
  );
}
