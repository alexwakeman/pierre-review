import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'AI reviews',
  summary: 'The newest AI review on each pull request, with the ones that are new since you last looked.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
