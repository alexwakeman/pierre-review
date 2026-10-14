// Which file-type mark a changed file wears in the Changes tab (the rail and each file heading).
//
// DISPLAY ONLY. This is NOT one of the four path classifiers CLAUDE.md names (`NOISE_GLOBS`,
// `isLockFile`, `isNonCodeFile`, `BLAST_SURFACES` + `isTestFile`) and must never be folded into
// one or read by one: those decide what an agent reviews, what starts collapsed, what counts as
// code and how far a change reaches. This decides a picture. Its lock-file and test-file lists
// are deliberately its own, so widening one here changes no behaviour anywhere.
//
// Resolution order: the exact file NAME first (Dockerfile, package.json, yarn.lock), then
// name-shaped families (`.env.*`, `Dockerfile.*`, `*.test.ts`), then the extension, then the
// generic file. Case-insensitive throughout.

export type FileTypeIconId =
  | 'javascript'
  | 'react'
  | 'typescript'
  | 'react_ts'
  | 'json'
  | 'markdown'
  | 'html'
  | 'css'
  | 'sass'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'swift'
  | 'ruby'
  | 'php'
  | 'c'
  | 'h'
  | 'cpp'
  | 'hpp'
  | 'csharp'
  | 'console'
  | 'yaml'
  | 'toml'
  | 'docker'
  | 'database'
  | 'graphql'
  | 'svg'
  | 'image'
  | 'lock'
  | 'tune'
  | 'git'
  | 'vue'
  | 'svelte'
  | 'test-js'
  | 'test-ts'
  | 'test-jsx'
  | 'nodejs'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'settings'
  | 'document'
  | 'xml'
  | 'table'
  | 'file';

/** Whole file names that decide the mark on their own, before any extension is read. */
const BY_NAME: Record<string, FileTypeIconId> = {
  'package.json': 'nodejs',
  '.nvmrc': 'nodejs',
  '.node-version': 'nodejs',
  '.npmrc': 'npm',
  '.npmignore': 'npm',
  'pnpm-workspace.yaml': 'pnpm',
  '.pnpmfile.cjs': 'pnpm',
  '.yarnrc': 'yarn',
  '.yarnrc.yml': 'yarn',
  // Lock files: one padlock whatever the package manager — the point of the mark is "you
  // need not read this", which is the same fact for all of them.
  'package-lock.json': 'lock',
  'npm-shrinkwrap.json': 'lock',
  'pnpm-lock.yaml': 'lock',
  'yarn.lock': 'lock',
  'bun.lockb': 'lock',
  'bun.lock': 'lock',
  'cargo.lock': 'lock',
  'gemfile.lock': 'lock',
  'composer.lock': 'lock',
  'poetry.lock': 'lock',
  'pipfile.lock': 'lock',
  'uv.lock': 'lock',
  'flake.lock': 'lock',
  'go.sum': 'lock',
  'podfile.lock': 'lock',
  'mix.lock': 'lock',
  'pubspec.lock': 'lock',
  dockerfile: 'docker',
  containerfile: 'docker',
  '.dockerignore': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'compose.yml': 'docker',
  'compose.yaml': 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitkeep': 'git',
  '.git-blame-ignore-revs': 'git',
  '.mailmap': 'git',
  gemfile: 'ruby',
  rakefile: 'ruby',
  makefile: 'settings',
  '.editorconfig': 'settings',
  'go.mod': 'go',
  'go.work': 'go',
  'cargo.toml': 'rust',
};

const BY_EXTENSION: Record<string, FileTypeIconId> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'react',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'react_ts',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  ndjson: 'json',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  rst: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'sass',
  sass: 'sass',
  less: 'css',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  rb: 'ruby',
  erb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  php: 'php',
  c: 'c',
  h: 'h',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  'c++': 'cpp',
  hh: 'hpp',
  hpp: 'hpp',
  hxx: 'hpp',
  cs: 'csharp',
  csx: 'csharp',
  sh: 'console',
  bash: 'console',
  zsh: 'console',
  fish: 'console',
  ksh: 'console',
  bat: 'console',
  cmd: 'console',
  ps1: 'console',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  dockerfile: 'docker',
  sql: 'database',
  psql: 'database',
  pgsql: 'database',
  sqlite: 'database',
  db: 'database',
  graphql: 'graphql',
  gql: 'graphql',
  svg: 'svg',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  ico: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image',
  lock: 'lock',
  lockb: 'lock',
  env: 'tune',
  patch: 'git',
  vue: 'vue',
  svelte: 'svelte',
  ini: 'settings',
  cfg: 'settings',
  conf: 'settings',
  config: 'settings',
  properties: 'settings',
  txt: 'document',
  xml: 'xml',
  csv: 'table',
  tsv: 'table',
  xls: 'table',
  xlsx: 'table',
  ods: 'table',
  plist: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  csproj: 'xml',
};

/**
 * Test files keep their language's colour but wear the flask. `.test.` / `.spec.` / `.cy.` and a
 * `.snap` of a JS-family file. Only the JS family has a test mark upstream; a Python or Go test
 * file wears its language mark.
 */
const TEST_SUFFIX =
  /\.(test|spec|e2e-spec|cy|spec-d|test-d)\.([cm]?[jt]sx?)$|\.([cm]?[jt]sx?)\.snap$/;

function testMark(ext: string): FileTypeIconId {
  if (ext === 'tsx' || ext === 'jsx') return 'test-jsx';
  if (ext.endsWith('ts')) return 'test-ts';
  return 'test-js';
}

/** The mark for a repo-relative path. Never throws; anything unknown is the generic file. */
export function fileTypeIcon(path: string): FileTypeIconId {
  const normalized = path.replace(/\\/g, '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  if (name === '') return 'file';

  const named = BY_NAME[name];
  if (named) return named;

  // Families that are names rather than extensions.
  if (name === '.env' || name.startsWith('.env.')) return 'tune';
  if (name.startsWith('dockerfile.') || name.startsWith('containerfile.')) return 'docker';
  if (name.startsWith('docker-compose.') && /\.ya?ml$/.test(name)) return 'docker';
  if (name.startsWith('.gitignore') || name.startsWith('.gitattributes')) return 'git';

  const test = TEST_SUFFIX.exec(name);
  if (test) return testMark(test[2] ?? test[3] ?? 'js');

  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return 'file';
  const ext = name.slice(dot + 1);
  const byExt = BY_EXTENSION[ext];
  if (byExt) return byExt;
  // A dotfile whose whole name is "rc"-shaped (`.prettierrc`, `.eslintrc`) is configuration.
  if (dot === 0 && name.endsWith('rc')) return 'settings';
  return 'file';
}
