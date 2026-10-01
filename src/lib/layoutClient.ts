import type { ELK as Elk, ElkNode } from 'elkjs/lib/elk-api';
import ELK from 'elkjs/lib/elk-api.js';
import type { Engine } from './layout';

/** Workers to lay out in, so several arrangements are tried at once. */
const POOL = () => Math.min(4, Math.max(2, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2));
/** A pool that hasn't answered its first job by now is taken as not working. */
const FIRST_ANSWER_MS = 4000;

type Job = { graph: ElkNode; resolve: (g: ElkNode) => void; reject: (e: unknown) => void };

const defaultFactory = () => new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
/** ELK on this thread, loaded only when the workers don't work here. */
const defaultFallback: Engine = async (graph) => (await import('./elkMain')).mainThreadEngine(graph);

let factory: () => Worker = defaultFactory;
let onThisThread: Engine = defaultFallback;
let pool: Elk[] | undefined;
let broken = false;
let answered = false;
let nextId = 0;
let turn = 0;
const pending = new Map<number, Job>();

/** For tests: lay out in workers made this way, falling back to `fallback` (undefined: the real ones). Starts a fresh pool. */
export function setWorkerFactory(make?: () => Worker, fallback?: Engine): void {
  for (const e of pool ?? []) e.terminateWorker();
  pool = undefined;
  broken = false;
  answered = false;
  pending.clear();
  factory = make ?? defaultFactory;
  onThisThread = fallback ?? defaultFallback;
}

/** Workers don't work here: stop using them, and lay out everything still waiting on this thread. */
function giveUp(why: unknown) {
  if (broken) return;
  console.warn('Layout workers unavailable, laying out on the main thread:', why);
  broken = true;
  for (const e of pool ?? []) e.terminateWorker();
  pool = undefined;
  const waiting = [...pending.values()];
  pending.clear();
  for (const job of waiting) onThisThread(job.graph).then(job.resolve, job.reject);
}

function engines(): Elk[] {
  if (pool) return pool;
  pool = Array.from(
    { length: POOL() },
    () =>
      new ELK({
        workerFactory: () => {
          const w = factory();
          // ELK's own wrapper never hears about a worker that fails, so its layouts would wait forever.
          w.addEventListener('error', (e) => {
            e.preventDefault();
            giveUp(e.message || 'worker failed to start');
          });
          return w;
        },
      }),
  );
  setTimeout(() => {
    if (!answered && pending.size) giveUp('no answer in time');
  }, FIRST_ANSWER_MS);
  return pool;
}

/** Lays out in the next worker of the pool, or on this thread when workers don't work here. */
export const layoutInBackground: Engine = (graph) => {
  if (broken || typeof Worker === 'undefined') return onThisThread(graph);
  const ws = engines();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { graph, resolve, reject });
    ws[turn++ % ws.length].layout(graph).then(
      (g) => {
        answered = true;
        if (pending.delete(id)) resolve(g);
      },
      (err) => {
        answered = true;
        if (pending.delete(id)) reject(err);
      },
    );
  });
};

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
