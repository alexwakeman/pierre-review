import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Read the timeline',
  summary: 'The timeline draws each pull request as a bar over time, with its commits, reviews and comments on it.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
