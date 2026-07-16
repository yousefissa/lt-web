import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { diffParityStates, type EngineParityState } from '../src/engine/parity';
import { replayPlannedSolution } from '../solver/beam-search';
import { loadSolverProject } from '../solver/project-loader';
import { TacticalSimulator } from '../solver/simulator';
import type {
  PlannerAction,
  PolicyEvaluationReport,
  SolverResult,
  SolverScenario,
} from '../solver/types';

const projectPath = 'lt-maker/default.ltproj';

for (const chapter of [4, 5]) {
  test(`fixed-seed Chapter ${chapter} route matches the live engine at every action boundary`, async ({ page }) => {
    test.setTimeout(180_000);
    const scenario = JSON.parse(
      await readFile(`solver/scenarios/chapter-${chapter}.json`, 'utf8'),
    ) as SolverScenario;
    const saved = JSON.parse(
      await readFile(`solver/solutions/chapter-${chapter}.json`, 'utf8'),
    ) as SolverResult;
    expect(saved.plan?.length).toBeGreaterThan(0);
    const { db } = await loadSolverProject(projectPath);
    const route = replayPlannedSolution(db, scenario, saved.policy, saved.plan!);
    expect(route.metrics.cleared).toBe(true);
    expect(route.seed).toBe(scenario.seed);

    const simulator = new TacticalSimulator(db, scenario, saved.policy);
    simulator.beginPlayerTurn();
    const checkpoint = simulator.createCheckpoint(false);

    await page.goto(`/?harness=true&level=${chapter}&bundle=false`);
    await page.waitForFunction(
      () => (window as any).__harness?.ready === true,
      { timeout: 30_000 },
    );
    await page.evaluate((root) => {
      (window as any).__harness.restoreTacticalCheckpoint(root);
    }, checkpoint);

    const initialLive = await page.evaluate(
      () => (window as any).__harness.getParityState() as EngineParityState,
    );
    expect(diffParityStates(simulator.getParityState(), initialLive)).toEqual([]);

    for (let index = 0; index < route.plan!.length; index++) {
      const action = route.plan![index] as PlannerAction;
      simulator.applyPlayerAction(action);
      if (simulator.isPlayerTurnComplete() && !simulator.isTerminal()) {
        simulator.finishTurn();
        if (!simulator.isTerminal()) simulator.beginPlayerTurn();
      }
      let liveResult: any;
      try {
        liveResult = await page.evaluate((plannerAction) => {
          return (window as any).__harness.executePlannerAction(plannerAction);
        }, action);
      } catch (error) {
        throw new Error(
          `Chapter ${chapter} live replay failed after action ${index + 1}: ${JSON.stringify(action)}`,
          { cause: error },
        );
      }
      const live = liveResult.state as EngineParityState;
      const differences = diffParityStates(simulator.getParityState(), live);
      if (differences.length > 0) {
        console.log('live planner trace', JSON.stringify(liveResult.trace, null, 2));
        console.log('live AI actions', JSON.stringify(liveResult.aiActions, null, 2));
      }
      expect(
        differences,
        `Chapter ${chapter} parity drift after action ${index + 1}: ${JSON.stringify(action)}`,
      ).toEqual([]);
    }
  });
}

test('Chapter 3 global-policy representative seeds match the live engine at every action boundary', async ({ page }) => {
  test.setTimeout(300_000);
  const baseScenario = JSON.parse(
    await readFile('solver/scenarios/chapter-3.json', 'utf8'),
  ) as SolverScenario;
  const report = JSON.parse(
    await readFile('solver/results/global/chapter-3/trained-test.json', 'utf8'),
  ) as PolicyEvaluationReport;
  const requested = [
    report.representatives.typicalSeed,
    report.representatives.worstSuccessfulSeed,
    report.representatives.failedSeed,
  ].filter((seed, index, seeds): seed is number => seed !== undefined && seeds.indexOf(seed) === index);
  expect(requested.length).toBeGreaterThanOrEqual(2);
  const { db } = await loadSolverProject(projectPath);

  for (const seed of requested) {
    const run = report.runs.find((candidate) => candidate.seed === seed);
    expect(run?.result?.plan?.length, `seed ${seed} must have a replayable closed-loop plan`).toBeGreaterThan(0);
    const route = run!.result!;
    const scenario = { ...baseScenario, seed };
    const simulator = new TacticalSimulator(db, scenario, route.policy);
    simulator.beginPlayerTurn();
    const checkpoint = simulator.createCheckpoint(false);

    await page.goto('/?harness=true&level=3&bundle=false');
    await page.waitForFunction(
      () => (window as any).__harness?.ready === true,
      { timeout: 30_000 },
    );
    await page.evaluate((root) => {
      (window as any).__harness.restoreTacticalCheckpoint(root);
    }, checkpoint);
    const initialLive = await page.evaluate(
      () => (window as any).__harness.getParityState() as EngineParityState,
    );
    expect(diffParityStates(simulator.getParityState(), initialLive), `seed ${seed} initial state`).toEqual([]);

    for (let index = 0; index < route.plan!.length; index++) {
      const action = route.plan![index] as PlannerAction;
      simulator.applyPlayerAction(action);
      if (simulator.isPlayerTurnComplete() && !simulator.isTerminal()) {
        simulator.finishTurn();
        if (!simulator.isTerminal()) simulator.beginPlayerTurn();
      }
      const liveResult = await page.evaluate((plannerAction) => {
        return (window as any).__harness.executePlannerAction(plannerAction);
      }, action);
      let expected = simulator.getParityState();
      const crossedEvaluationBudget = index === route.plan!.length - 1
        && !route.metrics.cleared
        && simulator.getCurrentTurn() > scenario.maxTurns;
      if (crossedEvaluationBudget) {
        // maxTurns is an evaluator cutoff, not live-engine state. The solver
        // intentionally stops after the other phase, whereas the live engine
        // enters the next player phase and resets living player action flags.
        expected = {
          ...expected,
          phase: 'player',
          units: expected.units.map((unit) => unit.team === 'player' && !unit.dead
            ? {
              ...unit,
              hasAttacked: false,
              hasMoved: false,
              hasTraded: false,
              finished: false,
            }
            : unit),
        };
      }
      const differences = diffParityStates(expected, liveResult.state as EngineParityState);
      if (differences.length > 0) {
        console.log('global policy trace', JSON.stringify(liveResult.trace, null, 2));
        console.log('global policy AI actions', JSON.stringify(liveResult.aiActions, null, 2));
      }
      expect(
        differences,
        `seed ${seed} parity drift after action ${index + 1}: ${JSON.stringify(action)}`,
      ).toEqual([]);
    }
  }
});
