import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Check a pull request against its story',
  summary: 'The story check reads the ticket and says which acceptance criteria the code meets.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
