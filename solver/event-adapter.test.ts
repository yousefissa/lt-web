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

test('standard adapter derives reusable visit, talk, door, chest, and destructible rules', {
  skip: !existsSync(projectPath),
}, async () => {
  const { db } = await loadSolverProject(projectPath);
  const chapter5 = buildStandardEventPlan(db, db.levels.get('5')!);
  assert.deepEqual(
    chapter5.interactionRules.filter((rule) => rule.type === 'visit').map((rule) => rule.regionNid).sort(),
    ['Village1', 'Village2', 'Village3', 'Village4'],
  );
  assert.ok(chapter5.interactionRules.some(
    (rule) => rule.type === 'talk' && rule.actorNid === 'Natasha' && rule.targetNid === 'Joshua',
  ));
  assert.equal(chapter5.interactionRules.filter((rule) => rule.type === 'destructible').length, 4);

  const chapter3 = buildStandardEventPlan(db, db.levels.get('3')!);
  assert.equal(chapter3.interactionRules.filter((rule) => rule.type === 'chest').length, 4);
  assert.equal(chapter3.interactionRules.filter((rule) => rule.type === 'door').length, 3);
});

test('planner interactions consume unlock uses, grant rewards, and recruit directionally', {
  skip: !existsSync(projectPath),
}, async () => {
  const { db } = await loadSolverProject(projectPath);
  const chestScenario: SolverScenario = {
    name: 'Chapter 3 chest fixture',
    levelNid: '3',
    seed: 3,
    maxTurns: 1,
    objective: 'seize',
    eventAdapter: 'standard',
    team: {
      Colm: { level: 3, items: ['Iron_Sword', 'Lockpick'], position: [6, 12] },
    },
  };
  const chestSimulator = new TacticalSimulator(db, chestScenario);
  chestSimulator.beginPlayerTurn();
  const chest = chestSimulator.enumerateLegalActions().find(
    (action) => action.type === 'chest' && action.actor === 'Colm' && action.region === 'Chest1',
  );
  assert.ok(chest);
  chestSimulator.applyPlayerAction(chest);
  const colm = chestSimulator.getResult().finalUnits.find((unit) => unit.nid === 'Colm');
  assert.ok(colm?.items.some((item) => item.nid === 'Javelin'));
  assert.equal(colm?.items.find((item) => item.nid === 'Lockpick')?.uses, 14);
  assert.deepEqual(chestSimulator.getResult().interactions.openedChests, ['Chest1']);

  const chapter5Base: SolverScenario = {
    name: 'Chapter 5 interaction fixture',
    levelNid: '5',
    seed: 5,
    maxTurns: 1,
    objective: 'defeat_boss',
    bossNid: 'Saar',
    eventAdapter: 'standard',
    team: {
      Eirika: { level: 5, items: ['Rapier'], position: [12, 19] },
      Natasha: { level: 1, items: ['Heal'], position: [9, 8] },
    },
  };
  const visitSimulator = new TacticalSimulator(db, chapter5Base);
  visitSimulator.beginPlayerTurn();
  const visit = visitSimulator.enumerateLegalActions().find(
    (action) => action.type === 'visit' && action.actor === 'Eirika' && action.region === 'Village1',
  );
  assert.ok(visit);
  visitSimulator.applyPlayerAction(visit);
  assert.ok(visitSimulator.getResult().finalUnits.find((unit) => unit.nid === 'Eirika')
    ?.items.some((item) => item.nid === 'Dragonshield'));

  const talkSimulator = new TacticalSimulator(db, chapter5Base);
  talkSimulator.beginPlayerTurn();
  const talk = talkSimulator.enumerateLegalActions().find(
    (action) => action.type === 'talk' && action.actor === 'Natasha' && action.target === 'Joshua',
  );
  assert.ok(talk);
  talkSimulator.applyPlayerAction(talk);
  assert.deepEqual(talkSimulator.getResult().interactions.recruitedUnits, ['Joshua']);
});
