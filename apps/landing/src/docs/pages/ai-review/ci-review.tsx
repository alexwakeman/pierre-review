import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'CI review',
  summary: 'When checks fail, Limn reads the logs and says what broke and why.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
