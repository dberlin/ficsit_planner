import { expect, test } from 'bun:test';
import { countCrossings, routeSvgPath } from '../src/lib/routes';

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
