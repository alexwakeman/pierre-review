import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Severity scoring',
  summary: 'Limn scores each bot comment as nit, minor, major or critical with a model that runs on your computer.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
