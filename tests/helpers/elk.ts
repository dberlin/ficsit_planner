import { setWorkerFactory } from '../../src/lib/layoutClient';

/** The layout engine in workers of its own, as the app runs it; call the returned function to let the workers go. */
export function layoutEngine(): () => void {
  setWorkerFactory(() => new Worker(require.resolve('elkjs/lib/elk-worker.min.js')));
  return () => {
    setWorkerFactory();
  };
}
