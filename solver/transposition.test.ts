import assert from 'node:assert/strict';
import test from 'node:test';
import { DominanceTranspositionTable, dominates } from './transposition';

test('dominance transposition table keeps only Pareto-minimal path costs', () => {
  const table = new DominanceTranspositionTable();
  assert.equal(table.consider('same-future', { playerDeaths: 0, damageTaken: 9, actions: 12 }), 'accepted');
  assert.equal(table.consider('same-future', { playerDeaths: 0, damageTaken: 9, actions: 12 }), 'duplicate');
  assert.equal(table.consider('same-future', { playerDeaths: 0, damageTaken: 10, actions: 13 }), 'dominated');
  assert.equal(table.consider('same-future', { playerDeaths: 0, damageTaken: 8, actions: 11 }), 'improved');
  assert.equal(table.consider('same-future', { playerDeaths: 0, damageTaken: 7, actions: 14 }), 'accepted');
  assert.equal(table.stateCount, 1);
  assert.equal(table.labelCount, 2);
});

test('death priority does not let a lower-damage death dominate survival', () => {
  assert.equal(
    dominates(
      { playerDeaths: 1, damageTaken: 0, actions: 4 },
      { playerDeaths: 0, damageTaken: 20, actions: 8 },
    ),
    false,
  );
});
