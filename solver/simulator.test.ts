import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadSolverProject } from './project-loader';
import { TacticalSimulator } from './simulator';
import type { PolicyWeights, SolverMetrics, SolverScenario } from './types';

const projectPath = 'lt-maker/default.ltproj';
const scenarioPath = 'solver/scenarios/chapter-3.json';

test('Chapter 3 baseline clears deterministically through real engine systems', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8')) as SolverScenario;
  const { db } = await loadSolverProject(projectPath);
  const first = new TacticalSimulator(db, scenario).run();
  const second = new TacticalSimulator(db, scenario).run();

  assert.equal(first.metrics.cleared, true);
  assert.equal(first.metrics.wallsBroken, 3);
  assert.deepEqual(first.score, second.score);
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(
    first.replay.map((step) => step.description),
    second.replay.map((step) => step.description),
  );
});

test('saved Chapter 3 seed-selected solution remains a zero-damage clear', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8')) as SolverScenario;
  const saved = JSON.parse(await readFile('solver/solutions/chapter-3.json', 'utf8')) as {
    seed: number;
    policy: PolicyWeights;
    metrics: SolverMetrics;
    score: number[];
  };
  scenario.seed = saved.seed;
  const { db } = await loadSolverProject(projectPath);
  const result = new TacticalSimulator(db, scenario, saved.policy).run();

  assert.deepEqual(result.score, saved.score);
  assert.deepEqual(result.metrics, saved.metrics);
  assert.equal(result.metrics.damageTaken, 0);
  assert.equal(result.metrics.playerDeaths, 0);
  assert.equal(result.metrics.cleared, true);
});
