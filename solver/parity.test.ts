import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { diffParityStates } from '../src/engine/parity';
import { loadSolverProject } from './project-loader';
import { TacticalSimulator } from './simulator';
import type { SolverScenario } from './types';

const projectPath = 'lt-maker/default.ltproj';

test('parity snapshots are clone-stable and report field-level drift', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile('solver/scenarios/chapter-5.json', 'utf8')) as SolverScenario;
  const { db } = await loadSolverProject(projectPath);
  const simulator = new TacticalSimulator(db, scenario);
  simulator.beginPlayerTurn();
  const expected = simulator.getParityState();
  const actual = simulator.clone(false).getParityState();

  assert.deepEqual(diffParityStates(expected, actual), []);
  actual.units[0].hp--;
  const differences = diffParityStates(expected, actual);
  assert.equal(differences.length, 1);
  assert.match(differences[0].path, /units\[0\]\.hp/);
});
