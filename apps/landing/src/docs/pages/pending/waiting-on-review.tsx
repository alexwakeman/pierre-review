import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Waiting on review',
  summary: 'Pull requests that need a reviewer, oldest wait first.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
