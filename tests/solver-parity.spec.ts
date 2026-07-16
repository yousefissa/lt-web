import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { diffParityStates, type EngineParityState } from '../src/engine/parity';
import { replayPlannedSolution } from '../solver/beam-search';
import { loadSolverProject } from '../solver/project-loader';
import { TacticalSimulator } from '../solver/simulator';
import type { PlannerAction, SolverResult, SolverScenario } from '../solver/types';

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
