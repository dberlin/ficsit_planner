import { beforeAll, expect, test } from 'bun:test';
import type { Node } from '@xyflow/react';
import loadHighs, { type Highs } from 'highs';
import { data } from '../src/lib/data';
import { buildGraph, type FlowEdgeData, type MachineNodeData, portSpots, type Route } from '../src/lib/graph';
import { cachedLayout, forgetPlacements, layoutGraph } from '../src/lib/layout';
import { solve } from '../src/lib/solver';
import { testEngine } from './elkEngine';

let highs: Highs;
beforeAll(async () => {
  highs = await loadHighs();
});

const standard = () => new Set(data.recipes.filter((x) => x.kind === 'standard').map((x) => x.id));
const plan = (targets: { item: string; rate: number }[]) =>
  solve(highs, { targets, supplies: [], enabledRecipes: standard(), resourceCaps: {}, objective: 'resources' });

test('every belt has its own handle at each end: outputs on the right, inputs on the left', async () => {
  const r = plan([
    { item: 'Desc_ModularFrame_C', rate: 30 },
    { item: 'Desc_Plastic_C', rate: 20 },
  ]);
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
  expect(nodes.some((n) => n.id === 'target:Desc_ModularFrame_C')).toBe(true);
});

test('with splitters shown, a belt feeds one place per end and a splitter or merger hands out three at most', () => {
  for (const [item, rate] of [
    ['Desc_Motor_C', 10],
    ['Desc_Computer_C', 5],
    ['Desc_Plastic_C', 60],
    ['Desc_ModularFrameHeavy_C', 4],
  ] as const) {
    const r = plan([{ item, rate }]);
    const plain = buildGraph(r, 9);
    const { nodes, edges } = buildGraph(r, 9, { splitters: true });
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
    expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
    const kind = (id: string) => nodes.find((n) => n.id === id)?.type;
    const out = new Map<string, number>();
    const into = new Map<string, number>();
    for (const e of edges) {
      const item = (e.data as { item: string }).item;
      out.set(`${e.source}|${item}`, (out.get(`${e.source}|${item}`) ?? 0) + 1);
      into.set(`${e.target}|${item}`, (into.get(`${e.target}|${item}`) ?? 0) + 1);
    }
    for (const [key, n] of out) expect(n).toBeLessThanOrEqual(kind(key.split('|')[0]) === 'logistic' ? 3 : 1);
    for (const [key, n] of into) expect(n).toBeLessThanOrEqual(kind(key.split('|')[0]) === 'logistic' ? 3 : 1);
    // What goes into a splitter or merger comes out of it.
    for (const n of nodes.filter((x) => x.type === 'logistic')) {
      const rate = (list: typeof edges) => list.reduce((s, e) => s + (e.data as { rate: number }).rate, 0);
      expect(rate(edges.filter((e) => e.source === n.id))).toBeCloseTo(rate(edges.filter((e) => e.target === n.id)), 6);
    }
    // Machines and what they make are the same; only the logistics are new.
    expect(
      nodes
        .filter((n) => n.type !== 'logistic')
        .map((n) => n.id)
        .sort(),
    ).toEqual(plain.nodes.map((n) => n.id).sort());
    if (item === 'Desc_Motor_C') expect(nodes.some((n) => n.type === 'logistic')).toBe(true);
    expect(plain.nodes.some((n) => n.type === 'logistic')).toBe(false);
  }
});

type Rect = { x: number; y: number; w: number; h: number };
const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const cardOf = (n: Node): Rect => ({ x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 });

test('every belt label sits clear of the cards and of the other labels, whatever the belt shape', async () => {
  const r = plan([
    { item: 'Desc_Computer_C', rate: 20 },
    { item: 'Desc_Motor_C', rate: 30 },
  ]);
  for (const routing of ['ORTHOGONAL', 'SPLINES', 'POLYLINE'] as const) {
    const { nodes, edges } = await layoutGraph(buildGraph(r, 9), { dir: 'LR', routing, effort: 'fast' }, testEngine);
    const box = (p: { x: number; y: number }) => ({ x: p.x - 75, y: p.y - 22, w: 150, h: 44 });
    const labels = edges.map((e) => box((e.data as FlowEdgeData).route!.label));
    let overCards = 0;
    for (const l of labels) for (const n of nodes) if (hit(l, cardOf(n))) overCards++;
    let overLabels = 0;
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) if (hit(labels[i], labels[j])) overLabels++;
    expect(overCards, routing).toBe(0);
    expect(overLabels, routing).toBeLessThanOrEqual(Math.ceil(labels.length / 5));
  }
});

test('a belt running back against the flow is marked as a loop, routed round the cards at right angles', async () => {
  const r = plan([{ item: 'Desc_AluminumIngot_C', rate: 60 }]);
  for (const dir of ['LR', 'TB'] as const) {
    const { nodes, edges } = await layoutGraph(buildGraph(r, 9), { dir, effort: 'fast' }, testEngine);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const along = (id: string, end: 'out' | 'in') => {
      const n = byId.get(id)!;
      return dir === 'LR' ? n.position.x + (end === 'out' ? (n.width ?? 0) : 0) : n.position.y + (end === 'out' ? (n.height ?? 0) : 0);
    };
    const loops = edges.filter((e) => (e.data as { route?: Route }).route?.loop);
    // Water out of the scrap refinery back into the alumina one.
    expect(loops.length).toBeGreaterThan(0);
    for (const e of edges) {
      const back = along(e.target, 'in') <= along(e.source, 'out');
      expect(!!(e.data as { route?: Route }).route?.loop).toBe(back);
    }
    for (const e of loops) {
      const route = (e.data as { route: Route }).route;
      // Its ↺ sits just before the input, level with it.
      const end = route.points.at(-1)!;
      expect(dir === 'LR' ? route.loop!.y : route.loop!.x).toBeCloseTo(dir === 'LR' ? end.y : end.x, 6);
      // Straight runs with square turns, none of them through a card.
      for (let i = 1; i < route.points.length; i++) {
        const [a, b] = [route.points[i - 1], route.points[i]];
        expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5).toBe(true);
        const run = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
        for (const n of nodes) {
          const c = cardOf(n);
          expect(hit(run, { x: c.x + 2, y: c.y + 2, w: c.w - 4, h: c.h - 4 }), `${e.id} through ${n.id}`).toBe(false);
        }
      }
    }
  }
});

test('byproducts of a line split by destination meet their destinations in as few pipes as it takes', () => {
  const r = plan([
    { item: 'Desc_Plastic_C', rate: 30 },
    { item: 'Desc_PackagedOilResidue_C', rate: 15 },
  ]);
  const { nodes, edges } = buildGraph(r, 9, { splitters: true, splitLines: 'each' });
  // One junction for the crude oil going to two refineries; the leftover goes straight to the packager and the surplus.
  expect(nodes.filter((n) => n.type === 'logistic')).toHaveLength(1);
  const pairs = edges.map((e) => `${e.source}>${e.target}`);
  expect(new Set(pairs).size).toBe(pairs.length);
});

test('a splitter has one input and three outputs, a merger three inputs and one output, and each belt names its end', async () => {
  const r = plan([{ item: 'Desc_IronPlateReinforced_C', rate: 30 }]);
  for (const dir of ['LR', 'TB'] as const) {
    const { nodes, edges } = await layoutGraph(buildGraph(r, 9, { splitters: true }), { dir, effort: 'fast' }, testEngine);
    const logistic = nodes.filter((n) => n.type === 'logistic');
    expect(logistic.length).toBeGreaterThan(0);
    for (const n of logistic) {
      const ids = (n.handles ?? []).map((h) => h.id);
      const { ins, outs } = n.data as { ins: number; outs: number };
      const merger = ins === 3;
      expect(ids.filter((i) => i?.startsWith('i'))).toHaveLength(merger ? 3 : 1);
      expect(ids.filter((i) => i?.startsWith('o'))).toHaveLength(merger ? 1 : 3);
      const into = edges.filter((e) => e.target === n.id);
      const from = edges.filter((e) => e.source === n.id);
      const used = [...from.map((e) => e.sourceHandle), ...into.map((e) => e.targetHandle)];
      expect(used.every((h) => !!h && ids.includes(h))).toBe(true);
      // No two belts on one end.
      expect(new Set(used).size).toBe(used.length);
      // Each belt's route meets the building where that end is.
      const side = dir === 'LR' ? n.height! : n.width!;
      const spot = (e: (typeof edges)[number], end: 'in' | 'out') => {
        const slot = Number((end === 'in' ? e.targetHandle : e.sourceHandle)!.slice(1));
        return portSpots(end === 'in' ? ins : outs)[slot] * side;
      };
      const across = (p: { x: number; y: number }) => (dir === 'LR' ? p.y - n.position.y : p.x - n.position.x);
      for (const e of into) expect(across((e.data as FlowEdgeData).route!.points.at(-1)!)).toBeCloseTo(spot(e, 'in'), 6);
      for (const e of from) expect(across((e.data as FlowEdgeData).route!.points[0])).toBeCloseTo(spot(e, 'out'), 6);
    }
  }
});

test('belts side by side go into a card through an end as wide as they are, not through one point', async () => {
  const r = plan([{ item: 'Desc_IronPlate_C', rate: 1000 }]);
  const { nodes, edges } = await layoutGraph(buildGraph(r, 3), { dir: 'LR', effort: 'fast' }, testEngine);
  const many = edges.filter((e) => (e.data as { lanes: number }).lanes > 1);
  expect(many.length).toBeGreaterThan(0);
  for (const e of many) {
    const d = e.data as { lanes: number; wide?: { from: boolean; to: boolean } };
    expect(d.wide).toEqual({ from: true, to: true });
    const need = Math.min(d.lanes, 6) * 10;
    const out = nodes.find((n) => n.id === e.source)!.handles!.find((h) => h.id === e.sourceHandle)!;
    const into = nodes.find((n) => n.id === e.target)!.handles!.find((h) => h.id === e.targetHandle)!;
    expect(out.height).toBeGreaterThanOrEqual(need);
    expect(into.height).toBeGreaterThanOrEqual(need);
  }
});

test('a layout made before is reused and comes out exactly as a fresh one', async () => {
  const graph = (rate: number) =>
    buildGraph(
      plan([
        { item: 'Desc_Motor_C', rate },
        { item: 'Desc_Computer_C', rate: 5 },
      ]),
      9,
    );
  const opts = { box: { width: 1200, height: 700 }, effort: 'fast' as const };
  const fresh = async (rate: number) => {
    forgetPlacements();
    return JSON.stringify(await layoutGraph(graph(rate), opts, testEngine));
  };
  const same = await fresh(20);
  // Built again with the placement remembered, it's there at once, without the layout engine.
  expect(JSON.stringify(cachedLayout(graph(20), opts))).toBe(same);
  const none = () => Promise.reject(new Error('laid out again'));
  const first = await layoutGraph(graph(20), opts, none);
  expect(JSON.stringify(first)).toBe(same);
  // Moving what came back must not change what is remembered.
  for (const n of first.nodes) n.position.x += 999;
  for (const e of first.edges) for (const p of (e.data as { route?: { points: { x: number }[] } }).route?.points ?? []) p.x += 999;
  expect(JSON.stringify(await layoutGraph(graph(20), opts, none))).toBe(same);
  // The floor being another size picks between the directions again, from what is remembered.
  const narrow = { ...opts, box: { width: 400, height: 900 } };
  const onNarrow = JSON.stringify(await layoutGraph(graph(20), narrow, none));
  forgetPlacements();
  expect(JSON.stringify(await layoutGraph(graph(20), narrow, testEngine))).toBe(onNarrow);
  // Nothing is remembered for a factory that hasn't been laid out.
  forgetPlacements();
  expect(cachedLayout(graph(20), opts)).toBeUndefined();
});

test('splitting for a belt tier: lines become groups of whole machines whose every belt fits', () => {
  const r = plan([
    { item: 'Desc_ModularFrame_C', rate: 30 },
    { item: 'Desc_Plastic_C', rate: 120 },
  ]);
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
