import ELK from 'elkjs/lib/elk-api.js';
import { setLayoutEngine } from '../../src/lib/model/arrange';

/** The layout engine in workers of its own, as the app runs it; call the returned function to let the workers go. */
export function layoutEngine(): () => void {
  const list = [0, 1].map(() => new ELK({ workerFactory: () => new Worker(require.resolve('elkjs/lib/elk-worker.min.js')) as never }));
  let next = 0;
  setLayoutEngine((graph) => list[next++ % list.length].layout(graph));
  return () => {
    setLayoutEngine();
    for (const e of list) e.terminateWorker();
  };
}
