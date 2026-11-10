import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Follow-up reviews',
  summary: 'After new commits, a follow-up review checks which findings were fixed and looks at what changed.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
