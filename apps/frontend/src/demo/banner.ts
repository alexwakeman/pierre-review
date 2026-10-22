// The demo notice: one slim bar above the app, always visible. Plain DOM (no inline script, no
// inline style), so it obeys the site's CSP and the app cannot unmount it.

export const DEMO_NOTICE = 'Demo: sample data, nothing is sent.';
export const INSTALL_COMMAND = 'npx limn-review';

export function mountDemoBanner(doc: Document = document): HTMLElement {
  const bar = doc.createElement('div');
  bar.id = 'limn-demo-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Demo notice');

  const notice = doc.createElement('span');
  notice.className = 'limn-demo-notice';
  notice.textContent = DEMO_NOTICE;

  const install = doc.createElement('span');
  install.className = 'limn-demo-install';
  install.append('Run it on your own repos: ');
  const code = doc.createElement('code');
  code.textContent = INSTALL_COMMAND;
  install.append(code);

  const back = doc.createElement('a');
  back.className = 'limn-demo-link';
  back.href = '/';
  back.textContent = 'Back to the website';

  bar.append(notice, install, back);
  doc.body.classList.add('limn-demo');
  doc.body.insertBefore(bar, doc.body.firstChild);
  return bar;
}
