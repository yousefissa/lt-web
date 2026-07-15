import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { buildStandardEventPlan, inferObjectiveType } from './event-adapter';
import { loadSolverProject } from './project-loader';
import { TacticalSimulator } from './simulator';
import type { SolverScenario } from './types';
import { readFile } from 'node:fs/promises';

const projectPath = 'lt-maker/default.ltproj';

test('Chapter 4 standard event adapter derives rout and both reinforcement rules', {
  skip: !existsSync(projectPath),
}, async () => {
  const { db } = await loadSolverProject(projectPath);
  const level = db.levels.get('4');
  assert.ok(level);
  const plan = buildStandardEventPlan(db, level);

  assert.equal(inferObjectiveType(level, plan.events), 'rout');
  assert.ok(plan.initialCommands.some((command) => command.nid === 'set_stats' && command.args[0] === 'Boss'));
  assert.ok(plan.initialCommands.some((command) => command.nid === 'interact_unit' && command.args[1] === 'Mogall'));
  assert.deepEqual(
    plan.spawnRules.map((rule) => ({ group: rule.groupNid, trigger: rule.trigger })),
    [
      { group: 'RevenantRein', trigger: { type: 'region', regionNid: 'Trigger' } },
      { group: 'Turn2Rein', trigger: { type: 'turn', turn: 2 } },
    ],
  );
});

test('Chapter 4 intro effects leave the scripted Mogall dead and boss configured', {
  skip: !existsSync(projectPath),
}, async () => {
  const scenario = JSON.parse(await readFile('solver/scenarios/chapter-4.json', 'utf8')) as SolverScenario;
  const { db } = await loadSolverProject(projectPath);
  const units = new TacticalSimulator(db, scenario).getInitialUnits();
  const mogall = units.find((unit) => unit.nid === 'Mogall');
  const boss = units.find((unit) => unit.nid === 'Boss');
  const artur = units.find((unit) => unit.nid === 'Artur');

  assert.equal(mogall?.dead, true);
  assert.equal(mogall?.position, null);
  assert.equal(boss?.maxHp, 39);
  assert.deepEqual(artur?.position, [7, 3]);
});
