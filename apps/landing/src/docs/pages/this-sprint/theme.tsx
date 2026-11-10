import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'The Theme view',
  summary: 'Tickets grouped by what they are about, so you can see where the sprint\'s effort goes.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
