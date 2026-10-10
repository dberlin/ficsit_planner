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

test('with splitters shown, a belt feeds one place per end and a splitter or merger hands out three at most', () => {
  const all = new Set(data.recipes.filter((x) => x.kind === 'standard').map((x) => x.id));
  for (const [item, rate] of [
    ['Desc_Motor_C', 10],
    ['Desc_Computer_C', 5],
    ['Desc_Plastic_C', 60],
    ['Desc_ModularFrameHeavy_C', 4],
  ] as const) {
    const r = solve(highs, { targets: [{ item, rate }], supplies: [], enabledRecipes: all, resourceCaps: {}, objective: 'resources' });
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

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
const rectOf = (n: { position: Pt; width?: number; height?: number }): Rect => ({
  x: n.position.x,
  y: n.position.y,
  w: n.width ?? 0,
  h: n.height ?? 0,
});
/** Does a straight run cut through the inside of a box (not just along its edge)? */
const cuts = (a: Pt, b: Pt, r: Rect) => {
  const [x0, x1, y0, y1] = [Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return x0 < r.x + r.w - 1 && x1 > r.x + 1 && y0 < r.y + r.h - 1 && y1 > r.y + 1;
};

test('every belt label sits in a spot kept for it, off the cards and mostly off the other labels', async () => {
  const r = solve(highs, {
    targets: [
      { item: 'Desc_Computer_C', rate: 20 },
      { item: 'Desc_Motor_C', rate: 30 },
    ],
    supplies: [],
    enabledRecipes: new Set(data.recipes.filter((x) => x.kind === 'standard').map((x) => x.id)),
    resourceCaps: {},
    objective: 'resources',
  });
  const { nodes, edges } = await layoutGraph(buildGraph(r, 9), { dir: 'LR', effort: 'fast' }, testEngine);
  const spots = edges.map((e) => (e.data as FlowEdgeData).route?.label);
  expect(spots.every(Boolean)).toBe(true);
  const box = (p: Pt) => ({ x: p.x - 75, y: p.y - 22, w: 150, h: 44 });
  const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const labels = spots.map((p) => box(p!));
  let overCards = 0;
  for (const l of labels) for (const n of nodes) if (hit(l, rectOf(n))) overCards++;
  let overLabels = 0;
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) if (hit(labels[i], labels[j])) overLabels++;
  expect(overCards).toBe(0);
  expect(overLabels).toBeLessThanOrEqual(Math.ceil(labels.length / 5));
});

test('a belt running back against the flow goes round the cards, not through them, and is marked as a loop', async () => {
  const r = solve(highs, {
    targets: [{ item: 'Desc_AluminumIngot_C', rate: 60 }],
    supplies: [],
    enabledRecipes: new Set(data.recipes.filter((x) => x.kind === 'standard').map((x) => x.id)),
    resourceCaps: {},
    objective: 'resources',
  });
  for (const dir of ['LR', 'TB'] as const) {
    const { nodes, edges } = await layoutGraph(buildGraph(r, 9), { dir, effort: 'fast' }, testEngine);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const along = (id: string, end: 'out' | 'in') => {
      const n = byId.get(id)!;
      return dir === 'LR' ? n.position.x + (end === 'out' ? (n.width ?? 0) : 0) : n.position.y + (end === 'out' ? (n.height ?? 0) : 0);
    };
    const routeOf = (e: (typeof edges)[number]) => (e.data as FlowEdgeData).route!;
    const loops = edges.filter((e) => routeOf(e).loop);
    // Water out of the scrap refinery back into the alumina one.
    expect(loops.length).toBeGreaterThan(0);
    for (const e of edges) expect(!!routeOf(e).loop).toBe(along(e.target, 'in') <= along(e.source, 'out'));
    for (const e of loops) {
      const { points, loop } = routeOf(e);
      // Marked at the turn into its input.
      expect(loop).toEqual(points.at(-2)!);
      // Its label, wider than most for saying where it goes back to, sits beside its route and off every card.
      const { label } = routeOf(e);
      const near = points.slice(1).some((b, i) => {
        const a = points[i];
        const [dx, dy] = [b.x - a.x, b.y - a.y];
        const t = Math.max(0, Math.min(1, ((label.x - a.x) * dx + (label.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(label.x - (a.x + t * dx), label.y - (a.y + t * dy)) < 40;
      });
      expect(near).toBe(true);
      const tag = { x: label.x - 220, y: label.y - 22, w: 440, h: 44 };
      for (const n of nodes) {
        const r = rectOf(n);
        expect(tag.x < r.x + r.w && r.x < tag.x + tag.w && tag.y < r.y + r.h && r.y < tag.y + tag.h, `label of ${e.id} on ${n.id}`).toBe(
          false,
        );
      }
      for (let i = 1; i < points.length; i++)
        for (const n of nodes) expect(cuts(points[i - 1], points[i], rectOf(n)), `${e.id} through ${n.id}`).toBe(false);
    }
  }
});

const standard = () => new Set(data.recipes.filter((x) => x.kind === 'standard').map((x) => x.id));

test('byproducts of a line split by destination meet their destinations in as few pipes as it takes', () => {
  const r = solve(highs, {
    targets: [
      { item: 'Desc_Plastic_C', rate: 30 },
      { item: 'Desc_PackagedOilResidue_C', rate: 15 },
    ],
    supplies: [],
    enabledRecipes: standard(),
    resourceCaps: {},
    objective: 'resources',
  });
  const { nodes, edges } = buildGraph(r, 9, { splitters: true, splitLines: 'each' });
  // One junction for the crude oil going to two refineries; the leftover goes straight to the packager and the surplus.
  expect(nodes.filter((n) => n.type === 'logistic')).toHaveLength(1);
  const pairs = edges.map((e) => `${e.source}>${e.target}`);
  expect(new Set(pairs).size).toBe(pairs.length);
});

test('a splitter has one input and three outputs, a merger three inputs and one output, and each belt names its end', async () => {
  const r = solve(highs, {
    targets: [{ item: 'Desc_IronPlateReinforced_C', rate: 30 }],
    supplies: [],
    enabledRecipes: standard(),
    resourceCaps: {},
    objective: 'resources',
  });
  for (const dir of ['LR', 'TB'] as const) {
    const { nodes, edges } = await layoutGraph(buildGraph(r, 9, { splitters: true }), { dir, effort: 'fast' }, testEngine);
    const logistic = nodes.filter((n) => n.type === 'logistic');
    expect(logistic.length).toBeGreaterThan(0);
    for (const n of logistic) {
      const ids = (n.handles ?? []).map((h) => h.id);
      const merger = (n.data as { ins: number }).ins === 3;
      expect(ids.filter((i) => i?.startsWith('i'))).toHaveLength(merger ? 3 : 1);
      expect(ids.filter((i) => i?.startsWith('o'))).toHaveLength(merger ? 1 : 3);
      const outs = edges.filter((e) => e.source === n.id);
      const ins = edges.filter((e) => e.target === n.id);
      const used = [...outs.map((e) => e.sourceHandle), ...ins.map((e) => e.targetHandle)];
      expect(used.every((h) => !!h && ids.includes(h))).toBe(true);
      // No two belts on one end.
      expect(new Set(used).size).toBe(used.length);
      // Each belt's route meets the end it names.
      const at = (handle: string) => {
        const h = n.handles!.find((x) => x.id === handle)!;
        return { x: n.position.x + h.x + h.width / 2, y: n.position.y + h.y + h.height / 2 };
      };
      const meets = [
        ...outs.map((e) => [e.id, e.sourceHandle!, (e.data as FlowEdgeData).route!.points[0]] as const),
        ...ins.map((e) => [e.id, e.targetHandle!, (e.data as FlowEdgeData).route!.points.at(-1)!] as const),
      ];
      for (const [id, end, p] of meets) {
        const want = at(end);
        expect(Math.hypot(p.x - want.x, p.y - want.y), `${id} at ${end}`).toBeLessThan(6);
      }
    }
  }
});

test('belts side by side go into a card through an end as wide as they are, not through one point', async () => {
  const r = solve(highs, {
    targets: [{ item: 'Desc_IronPlate_C', rate: 1000 }],
    supplies: [],
    enabledRecipes: standard(),
    resourceCaps: {},
    objective: 'resources',
  });
  const { nodes, edges } = await layoutGraph(buildGraph(r, 3), { dir: 'LR', effort: 'fast' }, testEngine);
  const many = edges.filter((e) => (e.data as { lanes: number }).lanes > 1);
  expect(many.length).toBeGreaterThan(0);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of many) {
    const d = e.data as FlowEdgeData;
    expect(d.wide).toEqual({ from: true, to: true });
    const need = Math.min(d.lanes, 6) * 10;
    const ends = [
      [byId.get(e.source)!, e.sourceHandle!],
      [byId.get(e.target)!, e.targetHandle!],
    ] as const;
    for (const [n, id] of ends) {
      const h = n.handles!.find((x) => x.id === id)!;
      expect(h.height).toBeGreaterThanOrEqual(need);
      // Handles side by side on one card don't overlap.
      for (const o of n.handles!)
        if (o !== h && o.position === h.position) expect(o.y + o.height <= h.y + 0.5 || h.y + h.height <= o.y + 0.5).toBe(true);
    }
  }
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
