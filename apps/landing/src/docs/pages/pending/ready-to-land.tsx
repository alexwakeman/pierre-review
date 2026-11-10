import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Ready to land',
  summary: 'Approved pull requests that GitHub says can merge now.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
