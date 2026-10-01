import { beforeAll, expect, test } from 'bun:test';
import loadHighs, { type Highs } from 'highs';
import { data } from '../src/lib/data';
import { buildGraph, type FlowEdgeData, type MachineNodeData } from '../src/lib/graph';
import { layoutGraph } from '../src/lib/layout';
import { solve } from '../src/lib/solver';
import { testEngine } from './elkEngine';

let highs: Highs;
beforeAll(async () => {
  highs = await loadHighs();
});

test('every belt has its own handle at each end: outputs on the right, inputs on the left', async () => {
  const r = solve(highs, {
    targets: [
      { item: 'Desc_ModularFrame_C', rate: 30 },
      { item: 'Desc_Plastic_C', rate: 20 },
    ],
    supplies: [],
    enabledRecipes: new Set(data.recipes.filter((x) => x.kind === 'standard').map((x) => x.id)),
    resourceCaps: {},
    objective: 'resources',
  });
  const { nodes, edges } = await layoutGraph(buildGraph(r, 9), { dir: 'LR', effort: 'fast' }, testEngine);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    expect(e.sourceHandle).toBe(`${e.id}:out`);
    expect(e.targetHandle).toBe(`${e.id}:in`);
    const src = byId.get(e.source)!.handles!.find((h) => h.id === e.sourceHandle);
    const dst = byId.get(e.target)!.handles!.find((h) => h.id === e.targetHandle);
    expect(src?.type).toBe('source');
    expect(src?.position).toBe('right');
    expect(dst?.type).toBe('target');
    expect(dst?.position).toBe('left');
  }
  // One handle per belt end, no spares.
  const ends = edges.length * 2;
  expect(nodes.reduce((s, n) => s + n.handles!.length, 0)).toBe(ends);
  // Handles stay on the card, spread along its side.
  for (const n of nodes) for (const h of n.handles!) expect(h.y + h.height / 2).toBeGreaterThan(0);
  for (const n of nodes) for (const h of n.handles!) expect(h.y + h.height / 2).toBeLessThan(n.height!);
});

test('splitting for a belt tier: lines become groups of whole machines whose every belt fits', () => {
  const r = solve(highs, {
    targets: [
      { item: 'Desc_ModularFrame_C', rate: 30 },
      { item: 'Desc_Plastic_C', rate: 120 },
    ],
    supplies: [],
    enabledRecipes: new Set(data.recipes.filter((x) => x.kind === 'standard').map((x) => x.id)),
    resourceCaps: {},
    objective: 'resources',
  });
  const whole = buildGraph(r, 9);
  const { nodes, edges } = buildGraph(r, 9, { split: { belt: 60, pipe: 300 } });
  const machines = nodes.filter((n) => n.type === 'machine');
  const grouped = machines.filter((n) => (n.data as MachineNodeData).group);
  expect(grouped.length).toBeGreaterThan(0);

  // Each line's groups place exactly the line's machines.
  for (const u of r.recipes) {
    const mine = machines.filter((n) => n.id === `recipe:${u.recipe.id}` || n.id.startsWith(`recipe:${u.recipe.id}#`));
    const uses = mine.map((n) => (n.data as MachineNodeData).use);
    expect(uses.reduce((s, g) => s + g.built, 0)).toBe(u.built);
    expect(uses.reduce((s, g) => s + g.count, 0)).toBeCloseTo(u.count, 6);
    expect(uses.reduce((s, g) => s + g.sloops, 0)).toBe(u.sloops);
    expect(uses.flatMap((g) => g.clocks)).toEqual(u.clocks);
  }

  // Every belt into or out of a group fits on one Mk.1 belt or pipe.
  const ids = new Set(grouped.map((n) => n.id));
  for (const e of edges.filter((e) => e.type === 'flow' && (ids.has(e.source) || ids.has(e.target)))) {
    const d = e.data as FlowEdgeData;
    expect(d.rate).toBeLessThanOrEqual((data.items[d.item].form === 'solid' ? 60 : 300) + 1e-6);
  }

  // Nothing is lost on the way: each item moves as much as before the split.
  const moved = (es: typeof edges) => {
    const m = new Map<string, number>();
    for (const e of es.filter((e) => e.type === 'flow')) {
      const d = e.data as FlowEdgeData;
      m.set(d.item, (m.get(d.item) ?? 0) + d.rate);
    }
    return m;
  };
  const before = moved(whole.edges);
  for (const [item, rate] of moved(edges)) expect(rate).toBeCloseTo(before.get(item)!, 4);
});
