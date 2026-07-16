import { performance } from 'node:perf_hooks';
import type { Database } from '../src/data/database';
import { DEFAULT_POLICY, TacticalSimulator } from './simulator';
import { DominanceTranspositionTable } from './transposition';
import type {
  BeamSearchOptions,
  BeamSearchResult,
  BeamSearchStats,
  PlannerAction,
  PolicyWeights,
  SolverResult,
  SolverScenario,
  TacticalCheckpoint,
} from './types';

export const DEFAULT_BEAM_OPTIONS: BeamSearchOptions = {
  beamWidth: 32,
  branchLimit: 12,
  maxNodes: 30_000,
  damageFrontierRatio: 0.35,
  maxMovesPerUnit: 4,
  maxAttacksPerUnit: 4,
  maxHealsPerUnit: 2,
  includeWait: true,
};

interface BeamNode {
  checkpoint: TacticalCheckpoint;
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
  providedIncumbent?: SolverResult,
  prefix: PlannerAction[] = [],
): BeamSearchResult {
  const options: BeamSearchOptions = { ...DEFAULT_BEAM_OPTIONS, ...requested };
  validateOptions(options);
  const started = performance.now();

  const greedy = runGreedyPlannedSolution(db, scenario, policy);
  const verifiedProvided = providedIncumbent?.plan
    ? replayPlannedSolution(db, scenario, providedIncumbent.policy, providedIncumbent.plan)
    : providedIncumbent;
  let incumbent = verifiedProvided && compareScores(verifiedProvided.score, greedy.score) < 0
    ? verifiedProvided
    : greedy;
  const guidePlan = incumbent.plan ?? [];
  let incumbentSource: BeamSearchStats['incumbentSource'] = incumbent === greedy ? 'greedy' : 'beam';
  const rootSimulator = createSimulatorFromPlan(db, scenario, policy, prefix);
  if (!rootSimulator.isTerminal()) rootSimulator.beginPlayerTurn();
  const rootCheckpoint = rootSimulator.createCheckpoint(false);
  rootSimulator.restoreCheckpoint(rootCheckpoint);
  const root: BeamNode = {
    checkpoint: rootCheckpoint,
    plan: structuredClone(prefix),
    score: rootSimulator.getEvaluationScore(),
    heuristic: 0,
    guide: prefix.every((action, index) => actionKey(action) === actionKey(guidePlan[index])),
  };
  let frontier: BeamNode[] = [root];
  const transpositions = new DominanceTranspositionTable();
  transpositions.consider(rootSimulator.getFutureStateKey(), rootSimulator.getSearchCost());
  const stats: BeamSearchStats = {
    beamWidth: options.beamWidth,
    branchLimit: options.branchLimit,
    maxNodes: options.maxNodes,
    damageFrontierRatio: options.damageFrontierRatio,
    maxPlayerDeaths: options.maxPlayerDeaths,
    maxDamage: options.maxDamage,
    nodesGenerated: 0,
    nodesAccepted: 1,
    cacheHits: 0,
    dominancePrunes: 0,
    boundPrunes: 0,
    transpositionStates: 1,
    transpositionLabels: 1,
    frontierPeak: 1,
    deepestTurn: 1,
    incumbentSource,
    elapsedMs: 0,
  };

  while (frontier.length > 0 && stats.nodesGenerated < options.maxNodes) {
    const candidates: BeamNode[] = [];
    for (const node of frontier) {
      if (stats.nodesGenerated >= options.maxNodes) break;
      rootSimulator.restoreCheckpoint(node.checkpoint);
      const legal = rootSimulator.enumerateLegalActions(options);
      const preferred = node.guide ? guidePlan[node.plan.length] : undefined;
      const branches = selectDiverseBranches(legal, options.branchLimit, preferred);
      for (const action of branches) {
        if (stats.nodesGenerated >= options.maxNodes) break;
        stats.nodesGenerated++;
        rootSimulator.restoreCheckpoint(node.checkpoint);
        rootSimulator.applyPlayerAction(action);
        const plan = [...node.plan, structuredClone(action)];
        const followsGuide = node.guide && !!preferred && actionKey(action) === actionKey(preferred);

        if (rootSimulator.isPlayerTurnComplete() && !rootSimulator.isTerminal()) {
          rootSimulator.finishTurn();
          if (!rootSimulator.isTerminal()) rootSimulator.beginPlayerTurn();
        }

        const score = rootSimulator.getEvaluationScore();
        if (violatesIrreversibleBounds(rootSimulator, incumbent, options)) {
          stats.boundPrunes++;
          continue;
        }
        if (rootSimulator.isTerminal()) {
          const result = { ...rootSimulator.getResult(), plan };
          if (result.metrics.cleared && compareScores(result.score, incumbent.score) < 0) {
            incumbent = replayPlannedSolution(db, scenario, policy, plan);
            incumbentSource = 'beam';
          }
          continue;
        }

        const key = rootSimulator.getFutureStateKey();
        const decision = transpositions.consider(key, rootSimulator.getSearchCost());
        if ((decision === 'duplicate' || decision === 'dominated') && !followsGuide) {
          stats.cacheHits++;
          if (decision === 'dominated') stats.dominancePrunes++;
          continue;
        }
        stats.nodesAccepted++;
        stats.deepestTurn = Math.max(stats.deepestTurn, rootSimulator.getCurrentTurn());
        candidates.push({
          checkpoint: rootSimulator.createCheckpoint(false),
          plan,
          score,
          heuristic: node.heuristic + action.heuristic,
          guide: followsGuide,
        });
      }
    }

    frontier = selectFrontier(candidates, options.beamWidth, options.damageFrontierRatio);
    stats.frontierPeak = Math.max(stats.frontierPeak, frontier.length);
    stats.incumbentSource = incumbentSource;
    stats.transpositionStates = transpositions.stateCount;
    stats.transpositionLabels = transpositions.labelCount;
    stats.elapsedMs = performance.now() - started;
    options.onProgress?.({ ...stats }, incumbent);
  }

  stats.incumbentSource = incumbentSource;
  stats.transpositionStates = transpositions.stateCount;
  stats.transpositionLabels = transpositions.labelCount;
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
  const simulator = createSimulatorFromPlan(db, scenario, policy, plan);
  const result = simulator.getResult(performance.now() - started);
  return { ...result, plan: structuredClone(plan) };
}

export function createSimulatorFromPlan(
  db: Database,
  scenario: SolverScenario,
  policy: PolicyWeights,
  plan: PlannerAction[],
): TacticalSimulator {
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
  return simulator;
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
  for (const preferredType of [
    'visit', 'talk', 'chest', 'door', 'heal', 'attack', 'move', 'wait', 'seize',
  ] as const) {
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
  return `${action.turn}:${action.actor}:${action.type}:${action.target ?? ''}:${action.region ?? ''}:${action.itemIndex ?? ''}:${action.position.join(',')}`;
}

function compareNodes(a: BeamNode, b: BeamNode): number {
  return compareScores(a.score, b.score)
    || b.heuristic - a.heuristic
    || a.plan.length - b.plan.length
    || actionKey(a.plan.at(-1)!).localeCompare(actionKey(b.plan.at(-1)!));
}

function compareDamageNodes(a: BeamNode, b: BeamNode): number {
  const aDamageFirst = [a.score[0], a.score[1], a.score[2], a.score[5]];
  const bDamageFirst = [b.score[0], b.score[1], b.score[2], b.score[5]];
  return compareScores(aDamageFirst, bDamageFirst)
    || b.heuristic - a.heuristic
    || compareNodes(a, b);
}

function selectFrontier(candidates: BeamNode[], width: number, damageRatio: number): BeamNode[] {
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
  for (const node of objectiveOrdered.slice(0, Math.ceil(width * (1 - damageRatio)))) add(node);
  for (const node of damageOrdered.slice(0, Math.ceil(width * damageRatio))) add(node);
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
  if (!Number.isFinite(options.damageFrontierRatio)
    || options.damageFrontierRatio < 0 || options.damageFrontierRatio > 1) {
    throw new Error('damageFrontierRatio must be between 0 and 1');
  }
  if (options.maxPlayerDeaths !== undefined
    && (!Number.isInteger(options.maxPlayerDeaths) || options.maxPlayerDeaths < 0)) {
    throw new Error('maxPlayerDeaths must be a non-negative integer');
  }
  if (options.maxDamage !== undefined
    && (!Number.isInteger(options.maxDamage) || options.maxDamage < 0)) {
    throw new Error('maxDamage must be a non-negative integer');
  }
}

function violatesIrreversibleBounds(
  simulator: TacticalSimulator,
  incumbent: SolverResult,
  options: BeamSearchOptions,
): boolean {
  const cost = simulator.getSearchCost();
  if (options.maxPlayerDeaths !== undefined && cost.playerDeaths > options.maxPlayerDeaths) return true;
  if (options.maxDamage !== undefined && cost.damageTaken > options.maxDamage) return true;
  if (!incumbent.metrics.cleared) return false;
  if (cost.playerDeaths > incumbent.metrics.playerDeaths) return true;
  if (cost.playerDeaths < incumbent.metrics.playerDeaths) return false;
  if (cost.damageTaken > incumbent.metrics.damageTaken) return true;
  if (cost.damageTaken < incumbent.metrics.damageTaken) return false;
  if (simulator.getCurrentTurn() > incumbent.metrics.turns) return true;
  return simulator.getCurrentTurn() === incumbent.metrics.turns
    && cost.actions >= incumbent.metrics.actions
    && !simulator.isTerminal();
}
