import type { Engine } from './layout';

/** Lays out off to the side of the app: for now ELK on this thread, loaded on first use. */
export const layoutInBackground: Engine = async (graph) => (await import('./elkMain')).mainThreadEngine(graph);

/**
 * Wraps each new layout so only the latest one counts: one finishing after a newer one started resolves to
 * undefined, and the floor never jumps back to an older arrangement.
 */
export function latestOnly<T>(): (p: Promise<T>) => Promise<T | undefined> {
  let run = 0;
  return (p) => {
    const mine = ++run;
    return p.then((v) => (mine === run ? v : undefined));
  };
}
