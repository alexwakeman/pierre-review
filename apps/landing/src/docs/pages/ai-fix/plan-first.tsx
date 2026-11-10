import type { DocMeta } from '../../types';
import { Stub } from '../../kit';

export const meta: DocMeta = {
  title: 'Plan first',
  summary: 'Talk the fix through with the agent before it changes any code.',
  stub: true,
};

export default function Page(): JSX.Element {
  return <Stub />;
}
