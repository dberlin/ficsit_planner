import { expect, test } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import loadHighs from 'highs';
import { useFactoryEntries } from '../../src/lib/solution';
import { solve, type SolveInput } from '../../src/lib/solver';
import { setSkipped } from '../../src/lib/unlocks';
import { newPlan, useStore } from '../../src/store';

test('a background factory result keeps the miner unlocked when its solve started', async () => {
  const highs = await loadHighs();
  const originalWorker = globalThis.Worker;
  const originalState = useStore.getState();
  let worker: DeferredWorker | undefined;
  class DeferredWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { preventDefault: () => void; message: string }) => void;
    requests: { id: number; input: SolveInput }[] = [];
    constructor() {
      worker = this;
    }
    postMessage(request: { id: number; input: SolveInput }) {
      this.requests.push(request);
    }
    terminate() {}
  }
  try {
    // Substitute the worker transport while retaining the real solver and result cache.
    const globals = globalThis as unknown as { Worker: typeof DeferredWorker };
    globals.Worker = DeferredWorker;
    setSkipped([]);
    const plan = newPlan('Pending miner');
    plan.targets = [{ item: 'Desc_IronPlate_C', rate: 60 }];
    plan.extraction = { ...plan.extraction, miner: 'Build_MinerMk3_C' };
    useStore.setState({ plans: [plan], active: plan.id, tier: 9, skipped: [] });
    const view = renderHook(() => useFactoryEntries(true));
    const request = worker!.requests[0];
    const result = solve(highs, request.input);
    setSkipped(['Schematic_8-4_C']);
    await act(async () => {
      worker!.onmessage!({ data: { id: request.id, ok: true, value: result } });
    });
    setSkipped([]);
    view.rerender();
    expect(view.result.current[0].extraction?.find((use) => use.item === 'Desc_OreIron_C')?.extractor.id).toBe('Build_MinerMk3_C');
  } finally {
    cleanup();
    worker?.onerror?.({ preventDefault() {}, message: 'test teardown' });
    globalThis.Worker = originalWorker;
    setSkipped(originalState.skipped);
    useStore.setState(originalState, true);
  }
});
