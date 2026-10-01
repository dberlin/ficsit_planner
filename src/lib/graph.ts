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

export interface EndpointNodeData extends Record<string, unknown> {
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
  /** Where both machines were laid out. Once either is dragged, the belt falls back to a plain curve. */
  from: Point;
  to: Point;
  routing: EdgeRouting;
}

export interface FlowEdgeData extends Record<string, unknown> {
  item: string;
  rate: number;
  transport: Transport;
  /** Belts/pipes side by side when the best unlocked one can't carry it alone. */
  lanes: number;
  route?: Route;
}

/** Where one belt meets a card: its own handle, `offset` along the side (from the top, or the left top to bottom). */
export interface Port {
  id: string;
  type: 'source' | 'target';
  offset: number;
}

/** Handle ids for a belt's two ends. */
const ends = (id: string) => ({ sourceHandle: `${id}:out`, targetHandle: `${id}:in` });

const HANDLE = { width: 8, height: 12 };

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
    if (dir === 'TB') {
      // Same handle turned on its side.
      const flat = { width: HANDLE.height, height: HANDLE.width };
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
      y: p.offset - HANDLE.height / 2,
      ...HANDLE,
    };
  });
}

/** Ports spread evenly along each side in belt order, where nothing has placed them yet. */
export function spreadPorts(nodes: Node[], edges: Edge[], dir: Direction): void {
  for (const n of nodes) {
    const side = dir === 'LR' ? (n.height ?? 0) : (n.width ?? 0);
    const spread = (ids: string[], type: Port['type']) => ids.map((id, i) => ({ id, type, offset: (side * (i + 1)) / (ids.length + 1) }));
    setPorts(
      n,
      [
        ...spread(
          edges.filter((e) => e.target === n.id).map((e) => e.targetHandle!),
          'target',
        ),
        ...spread(
          edges.filter((e) => e.source === n.id).map((e) => e.sourceHandle!),
          'source',
        ),
      ],
      dir,
    );
  }
}

export const SIZE = {
  machine: { width: 310, height: 130 },
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
 * are first split into machine groups, so no belt or pipe between machines carries more than the chosen one can. Positions and
 * ports come from `layoutGraph`.
 */
export function buildGraph(result: SolveResult, tier: number, opts: BuildOptions = {}): { nodes: Node[]; edges: Edge[] } {
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
    for (const [a, b, rate] of pair(sources, targets)) belt(a, b, f.item, rate);
  }

  if (result.grid) addGrid(result, plants, nodes, edges, opts.consumers ?? [], box);

  return { nodes, edges };
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
