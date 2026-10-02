import { expect, test } from 'bun:test';
import { cleanSettings } from '../src/lib/sanitize';
import { DEFAULT_SETTINGS } from '../src/lib/settings';

test('layout settings default to network simplex, square belts, balanced', () => {
  expect(DEFAULT_SETTINGS.layoutPlacement).toBe('NETWORK_SIMPLEX');
  expect(DEFAULT_SETTINGS.autoBelts).toBe('square');
  expect(DEFAULT_SETTINGS.layoutEffort).toBe('balanced');
});

test('saved layout settings are kept when known and defaulted when not', () => {
  const kept = cleanSettings({ layoutPlacement: 'BRANDES_KOEPF', autoBelts: 'straight', layoutEffort: 'thorough' });
  expect([kept.layoutPlacement, kept.autoBelts, kept.layoutEffort]).toEqual(['BRANDES_KOEPF', 'straight', 'thorough']);
  const junk = cleanSettings({ layoutPlacement: 'DAGRE', autoBelts: 7, layoutEffort: null });
  expect([junk.layoutPlacement, junk.autoBelts, junk.layoutEffort]).toEqual(['NETWORK_SIMPLEX', 'square', 'balanced']);
});

test('machine clocks default to single and keep average when saved', () => {
  expect(DEFAULT_SETTINGS.clockSpread).toBe('single');
  expect(cleanSettings({ clockSpread: 'average' }).clockSpread).toBe('average');
  expect(cleanSettings({ clockSpread: 'even' }).clockSpread).toBe('single');
});
