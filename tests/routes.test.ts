import { expect, test } from 'bun:test';
import { Position } from '@xyflow/react';
import { arrival, arrowHead, countCrossings, edgePath, handlePath, routeSvgPath } from '../src/lib/routes';
import { turnFor } from '../src/components/floor/squarePath';

const p = (x: number, y: number) => ({ x, y });

test('polyline routes are straight segments', () => {
  expect(routeSvgPath([p(0, 0), p(10, 0), p(10, 10)], 'POLYLINE')).toBe('M0,0 L10,0 L10,10');
});

test('orthogonal routes round their corners, never more than half the shorter run', () => {
  // Runs of 100 and 8: the corner radius is capped at 4, not the usual 12.
  expect(routeSvgPath([p(0, 0), p(100, 0), p(100, 8)], 'ORTHOGONAL')).toBe('M0,0 L96,0 Q100,0 100,4 L100,8');
  expect(routeSvgPath([p(0, 0), p(100, 0), p(100, 100)], 'ORTHOGONAL')).toBe('M0,0 L88,0 Q100,0 100,12 L100,100');
});

test('spline routes are chains of cubic curves through ELK control points', () => {
  expect(routeSvgPath([p(0, 0), p(5, 0), p(5, 10), p(10, 10)], 'SPLINES')).toBe('M0,0 C5,0 5,10 10,10');
  // Control points that don't come in threes: drawn straight rather than guessed at.
  expect(routeSvgPath([p(0, 0), p(5, 5), p(10, 10)], 'SPLINES')).toBe('M0,0 L5,5 L10,10');
});

test('crossings: a real crossing counts once, touching at a shared machine does not, parallel runs do not', () => {
  const across = { source: 'a', target: 'b', points: [p(0, 0), p(10, 10)] };
  const back = { source: 'c', target: 'd', points: [p(0, 10), p(10, 0)] };
  expect(countCrossings([across, back])).toBe(1);
  const sameSource = { source: 'a', target: 'e', points: [p(0, 10), p(10, 0)] };
  expect(countCrossings([across, sameSource])).toBe(0);
  const parallel = { source: 'f', target: 'g', points: [p(0, 1), p(10, 11)] };
  expect(countCrossings([across, parallel])).toBe(0);
  // Each crossing segment pair counts: an S-bend crossing a straight run twice is 2.
  const s = { source: 'h', target: 'i', points: [p(0, 5), p(4, -5), p(8, 5)] };
  const flat = { source: 'j', target: 'k', points: [p(-1, 0), p(9, 0)] };
  expect(countCrossings([s, flat])).toBe(2);
});

test('a belt arrives heading along its last run, ignoring repeated end points', () => {
  // Back-edges arrive heading left, against the flow of the floor.
  expect(arrival([p(100, 0), p(100, 50), p(0, 50)])).toEqual({ at: p(0, 50), dir: p(-1, 0) });
  expect(arrival([p(0, 0), p(0, 30), p(0, 30)])).toEqual({ at: p(0, 30), dir: p(0, 1) });
});

test('the arrowhead tips at the end of the belt, its base set back along the way it came', () => {
  // Heading right into (100,50): base 10 back, 6 either side.
  expect(arrowHead({ at: p(100, 50), dir: p(1, 0) }, 10, 12)).toBe('100,50 90,56 90,44');
});

test('a laid-out belt arrives along its route; a moved one along the fallback', () => {
  const route = { points: [p(0, 0), p(50, 0), p(50, 20)], label: p(25, 0), from: p(0, 0), to: p(40, 20), routing: 'ORTHOGONAL' as const };
  const fallback = (): [string, number, number, ReturnType<typeof arrival>] => ['M', 0, 0, { at: p(9, 9), dir: p(-1, 0) }];
  expect(edgePath(route, p(0, 0), p(40, 20), fallback)[3]).toEqual({ at: p(50, 20), dir: p(0, 1) });
  expect(edgePath(route, p(0, 0), p(80, 20), fallback)[3]).toEqual({ at: p(9, 9), dir: p(-1, 0) });
});

test('active ELK belts take lane-wide turns and ease a small across-flow step without folded corners', () => {
  const radius = turnFor(6, 10);
  for (const down of [false, true]) {
    const at = (u: number, v: number) => (down ? p(v, u) : p(u, v));
    const route = {
      points: [at(0, 0), at(200, 0), at(200, 8), at(400, 8)],
      label: at(200, 4),
      from: p(0, 0),
      to: p(400, 0),
      routing: 'ORTHOGONAL' as const,
    };
    const [path, , , end] = edgePath(
      route,
      route.from,
      route.to,
      () => { throw new Error('unexpected fallback'); },
      { radius, down },
    );
    expect(path).toContain('C');
    expect(path).not.toContain('Q');
    expect(end).toEqual({ at: at(400, 8), dir: at(1, 0) });
    const turn = routeSvgPath([at(0, 0), at(200, 0), at(200, 200)], 'ORTHOGONAL', radius);
    const arc = [...turn.matchAll(/Q([-\d.,]+) ([-\d.,]+)/g)][0];
    expect(arc).toBeDefined();
    const corner = arc[1].split(',').map(Number);
    const exit = arc[2].split(',').map(Number);
    expect(Math.hypot(exit[0] - corner[0], exit[1] - corner[1])).toBeGreaterThan(25);
  }
});

test('forward ELK paths never overshoot their handles after endpoint offsets, in every shape and direction', () => {
  for (const down of [false, true]) {
    const at = (u: number, v: number) => (down ? p(v, u) : p(u, v));
    for (const routing of ['ORTHOGONAL', 'POLYLINE', 'SPLINES'] as const) {
      const points = routing === 'SPLINES'
        ? [at(0, 0), at(310, 0), at(310, 100), at(300, 100)]
        : [at(0, 0), at(-10, 0), at(310, 0), at(310, 100), at(300, 100)];
      const original = points.map((point) => ({ ...point }));
      const route = { points, routing, label: at(150, 50), from: p(0, 0), to: p(300, 0) };
      const [path, lx, ly, end] = edgePath(
        route,
        route.from,
        route.to,
        () => { throw new Error('unexpected fallback'); },
        { radius: turnFor(6, 10), down },
      );
      // All endpoints and controls advance along the flow; their Béziers therefore cannot double back.
      const along = [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[down ? 2 : 1]));
      expect(along[0]).toBe(0);
      expect(along.at(-1)).toBe(300);
      expect(along.every((u, i) => i === 0 || u >= along[i - 1])).toBe(true);
      expect(end).toEqual({ at: at(300, 100), dir: at(1, 0) });
      expect(route.points).toEqual(original);
      expect([lx, ly]).toEqual(down ? [50, 150] : [150, 50]);
    }
  }
});

test('drag fallback keeps wide small-step belts eased and arrows pointing into either floor direction', () => {
  for (const down of [false, true]) {
    const e = {
      sourceX: 0, sourceY: 0, targetX: down ? 8 : 400, targetY: down ? 400 : 8,
      sourcePosition: down ? Position.Bottom : Position.Right,
      targetPosition: down ? Position.Top : Position.Left,
    };
    for (const routing of ['ORTHOGONAL', 'POLYLINE', 'SPLINES'] as const) {
      const [path, , , end] = handlePath(routing, e, turnFor(6, 10));
      expect(path).not.toContain('NaN');
      if (routing === 'ORTHOGONAL') {
        expect(path).toContain('C');
        expect(path).not.toContain('Q');
      }
      expect(end.at).toEqual(p(e.targetX, e.targetY));
      if (routing !== 'POLYLINE') expect(end.dir).toEqual(down ? p(0, 1) : p(1, 0));
    }
  }
});

test('intentional back routes keep their detour and arrival direction', () => {
  const route = {
    points: [p(300, 0), p(350, 0), p(350, 100), p(-50, 100), p(-50, 0), p(0, 0)],
    routing: 'ORTHOGONAL' as const, label: p(150, 100), from: p(300, 0), to: p(0, 0), loop: p(-30, 0),
  };
  const [path, , , end] = edgePath(route, route.from, route.to, () => { throw new Error('unexpected fallback'); }, { radius: turnFor(6, 10), down: false });
  expect(path).toContain('350,100');
  expect(path).toContain('-50,0');
  expect(end).toEqual({ at: p(0, 0), dir: p(1, 0) });
});
