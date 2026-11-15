import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { useReveal } from '../components/board/useReveal';
import { Hero } from '../components/board/Hero';
import { BotsSection, EnsembleSection, HowItWorks } from '../components/board/HomeSections';
import { Close } from '../components/board/Close';
import './home.css';

// ---------------------------------------------------------------------------
// The home page, in the board design (src/board.css): the claim, then the three things
// the product is — ensemble review (each teammate's own agent, GitHub as the source of
// truth), build (ticket to pull request) and dependency automation — each ending on a
// link to its own page. Everything else lives on /everything-else.
//
// useReveal puts `js-rise` on the root from an effect and reveals each `.rise`
// element as it scrolls in. Without JS, or with reduced motion, nothing is hidden,
// so the prerendered HTML shows every word.
// ---------------------------------------------------------------------------

export default function Home(): JSX.Element {
  useSeo(seoFor('/'));
  const ref = useReveal<HTMLDivElement>();
  return (
    <div className="lb home" ref={ref}>
      <Hero />
      <EnsembleSection />
      <HowItWorks />
      <BotsSection />
      <Close />
    </div>
  );
}
