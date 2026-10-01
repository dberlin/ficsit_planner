import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });

// React takes whatever an effect returns as its clean-up and calls it. An effect written as `useEffect(() => call())`
// returns the call's result: the store's `set`, for one, returns its save to storage (a promise) in the browser, and
// the screen breaks with "destroy is not a function" the moment the component closes. Bun has no storage, so only a
// browser shows it; this keeps the shape out. Clean-ups (`() => () => …`) and block bodies are fine.
test('no effect returns the value of what it calls', () => {
  const src = path.join(import.meta.dir, '..', 'src');
  const found = files(src).flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => (/useEffect\(\(\) => (?![{(])/.test(line) ? [`${path.relative(src, file)}:${i + 1}`] : [])),
  );
  expect(found).toEqual([]);
});
