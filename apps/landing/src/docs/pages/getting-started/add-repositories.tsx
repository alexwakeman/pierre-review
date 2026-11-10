import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Add your repositories',
  summary: 'Choose the repositories Limn follows. The first sync brings in two weeks of history quickly, then fills in the rest.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
