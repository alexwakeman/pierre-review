import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Check against docs',
  summary: 'Compare a story with your reference docs and see where they disagree.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
