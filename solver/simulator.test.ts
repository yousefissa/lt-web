import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  beamSearchFixedSeed,
  createSimulatorFromPlan,
  replayPlannedSolution,
  runGreedyPlannedSolution,
} from './beam-search';
import { loadSolverProject } from './project-loader';
import { proveFixedSeedBound } from './proof-search';
import { searchSeedRangeParallel } from './parallel-search';
import { searchSeedRange } from './search';
import { TacticalSimulator } from './simulator';
import type { PlannerAction, PolicyWeights, SolverMetrics, SolverScenario } from './types';

const projectPath = 'lt-maker/default.ltproj';
const scenarioPath = 'solver/scenarios/chapter-3.json';

test('Chapter 3 default policy runs deterministically through real engine systems', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8')) as SolverScenario;
  const { db } = await loadSolverProject(projectPath);
  const first = new TacticalSimulator(db, scenario).run();
  const second = new TacticalSimulator(db, scenario).run();

  assert.equal(first.metrics.wallsBroken, 3);
  assert.deepEqual(first.score, second.score);
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(
    first.replay.map((step) => step.description),
    second.replay.map((step) => step.description),
  );
});

test('saved Chapter 4 solution replays the event-derived rout exactly', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile('solver/scenarios/chapter-4.json', 'utf8')) as SolverScenario;
  const saved = JSON.parse(await readFile('solver/solutions/chapter-4.json', 'utf8')) as {
    seed: number;
    policy: PolicyWeights;
    metrics: SolverMetrics;
    score: number[];
    plan?: PlannerAction[];
  };
  assert.equal(saved.seed, scenario.seed);
  const { db } = await loadSolverProject(projectPath);
  const result = saved.plan
    ? replayPlannedSolution(db, scenario, saved.policy, saved.plan)
    : new TacticalSimulator(db, scenario, saved.policy).run();

  assert.deepEqual(result.score, saved.score);
  assert.deepEqual(result.metrics, saved.metrics);
  assert.equal(result.objective, 'rout');
  assert.equal(result.metrics.playerDeaths, 0);
  assert.equal(result.metrics.enemiesDefeated + result.metrics.wallsBroken, 23);
});

test('non-benchmark parallel seed diagnostic matches its sequential implementation', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile('solver/scenarios/chapter-4.json', 'utf8')) as SolverScenario;
  const saved = JSON.parse(await readFile('solver/solutions/chapter-4.json', 'utf8')) as {
    policy: PolicyWeights;
  };
  const { db } = await loadSolverProject(projectPath);
  const sequential = searchSeedRange(db, scenario, 0, 7, saved.policy);
  const parallel = await searchSeedRangeParallel(projectPath, scenario, saved.policy, 0, 7, 2);

  assert.equal(parallel.seed, sequential.seed);
  assert.deepEqual(parallel.score, sequential.score);
  assert.deepEqual(parallel.metrics, sequential.metrics);
});

test('saved Chapter 3 fixed-seed solution remains a no-death clear', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8')) as SolverScenario;
  const saved = JSON.parse(await readFile('solver/solutions/chapter-3.json', 'utf8')) as {
    seed: number;
    policy: PolicyWeights;
    metrics: SolverMetrics;
    score: number[];
  };
  assert.equal(saved.seed, scenario.seed);
  const { db } = await loadSolverProject(projectPath);
  const result = new TacticalSimulator(db, scenario, saved.policy).run();

  assert.deepEqual(result.score, saved.score);
  assert.deepEqual(result.metrics, saved.metrics);
  assert.equal(result.metrics.damageTaken, 0);
  assert.equal(result.metrics.playerDeaths, 0);
  assert.equal(result.metrics.cleared, true);
});

test('planner checkpoints clone exact RNG, unit, inventory, and turn state', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8')) as SolverScenario;
  const { db } = await loadSolverProject(projectPath);
  const simulator = new TacticalSimulator(db, scenario);
  simulator.beginPlayerTurn();

  const actions = simulator.enumerateLegalActions({
    maxMovesPerUnit: 2,
    maxAttacksPerUnit: 2,
    maxHealsPerUnit: 1,
  });
  assert.ok(actions.length > 0);
  assert.ok(actions.some((action) => action.type === 'wait'));
  assert.ok(actions.some((action) => action.type === 'move' || action.type === 'attack'));

  const clone = simulator.clone(false);
  assert.deepEqual(clone.createCheckpoint(false), simulator.createCheckpoint(false));
  assert.equal(clone.getTranspositionKey(), simulator.getTranspositionKey());
  assert.equal(clone.getFutureStateKey(), simulator.getFutureStateKey());
  const chosen = actions.find((action) => action.type === 'attack') ?? actions[0];
  simulator.applyPlayerAction(chosen);
  clone.applyPlayerAction(chosen);

  assert.equal(clone.getTranspositionKey(), simulator.getTranspositionKey());
  assert.deepEqual(clone.getResult().metrics, simulator.getResult().metrics);
  assert.deepEqual(clone.getResult().finalUnits, simulator.getResult().finalUnits);
});

test('future-state identity excludes already-paid path cost', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8')) as SolverScenario;
  const { db } = await loadSolverProject(projectPath);
  const simulator = new TacticalSimulator(db, scenario);
  simulator.beginPlayerTurn();
  const checkpoint = simulator.createCheckpoint(false);
  const futureKey = simulator.getFutureStateKey();
  const exactKey = simulator.getTranspositionKey();

  checkpoint.metrics.actions += 3;
  checkpoint.metrics.damageTaken += 4;
  simulator.restoreCheckpoint(checkpoint);

  assert.equal(simulator.getFutureStateKey(), futureKey);
  assert.notEqual(simulator.getTranspositionKey(), exactKey);
  assert.deepEqual(simulator.getSearchCost(), {
    playerDeaths: checkpoint.metrics.playerDeaths,
    damageTaken: checkpoint.metrics.damageTaken,
    actions: checkpoint.metrics.actions,
  });
});

test('planner attacks persist the selected weapon for future counters', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile('solver/scenarios/chapter-4.json', 'utf8')) as SolverScenario;
  const { db } = await loadSolverProject(projectPath);
  const simulator = new TacticalSimulator(db, scenario);
  simulator.beginPlayerTurn();

  const javelinAttack = simulator.enumerateLegalActions({
    maxMovesPerUnit: 8,
    maxAttacksPerUnit: 20,
    maxHealsPerUnit: 2,
  }).find((action) => action.type === 'attack'
    && action.actor === 'Vanessa'
    && action.item === 'Javelin'
    && action.target === 'Snag');
  assert.ok(javelinAttack, 'expected Vanessa to have a legal Javelin attack on the Snag');
  simulator.applyPlayerAction(javelinAttack);

  const vanessa = simulator.getParityState().units.find((unit) => unit.nid === 'Vanessa');
  assert.equal(vanessa?.items[0].nid, 'Slim_Lance', 'equipping must not reorder inventory');
  assert.equal(vanessa?.equippedItemIndex, 1);
});

test('explicit fixed-seed greedy plan matches and replays the Chapter 4 policy', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile('solver/scenarios/chapter-4.json', 'utf8')) as SolverScenario;
  const saved = JSON.parse(await readFile('solver/solutions/chapter-4.json', 'utf8')) as {
    policy: PolicyWeights;
  };
  const { db } = await loadSolverProject(projectPath);
  const legacy = new TacticalSimulator(db, scenario, saved.policy).run();
  const planned = runGreedyPlannedSolution(db, scenario, saved.policy);
  const replayed = replayPlannedSolution(db, scenario, saved.policy, planned.plan!);

  assert.ok(planned.plan && planned.plan.length > 0);
  assert.deepEqual(planned.score, legacy.score);
  assert.deepEqual(planned.metrics, legacy.metrics);
  assert.deepEqual(replayed.score, planned.score);
  assert.deepEqual(replayed.metrics, planned.metrics);
  assert.deepEqual(replayed.finalUnits, planned.finalUnits);
});

test('beam search remains on the scenario seed and returns a replayable incumbent', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8')) as SolverScenario;
  const saved = JSON.parse(await readFile('solver/solutions/chapter-3.json', 'utf8')) as {
    policy: PolicyWeights;
  };
  const { db } = await loadSolverProject(projectPath);
  const searched = beamSearchFixedSeed(db, scenario, saved.policy, {
    beamWidth: 4,
    branchLimit: 4,
    maxNodes: 40,
    maxMovesPerUnit: 1,
    maxAttacksPerUnit: 1,
    maxHealsPerUnit: 1,
  });

  assert.equal(searched.result.seed, scenario.seed);
  assert.equal(searched.result.metrics.cleared, true);
  assert.ok(searched.result.plan && searched.result.plan.length > 0);
  const replayed = replayPlannedSolution(db, scenario, searched.result.policy, searched.result.plan!);
  assert.deepEqual(replayed.score, searched.result.score);
  assert.deepEqual(replayed.metrics, searched.result.metrics);
});

test('proof search distinguishes a found route from an exhausted damage bound', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile('solver/scenarios/chapter-4.json', 'utf8')) as SolverScenario;
  const saved = JSON.parse(await readFile('solver/solutions/chapter-4.json', 'utf8')) as {
    policy: PolicyWeights;
    plan: PlannerAction[];
    metrics: SolverMetrics;
  };
  const { db } = await loadSolverProject(projectPath);
  const prefix = saved.plan.slice(0, -1);
  const prefixSimulator = createSimulatorFromPlan(db, scenario, saved.policy, prefix);
  assert.equal(prefixSimulator.getSearchCost().damageTaken, saved.metrics.damageTaken);

  const found = proveFixedSeedBound(db, scenario, saved.policy, {
    maxNodes: 500,
    maxPlayerDeaths: 0,
    maxDamage: saved.metrics.damageTaken,
  }, prefix);
  assert.equal(found.status, 'found');
  assert.equal(found.result?.metrics.cleared, true);
  assert.equal(found.result?.seed, scenario.seed);

  const infeasible = proveFixedSeedBound(db, scenario, saved.policy, {
    maxNodes: 500,
    maxPlayerDeaths: 0,
    maxDamage: saved.metrics.damageTaken - 1,
  }, prefix);
  assert.equal(infeasible.status, 'infeasible');
  assert.equal(infeasible.stats.exhausted, true);
});

test('saved Chapter 5 fixed-seed plan recruits Joshua and clears without deaths', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile('solver/scenarios/chapter-5.json', 'utf8')) as SolverScenario;
  const saved = JSON.parse(await readFile('solver/solutions/chapter-5.json', 'utf8')) as {
    seed: number;
    policy: PolicyWeights;
    plan: PlannerAction[];
    metrics: SolverMetrics;
    score: number[];
  };
  assert.equal(saved.seed, scenario.seed);
  const { db } = await loadSolverProject(projectPath);
  const result = replayPlannedSolution(db, scenario, saved.policy, saved.plan);

  assert.deepEqual(result.score, saved.score);
  assert.deepEqual(result.metrics, saved.metrics);
  assert.equal(result.metrics.playerDeaths, 0);
  assert.equal(result.metrics.cleared, true);
  assert.deepEqual(result.interactions.recruitedUnits, ['Joshua']);
  assert.equal(result.interactions.requirementsSatisfied, true);
});
