import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Database } from '../src/data/database';
import {
  aggregatePolicyRuns,
  computePolicyScenarioFingerprint,
  createPolicyArtifact,
  createSeedManifest,
  deriveManifestSeed,
  DeterministicHeuristicPolicy,
  evaluatePolicyManifest,
  runClosedLoopPolicy,
  validateSeedManifest,
} from './global-policy';
import { loadSolverProject } from './project-loader';
import { DEFAULT_POLICY } from './simulator';
import type {
  BenchmarkFingerprint,
  ClosedLoopPolicy,
  PolicyObservation,
  PolicySeedRun,
  SolverMetrics,
  SolverResult,
  SolverScenario,
} from './types';

const projectPath = 'lt-maker/default.ltproj';
const dummyFingerprint: BenchmarkFingerprint = {
  version: 1,
  scenarioSha256: 'a'.repeat(64),
  projectDataSha256: 'b'.repeat(64),
  engineSourceSha256: 'c'.repeat(64),
  instanceSha256: 'd'.repeat(64),
};

test('seed manifests are deterministic, split-specific, immutable, and reject filtering', () => {
  const scenario = { name: 'Fixture', levelNid: 'x' } as SolverScenario;
  const train = createSeedManifest(scenario, dummyFingerprint, 'train', 6);
  const repeated = createSeedManifest(scenario, dummyFingerprint, 'train', 6);
  const validation = createSeedManifest(scenario, dummyFingerprint, 'validation', 6);

  assert.deepEqual(train, repeated);
  assert.notDeepEqual(train.seeds, validation.seeds);
  assert.equal(train.seeds[3], deriveManifestSeed(dummyFingerprint.instanceSha256, 'train', 3));
  validateSeedManifest(train, dummyFingerprint, 'train');
  assert.throws(
    () => validateSeedManifest({ ...train, seeds: train.seeds.slice(1) }, dummyFingerprint, 'train'),
    /changed, reordered, filtered|fingerprint mismatch/,
  );
  assert.throws(
    () => validateSeedManifest(train, dummyFingerprint, 'test'),
    /Expected a test seed manifest/,
  );
});

test('global scoring follows the required lexicographic aggregate order', () => {
  const runs: PolicySeedRun[] = [
    policyRun(0, 10, true, 0, 5, 4, 20),
    policyRun(1, 11, true, 1, 30, 6, 40),
    policyRun(2, 12, false, 0, 10, 8, 50),
  ];
  const { aggregate, score } = aggregatePolicyRuns(runs);
  assert.deepEqual(score, [1, 1, 1, 30, 30, 15, 6, 110 / 3]);
  assert.equal(aggregate.failedClears, 1);
  assert.equal(aggregate.seedsWithDeaths, 1);
  assert.equal(aggregate.totalDeaths, 1);
  assert.equal(aggregate.worstDamage, 30);
  assert.equal(aggregate.cvar95Damage, 30);
});

test('closed-loop policy receives no seed, RNG state, simulator, or future rolls', {
  skip: !existsSync(projectPath),
}, async () => {
  const { db, scenario } = await loadChapter3();
  const delegate = new DeterministicHeuristicPolicy(DEFAULT_POLICY);
  const observedKeys = new Set<string>();
  let observations = 0;
  const spy: ClosedLoopPolicy = {
    kind: 'deterministic-heuristic',
    deterministic: true,
    weights: DEFAULT_POLICY,
    selectAction(observation) {
      observations++;
      collectKeys(observation, observedKeys);
      assert.equal(isDeepFrozen(observation), true);
      return delegate.selectAction(observation);
    },
  };

  const first = runClosedLoopPolicy(db, scenario, spy);
  const second = runClosedLoopPolicy(db, scenario, new DeterministicHeuristicPolicy(DEFAULT_POLICY));
  assert.ok(observations > 1);
  assert.ok(first.plan && first.plan.length > 0);
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.plan, second.plan);
  assert.deepEqual(
    [...observedKeys].filter((key) => /seed|rng|future|roll|simulator/i.test(key)),
    [],
  );
});

test('parallel global evaluator runs and reports every immutable manifest seed', {
  skip: !existsSync(projectPath),
  timeout: 120_000,
}, async () => {
  const { db, scenario } = await loadChapter3();
  const fingerprint = await computePolicyScenarioFingerprint(scenario, projectPath);
  const manifest = createSeedManifest(scenario, fingerprint, 'validation', 3);
  const policy = createPolicyArtifact(DEFAULT_POLICY, fingerprint);
  const report = await evaluatePolicyManifest(db, projectPath, scenario, manifest, policy, { workers: 2 });

  assert.equal(report.runs.length, manifest.seeds.length);
  assert.deepEqual(report.runs.map((run) => run.seed), manifest.seeds);
  assert.equal(report.aggregate.seeds, manifest.seeds.length);
  assert.equal(report.aggregate.clears + report.aggregate.failedClears, manifest.seeds.length);
  assert.ok(report.runs.every((run) => run.result?.plan && run.result.plan.length > 0));
});

async function loadChapter3(): Promise<{ db: Database; scenario: SolverScenario }> {
  const scenario = JSON.parse(
    await readFile('solver/scenarios/chapter-3.json', 'utf8'),
  ) as SolverScenario;
  const { db } = await loadSolverProject(projectPath);
  return { db, scenario };
}

function policyRun(
  index: number,
  seed: number,
  cleared: boolean,
  deaths: number,
  damage: number,
  turns: number,
  actions: number,
): PolicySeedRun {
  const metrics: SolverMetrics = {
    cleared,
    lost: false,
    turns,
    actions,
    combats: 0,
    damageTaken: damage,
    healingReceived: 0,
    playerDeaths: deaths,
    enemiesDefeated: 0,
    wallsBroken: 0,
    remainingPlayerHp: 0,
    remainingEnemyHp: 0,
  };
  return {
    index,
    seed,
    status: cleared ? 'clear' : 'failed',
    result: { metrics } as SolverResult,
  };
}

function collectKeys(value: unknown, keys: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    collectKeys(item, keys);
  }
}

function isDeepFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isDeepFrozen);
}
