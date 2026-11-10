import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Ticket tab',
  summary: 'The linked ticket\'s story inside the pull request: criteria, comments and the story check.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
