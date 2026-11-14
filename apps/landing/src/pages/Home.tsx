import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { useReveal } from '../components/board/useReveal';
import { Hero } from '../components/board/Hero';
import { WorksWith } from '../components/board/WorksWith';
import { Proof } from '../components/board/Proof';
import { Fix, Review, See, Ship } from '../components/board/Chapters';
import { WhyEnsemble } from '../components/board/WhyEnsemble';
import { Tiers } from '../components/board/Tiers';
import { Faq } from '../components/board/Faq';
import { Close } from '../components/board/Close';
import './home.css';

// ---------------------------------------------------------------------------
// The home page. Copy and structure: the approved mockup (limn-landing-mockup.html),
// word for word, in the board design (src/board.css).
//
// Every product picture is an HTML mock (components/mock/, data in src/mock/acme.ts),
// not a screenshot: real text, crawlable, restacked on phones.
//
// useReveal puts `js-rise` on the root from an effect and reveals each `.rise`
// element as it scrolls in. Without JS, or with reduced motion, nothing is hidden,
// so the prerendered HTML shows every word.
//
// Running order: hero · works with · proof figures · Review · Fix · Ship · See ·
// Why Ensemble · every feature, free · questions · run it.
// ---------------------------------------------------------------------------

export default function Home(): JSX.Element {
  useSeo(seoFor('/'));
  const ref = useReveal<HTMLDivElement>();
  return (
    <div className="lb home" ref={ref}>
      <Hero />
      <WorksWith />
      <Proof />
      <Review />
      <Fix />
      <Ship />
      <See />
      <WhyEnsemble />
      <Tiers />
      <Faq />
      <Close />
    </div>
  );
}
