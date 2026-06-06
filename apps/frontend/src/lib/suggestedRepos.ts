// Hardcoded, curated suggestions shown in the Add-repo picker when the search box
// is focused with an empty query — a "where do I start?" springboard. These are
// notable, active, public repos across a deliberately wide spread of fields. Each
// slug was verified to resolve on GitHub (exact `full_name`, no redirect); revisit
// periodically since repos can be renamed/archived (no test guards this list).
//
// Pure UI seed data — owner/name are the canonical GitHub slug halves, so
// `${owner}/${name}` is the fullName and the add body is `{ owner, name }`.

export interface CuratedRepo {
  owner: string;
  name: string;
  /** Short field label, shown as a chip on the row. */
  category: string;
  /** One concise line on why it's interesting. */
  why: string;
}

export const SUGGESTED_REPOS: readonly CuratedRepo[] = [
  {
    owner: 'mrdoob',
    name: 'three.js',
    category: 'Graphics',
    why: 'The de-facto JavaScript 3D library (WebGL/WebGPU) behind most browser 3D and creative coding.',
  },
  {
    owner: 'bevyengine',
    name: 'bevy',
    category: 'Game engines',
    why: 'A refreshingly simple, data-driven game engine in Rust with one of open source’s most active engine communities.',
  },
  {
    owner: 'obsproject',
    name: 'obs-studio',
    category: 'Media',
    why: 'The industry-standard open-source live-streaming and screen-recording suite.',
  },
  {
    owner: 'huggingface',
    name: 'transformers',
    category: 'Machine learning',
    why: 'The model-definition framework behind state-of-the-art NLP/vision/audio models; hub of the open ML ecosystem.',
  },
  {
    owner: 'pytorch',
    name: 'pytorch',
    category: 'Machine learning',
    why: 'Meta’s deep-learning framework that dominates research and increasingly production training.',
  },
  {
    owner: 'ollama',
    name: 'ollama',
    category: 'Machine learning',
    why: 'The easiest way to run open LLMs locally; explosive recent adoption.',
  },
  {
    owner: 'ggml-org',
    name: 'llama.cpp',
    category: 'Machine learning',
    why: 'Highly optimized C/C++ LLM inference that made local, quantized model serving mainstream.',
  },
  {
    owner: 'numpy',
    name: 'numpy',
    category: 'Scientific computing',
    why: 'The foundational N-dimensional array library underpinning essentially all of Python’s scientific stack.',
  },
  {
    owner: 'pola-rs',
    name: 'polars',
    category: 'Data science',
    why: 'A blazing-fast multi-threaded DataFrame query engine in Rust; the modern challenger to pandas.',
  },
  {
    owner: 'jupyter',
    name: 'notebook',
    category: 'Data science',
    why: 'The interactive notebook that became the lingua franca of data science and research computing.',
  },
  {
    owner: 'rust-lang',
    name: 'rust',
    category: 'Languages',
    why: 'The Rust language and compiler; a memory-safe systems language topping developer-love surveys.',
  },
  {
    owner: 'golang',
    name: 'go',
    category: 'Languages',
    why: 'Google’s Go language and toolchain; the backbone of modern cloud and infrastructure software.',
  },
  {
    owner: 'ziglang',
    name: 'zig',
    category: 'Languages',
    why: 'A fast-growing low-level language aiming to be a simpler, safer C; also a drop-in C/C++ compiler.',
  },
  {
    owner: 'duckdb',
    name: 'duckdb',
    category: 'Databases',
    why: 'An in-process analytical SQL database — the “SQLite for analytics” — surging across data tooling.',
  },
  {
    owner: 'redis',
    name: 'redis',
    category: 'Databases',
    why: 'The ubiquitous in-memory data store used for caching, queues, and real-time data.',
  },
  {
    owner: 'cockroachdb',
    name: 'cockroach',
    category: 'Databases',
    why: 'A distributed, PostgreSQL-compatible SQL database built for resilience and horizontal scale.',
  },
  {
    owner: 'sveltejs',
    name: 'svelte',
    category: 'Web frameworks',
    why: 'A compiler-first UI framework producing tiny, fast apps; consistently top-rated for satisfaction.',
  },
  {
    owner: 'denoland',
    name: 'deno',
    category: 'Runtimes',
    why: 'A secure, TypeScript-first JavaScript runtime from Node’s original creator.',
  },
  {
    owner: 'neovim',
    name: 'neovim',
    category: 'Dev tools',
    why: 'The hyperextensible, Lua-scriptable Vim fork that became the modern terminal editor of choice.',
  },
  {
    owner: 'openssl',
    name: 'openssl',
    category: 'Security',
    why: 'The cryptography and TLS library securing a huge fraction of the internet’s traffic.',
  },
  {
    owner: 'd3',
    name: 'd3',
    category: 'Visualization',
    why: 'The canonical library for bespoke, data-driven SVG/Canvas visualizations.',
  },
  {
    owner: 'tldraw',
    name: 'tldraw',
    category: 'Visualization',
    why: 'An infinite-canvas drawing SDK and whiteboard; a slick showcase of modern web UI and real-time collab.',
  },
] as const;
