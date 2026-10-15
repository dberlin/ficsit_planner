import type { Edge, Node } from '@xyflow/react';
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import {
  type Direction,
  type FlowEdgeData,
  type Graph,
  LABEL,
  LINE_TAG,
  type LogisticNodeData,
  lineOf,
  logisticHandles,
  type Port,
  portSize,
  portSpots,
  type PowerEdgeData,
  type Route,
  SPACING,
  setPorts,
  slotsFor,
  spreadPorts,
} from './graph';
import { countCrossings, type EdgeRouting, type Point, type RoutedEdge } from './routes';
import { EFFORT_SEEDS, type LayoutEffort, type LayoutPlacement } from './settings';

/**
 * Lays out one ELK graph: a worker from the pool, or ELK on this thread. `isStale` says a newer layout replaced
 * this one, so an engine with a queue can drop it rather than run it for nothing.
 */
export type Engine = (graph: ElkNode, isStale?: () => boolean) => Promise<ElkNode>;

export interface LayoutOptions {
  /** Fixed direction; without it both are tried against the screen and the better fit wins. */
  dir?: Direction;
  /** The floor the graph is shown on, for picking the direction. */
  box?: { width: number; height: number };
  /** Card size from the settings. */
  scale?: number;
  /** Belt label text size, for the room kept free for labels. */
  text?: number;
  /** Room between machines, 1 = default. */
  spacing?: number;
  placement?: LayoutPlacement;
  routing?: EdgeRouting;
  effort?: LayoutEffort;
}

/** A laid-out floor: cards placed, belts routed, and the direction it runs. */
export interface Floor {
  nodes: Node[];
  edges: Edge[];
  dir: Direction;
}

/** Past this many cards and belts together, one arrangement per direction: each takes seconds on a floor this big. */
const BIG = 400;

/** Gap between belts, and between a belt and a machine, before spacing and card size. */
const BELT_GAP = 12;

/** Room along a card's side for each belt meeting it, so belts side by side stay apart. */
const PORT_PITCH = 14;

/** Room between one line of its own and the next. */
const LINE_GAP = 140;

/** How far before its input a belt running back against the flow climbs into it, where its ↺ mark sits. */
const LOOP_STUB = 30;

/**
 * Cards with more belts on one side than fit there grow along that side (taller left to right, wider top to
 * bottom), and say so in `data.side` for the stylesheet. Wide ends take their whole width. Splitters and mergers
 * keep the building's size. New node objects; the built ones are untouched.
 */
function roomForPorts(graph: Graph, dir: Direction): Graph {
  const sides = new Map<string, { in: number[]; out: number[] }>();
  const side = (id: string) => sides.get(id) ?? sides.set(id, { in: [], out: [] }).get(id)!;
  for (const e of graph.edges) {
    side(e.source).out.push(portSize(e, 'from') ?? 0);
    side(e.target).in.push(portSize(e, 'to') ?? 0);
  }
  const room = (sizes: number[] = []) => sizes.reduce((a, b) => a + b, 0) + (sizes.length + 1) * PORT_PITCH;
  const along = dir === 'LR' ? 'height' : 'width';
  const nodes = graph.nodes.map((n) => {
    if (n.type === 'logistic') return n;
    const need = Math.max(room(sides.get(n.id)?.in), room(sides.get(n.id)?.out));
    return need <= (n[along] ?? 0) ? n : { ...n, [along]: need, data: { ...n.data, side: need } };
  });
  return { nodes, edges: graph.edges };
}

/** How ELK lays out a floor: layered, in one direction, with room for belts and their labels, from one random seed. */
export function elkOptions(opts: LayoutOptions, dir: Direction, seed: number): Record<string, string> {
  const gap = (opts.scale ?? 1) * (opts.spacing ?? 1);
  const belt = String(BELT_GAP * gap);
  return {
    'elk.algorithm': 'layered',
    'elk.direction': dir === 'LR' ? 'RIGHT' : 'DOWN',
    'elk.layered.nodePlacement.strategy': opts.placement ?? 'NETWORK_SIMPLEX',
    'elk.edgeRouting': opts.routing ?? 'ORTHOGONAL',
    'elk.layered.edgeRouting.splines.mode': 'CONSERVATIVE',
    // Layer sweeps, then the greedy-switch pass, which ELK otherwise skips past 40 nodes (labels and long belts
    // add hidden nodes that count). Seeds, not ELK's own thoroughness, are how we try harder.
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
    'elk.layered.crossingMinimization.greedySwitch.activationThreshold': '0',
    'elk.layered.cycleBreaking.strategy': 'GREEDY',
    'elk.randomSeed': String(seed),
    'elk.spacing.nodeNode': String(SPACING[dir].nodesep * gap),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(SPACING[dir].ranksep * gap),
    'elk.spacing.edgeEdge': belt,
    'elk.spacing.edgeNode': belt,
    'elk.layered.spacing.edgeEdgeBetweenLayers': belt,
    'elk.layered.spacing.edgeNodeBetweenLayers': belt,
    'elk.edgeLabels.placement': 'CENTER',
    'elk.padding': '[top=30,left=30,bottom=30,right=30]',
  };
}

/** The graph in ELK's terms, for one direction and one random seed. */
export function toElk(graph: Graph, opts: LayoutOptions, dir: Direction, seed: number): ElkNode {
  const text = opts.text ?? 1;
  const label = { width: Math.round(LABEL.width * text), height: Math.round(LABEL.height * text) };
  const [inSide, outSide] = dir === 'LR' ? ['WEST', 'EAST'] : ['NORTH', 'SOUTH'];
  const ports = new Map<string, ElkPort[]>(graph.nodes.map((n) => [n.id, []]));
  // A wide end is a port as long as its belts side by side, so ELK keeps room along the side for all of them.
  const port = (id: string, side: string, size = 0): ElkPort => ({
    id,
    ...(dir === 'LR' ? { width: 0, height: size } : { width: size, height: 0 }),
    layoutOptions: { 'elk.port.side': side },
  });
  for (const e of graph.edges) {
    ports.get(e.source)?.push(port(e.sourceHandle!, outSide, portSize(e, 'from')));
    ports.get(e.target)?.push(port(e.targetHandle!, inSide, portSize(e, 'to')));
  }
  return {
    id: 'root',
    layoutOptions: elkOptions(opts, dir, seed),
    children: graph.nodes.map((n) => ({
      id: n.id,
      width: n.width,
      height: n.height,
      ports: ports.get(n.id),
      layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
    })),
    edges: graph.edges.map(
      (e): ElkExtendedEdge => ({
        id: e.id,
        sources: [e.sourceHandle!],
        targets: [e.targetHandle!],
        // ELK skips a label with no text, keeping no room for it; ours are drawn by the floor, so any text will do.
        labels: [{ id: `${e.id}:label`, text: e.id, ...label }],
      }),
    ),
  };
}

/**
 * Where everything went in one arrangement, apart from what the cards and belts say: kept, so the same factory with
 * other numbers is placed again without laying it out.
 */
export interface Placement {
  dir: Direction;
  routing: EdgeRouting;
  width: number;
  height: number;
  nodes: Map<string, { x: number; y: number; width: number; height: number; side?: number; ports: Port[] }>;
  edges: Map<string, { sourceHandle: string; targetHandle: string; points: Point[]; label: Point; loop?: Point }>;
}

/** In (u, v): u along the flow, v across it, so one rule serves both directions. */
const uvOf =
  (dir: Direction) =>
  (p: Point): [number, number] =>
    dir === 'LR' ? [p.x, p.y] : [p.y, p.x];
const xyOf =
  (dir: Direction) =>
  (u: number, v: number): Point =>
    dir === 'LR' ? { x: u, y: v } : { x: v, y: u };

/**
 * A route with its first point moved to `at`, still leaving the way it did: right-angle belts keep their right angles
 * (their first bend moves with it, or a step is put in), curves bend their first control point by as much.
 */
function moveStart(points: Point[], at: Point, dir: Direction, routing: EdgeRouting): Point[] {
  const uv = uvOf(dir);
  const xy = xyOf(dir);
  const pts = points.map((p) => ({ ...p }));
  const [u0, v0] = uv(at);
  if (routing === 'ORTHOGONAL' && pts.length > 1) {
    const [u1, v1] = uv(pts[1]);
    if (pts.length > 2 && Math.abs(u1 - uv(pts[2])[0]) < 0.5) pts[1] = xy(u1, v0);
    else if (Math.abs(v1 - v0) > 0.5) pts.splice(1, 0, xy((u0 + u1) / 2, v0), xy((u0 + u1) / 2, v1));
  } else if (routing === 'SPLINES' && pts.length > 1) {
    pts[1] = { x: pts[1].x + at.x - pts[0].x, y: pts[1].y + at.y - pts[0].y };
  }
  pts[0] = { ...at };
  return pts;
}

/** The arrangement ELK came back with, made the floor's: ports on the cards, splitters' belts on their ends, loops marked. */
function placementOf(graph: Graph, laid: ElkNode, dir: Direction, routing: EdgeRouting): Placement {
  const uv = uvOf(dir);
  const xy = xyOf(dir);
  const placed = new Map((laid.children ?? []).map((c) => [c.id, c]));
  const offsetOf = new Map<string, number>();
  const nodes: Placement['nodes'] = new Map();
  for (const n of graph.nodes) {
    const c = placed.get(n.id);
    const ports: Port[] = (c?.ports ?? []).map((p) => {
      const size = dir === 'LR' ? (p.height ?? 0) : (p.width ?? 0);
      const offset = dir === 'LR' ? (p.y ?? 0) + (p.height ?? 0) / 2 : (p.x ?? 0) + (p.width ?? 0) / 2;
      offsetOf.set(p.id, offset);
      return { id: p.id, type: p.id.endsWith(':out') ? 'source' : 'target', offset, ...(size ? { size } : {}) };
    });
    const { side } = n.data as { side?: number };
    nodes.set(n.id, { x: c?.x ?? 0, y: c?.y ?? 0, width: n.width ?? 0, height: n.height ?? 0, ...(side ? { side } : {}), ports });
  }
  const routed = new Map((laid.edges ?? []).map((e) => [e.id, e as ElkExtendedEdge]));
  const edges: Placement['edges'] = new Map();
  for (const e of graph.edges) {
    const s = routed.get(e.id)?.sections?.[0];
    if (!s) continue;
    const points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x, y: p.y }));
    const l = routed.get(e.id)?.labels?.[0];
    const label = l ? { x: (l.x ?? 0) + (l.width ?? 0) / 2, y: (l.y ?? 0) + (l.height ?? 0) / 2 } : points[Math.floor(points.length / 2)];
    edges.set(e.id, { sourceHandle: e.sourceHandle!, targetHandle: e.targetHandle!, points, label });
  }

  // A splitter or merger has its ends where the building has them: each belt takes the one in the order ELK put it
  // along the side, so belts leaving one side don't cross, and its route is moved onto that end.
  for (const n of graph.nodes) {
    if (n.type !== 'logistic') continue;
    const d = n.data as LogisticNodeData;
    const at = nodes.get(n.id)!;
    const along = dir === 'LR' ? at.height : at.width;
    const [u, v] = uv(at);
    const [du] = uv({ x: at.width, y: at.height });
    for (const end of ['in', 'out'] as const) {
      const mine = graph.edges
        .filter((e) => (end === 'in' ? e.target : e.source) === n.id && edges.has(e.id))
        .sort(
          (a, b) =>
            (offsetOf.get(end === 'in' ? a.targetHandle! : a.sourceHandle!) ?? 0) -
            (offsetOf.get(end === 'in' ? b.targetHandle! : b.sourceHandle!) ?? 0),
        );
      const total = end === 'in' ? d.ins : d.outs;
      slotsFor(mine.length, total).forEach((slot, i) => {
        const r = edges.get(mine[i].id)!;
        const spot = xy(end === 'in' ? u : u + du, v + portSpots(total)[slot] * along);
        if (end === 'in') {
          r.targetHandle = `i${slot}`;
          r.points = moveStart([...r.points].reverse(), spot, dir, routing).reverse();
        } else {
          r.sourceHandle = `o${slot}`;
          r.points = moveStart(r.points, spot, dir, routing);
        }
      });
    }
    at.ports = [];
  }

  // Belts that run back against the flow (water out of a later machine into an earlier one) are marked, with the spot
  // just before their input where they climb into it.
  const kind = new Map(graph.edges.map((e) => [e.id, e.type]));
  for (const e of graph.edges) {
    const r = edges.get(e.id);
    if (!r || kind.get(e.id) !== 'flow') continue;
    const [s, t] = [nodes.get(e.source)!, nodes.get(e.target)!];
    const out = uv(s)[0] + uv({ x: s.width, y: s.height })[0];
    const into = uv(t)[0];
    if (into > out) continue;
    const end = uv(r.points.at(-1)!);
    r.loop = xy(end[0] - LOOP_STUB, end[1]);
  }
  return { dir, routing, width: laid.width ?? 0, height: laid.height ?? 0, nodes, edges };
}

/** The built graph placed as `p` has it: new node and edge objects, the built ones untouched. */
function applyPlacement(graph: Graph, p: Placement): Floor {
  const nodes = graph.nodes.map((n) => {
    const at = p.nodes.get(n.id);
    const node: Node = {
      ...n,
      position: { x: at?.x ?? 0, y: at?.y ?? 0 },
      width: at?.width ?? n.width,
      height: at?.height ?? n.height,
      ...(at?.side ? { data: { ...n.data, side: at.side } } : {}),
    };
    if (n.type === 'logistic') node.handles = logisticHandles(node, p.dir);
    else
      setPorts(
        node,
        (at?.ports ?? []).map((x) => ({ ...x })),
        p.dir,
      );
    return node;
  });
  const pos = new Map(nodes.map((n) => [n.id, n.position]));
  const edges = graph.edges.map((e) => {
    const r = p.edges.get(e.id);
    if (!r) return { ...e };
    const route: Route = {
      points: r.points.map((x) => ({ ...x })),
      label: { ...r.label },
      from: { ...pos.get(e.source)! },
      to: { ...pos.get(e.target)! },
      routing: p.routing,
      ...(r.loop ? { loop: { ...r.loop } } : {}),
    };
    return {
      ...e,
      sourceHandle: r.sourceHandle,
      targetHandle: r.targetHandle,
      data: { ...(e.data as FlowEdgeData | PowerEdgeData), route },
    };
  });
  return { nodes, edges, dir: p.dir };
}

/** The floor's belts as routed lines, for counting crossings. */
export function routesOf(floor: Floor): RoutedEdge[] {
  return floor.edges.flatMap((e) => {
    const route = (e.data as FlowEdgeData | PowerEdgeData | undefined)?.route;
    return route ? [{ source: e.source, target: e.target, points: route.points }] : [];
  });
}

/** The run with the fewest crossing belts, the earlier one on a tie. With one run there is nothing to count. */
export function fewestCrossings<T extends { floor: Floor }>(runs: T[]): T {
  if (runs.length === 1) return runs[0];
  return runs.map((run) => ({ run, crossings: countCrossings(routesOf(run.floor)) })).reduce((a, b) => (b.crossings < a.crossings ? b : a))
    .run;
}

/** Arrangements already made, by everything they are made from. */
const placements = new Map<string, Placement>();
const MAX_PLACEMENTS = 64;

export function forgetPlacements() {
  placements.clear();
}

/**
 * What an arrangement in one direction is made from: the cards (ids and sizes), the belts between them and how wide
 * their ends are, and the options that shape the layout. The screen's size isn't part of it, as it only decides
 * between the directions afterwards. Changing a number leaves all of this as it was.
 */
function keyOf(graph: Graph, opts: LayoutOptions, dir: Direction): string {
  return [
    dir,
    opts.scale ?? 1,
    opts.spacing ?? 1,
    opts.text ?? 1,
    opts.placement ?? 'NETWORK_SIMPLEX',
    opts.routing ?? 'ORTHOGONAL',
    opts.effort ?? 'balanced',
    graph.nodes.map((n) => `${n.id}:${n.width}x${n.height}`).join(','),
    graph.edges.map((e) => `${e.id}>${e.source}>${e.target}:${portSize(e, 'from') ?? 0}/${portSize(e, 'to') ?? 0}`).join(','),
  ].join('|');
}

function remember(key: string, p: Placement) {
  placements.set(key, p);
  if (placements.size > MAX_PLACEMENTS) placements.delete(placements.keys().next().value as string);
}

/** The fewest-crossing arrangement in one direction, from each seed the effort allows, all at once. */
async function arrangeIn(graph: Graph, opts: LayoutOptions, dir: Direction, engine: Engine, isStale?: () => boolean): Promise<Placement> {
  const key = keyOf(graph, opts, dir);
  const hit = placements.get(key);
  if (hit) return hit;
  const sized = roomForPorts(graph, dir);
  const routing = opts.routing ?? 'ORTHOGONAL';
  const tries = graph.nodes.length + graph.edges.length > BIG ? 1 : EFFORT_SEEDS[opts.effort ?? 'balanced'];
  const seeds = Array.from({ length: tries }, (_, i) => i + 1);
  const runs = await Promise.all(
    seeds.map(async (seed) => {
      const placement = placementOf(sized, await engine(toElk(sized, opts, dir, seed), isStale), dir, routing);
      return { placement, floor: applyPlacement(sized, placement) };
    }),
  );
  const best = fewestCrossings(runs).placement;
  remember(key, best);
  return best;
}

const dirsFor = ({ dir, box }: LayoutOptions): Direction[] => (dir ? [dir] : box ? ['LR', 'TB'] : ['LR']);

/**
 * Between directions, the one that shows the whole factory bigger on this screen, unless it's only slightly better
 * than the way the screen is shaped.
 */
function choose(placed: Placement[], { box }: LayoutOptions): Placement {
  const natural: Direction = box && box.height > box.width ? 'TB' : 'LR';
  const fit = (p: Placement) => (box ? Math.min(box.width / p.width, box.height / p.height) : 1);
  return placed.reduce((a, b) => {
    const [x, y] = a.dir === natural ? [a, b] : [b, a];
    return fit(y) > fit(x) * 1.2 ? y : x;
  });
}

/** A factory's lines of their own, each with its tag; none when it's built as one. */
function linesOf(graph: Graph): { tag: Node; graph: Graph }[] {
  return graph.nodes
    .filter((n) => n.type === 'line')
    .map((tag) => {
      const i = Number(tag.id.slice('line:'.length));
      return {
        tag,
        graph: { nodes: graph.nodes.filter((n) => lineOf(n.id) === i), edges: graph.edges.filter((e) => lineOf(e.id) === i) },
      };
    });
}

/** Lines laid out apart stood one after the other: down the page left to right, side by side top to bottom, each with room above for its tag. */
function stack(floors: Floor[], tags: Node[], dir: Direction): Floor {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let cursor = 0;
  floors.forEach((f, i) => {
    const box = {
      minX: Math.min(...f.nodes.map((n) => n.position.x)),
      minY: Math.min(...f.nodes.map((n) => n.position.y)),
      maxX: Math.max(...f.nodes.map((n) => n.position.x + (n.width ?? 0))),
      maxY: Math.max(...f.nodes.map((n) => n.position.y + (n.height ?? 0))),
    };
    const [dx, dy] = dir === 'LR' ? [-box.minX, cursor + LINE_TAG.room - box.minY] : [cursor - box.minX, LINE_TAG.room - box.minY];
    cursor += (dir === 'LR' ? box.maxY - box.minY : box.maxX - box.minX) + LINE_GAP + LINE_TAG.room;
    const at = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
    nodes.push({ ...tags[i], position: at({ x: box.minX, y: box.minY - LINE_TAG.room }) });
    for (const n of f.nodes) nodes.push({ ...n, position: at(n.position) });
    for (const e of f.edges) {
      const data = e.data as FlowEdgeData | PowerEdgeData;
      const route = data.route && {
        ...data.route,
        points: data.route.points.map(at),
        label: at(data.route.label),
        from: at(data.route.from),
        to: at(data.route.to),
        ...(data.route.loop ? { loop: at(data.route.loop) } : {}),
      };
      edges.push({ ...e, data: { ...data, route } });
    }
  });
  return { nodes, edges, dir };
}

/**
 * Lays the graph out with each seed the effort allows, in each allowed direction, all at once. Within a direction
 * the fewest crossing belts wins (the lower seed on a tie); between directions, the one that shows the whole
 * factory bigger on this screen, unless it's only slightly better than the way the screen is shaped. Lines of their
 * own are laid out apart, all in the direction the first one picked unless the player chose, and stood one after the
 * other. An arrangement made before for the same cards and belts is placed again without laying anything out.
 */
export async function layoutGraph(graph: Graph, opts: LayoutOptions, engine: Engine, isStale?: () => boolean): Promise<Floor> {
  const one = async (g: Graph, o: LayoutOptions) =>
    applyPlacement(g, choose(await Promise.all(dirsFor(o).map((d) => arrangeIn(g, o, d, engine, isStale))), o));
  const lines = linesOf(graph);
  if (!lines.length) return one(graph, opts);
  const first = await one(lines[0].graph, opts);
  const rest = await Promise.all(lines.slice(1).map((l) => one(l.graph, { ...opts, dir: first.dir })));
  return stack(
    [first, ...rest],
    lines.map((l) => l.tag),
    first.dir,
  );
}

/** The floor `layoutGraph` would come back with, when everything it needs was laid out before; undefined otherwise. */
export function cachedLayout(graph: Graph, opts: LayoutOptions): Floor | undefined {
  const one = (g: Graph, o: LayoutOptions) => {
    const placed = dirsFor(o).map((d) => placements.get(keyOf(g, o, d)));
    return placed.every((p) => p) ? applyPlacement(g, choose(placed as Placement[], o)) : undefined;
  };
  const lines = linesOf(graph);
  if (!lines.length) return one(graph, opts);
  const first = one(lines[0].graph, opts);
  if (!first) return undefined;
  const rest = lines.slice(1).map((l) => one(l.graph, { ...opts, dir: first.dir }));
  if (rest.some((f) => !f)) return undefined;
  return stack(
    [first, ...(rest as Floor[])],
    lines.map((l) => l.tag),
    first.dir,
  );
}

/** When no layout engine works: cards in a plain grid in build order, belts as plain paths between their handles. */
export function gridLayout(built: Graph, dir: Direction): Floor {
  const graph = roomForPorts(built, dir);
  const cols = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)));
  const cellW = Math.max(0, ...graph.nodes.map((n) => n.width ?? 0)) + 80;
  const cellH = Math.max(0, ...graph.nodes.map((n) => n.height ?? 0)) + 80;
  const nodes = graph.nodes.map((n, i) => ({ ...n, position: { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH } }));
  spreadPorts(nodes, graph.edges, dir);
  // A splitter's or merger's belts take its ends in turn.
  const edges = graph.edges.map((e) => ({ ...e }));
  for (const n of nodes) {
    if (n.type !== 'logistic') continue;
    const d = n.data as LogisticNodeData;
    const ins = edges.filter((e) => e.target === n.id);
    const outs = edges.filter((e) => e.source === n.id);
    slotsFor(ins.length, d.ins).forEach((slot, i) => {
      ins[i].targetHandle = `i${slot}`;
    });
    slotsFor(outs.length, d.outs).forEach((slot, i) => {
      outs[i].sourceHandle = `o${slot}`;
    });
  }
  return { nodes, edges, dir };
}
