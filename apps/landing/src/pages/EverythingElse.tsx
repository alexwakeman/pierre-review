import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { useReveal } from '../components/board/useReveal';
import { WorksWith } from '../components/board/WorksWith';
import { Proof } from '../components/board/Proof';
import { Fix, Review, See, Ship } from '../components/board/Chapters';
import { WhyEnsemble } from '../components/board/WhyEnsemble';
import { Tiers } from '../components/board/Tiers';
import { Faq } from '../components/board/Faq';
import { Close } from '../components/board/Close';
import { ReportingSection } from './Reporting';
import { HowWeMeasureSection } from './HowWeMeasure';
import './home.css';

// ---------------------------------------------------------------------------
// Everything else: what the home page no longer carries. The four product chapters
// (Review, Fix, Ship, See), the tools it reads, the proof figures, Reporting and
// metrics (#reporting) and How we measure (#how-we-measure), then Why Ensemble,
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
        <section className="section chapter ee-head" aria-labelledby="ee-h">
          <div className="chap">
            <h1 id="ee-h">Everything else</h1>
            <p>
              Review, fix, ship and see across every repository: the rest of what it does, how it reports and how we
              measure.
            </p>
          </div>
        </section>
        <Review />
        <Fix />
        <Ship />
        <See />
        <WorksWith />
        <Proof />
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
