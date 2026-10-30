import { describe, expect, test } from 'bun:test';
import { data } from '../src/lib/data';
import { describeUse, NO_MOD } from '../src/lib/solver';

const smelter = data.recipes.find((r) => r.id === 'Recipe_IngotIron_C')!;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('whole machines at 100% and one slower', () => {
  test('6.65 machines: 6 at 100% and one at 65%, the same output as 7 at 95%', () => {
    const average = describeUse(smelter, NO_MOD, 6.65, 'average');
    const single = describeUse(smelter, NO_MOD, 6.65, 'single');
    expect(average.built).toBe(7);
    expect(single.built).toBe(7);
    expect(single.clocks.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(single.clocks[6]).toBeCloseTo(0.65, 6);
    expect(sum(single.clocks)).toBeCloseTo(sum(average.clocks), 6);
    expect(single.spread).toBe('single');
    expect(average.spread).toBe('average');
  });

  test('a clock the player set stays on every machine', () => {
    const use = describeUse(smelter, { clock: 0.5, sloops: 0 }, 7, 'single');
    expect(use.clocks).toEqual(Array(7).fill(0.5));
    expect(use.spread).toBe('single');
  });

  test('a fractional line keeps its configured lower clock before the last machine', () => {
    const use = describeUse(smelter, { clock: 0.5, sloops: 0 }, 2.5, 'single');
    expect(use.clocks).toEqual([0.5, 0.5, 0.25]);
    expect(use.outputs[0].rate).toBeCloseTo(37.5, 6);
  });

  test('a remainder below 1% borrows from the preceding machine without changing production', () => {
    const use = describeUse(smelter, NO_MOD, 1.001, 'single');
    expect(use.clocks).toEqual([expect.closeTo(0.991, 6), 0.01]);
    expect(use.outputs[0].rate).toBeCloseTo(30.03, 6);
  });

  test('a line that fills its machines is the same either way', () => {
    expect(describeUse(smelter, NO_MOD, 4, 'single').clocks).toEqual([1, 1, 1, 1]);
    expect(describeUse(smelter, NO_MOD, 0.4, 'single').clocks).toEqual([0.4]);
  });
});
