import { confluenceSource } from './confluence.js';
import { registerWikiSource, wikiSourceFor } from './source.js';

// The wiki adapters this build ships (docs/REFERENCE-DOCS.md § Wiki sources). A new wiki (Notion)
// implements `WikiSource` and registers here — nothing else names a provider.
if (!wikiSourceFor('confluence')) registerWikiSource(confluenceSource());
