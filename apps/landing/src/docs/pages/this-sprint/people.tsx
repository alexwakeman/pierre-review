import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'The People view',
  summary: 'Tickets by person, so you can see who has too much and who is blocked.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
