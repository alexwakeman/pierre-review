import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'My turn',
  summary: 'The pull requests where you owe the next action, and nothing else. A card goes when you act or when you dismiss it.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
