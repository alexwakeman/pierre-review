import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Read the feed',
  summary: 'The feed lists what happened in the workspace, newest first: reviews, comments, merges and CI.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
