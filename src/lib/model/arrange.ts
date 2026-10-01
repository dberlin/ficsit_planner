import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import { LABEL, type Point } from '../graph';
import { elkOptions, type Engine } from '../layout';
import { layoutInBackground } from '../layoutClient';
import { countCrossings } from '../routes';
import { EFFORT_SEEDS } from '../settings';
import { cardSize } from './layout';
import { portsOf } from './ports';
import { isPart, type MLink, type Model } from './types';

/** Where each card goes and each belt's bends: what laying a model out gives, before it's put on the model. */
export interface Arrangement {
  pos: Map<string, Point>;
  pts: Map<string, [number, number][]>;
}

/** Each end's handle id, on the side and at the height the card draws it: inputs left, outputs right, spread evenly. */
const portId = (node: string, side: 'in' | 'out', i: number) => `${node}:${side}${i}`;

/** The model's cards and belts in ELK's terms, for one random seed. */
function toElk(m: Model, links: MLink[], seed: number): ElkNode {
  const parts = m.nodes.filter(isPart);
  return {
    id: 'root',
    layoutOptions: elkOptions({}, 'LR', seed),
    children: parts.map((n) => {
      const { w, h } = cardSize(n);
      const { ins, outs } = portsOf(n);
      const side = (kind: 'in' | 'out', of: number): ElkPort[] =>
        Array.from({ length: of }, (_, i) => ({
          id: portId(n.id, kind, i),
          x: kind === 'in' ? 0 : w,
          y: (h * (i + 1)) / (of + 1),
          width: 0,
          height: 0,
          layoutOptions: { 'elk.port.side': kind === 'in' ? 'WEST' : 'EAST' },
        }));
      return {
        id: n.id,
        width: w,
        height: h,
        ports: [...side('in', ins.length), ...side('out', outs.length)],
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      };
    }),
    edges: links.map(
      (l): ElkExtendedEdge => ({
        id: l.id,
        sources: [portId(l.a, 'out', l.ap)],
        targets: [portId(l.b, 'in', l.bp)],
        // ELK skips a label with no text, keeping no room for it; the floor draws its own.
        labels: [{ id: `${l.id}:label`, text: l.id, ...LABEL }],
      }),
    ),
  };
}

/** One laid-out model: where the cards went, every belt's whole path, and how it scores (lower is better). */
function fromElk(laid: ElkNode, links: MLink[]) {
  const pos = new Map((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
  const paths = new Map(
    (laid.edges ?? []).flatMap((e) => {
      const s = (e as ElkExtendedEdge).sections?.[0];
      return s ? [[e.id, [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x, y: p.y }))] as const] : [];
    }),
  );
  const routed = links.flatMap((l) => {
    const points = paths.get(l.id);
    return points ? [{ source: l.a, target: l.b, points }] : [];
  });
  const length = links.reduce((s, l) => s + Math.abs((pos.get(l.b)?.x ?? 0) - (pos.get(l.a)?.x ?? 0)), 0);
  // A belt across the whole floor reads worse than a crossing or two: every 400 units of belt counts as one crossing.
  return { pos, paths, score: countCrossings(routed) + length / 400 };
}

/**
 * Lays a whole model out afresh, left to right like the Auto floor, with ELK: every card in a column by how far down
 * the line it is, splitters and mergers in columns of their own, miners beside what they feed, and every belt routed
 * at right angles around the cards from the end it leaves to the end it arrives at, with room kept for its label.
 * Several seeds are tried and the fewest crossings, then the shortest belts, win. Notes and boxes aren't placed.
 */
export async function arrangement(m: Model, engine: Engine = layoutInBackground): Promise<Arrangement> {
  const parts = m.nodes.filter(isPart);
  const ids = new Set(parts.map((n) => n.id));
  const links = m.links.filter((l) => ids.has(l.a) && ids.has(l.b));
  if (parts.length === 0) return { pos: new Map(), pts: new Map() };
  const seeds = Array.from({ length: EFFORT_SEEDS.balanced }, (_, i) => i + 1);
  const runs = await Promise.all(seeds.map(async (seed) => fromElk(await engine(toElk(m, links, seed)), links)));
  const best = runs.reduce((a, b) => (b.score < a.score ? b : a));
  const round = (p: Point): [number, number] => [Math.round(p.x), Math.round(p.y)];
  const pts = new Map<string, [number, number][]>();
  for (const [id, points] of best.paths) {
    // The ends are the cards' handles, which the belt is drawn from; a belt with no bends keeps its middle, for the label.
    const bends = points.slice(1, -1);
    const a = points[0];
    const b = points.at(-1)!;
    pts.set(id, (bends.length ? bends : [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]).map(round));
  }
  const pos = new Map([...best.pos].map(([id, p]) => [id, { x: Math.round(p.x), y: Math.round(p.y) }]));
  return { pos, pts };
}

/**
 * Puts an arrangement on a model: the cards it placed move there and their belts take its bends. Cards and belts it
 * doesn't know (added while it was being worked out) stay as they are.
 */
export function applyArrangement(m: Model, a: Arrangement): Model {
  if (a.pos.size === 0) return m;
  return {
    ...m,
    nodes: m.nodes.map((n) => {
      const p = a.pos.get(n.id);
      return p ? { ...n, x: p.x, y: p.y } : n;
    }),
    links: m.links.map((l) => {
      const pts = a.pts.get(l.id);
      if (pts) return { ...l, pts };
      if (!l.pts || (!a.pos.has(l.a) && !a.pos.has(l.b))) return l;
      // A belt between cards that moved, with no route of its own: its old bends would lead nowhere.
      const { pts: _, ...rest } = l;
      return rest;
    }),
  };
}

/** The model laid out afresh: `arrangement` put on it. */
export async function arrangeModel(m: Model, engine?: Engine): Promise<Model> {
  return applyArrangement(m, await arrangement(m, engine));
}
