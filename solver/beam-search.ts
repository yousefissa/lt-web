import { performance } from 'node:perf_hooks';
import type { Database } from '../src/data/database';
import { DEFAULT_POLICY, TacticalSimulator } from './simulator';
import type {
  BeamSearchOptions,
  BeamSearchResult,
  BeamSearchStats,
  PlannerAction,
  PolicyWeights,
  SolverResult,
  SolverScenario,
} from './types';

export const DEFAULT_BEAM_OPTIONS: BeamSearchOptions = {
  beamWidth: 32,
  branchLimit: 12,
  maxNodes: 30_000,
  maxMovesPerUnit: 4,
  maxAttacksPerUnit: 4,
  maxHealsPerUnit: 2,
  includeWait: true,
};

interface BeamNode {
  simulator: TacticalSimulator;
  plan: PlannerAction[];
  score: number[];
  heuristic: number;
  guide: boolean;
}

/** Search one immutable scenario seed. No code path mutates or scans the seed. */
export function beamSearchFixedSeed(
  db: Database,
  scenario: SolverScenario,
  policy: PolicyWeights = DEFAULT_POLICY,
  requested: Partial<BeamSearchOptions> = {},
): BeamSearchResult {
  const options: BeamSearchOptions = { ...DEFAULT_BEAM_OPTIONS, ...requested };
  validateOptions(options);
  const started = performance.now();

  let incumbent = runGreedyPlannedSolution(db, scenario, policy);
  const guidePlan = incumbent.plan ?? [];
  let incumbentSource: BeamSearchStats['incumbentSource'] = 'greedy';
  const rootSimulator = new TacticalSimulator(db, scenario, policy);
  rootSimulator.beginPlayerTurn();
  rootSimulator.restoreCheckpoint(rootSimulator.createCheckpoint(false));
  const root: BeamNode = {
    simulator: rootSimulator,
    plan: [],
    score: rootSimulator.getEvaluationScore(),
    heuristic: 0,
    guide: true,
  };
  let frontier: BeamNode[] = [root];
  const transpositions = new Set<string>([rootSimulator.getTranspositionKey()]);
  const stats: BeamSearchStats = {
    beamWidth: options.beamWidth,
    branchLimit: options.branchLimit,
    maxNodes: options.maxNodes,
    nodesGenerated: 0,
    nodesAccepted: 1,
    cacheHits: 0,
    frontierPeak: 1,
    deepestTurn: 1,
    incumbentSource,
    elapsedMs: 0,
  };

  while (frontier.length > 0 && stats.nodesGenerated < options.maxNodes) {
    const candidates: BeamNode[] = [];
    for (const node of frontier) {
      if (stats.nodesGenerated >= options.maxNodes) break;
      const legal = node.simulator.enumerateLegalActions(options);
      const preferred = node.guide ? guidePlan[node.plan.length] : undefined;
      const branches = selectDiverseBranches(legal, options.branchLimit, preferred);
      for (const action of branches) {
        if (stats.nodesGenerated >= options.maxNodes) break;
        stats.nodesGenerated++;
        const simulator = node.simulator.clone(false);
        simulator.applyPlayerAction(action);
        const plan = [...node.plan, structuredClone(action)];
        const followsGuide = node.guide && !!preferred && actionKey(action) === actionKey(preferred);

        if (simulator.isPlayerTurnComplete() && !simulator.isTerminal()) {
          simulator.finishTurn();
          if (!simulator.isTerminal()) simulator.beginPlayerTurn();
        }

        const score = simulator.getEvaluationScore();
        if (simulator.isTerminal()) {
          const result = { ...simulator.getResult(), plan };
          if (result.metrics.cleared && compareScores(result.score, incumbent.score) < 0) {
            incumbent = replayPlannedSolution(db, scenario, policy, plan);
            incumbentSource = 'beam';
          }
          continue;
        }

        const key = simulator.getTranspositionKey();
        if (transpositions.has(key) && !followsGuide) {
          stats.cacheHits++;
          continue;
        }
        if (!transpositions.has(key)) transpositions.add(key);
        stats.nodesAccepted++;
        stats.deepestTurn = Math.max(stats.deepestTurn, simulator.getCurrentTurn());
        candidates.push({
          simulator,
          plan,
          score,
          heuristic: node.heuristic + action.heuristic,
          guide: followsGuide,
        });
      }
    }

    frontier = selectFrontier(candidates, options.beamWidth);
    stats.frontierPeak = Math.max(stats.frontierPeak, frontier.length);
    stats.incumbentSource = incumbentSource;
    stats.elapsedMs = performance.now() - started;
    options.onProgress?.({ ...stats }, incumbent);
  }

  stats.incumbentSource = incumbentSource;
  stats.elapsedMs = performance.now() - started;
  const result: SolverResult = {
    ...incumbent,
    planner: { ...stats },
    elapsedMs: stats.elapsedMs,
  };
  return { result, stats };
}

/** Deterministically verify a planner route against its fixed scenario seed. */
export function replayPlannedSolution(
  db: Database,
  scenario: SolverScenario,
  policy: PolicyWeights,
  plan: PlannerAction[],
): SolverResult {
  const started = performance.now();
  const simulator = new TacticalSimulator(db, scenario, policy);
  for (let index = 0; index < plan.length; index++) {
    const action = plan[index];
    if (simulator.isTerminal()) throw new Error(`Plan has actions after terminal state at index ${index}`);
    simulator.beginPlayerTurn();
    if (action.turn !== simulator.getCurrentTurn()) {
      throw new Error(
        `Plan skips or repeats a turn at action ${index}: expected ${simulator.getCurrentTurn()}, got ${action.turn}`,
      );
    }
    simulator.applyPlayerAction(action);
    if (simulator.isPlayerTurnComplete() && !simulator.isTerminal()) simulator.finishTurn();
  }
  const result = simulator.getResult(performance.now() - started);
  return { ...result, plan: structuredClone(plan) };
}

/** Express the legacy greedy policy as a deterministic, replayable action plan. */
export function runGreedyPlannedSolution(
  db: Database,
  scenario: SolverScenario,
  policy: PolicyWeights = DEFAULT_POLICY,
): SolverResult {
  const started = performance.now();
  const simulator = new TacticalSimulator(db, scenario, policy);
  const plan: PlannerAction[] = [];
  while (!simulator.isTerminal()) {
    simulator.beginPlayerTurn();
    while (!simulator.isPlayerTurnComplete() && !simulator.isTerminal()) {
      const action = simulator.getGreedyPlayerAction();
      if (!action) throw new Error(`Greedy policy produced no action on turn ${simulator.getCurrentTurn()}`);
      plan.push(structuredClone(action));
      simulator.applyPlayerAction(action);
    }
    if (!simulator.isTerminal()) simulator.finishTurn();
  }
  return { ...simulator.getResult(performance.now() - started), plan };
}

function selectDiverseBranches(
  actions: PlannerAction[],
  limit: number,
  preferred?: PlannerAction,
): PlannerAction[] {
  if (actions.length <= limit) return actions;
  const selected: PlannerAction[] = [];
  const seen = new Set<string>();
  const add = (action: PlannerAction): void => {
    const key = actionKey(action);
    if (selected.length < limit && !seen.has(key)) {
      seen.add(key);
      selected.push(action);
    }
  };

  if (preferred) add(preferred);
  const actors = new Set<string>();
  for (const action of actions) {
    if (actors.has(action.actor)) continue;
    actors.add(action.actor);
    add(action);
  }
  for (const preferredType of ['wait', 'move', 'attack', 'heal', 'seize'] as const) {
    const actorTypes = new Set<string>();
    for (const action of actions) {
      if (action.type !== preferredType || actorTypes.has(action.actor)) continue;
      actorTypes.add(action.actor);
      add(action);
    }
  }
  const types = new Set<string>();
  for (const action of actions) {
    if (types.has(action.type)) continue;
    types.add(action.type);
    add(action);
  }
  for (const action of actions) add(action);
  return selected;
}

function actionKey(action: PlannerAction): string {
  return `${action.turn}:${action.actor}:${action.type}:${action.target ?? ''}:${action.itemIndex ?? ''}:${action.position.join(',')}`;
}

function compareNodes(a: BeamNode, b: BeamNode): number {
  return compareScores(a.score, b.score)
    || b.heuristic - a.heuristic
    || a.plan.length - b.plan.length
    || actionKey(a.plan.at(-1)!).localeCompare(actionKey(b.plan.at(-1)!));
}

function compareDamageNodes(a: BeamNode, b: BeamNode): number {
  const aDamageFirst = [a.score[0], a.score[1], a.score[2], a.score[5], a.score[3], a.score[4]];
  const bDamageFirst = [b.score[0], b.score[1], b.score[2], b.score[5], b.score[3], b.score[4]];
  return compareScores(aDamageFirst, bDamageFirst)
    || b.heuristic - a.heuristic
    || compareNodes(a, b);
}

function selectFrontier(candidates: BeamNode[], width: number): BeamNode[] {
  if (candidates.length <= width) return candidates.sort(compareNodes);
  const selected: BeamNode[] = [];
  const seen = new Set<BeamNode>();
  const add = (node: BeamNode): void => {
    if (selected.length < width && !seen.has(node)) {
      seen.add(node);
      selected.push(node);
    }
  };

  const objectiveOrdered = [...candidates].sort(compareNodes);
  const damageOrdered = [...candidates].sort(compareDamageNodes);
  for (const node of objectiveOrdered.slice(0, Math.ceil(width * 0.55))) add(node);
  for (const node of damageOrdered.slice(0, Math.ceil(width * 0.35))) add(node);
  for (const node of objectiveOrdered) add(node);

  const guide = candidates.find((candidate) => candidate.guide);
  if (guide && !seen.has(guide)) selected[selected.length - 1] = guide;
  return selected;
}

function compareScores(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function validateOptions(options: BeamSearchOptions): void {
  for (const [name, value] of Object.entries({
    beamWidth: options.beamWidth,
    branchLimit: options.branchLimit,
    maxNodes: options.maxNodes,
  })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
}
