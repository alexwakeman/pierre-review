import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Repository pages',
  summary: 'Each repository in the sidebar opens its own page: its open pull requests, its default branch and its sync state.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
