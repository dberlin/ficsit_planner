import { Position, type Edge, type Node } from '@xyflow/react';
import { groupClocks } from './clocks';
import { data, transportFor, type Transport } from './data';
import { plantIdOf } from './power';
import { splitUse, type RecipeUse, type SolveResult } from './solver';
import { matchFlows, type Split, type SplitGroup, splitByDestination } from './split';
import type { EdgeRouting, Point } from './routes';
export type { Point } from './routes';

/** Left to right or top to bottom. The layout picks whichever fits the screen, unless the player chose. */
export type Direction = 'LR' | 'TB';

export type EndpointKind = 'raw' | 'supply' | 'missing' | 'target' | 'surplus';

export interface MachineNodeData extends Record<string, unknown> {
  use: RecipeUse;
  /** Generators: MW this plant puts on the grid, augmenter boost included. */
  generation?: number;
  /** The line built as one group per place its output goes, when it goes to more than one. */
  split?: Split;
  /** A card of its own for one of those groups: `use` is then just this group's machines. */
  part?: SplitGroup;
  /** One of the groups a line was split into so each belt and pipe fits: group n of `of`. */
  group?: { n: number; of: number };
  /** One per belt end, placed by the layout. */
  ports?: Port[];
}

/** Who draws from the grid: a factory, the fuel chain itself, what the player typed in, or the output sent on. */
export interface Consumer {
  id: string;
  label: string;
  mw: number;
  tone: 'factory' | 'chain' | 'other' | 'out';
}

export interface PowerNodeData extends Record<string, unknown> {
  kind: 'grid' | 'consumer';
  label: string;
  mw: number;
  tone?: Consumer['tone'];
  /** Grid: augmenter boost, e.g. 0.3. */
  boost?: number;
  /** Grid: generation minus everything drawn; negative when the grid is short. */
  balance?: number;
  /** One per belt end, placed by the layout. */
  ports?: Port[];
}

/** A power line: generator to grid, grid to what it feeds. */
export interface PowerEdgeData extends Record<string, unknown> {
  mw: number;
  route?: Route;
}

export interface LogisticNodeData extends Record<string, unknown> {
  kind: 'splitter' | 'merger' | 'junction';
  item: string;
  /** What passes through it, per minute. */
  rate: number;
  /** How many ends it has on each side: one in and three out for a splitter, three in and one out for a merger. */
  ins: number;
  outs: number;
}

export interface EndpointNodeData extends Record<string, unknown> {
  kind: EndpointKind;
  item: string;
  rate: number;
  /** The products of the line this card belongs to, when the factory is built as lines of their own. */
  line?: string[];
  /** One per belt end, placed by the layout. */
  ports?: Port[];
}

/** The heading over a line of its own. */
export interface LineTagData extends Record<string, unknown> {
  /** The products the line makes. */
  items: string[];
}

/** The belt's path from the layout: around machines, through a spot kept free for its label. */
export interface Route {
  /** The whole path, from the output handle to the input handle. */
  points: Point[];
  label: Point;
  /** Where both machines were laid out. Once either is dragged, the belt falls back to a plain curve. */
  from: Point;
  to: Point;
  routing: EdgeRouting;
  /** A belt that runs back against the flow, round the cards: the turn where it heads into its input. */
  loop?: Point;
}

export interface FlowEdgeData extends Record<string, unknown> {
  item: string;
  rate: number;
  transport: Transport;
  /** Belts/pipes side by side when the best unlocked one can't carry it alone. */
  lanes: number;
  /** Which ends are as wide as the belts (a card's end), so those belts run in parallel into it instead of joining. */
  wide?: { from: boolean; to: boolean };
  route?: Route;
}

/** Where one belt meets a card: its own handle, `offset` along the side (from the top, or the left top to bottom). */
export interface Port {
  id: string;
  type: 'source' | 'target';
  offset: number;
  /** How long the handle is along the side, for belts side by side that go in through it in parallel. */
  size?: number;
}

/** Handle ids for a belt's two ends. */
const ends = (id: string) => ({ sourceHandle: `${id}:out`, targetHandle: `${id}:in` });

export const HANDLE = { width: 8, height: 12 };

/** The most belts side by side that are drawn as such; past that the label's count says how many. */
export const MAX_LANES = 6;
/** Centre to centre between belts side by side. */
export const LANE_PITCH = 10;

/** How long a belt's handle is on a card: as wide as the belts side by side that go in through it, or 0 for a plain one. */
export function endSize(e: Edge, end: 'from' | 'to'): number {
  const d = e.data as FlowEdgeData | undefined;
  return e.type === 'flow' && d?.wide?.[end] ? Math.min(d.lanes, MAX_LANES) * LANE_PITCH : 0;
}

/** Where along its side each of `n` ends of a splitter or merger sits, as a share of the side: one in the middle, three evenly. */
export const portSpots = (n: number): number[] => (n <= 1 ? [0.5] : Array.from({ length: n }, (_, i) => (i + 1) / (n + 1)));

/** Which of `total` ends the `used` ones sit on, in order: one in the middle, two on the outer ends, three on all. */
export const slotsFor = (used: number, total: number): number[] =>
  total <= 1 ? [0] : used === 1 ? [Math.floor(total / 2)] : used === 2 && total === 3 ? [0, 2] : Array.from({ length: used }, (_, i) => i);

/**
 * The node's handles from its ports: inputs on the inflow side, outputs on the outflow side. Spelled out up front,
 * since without them React Flow assumes top/bottom handles for any node it hasn't measured yet.
 */
export function setPorts(node: Node, ports: Port[], dir: Direction): void {
  const width = node.width ?? 0;
  const height = node.height ?? 0;
  node.data = { ...node.data, ports };
  node.handles = ports.map((p) => {
    const input = p.type === 'target';
    const long = Math.max(HANDLE.height, p.size ?? 0);
    if (dir === 'TB') {
      // Same handle turned on its side.
      const flat = { width: long, height: HANDLE.width };
      return {
        id: p.id,
        type: p.type,
        position: input ? Position.Top : Position.Bottom,
        x: p.offset - flat.width / 2,
        y: input ? -flat.height / 2 : height - flat.height / 2,
        ...flat,
      };
    }
    return {
      id: p.id,
      type: p.type,
      position: input ? Position.Left : Position.Right,
      x: input ? -HANDLE.width / 2 : width - HANDLE.width / 2,
      y: p.offset - long / 2,
      width: HANDLE.width,
      height: long,
    };
  });
}

/**
 * A splitter's or merger's handles: its fixed ends spread along each side, `i0`… in and `o0`… out, each with an id
 * the belts name.
 */
export function setLogisticHandles(node: Node, dir: Direction): void {
  const { ins, outs } = node.data as LogisticNodeData;
  const size = { width: node.width ?? 0, height: node.height ?? 0 };
  const down = dir === 'TB';
  const [w, h] = down ? [HANDLE.height, HANDLE.width] : [HANDLE.width, HANDLE.height];
  node.handles = [
    ...portSpots(ins).map((at, i) => ({
      id: `i${i}`,
      type: 'target' as const,
      position: down ? Position.Top : Position.Left,
      x: down ? at * size.width - w / 2 : -w / 2,
      y: down ? -h / 2 : at * size.height - h / 2,
      width: w,
      height: h,
    })),
    ...portSpots(outs).map((at, i) => ({
      id: `o${i}`,
      type: 'source' as const,
      position: down ? Position.Bottom : Position.Right,
      x: down ? at * size.width - w / 2 : size.width - w / 2,
      y: down ? size.height - h / 2 : at * size.height - h / 2,
      width: w,
      height: h,
    })),
  ];
}

/** Ports spread evenly along each side in belt order, where nothing has placed them yet. */
export function spreadPorts(nodes: Node[], edges: Edge[], dir: Direction): void {
  for (const n of nodes) {
    if (n.type === 'line') continue;
    const into = edges.filter((e) => e.target === n.id);
    const out = edges.filter((e) => e.source === n.id);
    if (n.type === 'logistic') {
      const d = n.data as LogisticNodeData;
      slotsFor(out.length, d.outs).forEach((slot, i) => {
        out[i].sourceHandle = `o${slot}`;
      });
      slotsFor(into.length, d.ins).forEach((slot, i) => {
        into[i].targetHandle = `i${slot}`;
      });
      setLogisticHandles(n, dir);
      continue;
    }
    const side = dir === 'LR' ? (n.height ?? 0) : (n.width ?? 0);
    const spread = (list: Edge[], type: Port['type']): Port[] =>
      list.map((e, i) => ({
        id: (type === 'target' ? e.targetHandle : e.sourceHandle)!,
        type,
        offset: (side * (i + 1)) / (list.length + 1),
        size: endSize(e, type === 'target' ? 'to' : 'from'),
      }));
    setPorts(n, [...spread(into, 'target'), ...spread(out, 'source')], dir);
  }
}

export const SIZE = {
  machine: { width: 310, height: 130 },
  logistic: { width: 96, height: 96 },
  endpoint: { width: 330, height: 100 },
  grid: { width: 300, height: 124 },
  consumer: { width: 260, height: 84 },
};

/** The heading over a line of its own, and the room kept above the line for it. */
export const LINE_TAG = { width: 520, height: 60, room: 84 };

/** Each clock group past the first ("+ 1 × 126.19%") takes a line of its own under the count, and the card grows by it. */
export const RUN_LINE = 32;
export const runExtra = (u: RecipeUse) => Math.max(0, groupClocks(u.clocks).length - 1);
/** Lines a machine card grows by: extra clock groups, and the split by destination (or where this group goes) on a line of its own. */
export const cardExtra = (u: RecipeUse, split?: Split | SplitGroup) => runExtra(u) + (split ? 1 : 0);

type Box = { width: number; height: number };

/**
 * A card's box on the floor: card size scales all of it, and text size makes room for the bigger
 * lettering (mostly height, since lines wrap). The CSS sizes the cards with the same formula.
 */
export const cardBox = (size: Box, k: number, text: number): Box => ({
  width: Math.round(size.width * k * (0.6 + 0.4 * text)),
  height: Math.round(size.height * k * (0.3 + 0.7 * text)),
});

/**
 * Space kept for each belt label, so labels never sit on a machine. ELK gives centred labels a layer of
 * their own, so ranksep is the gap on both sides of that label layer together.
 */
export const LABEL = { width: 176, height: 50 };
export const SPACING = {
  LR: { nodesep: 34, ranksep: 70 },
  TB: { nodesep: 30, ranksep: 70 },
};

export interface BuildOptions {
  /** Card size from the settings; the stylesheet draws the cards at the same scale. */
  scale?: number;
  /** Belt label text size from the settings, for the room kept free for labels. */
  text?: number;
  /** Power grid: what it feeds, drawn after the grid node. */
  consumers?: Consumer[];
  /** A line whose output goes to several places: one card with a note, or a card per place. */
  splitLines?: 'one' | 'each';
  /** A splitter, merger or pipe junction where a belt feeds several machines or several belts feed one. */
  splitters?: boolean;
  /**
   * Most a single belt (solids) or pipe (fluids) may carry, per minute. Lines whose flows don't fit are split
   * into groups of whole machines that do, each fed and emptied by its own belts.
   */
  split?: { belt?: number; pipe?: number };
}

type Graph = { nodes: Node[]; edges: Edge[] };

/** The node ids of line `i` of a factory built as lines of their own, and its heading's. */
export const lineId = (i: number, id: string) => `L${i}:${id}`;
export const lineTagId = (i: number) => `line:${i}`;

/**
 * The graph of a factory. With products on lines of their own, each line's cards and belts are named after it, with a
 * heading over it; the layout lays each line out apart and stands them one after the other. Positions and ports come
 * from `layoutGraph`.
 */
export function buildGraph(result: SolveResult, tier: number, opts: BuildOptions = {}): Graph {
  const lines = result.lines;
  if (!lines || lines.length < 2) return buildGraphOne(result, tier, opts);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const [i, line] of lines.entries()) {
    const g = buildGraphOne({ ...line.result, lines: undefined }, tier, opts);
    nodes.push({
      id: lineTagId(i),
      type: 'line',
      position: { x: 0, y: 0 },
      data: { items: line.items } satisfies LineTagData,
      width: LINE_TAG.width,
      height: LINE_TAG.height,
      draggable: false,
      selectable: false,
      focusable: false,
      handles: [],
    });
    // A leftover card of a line of its own says which products that line makes, so what is made from it joins them.
    const owned = (n: Node) => (n.type === 'endpoint' ? { ...n, data: { ...n.data, line: line.items } } : n);
    for (const n of g.nodes) nodes.push({ ...owned(n), id: lineId(i, n.id) });
    for (const e of g.edges) {
      const id = lineId(i, e.id);
      // Handles keep their own names, for a splitter's fixed ends; a card's are named after the belt.
      const rename = (h: string | null | undefined) => (h?.startsWith(`${e.id}:`) ? `${id}${h.slice(e.id.length)}` : h);
      edges.push({
        ...e,
        id,
        source: lineId(i, e.source),
        target: lineId(i, e.target),
        sourceHandle: rename(e.sourceHandle),
        targetHandle: rename(e.targetHandle),
      });
    }
  }
  return { nodes, edges };
}

/** Most groups a line is split into; past this it stays whole and its belts show as lanes side by side. */
const MAX_GROUPS = 50;

/**
 * The line as groups of consecutive machines, each as big as it can be with every item it takes in or sends
 * out fitting on one belt or pipe. A machine that overflows one on its own gets a group to itself. Lines that
 * already fit, and lines that would need more than MAX_GROUPS groups, stay whole.
 */
export function machineGroups(u: RecipeUse, capOf: (item: string) => number | undefined): RecipeUse[] {
  const add = (sum: Map<string, number>, m: RecipeUse) => {
    const next = new Map(sum);
    for (const f of m.inputs) next.set(`in:${f.item}`, (next.get(`in:${f.item}`) ?? 0) + f.rate);
    for (const f of m.outputs) next.set(`out:${f.item}`, (next.get(`out:${f.item}`) ?? 0) + f.rate);
    return next;
  };
  const fits = (sum: Map<string, number>) =>
    [...sum].every(([key, rate]) => {
      const cap = capOf(key.slice(key.indexOf(':') + 1));
      return cap === undefined || rate <= cap + 1e-6;
    });
  if (u.built < 2 || fits(add(new Map(), u))) return [u];
  const sizes: number[] = [];
  let sum = new Map<string, number>();
  for (const m of splitUse(
    u,
    u.clocks.map(() => 1),
  )) {
    const next = add(sum, m);
    if (sizes.length && fits(next)) {
      sum = next;
      sizes[sizes.length - 1]++;
    } else {
      sum = add(new Map(), m);
      sizes.push(1);
    }
  }
  return sizes.length < 2 || sizes.length > MAX_GROUPS ? [u] : splitUse(u, sizes);
}

/** One of the cards a line is drawn as, its share of the line's machines, and the destination it was made for. */
interface Card {
  id: string;
  share: number;
  part?: SplitGroup;
}

/**
 * Turns an LP solution into a factory graph, with a belt for each flow `matchFlows` finds. With `opts.split`, lines
 * are first split into machine groups, so no belt or pipe between machines carries more than the chosen one can.
 */
function buildGraphOne(result: SolveResult, tier: number, opts: BuildOptions = {}): Graph {
  const k = opts.scale ?? 1;
  const box = (size: Box) => cardBox(size, k, opts.text ?? 1);
  const nodes: Node[] = [];

  const endpoint = (kind: EndpointKind, item: string, rate: number) => {
    const id = `${kind}:${item}`;
    nodes.push({
      id,
      type: 'endpoint',
      position: { x: 0, y: 0 },
      data: { kind, item, rate } satisfies EndpointNodeData,
      ...box(SIZE.endpoint),
      handles: [],
    });
  };

  for (const r of result.raw) endpoint('raw', r.item, r.rate);
  for (const s of result.supplies) endpoint('supply', s.item, s.rate);
  for (const m of result.missing) endpoint('missing', m.item, m.rate);

  const flows = matchFlows(result);
  const capOf = (item: string) => (data.items[item]?.form === 'solid' ? opts.split?.belt : opts.split?.pipe) || undefined;
  const tiered = (u: RecipeUse) => (opts.split?.belt || opts.split?.pipe ? machineGroups(u, capOf) : [u]);
  // Lines drawn as more than one card (a card per destination, or groups that fit the chosen belt): each card's
  // node id, its share of the line's machines, and the destination it was made for.
  const cards = new Map<string, Card[]>();
  const plants: { id: string; mw: number }[] = [];
  const card = (id: string, data: MachineNodeData, split?: Split | SplitGroup) => {
    nodes.push({
      id,
      type: 'machine',
      position: { x: 0, y: 0 },
      data,
      ...box({ ...SIZE.machine, height: SIZE.machine.height + RUN_LINE * cardExtra(data.use, split) }),
      handles: [],
    });
  };
  for (const u of result.recipes) {
    const id = `recipe:${u.recipe.id}`;
    const plant = plantIdOf(u.recipe.id);
    const generation = plant ? (result.grid?.plants[plant] ?? 0) : undefined;
    const split = splitByDestination(u, flows, tier);
    const list: Card[] = [];
    if (split && opts.splitLines === 'each') {
      split.groups.forEach((part, i) => {
        const groups = tiered(part.use);
        groups.forEach((g, j) => {
          const gid = groups.length > 1 ? `${id}~${i}#${j + 1}` : `${id}~${i}`;
          const group = groups.length > 1 ? { n: j + 1, of: groups.length } : undefined;
          // Each group sends its own share of what the destination takes.
          const own = { ...part, use: g, rate: part.use.count > 0 ? (part.rate * g.count) / part.use.count : part.rate / groups.length };
          card(gid, { use: g, part: own, group }, own);
          list.push({ id: gid, share: g.count / u.count, part });
        });
      });
    } else {
      const groups = tiered(u);
      groups.forEach((g, i) => {
        const gid = groups.length > 1 ? `${id}#${i + 1}` : id;
        // A generator group puts its share of the plant's power on the grid, by how much fuel it burns.
        const mw = generation === undefined ? undefined : u.count > 0 ? (generation * g.count) / u.count : generation / groups.length;
        const group = groups.length > 1 ? { n: i + 1, of: groups.length } : undefined;
        // One card with a "Split 3 + 2" note; split to fit the belts, the groups say which of them they are instead.
        const note = groups.length > 1 ? undefined : split;
        card(gid, { use: g, generation: mw, split: note, group }, note);
        if (mw !== undefined) plants.push({ id: gid, mw });
        list.push({ id: gid, share: u.count > 0 ? g.count / u.count : 1 / groups.length });
      });
    }
    if (list.length > 1) cards.set(id, list);
  }

  for (const t of result.targets) endpoint('target', t.item, t.rate);
  for (const s of result.surplus) endpoint('surplus', s.item, s.rate);

  const edges: Edge[] = [];
  const belt = (from: string, to: string, item: string, rate: number) => {
    const { transport, lanes } = transportFor(data.items[item], rate, tier);
    const id = `${from}>${to}>${item}`;
    edges.push({
      id,
      source: from,
      target: to,
      ...ends(id),
      type: 'flow',
      data: { item, rate, transport, lanes } satisfies FlowEdgeData,
    });
  };
  const shared = new Map<string, { sources: Map<string, number>; targets: Map<string, number> }>();
  for (const f of flows) {
    if (f.from === f.to) continue;
    const from = cards.get(f.from);
    const to = cards.get(f.to);
    if (!from && !to) {
      belt(f.from, f.to, f.item, f.rate);
      continue;
    }
    // A split line's main output leaves from the group made for that destination; everything else (its inputs, its
    // byproducts) is shared out by each group's size, and matched largest first like the belts between lines.
    const own = from?.filter((c) => c.part?.nodes.includes(f.to) && f.item === c.part.use.outputs[0].item) ?? [];
    const ownShare = own.reduce((s, c) => s + c.share, 0);
    const sources = own.length
      ? own.map((c) => ({ id: c.id, rate: (f.rate * c.share) / ownShare }))
      : from
        ? from.map((c) => ({ id: c.id, rate: f.rate * c.share }))
        : [{ id: f.from, rate: f.rate }];
    const targets = to ? to.map((c) => ({ id: c.id, rate: f.rate * c.share })) : [{ id: f.to, rate: f.rate }];
    if (own.length) {
      for (const [a, b, rate] of pair(sources, targets)) belt(a, b, f.item, rate);
      continue;
    }
    // Shared out by group size: kept for the whole item and matched once below, so two groups' byproducts meet their
    // destinations in as few belts as it takes, not one set of belts for every flow.
    const by = shared.get(f.item) ?? { sources: new Map<string, number>(), targets: new Map<string, number>() };
    shared.set(f.item, by);
    for (const x of sources) by.sources.set(x.id, (by.sources.get(x.id) ?? 0) + x.rate);
    for (const x of targets) by.targets.set(x.id, (by.targets.get(x.id) ?? 0) + x.rate);
  }
  for (const [item, by] of shared) {
    const list = (m: Map<string, number>) => [...m].map(([id, rate]) => ({ id, rate }));
    for (const [a, b, rate] of pair(list(by.sources), list(by.targets))) if (a !== b) belt(a, b, item, rate);
  }

  if (opts.splitters) addLogistics(nodes, edges, box, tier);
  if (result.grid) addGrid(result, plants, nodes, edges, opts.consumers ?? [], box);
  widenEnds(nodes, edges);

  return { nodes, edges };
}

/**
 * Belts side by side go into a card through an end as wide as they are, so a line of 14 belts enters the card as a
 * ribbon and not through one point. The ends of splitters and mergers stay small: their belts join there.
 */
function widenEnds(nodes: Node[], edges: Edge[]) {
  const type = new Map(nodes.map((n) => [n.id, n.type]));
  const card = (id: string) => type.get(id) === 'machine' || type.get(id) === 'endpoint';
  for (const e of edges) {
    if (e.type !== 'flow') continue;
    const d = e.data as FlowEdgeData;
    if (Math.min(d.lanes, MAX_LANES) < 2) continue;
    e.data = { ...d, wide: { from: card(e.source), to: card(e.target) } };
  }
}

/** Up to three belts out of a splitter (three into a merger); more than that chains another one on. */
const FAN = 3;

/**
 * A belt that feeds several machines gets a splitter, and several belts into one machine a merger (a junction for
 * pipes), chained three at a time like on the Manual floor, so the floor shows what would be built. Which of a
 * splitter's ends each belt takes is settled once the layout has placed what it goes to.
 */
function addLogistics(nodes: Node[], edges: Edge[], box: (size: Box) => Box, tier: number) {
  let n = 0;
  const seen = new Map<string, number>();
  const unique = (id: string) => {
    const c = (seen.get(id) ?? 0) + 1;
    seen.set(id, c);
    return c > 1 ? `${id}#${c}` : id;
  };
  const flowEdges = () => edges.filter((e) => e.type === 'flow');
  const make = (from: string, to: string, item: string, rate: number): Edge => {
    const { transport, lanes } = transportFor(data.items[item], rate, tier);
    const id = unique(`${from}>${to}>${item}`);
    return {
      id,
      source: from,
      target: to,
      ...ends(id),
      type: 'flow',
      data: { item, rate, transport, lanes } satisfies FlowEdgeData,
    };
  };
  const logistic = (kind: LogisticNodeData['kind'], item: string, rate: number, merge: boolean): string => {
    const id = `${kind}:${n++}`;
    nodes.push({
      id,
      type: 'logistic',
      position: { x: 0, y: 0 },
      data: { kind, item, rate, ins: merge ? FAN : 1, outs: merge ? 1 : FAN } satisfies LogisticNodeData,
      ...box(SIZE.logistic),
      handles: [],
    });
    return id;
  };
  const group = (key: (e: Edge) => string) => {
    const by = new Map<string, Edge[]>();
    for (const e of flowEdges()) by.set(key(e), [...(by.get(key(e)) ?? []), e]);
    return [...by.values()].filter((list) => list.length > 1);
  };
  const rateOf = (e: Edge) => (e.data as FlowEdgeData).rate;
  const itemOf = (e: Edge) => (e.data as FlowEdgeData).item;
  const pipe = (item: string) => data.items[item]?.form !== 'solid';
  const drop = (gone: Edge[]) => {
    for (const e of gone) edges.splice(edges.indexOf(e), 1);
  };

  // Splitters: one output going to several places.
  for (const list of group((e) => `${e.source}|${itemOf(e)}`)) {
    const item = itemOf(list[0]);
    const kind = pipe(item) ? 'junction' : 'splitter';
    drop(list);
    let feed = list[0].source;
    let left = [...list].sort((a, b) => rateOf(b) - rateOf(a));
    while (left.length) {
      const last = left.length <= FAN;
      const take = last ? left : left.slice(0, FAN - 1);
      const through = left.reduce((s, e) => s + rateOf(e), 0);
      const id = logistic(kind, item, through, false);
      edges.push(make(feed, id, item, through));
      for (const e of take) edges.push(make(id, e.target, item, rateOf(e)));
      left = left.slice(take.length);
      feed = id;
    }
  }
  // Mergers: several belts into one input.
  for (const list of group((e) => `${e.target}|${itemOf(e)}`)) {
    const item = itemOf(list[0]);
    const kind = pipe(item) ? 'junction' : 'merger';
    drop(list);
    const into = list[0].target;
    let left = [...list].sort((a, b) => rateOf(b) - rateOf(a));
    let feed = into;
    // The first merger is the one next to the machine; each further one feeds the one before it.
    while (left.length) {
      const last = left.length <= FAN;
      const take = last ? left : left.slice(0, FAN - 1);
      const through = left.reduce((s, e) => s + rateOf(e), 0);
      const id = logistic(kind, item, through, true);
      edges.push(make(id, feed, item, through));
      for (const e of take) edges.push(make(e.source, id, item, rateOf(e)));
      left = left.slice(take.length);
      feed = id;
    }
  }
}

/** Two lists of ends matched largest first, as few belts as it takes: [from, to, rate] each. */
function pair(sources: { id: string; rate: number }[], targets: { id: string; rate: number }[]): [string, string, number][] {
  const p = sources.map((x) => ({ ...x })).sort((a, b) => b.rate - a.rate);
  const c = targets.map((x) => ({ ...x })).sort((a, b) => b.rate - a.rate);
  const out: [string, string, number][] = [];
  let i = 0;
  let j = 0;
  while (i < p.length && j < c.length) {
    const rate = Math.min(p[i].rate, c[j].rate);
    if (rate > 1e-4) out.push([p[i].id, c[j].id, rate]);
    p[i].rate -= rate;
    c[j].rate -= rate;
    if (p[i].rate <= 1e-6) i++;
    if (c[j].rate <= 1e-6) j++;
  }
  return out;
}

/**
 * The power grid as a node of its own: every generator feeds it a power line, and it feeds each
 * consumer, so the whole grid reads left to right from fuel to factories.
 */
function addGrid(
  result: SolveResult,
  plants: { id: string; mw: number }[],
  nodes: Node[],
  edges: Edge[],
  consumers: Consumer[],
  box: (size: Box) => Box,
) {
  const grid = result.grid!;
  const drawn = consumers.reduce((s, c) => s + c.mw, 0);
  nodes.push({
    id: 'grid',
    type: 'power',
    position: { x: 0, y: 0 },
    data: { kind: 'grid', label: '', mw: grid.generation, boost: grid.boost, balance: grid.generation - drawn } satisfies PowerNodeData,
    ...box(SIZE.grid),
    handles: [],
  });
  for (const { id, mw } of plants) {
    edges.push({
      id: `${id}>grid`,
      source: id,
      target: 'grid',
      ...ends(`${id}>grid`),
      type: 'power',
      data: { mw } satisfies PowerEdgeData,
    });
  }
  for (const c of consumers) {
    const id = `use:${c.id}`;
    nodes.push({
      id,
      type: 'power',
      position: { x: 0, y: 0 },
      data: { kind: 'consumer', label: c.label, mw: c.mw, tone: c.tone } satisfies PowerNodeData,
      ...box(SIZE.consumer),
      handles: [],
    });
    edges.push({
      id: `grid>${id}`,
      source: 'grid',
      target: id,
      ...ends(`grid>${id}`),
      type: 'power',
      data: { mw: c.mw } satisfies PowerEdgeData,
    });
  }
}
