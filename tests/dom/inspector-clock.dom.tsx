import { describe, expect, test } from 'bun:test';

import { cleanup, render } from '@testing-library/react';
import { Inspector } from '../../src/components/Inspector';
import { data } from '../../src/lib/data';
import type { ClockSpread } from '../../src/lib/settings';
import { describeUse, NO_MOD, type SolveResult } from '../../src/lib/solver';
import { useStore } from '../../src/store';

const smelter = data.recipes.find((r) => r.id === 'Recipe_IngotIron_C')!;

// One iron line of 6.65 machines: 6 at 100% and one at 65% with "single", 7 at 95% with "average".
const open = (spread: ClockSpread, count = 6.65, clock = 1) => {
  useStore.setState({ inspect: smelter.id });
  const result = {
    recipes: [describeUse(smelter, { ...NO_MOD, clock }, count, spread)],
    raw: [],
    supplies: [],
    targets: [],
    surplus: [],
    missing: [],
  } as unknown as SolveResult;
  return render(<Inspector result={result} />);
};

describe('the clock on a line with a single slower machine', () => {
  test('at 100% and one slower the slider and the field are locked at 100', () => {
    const view = open('single');
    const slider = view.container.querySelector('input[type="range"]') as HTMLInputElement;
    const field = view.container.querySelector('input.rate-input') as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    expect(slider.value).toBe('100');
    expect(field.disabled).toBe(true);
    expect(field.value).toBe('100');
    expect(view.getByText('Single')).toBeTruthy();
    cleanup();
  });

  test('a configured lower clock is shown for a line with one slower machine', () => {
    const view = open('single', 2.5, 0.5);
    const slider = view.container.querySelector('input[type="range"]') as HTMLInputElement;
    const field = view.container.querySelector('input.rate-input') as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    expect(slider.value).toBe('50');
    expect(field.disabled).toBe(true);
    expect(field.value).toBe('50');
    cleanup();
  });

  test('machines spread evenly keep a free clock showing the average', () => {
    const view = open('average');
    const slider = view.container.querySelector('input[type="range"]') as HTMLInputElement;
    const field = view.container.querySelector('input.rate-input') as HTMLInputElement;
    expect(slider.disabled).toBe(false);
    expect(field.disabled).toBe(false);
    expect(slider.value).toBe('95');
    expect(view.queryByText('Single')).toBeNull();
    cleanup();
  });

  test('a whole number of machines, all at 100%, keeps a free clock', () => {
    const view = open('single', 6);
    const slider = view.container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider.disabled).toBe(false);
    expect(slider.value).toBe('100');
    expect(view.queryByText('Single')).toBeNull();
    cleanup();
  });
});
