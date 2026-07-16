import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { benchmarkFingerprintsEqual, computeBenchmarkFingerprint } from './benchmark';
import type { SolverScenario } from './types';

const projectPath = 'lt-maker/default.ltproj';

test('benchmark fingerprint binds gameplay inputs and project data but ignores notes', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile('solver/scenarios/chapter-5.json', 'utf8')) as SolverScenario;
  const first = await computeBenchmarkFingerprint(scenario, projectPath);
  const renamed = await computeBenchmarkFingerprint({
    ...scenario,
    name: 'Display-only rename',
    notes: ['Display-only note'],
  }, projectPath);
  const changedSeed = await computeBenchmarkFingerprint({ ...scenario, seed: scenario.seed + 1 }, projectPath);

  assert.equal(benchmarkFingerprintsEqual(first, renamed), true);
  assert.equal(first.projectDataSha256, changedSeed.projectDataSha256);
  assert.equal(first.engineSourceSha256, changedSeed.engineSourceSha256);
  assert.notEqual(first.scenarioSha256, changedSeed.scenarioSha256);
  assert.notEqual(first.instanceSha256, changedSeed.instanceSha256);
});
