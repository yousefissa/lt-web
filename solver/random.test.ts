import assert from 'node:assert/strict';
import test from 'node:test';
import { SeededRandom } from '../src/engine/random';

test('SeededRandom produces stable independent streams', () => {
  const first = new SeededRandom(115);
  const second = new SeededRandom(115);
  const third = new SeededRandom(116);
  const a = Array.from({ length: 8 }, () => first.next());
  const b = Array.from({ length: 8 }, () => second.next());
  const c = Array.from({ length: 8 }, () => third.next());
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.every((value) => value >= 0 && value < 1));
});
