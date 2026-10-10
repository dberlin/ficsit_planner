import type { Edge, Node } from '@xyflow/react';
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import {
  type Direction,
  endSize,
  type FlowEdgeData,
  LABEL,
  LINE_TAG,
  type LogisticNodeData,
  type Port,
  type PowerEdgeData,
  portSpots,
  type Route,
  SPACING,
  setLogisticHandles,
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

type Graph = { nodes: Node[]; edges: Edge[] };

/** A floor laid out in one direction, with how big it came out. */
type Run = { floor: Floor; width: number; height: number };

/** Past this many cards and belts together, one arrangement per direction: each takes seconds on a floor this big. */
const BIG = 400;

/** Gap between belts, and between a belt and a machine, before spacing and card size. */
const BELT_GAP = 12;

/** Room along a card's side for each belt meeting it, so belts side by side stay apart. */
const PORT_PITCH = 14;

/** About as big as a loop's label draws: "Alumina Solution 60/min back to Aluminum Scrap" and its belt's Mk. */
const LOOP_LABEL = { width: 440, height: 44 };

/** Room between one line of its own and the next. */
const LINE_GAP = 140;

/**
 * Cards with more belts on one side than fit there grow along that side (taller left to right, wider top to
 * bottom), and say so in `data.side` for the stylesheet. New node objects; the built ones are untouched.
 */
function roomForPorts(graph: Graph, dir: Direction): Graph {
  const ins = new Map<string, number>();
  const outs = new Map<string, number>();
  for (const e of graph.edges) {
    outs.set(e.source, (outs.get(e.source) ?? 0) + endSize(e, 'from') + PORT_PITCH);
    ins.set(e.target, (ins.get(e.target) ?? 0) + endSize(e, 'to') + PORT_PITCH);
  }
  const along = dir === 'LR' ? 'height' : 'width';
  const nodes = graph.nodes.map((n) => {
    // A splitter's ends are fixed by the building.
    if (n.type === 'logistic') return n;
    const need = Math.max(ins.get(n.id) ?? 0, outs.get(n.id) ?? 0) + PORT_PITCH;
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
    // A belt running back to an earlier machine goes round the cards, not back through them.
    'elk.layered.feedbackEdges': 'true',
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

/**
 * The graph in ELK's terms, for one direction and one random seed. `loops` are the belts that run back round the cards,
 * whose labels say where they go back to and need more room.
 */
export function toElk(graph: Graph, opts: LayoutOptions, dir: Direction, seed: number, loops?: Set<string>): ElkNode {
  const text = opts.text ?? 1;
  const size = (s: { width: number; height: number }) => ({ width: Math.round(s.width * text), height: Math.round(s.height * text) });
  const [inSide, outSide] = dir === 'LR' ? ['WEST', 'EAST'] : ['NORTH', 'SOUTH'];
  const ports = new Map<string, ElkPort[]>(graph.nodes.map((n) => [n.id, []]));
  // Belts side by side go in through a port as wide as they are.
  const port = (id: string, side: string, size: number): ElkPort => ({
    id,
    ...(dir === 'LR' ? { width: 0, height: size } : { width: size, height: 0 }),
    layoutOptions: { 'elk.port.side': side },
  });
  for (const e of graph.edges) {
    ports.get(e.source)?.push(port(e.sourceHandle!, outSide, endSize(e, 'from')));
    ports.get(e.target)?.push(port(e.targetHandle!, inSide, endSize(e, 'to')));
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
        labels: [{ id: `${e.id}:label`, text: e.id, ...size(loops?.has(e.id) ? LOOP_LABEL : LABEL) }],
      }),
    ),
  };
}

/**
 * A route moved to end at `to` instead: the run into it stays straight at right angles (a straight belt gets a step
 * halfway), and a curve's nearest control point moves with it.
 */
function snapEnd(points: Point[], end: 'start' | 'end', to: Point, dir: Direction, routing: EdgeRouting): Point[] {
  const pts = points.map((p) => ({ ...p }));
  const i = end === 'start' ? 0 : pts.length - 1;
  const j = end === 'start' ? 1 : pts.length - 2;
  const shift = { x: to.x - pts[i].x, y: to.y - pts[i].y };
  pts[i] = { ...to };
  if (routing === 'POLYLINE' || pts.length < 2) return pts;
  if (routing === 'SPLINES' || pts.length > 2) {
    pts[j] = dir === 'LR' ? { ...pts[j], y: pts[j].y + shift.y } : { ...pts[j], x: pts[j].x + shift.x };
    return pts;
  }
  const [a, b] = pts;
  if (dir === 'LR' ? Math.abs(a.y - b.y) < 0.5 : Math.abs(a.x - b.x) < 0.5) return pts;
  const mid = dir === 'LR' ? (a.x + b.x) / 2 : (a.y + b.y) / 2;
  return dir === 'LR' ? [a, { x: mid, y: a.y }, { x: mid, y: b.y }, b] : [a, { x: a.x, y: mid }, { x: b.x, y: mid }, b];
}

/** The built graph placed as ELK laid it out: new node and edge objects, the built ones untouched. */
export function fromElk(graph: Graph, laid: ElkNode, dir: Direction, routing: EdgeRouting, text = 1): Floor {
  const placed = new Map((laid.children ?? []).map((c) => [c.id, c]));
  const along = (p: { x?: number; y?: number; width?: number; height?: number }) =>
    dir === 'LR' ? (p.y ?? 0) + (p.height ?? 0) / 2 : (p.x ?? 0) + (p.width ?? 0) / 2;
  // A splitter's belts each take one of its fixed ends, in the order ELK put them along the side: the handle each takes,
  // and where that end sits on the floor.
  const fixed = new Map<string, { handle: string; at: Point }>();
  const nodes = graph.nodes.map((n) => {
    const c = placed.get(n.id);
    const node: Node = { ...n, position: { x: c?.x ?? 0, y: c?.y ?? 0 } };
    if (n.type === 'logistic') {
      const d = n.data as LogisticNodeData;
      const [w, h] = [n.width ?? 0, n.height ?? 0];
      for (const [side, total] of [
        ['in', d.ins],
        ['out', d.outs],
      ] as const) {
        const mine = (c?.ports ?? []).filter((p) => p.id.endsWith(`:${side}`)).sort((a, b) => along(a) - along(b));
        const spots = portSpots(total);
        slotsFor(mine.length, total).forEach((slot, i) => {
          const u = side === 'in' ? 0 : dir === 'LR' ? w : h;
          const at =
            dir === 'LR'
              ? { x: node.position.x + u, y: node.position.y + spots[slot] * h }
              : { x: node.position.x + spots[slot] * w, y: node.position.y + u };
          fixed.set(mine[i].id, { handle: `${side === 'in' ? 'i' : 'o'}${slot}`, at });
        });
      }
      setLogisticHandles(node, dir);
      return node;
    }
    const ports: Port[] = (c?.ports ?? []).map((p) => ({
      id: p.id,
      type: p.id.endsWith(':out') ? 'source' : 'target',
      offset: along(p),
      size: dir === 'LR' ? p.height : p.width,
    }));
    if (n.type !== 'line') setPorts(node, ports, dir);
    return node;
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const routed = new Map((laid.edges ?? []).map((e) => [e.id, e as ElkExtendedEdge]));
  // How far along the floor's flow a card's output and input sides are.
  const outAt = (n: Node) => (dir === 'LR' ? n.position.x + (n.width ?? 0) : n.position.y + (n.height ?? 0));
  const inAt = (n: Node) => (dir === 'LR' ? n.position.x : n.position.y);
  const edges = graph.edges.map((e) => {
    const out = fixed.get(e.sourceHandle!);
    const into = fixed.get(e.targetHandle!);
    const ends = { ...(out ? { sourceHandle: out.handle } : {}), ...(into ? { targetHandle: into.handle } : {}) };
    const r = routed.get(e.id);
    const s = r?.sections?.[0];
    if (!r || !s) return { ...e, ...ends };
    let points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x, y: p.y }));
    if (out) points = snapEnd(points, 'start', out.at, dir, routing);
    if (into) points = snapEnd(points, 'end', into.at, dir, routing);
    const l = r.labels?.[0];
    const label = l ? { x: (l.x ?? 0) + (l.width ?? 0) / 2, y: (l.y ?? 0) + (l.height ?? 0) / 2 } : points[Math.floor(points.length / 2)];
    const [from, to] = [byId.get(e.source)!, byId.get(e.target)!];
    // A belt into a machine no further along than the one it leaves runs back round the cards: marked where it turns in.
    const back = e.type === 'flow' && inAt(to) <= outAt(from) && points.length > 2;
    const route: Route = { points, label, from: from.position, to: to.position, routing, ...(back ? { loop: points.at(-2)! } : {}) };
    return { ...e, ...ends, data: { ...(e.data as FlowEdgeData | PowerEdgeData), route } };
  });
  placeLoopLabels(nodes, edges, text);
  return { nodes, edges, dir };
}

type Rect = { x: number; y: number; w: number; h: number };
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** How far from its belt a label still reads as that belt's. */
const BESIDE = 40;

/** How far a point is from a straight run. */
function distance(p: Point, a: Point, b: Point): number {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Where along a run a label may sit, most wanted first. */
const ALONG = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9];

/**
 * A loop's label says where the belt goes back to, so it's wider than the room ELK keeps for a label. It slides along
 * the loop's runs to where it covers least: the cards, the other belts' labels, and the loops' labels put down before.
 */
function placeLoopLabels(nodes: Node[], edges: Edge[], text: number) {
  const loops = edges.filter((e) => (e.data as FlowEdgeData | undefined)?.route?.loop);
  if (!loops.length) return;
  const box = (p: Point, size: { width: number; height: number }): Rect => ({
    x: p.x - (size.width * text) / 2,
    y: p.y - (size.height * text) / 2,
    w: size.width * text,
    h: size.height * text,
  });
  const cards: Rect[] = nodes.map((n) => ({ x: n.position.x - 4, y: n.position.y - 4, w: (n.width ?? 0) + 8, h: (n.height ?? 0) + 8 }));
  const taken: Rect[] = edges.flatMap((e) => {
    const route = (e.data as FlowEdgeData | PowerEdgeData | undefined)?.route;
    return route && !route.loop ? [box(route.label, LABEL)] : [];
  });
  for (const e of loops) {
    const route = (e.data as FlowEdgeData).route!;
    const runs = route.points.slice(1).map((b, i) => [route.points[i], b] as const);
    const long = runs.filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) > 30);
    // The spot ELK kept for it first, if that's beside the belt (on a floor running down it can be far off), then
    // along its runs.
    const along = (long.length ? long : runs).flatMap(([a, b]) =>
      ALONG.map((t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })),
    );
    const spots = runs.some(([a, b]) => distance(route.label, a, b) < BESIDE * text) ? [route.label, ...along] : along;
    let best: { p: Point; cost: number } | undefined;
    for (const p of spots) {
      const r = box(p, LOOP_LABEL);
      const cost = [...cards, ...taken].reduce((sum, c) => sum + overlap(r, c), 0);
      if (!best || cost < best.cost) best = { p, cost };
    }
    if (!best) continue;
    route.label = best.p;
    taken.push(box(best.p, LOOP_LABEL));
  }
}

/** The floor's belts as routed lines, for counting crossings. */
export function routesOf(floor: Floor): RoutedEdge[] {
  return floor.edges.flatMap((e) => {
    const route = (e.data as FlowEdgeData | PowerEdgeData | undefined)?.route;
    return route ? [{ source: e.source, target: e.target, points: route.points }] : [];
  });
}

/** The lines of a factory built as lines of their own: each one's heading, cards and belts. Undefined for one line. */
function linesOf(graph: Graph): { tag: Node; graph: Graph }[] | undefined {
  const tags = graph.nodes.filter((n) => n.type === 'line');
  if (!tags.length) return undefined;
  return tags.map((tag) => {
    const prefix = `L${tag.id.slice('line:'.length)}:`;
    return {
      tag,
      graph: { nodes: graph.nodes.filter((n) => n.id.startsWith(prefix)), edges: graph.edges.filter((e) => e.source.startsWith(prefix)) },
    };
  });
}

/** A floor moved by (dx, dy): new node and edge objects, routes and all. */
function shift(floor: Floor, dx: number, dy: number): Floor {
  const at = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  return {
    dir: floor.dir,
    nodes: floor.nodes.map((n) => ({ ...n, position: at(n.position) })),
    edges: floor.edges.map((e) => {
      const d = e.data as FlowEdgeData | PowerEdgeData | undefined;
      const r = d?.route;
      if (!r) return e;
      const route: Route = {
        ...r,
        points: r.points.map(at),
        label: at(r.label),
        from: at(r.from),
        to: at(r.to),
        ...(r.loop ? { loop: at(r.loop) } : {}),
      };
      return { ...e, data: { ...d, route } };
    }),
  };
}

/** The box round a floor's cards. */
function bounds(nodes: Node[]) {
  return {
    minX: Math.min(...nodes.map((n) => n.position.x)),
    minY: Math.min(...nodes.map((n) => n.position.y)),
    maxX: Math.max(...nodes.map((n) => n.position.x + (n.width ?? 0))),
    maxY: Math.max(...nodes.map((n) => n.position.y + (n.height ?? 0))),
  };
}

/**
 * Lines laid out apart, standing one after the other: down the page on a floor running right, side by side on one
 * running down, each with its heading above it.
 */
function stack(lines: { tag: Node; run: Run }[], dir: Direction): Run {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let cursor = 0;
  for (const { tag, run } of lines) {
    if (!run.floor.nodes.length) continue;
    const box = bounds(run.floor.nodes);
    const [dx, dy] = dir === 'LR' ? [-box.minX, cursor + LINE_TAG.room - box.minY] : [cursor - box.minX, LINE_TAG.room - box.minY];
    cursor += (dir === 'LR' ? box.maxY - box.minY : box.maxX - box.minX) + LINE_GAP + LINE_TAG.room;
    const moved = shift(run.floor, dx, dy);
    nodes.push({ ...tag, position: { x: box.minX + dx, y: box.minY + dy - LINE_TAG.room } }, ...moved.nodes);
    edges.push(...moved.edges);
  }
  const all = bounds(nodes);
  return { floor: { nodes, edges, dir }, width: all.maxX - all.minX, height: all.maxY - all.minY };
}

/**
 * Lays the graph out with each seed the effort allows, in each allowed direction, all at once. Within a direction
 * the fewest crossing belts wins (the lower seed on a tie); between directions, the one that shows the whole
 * factory bigger on this screen, unless it's only slightly better than the way the screen is shaped. A factory built
 * as lines of their own has each line laid out apart, and the lines stood one after the other.
 */
export async function layoutGraph(graph: Graph, opts: LayoutOptions, engine: Engine, isStale?: () => boolean): Promise<Floor> {
  const { dir, box } = opts;
  const natural: Direction = box && box.height > box.width ? 'TB' : 'LR';
  const dirs: Direction[] = dir ? [dir] : box ? ['LR', 'TB'] : ['LR'];
  const tries = graph.nodes.length + graph.edges.length > BIG ? 1 : EFFORT_SEEDS[opts.effort ?? 'balanced'];
  const seeds = Array.from({ length: tries }, (_, i) => i + 1);
  const routing = opts.routing ?? 'ORTHOGONAL';
  const once = async (g: Graph, d: Direction): Promise<Run> => {
    const sized = roomForPorts(g, d);
    const runs = await Promise.all(
      seeds.map(async (seed) => {
        let laid = await engine(toElk(sized, opts, d, seed), isStale);
        let floor = fromElk(sized, laid, d, routing, opts.text);
        // Belts that came out running back get room for their longer labels: laid out again from the same seed, which
        // turns the same belts round.
        const loops = new Set(floor.edges.filter((e) => (e.data as FlowEdgeData | undefined)?.route?.loop).map((e) => e.id));
        if (loops.size) {
          laid = await engine(toElk(sized, opts, d, seed, loops), isStale);
          floor = fromElk(sized, laid, d, routing, opts.text);
        }
        return { floor, width: laid.width ?? 0, height: laid.height ?? 0 };
      }),
    );
    return fewestCrossings(runs);
  };
  const lines = linesOf(graph);
  const best = await Promise.all(
    dirs.map(async (d) =>
      lines ? stack(await Promise.all(lines.map(async (l) => ({ tag: l.tag, run: await once(l.graph, d) }))), d) : once(graph, d),
    ),
  );
  const fit = (p: { width: number; height: number }) => (box ? Math.min(box.width / p.width, box.height / p.height) : 1);
  return best.reduce((a, b) => {
    const [x, y] = a.floor.dir === natural ? [a, b] : [b, a];
    return fit(y) > fit(x) * 1.2 ? y : x;
  }).floor;
}

/** The run with the fewest crossing belts, the earlier one on a tie. With one run there is nothing to count. */
export function fewestCrossings<T extends { floor: Floor }>(runs: T[]): T {
  if (runs.length === 1) return runs[0];
  return runs.map((run) => ({ run, crossings: countCrossings(routesOf(run.floor)) })).reduce((a, b) => (b.crossings < a.crossings ? b : a))
    .run;
}

/** When no layout engine works: cards in a plain grid in build order, belts as plain curves between their handles. */
export function gridLayout(built: Graph, dir: Direction): Floor {
  const graph = roomForPorts(built, dir);
  const cols = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)));
  const cellW = Math.max(0, ...graph.nodes.map((n) => n.width ?? 0)) + 80;
  const cellH = Math.max(0, ...graph.nodes.map((n) => n.height ?? 0)) + 80;
  const nodes = graph.nodes.map((n, i) => ({ ...n, position: { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH } }));
  const edges = graph.edges.map((e) => ({ ...e }));
  spreadPorts(nodes, edges, dir);
  return { nodes, edges, dir };
}
