import { confluenceSource } from './confluence.js';
import { notionSource } from './notion.js';
import { registerWikiSource, wikiSourceFor } from './source.js';

// The wiki adapters this build ships (docs/REFERENCE-DOCS.md § Wiki sources). A new wiki implements
// `WikiSource` and registers here — nothing else names a provider (except the credential ladder and the
// provider union on the wire).
if (!wikiSourceFor('confluence')) registerWikiSource(confluenceSource());
if (!wikiSourceFor('notion')) registerWikiSource(notionSource());
