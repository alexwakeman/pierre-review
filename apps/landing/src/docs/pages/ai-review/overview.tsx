import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'How AI review works',
  summary: 'Limn reviews a pull request with Claude or Codex on your own account. Nothing is posted until you say so.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
