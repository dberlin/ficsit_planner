import ELK from 'elkjs/lib/elk-api.js';
import type { Engine } from '../src/lib/layout';

// Bun has a global `self` and no `document`, so ELK's bundled build takes it for a web worker and won't start here.
// ELK's own worker script runs fine in a Bun worker, the same way the app runs it in the browser.
const elk = new ELK({ workerFactory: () => new Worker(require.resolve('elkjs/lib/elk-worker.min.js')) });

export const testEngine: Engine = (graph) => elk.layout(graph);
