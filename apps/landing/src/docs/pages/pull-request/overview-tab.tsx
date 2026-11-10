import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Overview tab',
  summary: 'The pull request\'s state at a glance: can it land, what blocks it, checks, reviews and the AI review.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
