import { beforeAll, expect, test } from 'bun:test';
import type { Node } from '@xyflow/react';
import loadHighs, { type Highs } from 'highs';
import { data } from '../src/lib/data';
import { buildGraph, type FlowEdgeData, type MachineNodeData, portSpots, type Route } from '../src/lib/graph';
import { cachedLayout, forgetPlacements, layoutGraph } from '../src/lib/layout';
import { autoAreas } from '../src/lib/autoAreas';
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
    if (byId.get(e.source)!.type !== 'logistic') expect(e.sourceHandle).toBe(`${e.id}:out`);
    if (byId.get(e.target)!.type !== 'logistic') expect(e.targetHandle).toBe(`${e.id}:in`);
    const src = byId.get(e.source)!.handles!.find((h) => h.id === e.sourceHandle);
    const dst = byId.get(e.target)!.handles!.find((h) => h.id === e.targetHandle);
    expect(src?.type).toBe('source');
    expect(src?.position).toBe('right');
    expect(dst?.type).toBe('target');
    expect(dst?.position).toBe('left');
  }
  // Logistics expose their unused sockets too; every connected end still has exactly one belt.
  for (const n of nodes) {
    const used = [
      ...edges.filter((e) => e.source === n.id).map((e) => e.sourceHandle),
      ...edges.filter((e) => e.target === n.id).map((e) => e.targetHandle),
    ];
    expect(new Set(used).size).toBe(used.length);
  }
  // Handles stay on the card, spread along its side.
  for (const n of nodes) for (const h of n.handles!) expect(h.y + h.height / 2).toBeGreaterThan(0);
  for (const n of nodes) for (const h of n.handles!) expect(h.y + h.height / 2).toBeLessThan(n.height!);
  expect(nodes.some((n) => n.id === 'target:Desc_ModularFrame_C')).toBe(true);
});

test('logistics are always shown: a belt feeds one place per end and each splitter or merger hands out three at most', () => {
  for (const [item, rate] of [
    ['Desc_Motor_C', 10],
    ['Desc_Computer_C', 5],
    ['Desc_Plastic_C', 60],
    ['Desc_ModularFrameHeavy_C', 4],
  ] as const) {
    const r = plan([{ item, rate }]);
    const { nodes, edges } = buildGraph(r, 9);
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
    // Every solved machine remains represented alongside the logistics.
    expect(
      nodes
        .filter((n) => n.type === 'machine')
        .map((n) => n.id)
        .sort(),
    ).toEqual(r.recipes.map((u) => `recipe:${u.recipe.id}`).sort());
    if (item === 'Desc_Motor_C') expect(nodes.some((n) => n.type === 'logistic')).toBe(true);
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
  const { nodes, edges } = buildGraph(r, 9, { splitLines: 'each' });
  // One junction for the crude oil going to two refineries; the leftover goes straight to the packager and the surplus.
  expect(nodes.filter((n) => n.type === 'logistic')).toHaveLength(1);
  const pairs = edges.map((e) => `${e.source}>${e.target}`);
  expect(new Set(pairs).size).toBe(pairs.length);
});

test('a splitter has one input and three outputs, a merger three inputs and one output, and each belt names its end', async () => {
  const r = plan([{ item: 'Desc_IronPlateReinforced_C', rate: 30 }]);
  for (const dir of ['LR', 'TB'] as const) {
    const { nodes, edges } = await layoutGraph(buildGraph(r, 9), { dir, effort: 'fast' }, testEngine);
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

  // Count each item as it leaves its producer, not again at every level of its logistic tree.
  const moved = (es: typeof edges, ns: typeof nodes) => {
    const producers = new Set(ns.filter((n) => n.type !== 'logistic').map((n) => n.id));
    const m = new Map<string, number>();
    for (const e of es.filter((e) => e.type === 'flow' && producers.has(e.source))) {
      const d = e.data as FlowEdgeData;
      m.set(d.item, (m.get(d.item) ?? 0) + d.rate);
    }
    return m;
  };
  const before = moved(whole.edges, whole.nodes);
  for (const [item, rate] of moved(edges, nodes)) expect(rate).toBeCloseTo(before.get(item)!, 4);
});

test('the Auto floor makes an area for each product built from two others, with what works only towards it', async () => {
  const r = solve(highs, {
    targets: [{ item: 'Desc_Motor_C', rate: 10 }],
    supplies: [],
    enabledRecipes: new Set(data.recipes.filter((x) => x.kind === 'standard').map((x) => x.id)),
    resourceCaps: {},
    objective: 'resources',
  });
  const { nodes, edges } = await layoutGraph(buildGraph(r, 9), { dir: 'LR', effort: 'fast' }, testEngine);
  const areas = autoAreas(nodes, edges);
  expect(areas.map((a) => a.label).sort()).toEqual(['Rotor', 'Stator']);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const a of areas) {
    const inside = nodes.filter(
      (n) =>
        n.type === 'machine' &&
        n.position.x >= a.x &&
        n.position.x + (n.width ?? 0) <= a.x + a.w &&
        n.position.y >= a.y &&
        n.position.y + (n.height ?? 0) <= a.y + a.h,
    );
    expect(inside.length).toBeGreaterThanOrEqual(3);
    expect(byId.size).toBeGreaterThan(inside.length);
  }
  // Two areas never overlap.
  const [p, q] = areas;
  expect(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y).toBe(true);
});

test('Auto floor keeps each product chain together, so four chains of a larger factory each get an area of their own', async () => {
  const r = solve(highs, {
    targets: [
      { item: 'Desc_Computer_C', rate: 5 },
      { item: 'Desc_Motor_C', rate: 10 },
    ],
    supplies: [],
    enabledRecipes: new Set(data.recipes.filter((x) => x.kind === 'standard').map((x) => x.id)),
    resourceCaps: {},
    objective: 'resources',
  });
  for (const dir of ['LR', 'TB'] as const) {
    forgetPlacements();
    const { nodes, edges } = await layoutGraph(buildGraph(r, 9), { dir, effort: 'fast' }, testEngine);
    const areas = autoAreas(nodes, edges);
    expect(areas.length).toBe(4);
    for (const a of areas) {
      // No machine of another chain stands in an area.
      const strangers = nodes.filter((n) => {
        if (n.type !== 'machine') return false;
        const x = Math.min(a.x + a.w, n.position.x + (n.width ?? 0)) - Math.max(a.x, n.position.x);
        const y = Math.min(a.y + a.h, n.position.y + (n.height ?? 0)) - Math.max(a.y, n.position.y);
        return (
          x > 0 &&
          y > 0 &&
          !(
            n.position.x >= a.x &&
            n.position.y >= a.y &&
            n.position.x + (n.width ?? 0) <= a.x + a.w &&
            n.position.y + (n.height ?? 0) <= a.y + a.h
          )
        );
      });
      expect(strangers.length).toBe(0);
    }
  }
});

test('with products on lines of their own, every line gets an area, a line of one machine too', async () => {
  const items = ['Desc_IronPlateReinforced_C', 'Desc_Cable_C', 'Desc_Cement_C'];
  const r = solve(highs, {
    targets: items.map((item) => ({ item, rate: 10 })),
    supplies: [],
    enabledRecipes: new Set(data.recipes.filter((x) => x.kind === 'standard').map((x) => x.id)),
    resourceCaps: {},
    objective: 'resources',
    lines: items,
  });
  const { nodes, edges } = await layoutGraph(buildGraph(r, 9), { dir: 'LR', effort: 'fast' }, testEngine);
  expect(
    autoAreas(nodes, edges)
      .map((a) => a.label)
      .sort(),
  ).toEqual(['Cable', 'Concrete', 'Reinforced Iron Plate']);
});

test('splitters and mergers form balanced trees, each branch under one of them as big as the next within one belt', () => {
  const r = solve(highs, {
    targets: ['Desc_ModularFrameHeavy_C', 'Desc_Computer_C', 'Desc_Motor_C', 'Desc_IronPlateReinforced_C', 'Desc_Cable_C'].map((item) => ({
      item,
      rate: 30,
    })),
    supplies: [],
    enabledRecipes: new Set(data.recipes.filter((x) => x.kind === 'standard').map((x) => x.id)),
    resourceCaps: {},
    objective: 'resources',
  });
  const { nodes, edges } = buildGraph(r, 9, { splitLines: 'each' });
  const logistic = new Set(nodes.filter((n) => n.type === 'logistic').map((n) => n.id));
  expect(logistic.size).toBeGreaterThan(0);
  // How many belts a branch ends in, however many splitters (or mergers) lie between.
  const leaves = (id: string, next: (n: string) => string[]): number =>
    logistic.has(id) ? next(id).reduce((sum, to) => sum + leaves(to, next), 0) : 1;
  const down = (id: string) => edges.filter((e) => e.source === id).map((e) => e.target);
  const up = (id: string) => edges.filter((e) => e.target === id).map((e) => e.source);
  let deep = 0;
  for (const id of logistic) {
    const kind = (nodes.find((n) => n.id === id)!.data as { kind: string }).kind;
    const ends = kind === 'merger' ? up(id) : down(id);
    expect(ends.length).toBeLessThanOrEqual(3);
    const sizes = ends.map((to) => leaves(to, kind === 'merger' ? up : down));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    // A tree's splitter has belts or splitters under it, never a mix: that would be a chain.
    const under = ends.filter((to) => logistic.has(to)).length;
    expect(under === 0 || under === ends.length).toBe(true);
    if (under > 0) deep++;
  }
  expect(deep).toBeGreaterThan(0);
});

// ---- One end per item on a machine card ----

type Ends = { in: { id: string; item?: string; at: number; len: number }[]; out: { id: string; item?: string; at: number; len: number }[] };
const factory = (item: string, rate: number) =>
  solve(highs, { targets: [{ item, rate }], supplies: [], enabledRecipes: standard(), resourceCaps: {}, objective: 'resources' });
const endsOf = (n: { data: unknown }) => (n.data as { ends?: Ends }).ends;
const machines = (nodes: ReturnType<typeof buildGraph>['nodes']) => nodes.filter((n) => n.type === 'machine');

test('a machine with two inputs has an end for each, and each belt goes into the end of its own item', async () => {
  const r = factory('Desc_Motor_C', 10);
  for (const dir of ['LR', 'TB'] as const) {
    const { nodes, edges } = await layoutGraph(buildGraph(r, 9), { dir, effort: 'fast' }, testEngine);
    const motor = machines(nodes).find(
      (n) => (n.data as { use: { recipe: { outputs: { item: string }[] } } }).use.recipe.outputs[0].item === 'Desc_Motor_C',
    )!;
    const ends = endsOf(motor)!;
    expect(ends.in).toHaveLength(2);
    expect(new Set(ends.in.map((e) => e.item)).size).toBe(2);
    const into = edges.filter((e) => e.target === motor.id);
    expect(into.length).toBeGreaterThanOrEqual(2);
    for (const e of into) {
      const end = ends.in.find((x) => x.id === e.targetHandle);
      expect(end?.item).toBe((e.data as { item: string }).item);
    }
  }
});

test('every belt on a machine card ends on the end of its item, through splitters and mergers, either way round', async () => {
  let viaMerger = 0;
  let viaSplitter = 0;
  for (const dir of ['LR', 'TB'] as const) {
    for (const [item, rate] of [
      ['Desc_Motor_C', 10],
      ['Desc_Computer_C', 30],
      ['Desc_Plastic_C', 60],
      ['Desc_ModularFrameHeavy_C', 12],
    ] as const) {
      const { nodes, edges } = await layoutGraph(
        buildGraph(factory(item, rate), 9, { splitLines: 'each' }),
        { dir, effort: 'fast' },
        testEngine,
      );
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const e of edges) {
        if (e.type !== 'flow') continue;
        const belt = (e.data as { item: string }).item;
        const [from, to] = [byId.get(e.source)!, byId.get(e.target)!];
        if (to.type === 'machine') {
          expect(endsOf(to)!.in.find((x) => x.id === e.targetHandle)?.item).toBe(belt);
          if (from.type === 'logistic') viaMerger++;
        }
        if (from.type === 'machine') {
          expect(endsOf(from)!.out.find((x) => x.id === e.sourceHandle)?.item).toBe(belt);
          if (to.type === 'logistic') viaSplitter++;
        }
      }
    }
  }
  expect(viaMerger).toBeGreaterThan(0);
  expect(viaSplitter).toBeGreaterThan(0);
});

test('a refinery that makes a byproduct has an out end for it as well, and the byproduct leaves from there', async () => {
  const { nodes, edges } = await layoutGraph(buildGraph(factory('Desc_Plastic_C', 60), 9), { dir: 'LR', effort: 'fast' }, testEngine);
  const refinery = machines(nodes).find((n) => endsOf(n)!.out.length === 2)!;
  expect(refinery).toBeTruthy();
  const ends = endsOf(refinery)!;
  expect(ends.out.map((e) => e.item).sort()).toEqual(['Desc_HeavyOilResidue_C', 'Desc_Plastic_C']);
  const residue = edges.find((e) => e.source === refinery.id && (e.data as { item: string }).item === 'Desc_HeavyOilResidue_C')!;
  expect(ends.out.find((x) => x.id === residue.sourceHandle)?.item).toBe('Desc_HeavyOilResidue_C');
  const plastic = edges.find((e) => e.source === refinery.id && (e.data as { item: string }).item === 'Desc_Plastic_C')!;
  expect(plastic.sourceHandle).not.toBe(residue.sourceHandle);
});

test('the ends a machine card declares are the ends its belts name, and no two of them overlap', async () => {
  for (const dir of ['LR', 'TB'] as const) {
    for (const [item, rate] of [
      ['Desc_Motor_C', 10],
      ['Desc_ModularFrameHeavy_C', 60],
      ['Desc_Computer_C', 150],
    ] as const) {
      const { nodes, edges } = await layoutGraph(buildGraph(factory(item, rate), 3), { dir, effort: 'fast' }, testEngine);
      for (const n of machines(nodes)) {
        const ends = endsOf(n)!;
        const declared = (n.handles ?? []).map((h) => h.id).sort();
        expect(declared).toEqual([...ends.in, ...ends.out].map((e) => e.id).sort());
        const used = [
          ...edges.filter((e) => e.source === n.id).map((e) => e.sourceHandle),
          ...edges.filter((e) => e.target === n.id).map((e) => e.targetHandle),
        ];
        expect(used.every((h) => !!h && declared.includes(h))).toBe(true);
        const side = dir === 'LR' ? n.height! : n.width!;
        for (const list of [ends.in, ends.out]) {
          const spans = list.map((e) => [e.at * side - e.len / 2, e.at * side + e.len / 2]).sort((a, b) => a[0] - b[0]);
          expect(spans.every(([a, b]) => a >= -1e-6 && b <= side + 1e-6)).toBe(true);
          for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThan(spans[i - 1][1] + 1e-6);
        }
      }
    }
  }
});

test('belts that would cross at a machine are put on its ends the other way round', async () => {
  // Wherever two belts reach a card from different sides of it, the one from above takes the upper end.
  const { nodes, edges } = await layoutGraph(
    buildGraph(factory('Desc_ModularFrameHeavy_C', 12), 9),
    { dir: 'LR', effort: 'fast' },
    testEngine,
  );
  const at = new Map(nodes.map((n) => [n.id, n.position.y + (n.height ?? 0) / 2]));
  let checked = 0;
  for (const n of machines(nodes)) {
    const into = edges.filter((e) => e.target === n.id).sort((a, b) => at.get(a.source)! - at.get(b.source)!);
    const slots = into.map((e) => endsOf(n)!.in.find((end) => end.id === e.targetHandle)!.at);
    if (new Set(into.map((e) => (e.data as { item: string }).item)).size < 2) continue;
    checked++;
    // Per item the first belt's order never goes against the end order by more than ties.
    const first = new Map<string, number>();
    for (const [i, e] of into.entries())
      if (!first.has((e.data as { item: string }).item)) first.set((e.data as { item: string }).item, slots[i]);
    const order = [...first.values()];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }
  expect(checked).toBeGreaterThan(0);
});
