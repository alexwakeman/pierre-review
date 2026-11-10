import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Bot activity tab',
  summary: 'What the review bots said on this pull request, with Limn\'s severity for each comment.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
