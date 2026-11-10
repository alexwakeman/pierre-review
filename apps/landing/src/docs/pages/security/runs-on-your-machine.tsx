import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Limn runs on your computer',
  summary: 'There is no Limn server and no account. What that means for your code and your data.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
