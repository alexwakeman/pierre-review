import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { useReveal } from '../components/board/useReveal';
import { Hero } from '../components/board/Hero';
import { GatherCheckAct } from '../components/board/GatherCheckAct';
import { Gather } from '../components/board/Gather';
import { Check } from '../components/board/Check';
import { SavesTime } from '../components/board/SavesTime';
import { Act } from '../components/board/Act';
import { Velocity } from '../components/board/Velocity';
import { Cost } from '../components/board/Cost';
import { Licence } from '../components/board/Licence';
import { Faq } from '../components/board/Faq';
import { Close } from '../components/board/Close';

// ---------------------------------------------------------------------------
// The home page: the board design (spec: .taste-skill/mockup/index.html).
//
// Every style lives under the `.lb` root (src/board.css), so the other pages keep
// their own look. The root breaks out of App's 1280px canvas to full bleed.
//
// useReveal puts `js-rise` on the root from an effect and reveals each `.rise`
// element as it scrolls in. Without JS, or with reduced motion, nothing is hidden,
// so the prerendered HTML shows every word.
//
// Running order: hero · Gather. Check. Act. · Gather · Check · time saved · Act · velocity ·
// cost · licence · questions · run it.
// ---------------------------------------------------------------------------

export default function Home(): JSX.Element {
  useSeo(seoFor('/'));
  const ref = useReveal<HTMLDivElement>();
  return (
    <div className="lb" ref={ref}>
      <Hero />
      <GatherCheckAct />
      <Gather />
      <Check />
      <SavesTime />
      <Act />
      <Velocity />
      <Cost />
      <Licence />
      <Faq />
      <Close />
    </div>
  );
}
