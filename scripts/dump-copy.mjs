// Dump every word the landing site renders, in page order, as one markdown file.
//
// WHY IT READS THE BUILD, NOT THE JSX. The copy is spread across three page
// components, a shared tier table and the SEO table, and a good half of it is
// interleaved with layout. Transcribing that by hand to review it is how a
// proofread and the live site drift apart. This reads `apps/landing/dist`, so
// what comes out is exactly what a reader gets — including the per-route <title>
// and meta description the prerenderer baked in.
//
//   pnpm --filter @pierre-review/landing build   # must run first: this reads dist/
//   node scripts/dump-copy.mjs [out.md]          # default /tmp/limn-site-copy.md
//
// Three shapes the generic HTML walk cannot get right on its own, all handled
// below: a stat tile (a big number in one box, its sentence in the next), the
// vendor rail (a column of one-word rows), and a call-to-action anchor (a block
// in the layout that is still an <a>). The comparison table is not walked at all
// — it is a CSS grid whose mobile-only "Free"/"Pro" markers interleave with the
// cells, so its rows are read from TierTable.tsx and rendered as a real table.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'apps', 'landing', 'dist');
const OUT = process.argv[2] ?? '/tmp/limn-site-copy.md';

const PAGES = [
  ['Home', '/', 'index.html'],
  ['For developers', '/for-developers', 'for-developers/index.html'],
  ['For engineering managers', '/for-managers', 'for-managers/index.html'],
  ['How we measure', '/how-we-measure', 'how-we-measure/index.html'],
];

const ENT = (s) =>
  s
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘').replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&times;/g, '×');

function tierRows() {
  const src = readFileSync(
    join(ROOT, 'apps', 'landing', 'src', 'components', 'feint', 'TierTable.tsx'),
    'utf8',
  );
  const body = src.slice(src.indexOf('const ROWS: Row[] = ['), src.indexOf('\n];'));
  const rows = [];
  const re =
    /\{\s*q:\s*'((?:[^'\\]|\\.)*)',\s*free:\s*(?:'((?:[^'\\]|\\.)*)'|`([^`]*)`),\s*pro:\s*'((?:[^'\\]|\\.)*)',\s*\}/g;
  let m;
  while ((m = re.exec(body))) {
    const u = (s) =>
      (s ?? '').replace(/\\'/g, "'").replace(/\$\{INSTALL_COMMAND\}/g, 'npx pierre-review');
    rows.push({ q: u(m[1]), free: u(m[2] ?? m[3]), pro: u(m[4]) });
  }
  if (rows.length === 0) throw new Error('no tier rows parsed — did ROWS change shape?');
  return rows;
}

const DROP = new Set(['Enlarge', '—', '·', 'Free', 'Pro', 'Question', '']);

function copyOf(html) {
  const m = html.match(/<!-- app:start -->([\s\S]*?)<!-- app:end -->/);
  let body = m ? m[1] : html;
  body = body
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<nav[\s\S]*?<\/nav>/g, '')
    .replace(/<footer[\s\S]*?<\/footer>/g, '');

  // Everything from the comparison table down is emitted from source, so cut it.
  const cut = body.indexOf('Free answers one pull request');
  const tail = cut > -1 ? body.slice(cut) : '';
  if (cut > -1) body = body.slice(0, cut);

  const walk = (chunk) => {
    let b = chunk
      .replace(/<h1[^>]*>/g, '\n@@1@@').replace(/<h2[^>]*>/g, '\n@@2@@')
      .replace(/<h3[^>]*>/g, '\n@@3@@').replace(/<h4[^>]*>/g, '\n@@4@@')
      .replace(/<\/(h1|h2|h3|h4)>/g, '\n')
      .replace(/<li[^>]*>/g, '\n@@L@@')
      .replace(/<figcaption[^>]*>/g, '\n@@C@@')
      .replace(/<blockquote[^>]*>/g, '\n@@Q@@')
      .replace(/<p[^>]*>/g, '\n@@P@@')
      .replace(/<\/(p|div|section|header|figure|ul|blockquote|figcaption|li)>/g, '\n')
      // A CTA anchor is a block in the layout; a link inside running copy is not,
      // and must not break the sentence it sits in. `inline-block` is what the
      // button primitives set and no prose link does.
      .replace(/<a [^>]*class="[^"]*inline-block[^"]*"[^>]*>/g, '\n@@B@@')
      .replace(/<\/?(span|a|em|strong|code|button)[^>]*>/g, '')
      .replace(/<[^>]+>/g, '');
    b = ENT(b);

    const out = [];
    for (const raw of b.split('\n')) {
      const t = raw.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const tag = t.match(/^@@(\d|L|C|Q|P|B)@@/);
      let text = (tag ? t.slice(tag[0].length) : t).replace(/^—\s*/, '').trim();
      // The frame's caption bar ends in its own "Enlarge" control.
      if (tag && tag[1] === 'C') text = text.replace(/Enlarge$/, '').trim();
      if (DROP.has(text)) continue;
      out.push({ k: tag ? tag[1] : 'x', t: text });
    }

    const joined = [];
    for (const n of out) {
      const prev = joined[joined.length - 1];
      if (n.k === 'x' && prev && prev.k === 'x' && prev.t.length < 30 && n.t.length < 30) {
        prev.t = `${prev.t} · ${n.t}`;
        continue;
      }
      if (n.k === 'P' && prev && prev.k === 'x' && prev.t.length < 12) {
        prev.k = 'S';
        prev.t = `**${prev.t}** — ${n.t}`;
        continue;
      }
      joined.push({ ...n });
    }
    return joined;
  };

  return { main: walk(body), tail: walk(tail) };
}

let md = `# Limn — the copy on the site

Every word that renders, in page order, read out of the prerendered HTML rather than
retyped. Rail labels ("02 / The board") and screenshot slots are marked so you can see
where each section sits.

Regenerate with \`node scripts/dump-copy.mjs\` after a landing build.
`;

const rows = tierRows();

for (const [name, path, file] of PAGES) {
  const html = readFileSync(join(DIST, file), 'utf8');
  const title = (html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? '';
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) ?? [])[1] ?? '';
  const { main, tail } = copyOf(html);

  md += `\n\n---\n\n# ${name} — \`${path}\`\n\n`;
  md += `**Browser tab / search result title**\n> ${ENT(title)}\n\n`;
  md += `**Meta description**\n> ${ENT(desc)}\n\n`;

  for (const n of main) {
    if (n.k === '1') md += `\n## H1 · ${n.t}\n\n`;
    else if (n.k === '2') md += `\n### ${n.t}\n\n`;
    else if (n.k === '3') md += `\n#### ${n.t}\n\n`;
    else if (n.k === '4') md += `\n##### ${n.t}\n\n`;
    else if (n.k === 'L') md += `- ${n.t}\n`;
    else if (n.k === 'C') md += `\n\`[ screenshot — ${n.t} ]\`\n\n`;
    else if (n.k === 'Q') md += `\n> *${n.t}*\n\n`;
    else if (n.k === 'B') md += `\n\`[ button: ${n.t} ]\`\n\n`;
    else if (n.k === 'S') md += `${n.t}\n\n`;
    else if (n.k === 'x' && n.t.length < 90) md += `\n*(label: ${n.t})*\n\n`;
    else md += `${n.t}\n\n`;
  }

  md += `\n### Free answers one pull request. Pro answers the fortnight.\n\n`;
  md += `Limn is open core. The free tier is the product, not a trial — it has no repository limit, no user limit and no expiry, and every action you take on a pull request lives in it. Pro is what happens when you need the same truth one grain up: across repositories, across people, across a period.\n\n`;
  md += `| Question | Free · open core | Pro · $25 per user |\n|---|---|---|\n`;
  for (const r of rows) md += `| **${r.q}** | ${r.free} | ${r.pro} |\n`;
  md += `\nA user is someone who signs in. Bots never count, and there is no per-repository charge.\n\n`;
  for (const n of tail) {
    if (n.k === 'C') md += `\n\`[ screenshot — ${n.t} ]\`\n\n`;
    else if (n.k === '2') md += `\n### ${n.t}\n\n`;
  }
  md += `Sign in with GitHub and the first repositories are on screen in a couple of minutes, or run the whole free tier on your own machine and keep the data there.\n\n`;
  md += `\`[Sign in with GitHub]\`  \`[Get Pro — $25 per user]\`\n\n`;
  md += `Checkout is not live yet — Pro is rolling out, and both buttons sign you into the free tier today. Or run it locally: \`npx pierre-review\`\n`;
}

writeFileSync(OUT, md);
console.log(`${OUT} — ${md.length} chars, ${rows.length} comparison rows`);
