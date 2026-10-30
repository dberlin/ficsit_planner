import { Position, type Edge, type Node, type NodeHandle } from '@xyflow/react';
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
  /** An end for each item the card takes and gives, in the order that keeps its belts from crossing; set once the cards have their places. */
  ends?: CardEnds;
  /** Lines and columns the card grew by, to give every end room for the belts side by side on it. */
  room?: { rows: number; cols: number };
}

/** One end of a machine card: a square on its edge holding the item's icon, with the belts for that item going into it. */
export interface CardEnd {
  /** The belt's per-edge handle id, or a stable id for an item with no belt. */
  id: string;
  /** The item it takes or gives; none for a generator's power line. */
  item?: string;
  /** Where its middle is along its side, as a share of the side. */
  at: number;
  /** How long it is along the side, in floor units: as wide as the belts side by side that meet it. */
  len: number;
}

export interface CardEnds {
  in: CardEnd[];
  out: CardEnd[];
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
  /** The products of the line this card belongs to, when the factory is built as lines of their own. */
  line?: string[];
  kind: EndpointKind;
  item: string;
  rate: number;
  /** One per belt end, placed by the layout. */
  ports?: Port[];
}

/** The belt's path from the layout: around machines, through a spot kept free for its label. */
export interface Route {
  /** The whole path, from the output handle to the input handle. */
  points: Point[];
  label: Point;
  /** Where both machines were laid out. Once either is dragged, the belt falls back to a path between its handles. */
  from: Point;
  to: Point;
  routing: EdgeRouting;
  /** A belt that runs back against the flow: the turn where it climbs into its input. */
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

/**
 * Where one belt meets a card: its own handle, `offset` along the side (from the top, or the left top to bottom) to
 * its middle, and `size` along the side when belts side by side need a wide end.
 */
export interface Port {
  id: string;
  type: 'source' | 'target';
  offset: number;
  size?: number;
}

/** Handle ids for a belt's two ends. */
export const ends = (id: string) => ({ sourceHandle: `${id}:out`, targetHandle: `${id}:in` });

export const HANDLE = { width: 8, height: 12 };

/** The most belts side by side that are drawn as such; past that the label's count says how many. */
export const MAX_LANES = 6;
/** Centre to centre between belts side by side. */
export const LANE_PITCH = 10;

/** How long a card's end is for one belt: as wide as its belts side by side when it has more than one, so they go in parallel. */
export const endLength = (lanes: number) => Math.max(HANDLE.height, Math.min(lanes, MAX_LANES) * LANE_PITCH);

/** Where along its side each of `n` ends of a splitter or merger sits, as a share of the side: one in the middle, three evenly. */
export const portSpots = (n: number): number[] => (n <= 1 ? [0.5] : Array.from({ length: n }, (_, i) => (i + 1) / (n + 1)));

/** Which of `total` ends the `used` ones sit on, in order: one in the middle, two on the outer ends, three on all. */
export const slotsFor = (used: number, total: number): number[] =>
  total <= 1 ? [0] : used === 1 ? [Math.floor(total / 2)] : used === 2 && total === 3 ? [0, 2] : Array.from({ length: used }, (_, i) => i);

/** A card's end is a square this big, kept this far from the next one, and sits this far over the card's side so it is joined to it (card scale 1). */
export const END = 26;
const END_GAP = 8;
const END_LAP = 2;
export const END_REACH = END - END_LAP;
/** The generator's power line among its ends. */
const POWER = 'power';
/** A card that must be wider to hold its ends grows by this much at a time, as it grows by a line for more clock groups. */
const WIDE_STEP = 40;

/** What a machine card gives ends for: the items it takes and gives, in the recipe's order. */
const keysOf = (d: MachineNodeData) => ({
  in: d.use.recipe.inputs.map((s) => s.item),
  out: [...d.use.recipe.outputs.map((s) => s.item), ...(d.use.recipe.kind === 'power' ? [POWER] : [])],
});
/** Which end of its machine a belt (or a generator's power line) is on. */
const keyOf = (e: Edge) => (e.type === 'power' ? POWER : (e.data as FlowEdgeData).item);

/** Most belts side by side any belt of an item has at a card's side. */
function lanesAt(edges: Edge[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges) {
    if (e.type !== 'flow') continue;
    const lanes = Math.min((e.data as FlowEdgeData).lanes, MAX_LANES);
    for (const k of [`${e.source}|o|${keyOf(e)}`, `${e.target}|i|${keyOf(e)}`]) m.set(k, Math.max(m.get(k) ?? 1, lanes));
  }
  return m;
}

/** How long an end is: the belts side by side that meet it, never less than its square. */
const endLen = (lanes: number | undefined, scale: number) => Math.max(END * scale, (lanes ?? 1) * LANE_PITCH);

/** The ends of one card, in the order given, spread along a side of `side` floor units with the same room between them. */
function cardEnds(id: string, order: { in: string[]; out: string[] }, lanes: Map<string, number>, side: number, scale: number): CardEnds {
  const row = (p: 'i' | 'o', keys: string[]): CardEnd[] => {
    const len = keys.map((key) => endLen(key === POWER ? 1 : lanes.get(`${id}|${p}|${key}`), scale));
    const gap = (side - len.reduce((a, b) => a + b, 0)) / (keys.length + 1);
    let from = gap;
    return keys.map((key, i) => {
      const at = (from + len[i] / 2) / side;
      from += len[i] + gap;
      return { id: `${p}${i}`, ...(key === POWER ? {} : { item: key }), at, len: len[i] };
    });
  };
  return { in: row('i', order.in), out: row('o', order.out) };
}

/**
 * Makes a machine card big enough for its ends: every end as long as the belts side by side on it, with room between.
 * It grows by lines (down a floor running right) or columns (across a floor running down), only when it has to.
 */
export function growCards(nodes: Node[], edges: Edge[], box: (size: Box) => Box, scale: number, dir: Direction) {
  const lanes = lanesAt(edges);
  for (const n of nodes) {
    if (n.type !== 'machine') continue;
    const d = n.data as MachineNodeData;
    const keys = keysOf(d);
    const room = (p: 'i' | 'o', list: string[]) =>
      list.reduce(
        (sum, key) => sum + endLen(key === POWER ? 1 : lanes.get(`${n.id}|${p}|${key}`), scale),
        END_GAP * scale * (list.length + 1),
      );
    const need = Math.max(room('i', keys.in), room('o', keys.out));
    const base = cardExtra(d.use, d.split ?? d.part);
    let [rows, cols] = [0, 0];
    while (dir !== 'TB' && box({ ...SIZE.machine, height: SIZE.machine.height + RUN_LINE * (base + rows) }).height < need) rows++;
    while (dir !== 'LR' && box({ ...SIZE.machine, width: SIZE.machine.width + WIDE_STEP * cols }).width < need) cols++;
    if (!rows && !cols) continue;
    const b = box({ width: SIZE.machine.width + WIDE_STEP * cols, height: SIZE.machine.height + RUN_LINE * (base + rows) });
    n.width = b.width;
    n.height = b.height;
    n.data = { ...d, room: { rows, cols } };
  }
}

/**
 * Item ends before layout. Every recipe item gets a port, including an unused byproduct; connected ends keep the
 * belt's unique handle id. ELK chooses their order and offsets together with the routes.
 */
export function machineEnds(nodes: Node[], edges: Edge[], dir: Direction, scale: number): Map<string, CardEnds> {
  const lanes = lanesAt(edges);
  const handles = new Map<string, string>();
  for (const e of edges) {
    handles.set(`${e.source}|o|${keyOf(e)}`, e.sourceHandle!);
    handles.set(`${e.target}|i|${keyOf(e)}`, e.targetHandle!);
  }
  const result = new Map<string, CardEnds>();
  for (const n of nodes) {
    if (n.type !== 'machine') continue;
    const card = cardEnds(n.id, keysOf(n.data as MachineNodeData), lanes, (dir === 'LR' ? n.height : n.width) ?? 0, scale);
    for (const [side, row] of [
      ['i', card.in],
      ['o', card.out],
    ] as const) {
      for (const end of row) {
        const key = `${n.id}|${side}|${end.item ?? POWER}`;
        end.id = handles.get(key) ?? `${key}:unused`;
      }
    }
    result.set(n.id, card);
  }
  return result;
}

/** The visible item squares and React Flow's pre-measured handles use exactly the same geometry. */
export function setCardEnds(node: Node, card: CardEnds, dir: Direction, scale: number): void {
  const ports: Port[] = [];
  for (const [type, row] of [
    ['target', card.in],
    ['source', card.out],
  ] as const) {
    for (const end of row)
      ports.push({ id: end.id, type, offset: end.at * ((dir === 'LR' ? node.height : node.width) ?? 0), size: end.len });
  }
  node.data = { ...node.data, ends: card, ports };
  const down = dir === 'TB';
  const square = END * scale;
  const reach = END_REACH * scale;
  node.handles = [];
  for (const [type, row] of [
    ['target', card.in],
    ['source', card.out],
  ] as const) {
    for (const end of row) {
      const along = end.at * ((down ? node.width : node.height) ?? 0) - end.len / 2;
      const out = type === 'target' ? -reach : ((down ? node.height : node.width) ?? 0) - END_LAP * scale;
      node.handles.push({
        id: end.id,
        type,
        position: down ? (type === 'target' ? Position.Top : Position.Bottom) : type === 'target' ? Position.Left : Position.Right,
        x: down ? along : out,
        y: down ? out : along,
        width: down ? end.len : square,
        height: down ? square : end.len,
      });
    }
  }
}

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
    const length = Math.max(HANDLE.height, p.size ?? 0);
    if (dir === 'TB') {
      // Same handle turned on its side.
      const flat = { width: length, height: HANDLE.width };
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
      y: p.offset - length / 2,
      width: HANDLE.width,
      height: length,
    };
  });
}

/** A splitter's or merger's ends, spread along its sides where the building has them, each with an id its belts name. */
export function logisticHandles(node: Node, dir: Direction): NodeHandle[] {
  const { ins, outs } = node.data as LogisticNodeData;
  const size = { width: node.width ?? 0, height: node.height ?? 0 };
  const down = dir === 'TB';
  const [w, h] = down ? [HANDLE.height, HANDLE.width] : [HANDLE.width, HANDLE.height];
  const list: NodeHandle[] = [];
  for (const [i, at] of portSpots(ins).entries())
    list.push({
      id: `i${i}`,
      type: 'target',
      position: down ? Position.Top : Position.Left,
      x: down ? at * size.width - w / 2 : -w / 2,
      y: down ? -h / 2 : at * size.height - h / 2,
      width: w,
      height: h,
    });
  for (const [i, at] of portSpots(outs).entries())
    list.push({
      id: `o${i}`,
      type: 'source',
      position: down ? Position.Bottom : Position.Right,
      x: down ? at * size.width - w / 2 : size.width - w / 2,
      y: down ? size.height - h / 2 : at * size.height - h / 2,
      width: w,
      height: h,
    });
  return list;
}

/** How long a belt's end is on the card at `end`: wide for belts side by side meeting a card, a plain handle otherwise. */
export function portSize(e: Edge, end: 'from' | 'to'): number | undefined {
  const d = e.data as FlowEdgeData | undefined;
  return d?.wide?.[end] ? endLength(d.lanes) : undefined;
}

/** Ports spread evenly along each side in belt order, where nothing has placed them yet. */
export function spreadPorts(nodes: Node[], edges: Edge[], dir: Direction): void {
  for (const n of nodes) {
    if (n.type === 'logistic') {
      n.handles = logisticHandles(n, dir);
      continue;
    }
    const side = dir === 'LR' ? (n.height ?? 0) : (n.width ?? 0);
    const spread = (list: { id: string; size?: number }[], type: Port['type']) =>
      list.map(({ id, size }, i) => ({ id, type, offset: (side * (i + 1)) / (list.length + 1), ...(size ? { size } : {}) }));
    setPorts(
      n,
      [
        ...spread(
          edges.filter((e) => e.target === n.id).map((e) => ({ id: e.targetHandle!, size: portSize(e, 'to') })),
          'target',
        ),
        ...spread(
          edges.filter((e) => e.source === n.id).map((e) => ({ id: e.sourceHandle!, size: portSize(e, 'from') })),
          'source',
        ),
      ],
      dir,
    );
  }
}

export const SIZE = {
  machine: { width: 310, height: 130 },
  logistic: { width: 96, height: 96 },
  endpoint: { width: 330, height: 100 },
  grid: { width: 300, height: 124 },
  consumer: { width: 260, height: 84 },
};

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
  /**
   * Most a single belt (solids) or pipe (fluids) may carry, per minute. Lines whose flows don't fit are split
   * into groups of whole machines that do, each fed and emptied by its own belts.
   */
  split?: { belt?: number; pipe?: number };
}

export interface LineTagData extends Record<string, unknown> {
  /** The products the line makes. */
  items: string[];
}

/** A factory's cards and belts, before the layout places them. */
export type Graph = { nodes: Node[]; edges: Edge[] };

export const LINE_TAG = { width: 520, height: 60, room: 84 };

/** Which line of its own a node or belt is on, from the `L{i}:` its id starts with. */
export const lineOf = (id: string): number | undefined => {
  const m = /^L(\d+):/.exec(id);
  return m ? Number(m[1]) : undefined;
};

/**
 * The graph of a factory. With products on lines of their own, each line's cards and belts get ids of their own
 * (`L{i}:`) and a tag naming its products, so the layout can stand the lines one after the other. Positions and
 * ports come from `layoutGraph`.
 */
export function buildGraph(result: SolveResult, tier: number, opts: BuildOptions = {}): Graph {
  const lines = result.lines;
  if (!lines || lines.length < 2) return buildGraphOne(result, tier, opts);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const [i, line] of lines.entries()) {
    const g = buildGraphOne({ ...line.result, lines: undefined }, tier, opts);
    const id = (x: string) => `L${i}:${x}`;
    nodes.push({
      id: `line:${i}`,
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
    for (const n of g.nodes) nodes.push({ ...owned(n), id: id(n.id) });
    for (const e of g.edges) edges.push({ ...e, id: id(e.id), source: id(e.source), target: id(e.target), ...ends(id(e.id)) });
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

  addLogistics(nodes, edges, box, tier);
  if (result.grid) addGrid(result, plants, nodes, edges, opts.consumers ?? [], box);
  widenEnds(nodes, edges);
  return { nodes, edges };
}

/**
 * Marks the belts side by side whose ends are a card's, so they get an end as wide as they are and enter the card as
 * a ribbon, not through one point. The ends of splitters and mergers stay small: their belts join there.
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
 * pipes), as a balanced tree of up to three at a time like on the Manual floor, so the floor shows what would be built.
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

  const total = (list: Edge[]) => list.reduce((sum, e) => sum + rateOf(e), 0);
  /** How many branches a splitter or merger over n belts has: up to FAN, and the branches as even in size as can be. */
  const branches = (list: Edge[]): Edge[][] => {
    const k = list.length <= FAN ? list.length : Math.min(FAN, Math.ceil(list.length / FAN));
    const base = Math.floor(list.length / k);
    const extra = list.length % k;
    const parts: Edge[][] = [];
    for (let j = 0, at = 0; j < k; j++) {
      const size = base + (j < extra ? 1 : 0);
      parts.push(list.slice(at, at + size));
      at += size;
    }
    return parts;
  };
  // Splitters: one output going to several places. A balanced tree, as on the Manual floor: no belt waits on a chain of them.
  const split = (feed: string, list: Edge[], item: string, kind: LogisticNodeData['kind']) => {
    const id = logistic(kind, item, total(list), false);
    edges.push(make(feed, id, item, total(list)));
    for (const part of branches(list)) {
      if (part.length === 1) edges.push(make(id, part[0].target, item, rateOf(part[0])));
      else split(id, part, item, kind);
    }
  };
  for (const list of group((e) => `${e.source}|${itemOf(e)}`)) {
    const item = itemOf(list[0]);
    drop(list);
    split(
      list[0].source,
      [...list].sort((a, b) => rateOf(b) - rateOf(a)),
      item,
      pipe(item) ? 'junction' : 'splitter',
    );
  }
  // Mergers: several belts into one input, the same tree the other way round.
  const merge = (into: string, list: Edge[], item: string, kind: LogisticNodeData['kind']) => {
    const id = logistic(kind, item, total(list), true);
    edges.push(make(id, into, item, total(list)));
    for (const part of branches(list)) {
      if (part.length === 1) edges.push(make(part[0].source, id, item, rateOf(part[0])));
      else merge(id, part, item, kind);
    }
  };
  for (const list of group((e) => `${e.target}|${itemOf(e)}`)) {
    const item = itemOf(list[0]);
    drop(list);
    merge(
      list[0].target,
      [...list].sort((a, b) => rateOf(b) - rateOf(a)),
      item,
      pipe(item) ? 'junction' : 'merger',
    );
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
