import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Unanswered threads',
  summary: 'Review threads nobody has answered or acted on.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
