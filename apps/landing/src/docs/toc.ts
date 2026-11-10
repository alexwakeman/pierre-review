import { isValidElement } from 'react';
import type { ReactNode } from 'react';
import { H2 } from './kit';

// "On this page": the H2s a page body renders, read from the JSX itself, so the prerendered HTML
// and the browser show the same list with no DOM pass.
//
// It calls the body as a plain function and walks the elements it returns, descending into every
// element's `children` (the JSX the page wrote), never into a component's own render. So an H2 must
// be in the page's own JSX (inside a Note or a div is fine), and the body must be HOOK-FREE.

export interface TocItem {
  id: string;
  text: string;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function walk(node: ReactNode, out: TocItem[]): void {
  if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return;
  }
  if (!isValidElement<{ id?: string; children?: ReactNode }>(node)) return;
  if (node.type === H2 && node.props.id) {
    out.push({ id: node.props.id, text: textOf(node.props.children).trim() });
    return;
  }
  walk(node.props.children, out);
}

const cache = new WeakMap<() => JSX.Element, TocItem[]>();

export function tocFor(Body: () => JSX.Element): TocItem[] {
  const hit = cache.get(Body);
  if (hit) return hit;
  const out: TocItem[] = [];
  walk(Body(), out);
  cache.set(Body, out);
  return out;
}
