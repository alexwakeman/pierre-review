import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { useReveal } from '../components/board/useReveal';
import { Hero } from '../components/board/Hero';
import { BotsSection, EnsembleSection, HowItWorks } from '../components/board/HomeSections';
import { Close } from '../components/board/Close';
import { Scene, type SceneTiming } from '../components/arcs/Scene';
import { Chain } from '../components/arcs/pieces';
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

// THE TWO SCENES (components/arcs/Scene.tsx): a picture pinned full width while the
// page scrolls over it. Timing in vh of scroll once the scene reaches the top.
//   CHAIN    behind the hero's text (one screen tall): the text scrolls away while the
//            chain comes together (0 → 130) and brightens (0 → 70); "Review as an
//            ensemble" enters at 100 + runway − 100 = 110, about 85% through, and the
//            chain dims behind it (110 → 170).
//   8 OUT    after "Dependency updates, handled": the hero's 8 in REVERSE (Scene
//            `reverse`). It scrolls in whole, then comes apart (0 → 120) as it
//            brightens (0 → 60); the close enters at runway − 100 = 85 and it dims
//            (85 → 145).
const CHAIN_SCENE: SceneTiming = { gather: 130, fadeIn: 70, runway: 110, outStart: 110, outEnd: 170 };
const EIGHT_OUT_SCENE: SceneTiming = { gather: 120, fadeIn: 60, runway: 185, outStart: 85, outEnd: 145 };

export default function Home(): JSX.Element {
  useSeo(seoFor('/'));
  const ref = useReveal<HTMLDivElement>();
  return (
    <div className="lb home" ref={ref}>
      <Scene
        className="scene-chain"
        timing={CHAIN_SCENE}
        art={<Chain label="Banded quarter-circles, each in its own run of colour, coming together as a tall figure of 8" />}
        before={<Hero />}
        after={<EnsembleSection />}
      />
      <HowItWorks />
      <BotsSection />
      <Scene
        className="scene-eight-out"
        reverse
        timing={EIGHT_OUT_SCENE}
        art={<Chain label="The same figure of 8 of banded quarter-circles, coming apart" />}
        after={<Close />}
      />
    </div>
  );
}
