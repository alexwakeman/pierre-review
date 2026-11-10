import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Check the default branches',
  summary: 'The strip at the top of Open pull requests shows whether each repository\'s default branch is green.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
