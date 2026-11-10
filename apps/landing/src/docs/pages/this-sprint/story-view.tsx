import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Open a ticket\'s story',
  summary: 'The story view shows one ticket: what it asks for, its comments, its pull requests and the story check.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
