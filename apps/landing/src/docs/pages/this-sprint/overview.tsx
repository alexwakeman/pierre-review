import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'See the current sprint',
  summary: 'This Sprint reads your tracker\'s current sprint and shows each ticket with its pull requests and its state.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
