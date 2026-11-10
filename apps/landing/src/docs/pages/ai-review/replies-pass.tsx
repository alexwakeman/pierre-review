import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Replies to findings',
  summary: 'When somebody replies to a finding, Limn reads the reply and says whether the finding still stands.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
