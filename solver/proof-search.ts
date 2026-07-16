import { performance } from 'node:perf_hooks';
import type { Database } from '../src/data/database';
import { createSimulatorFromPlan, replayPlannedSolution } from './beam-search';
import { DEFAULT_POLICY, TacticalSimulator } from './simulator';
import { DominanceTranspositionTable } from './transposition';
import type {
  PlannerAction,
  PolicyWeights,
  ProofSearchOptions,
  ProofSearchResult,
  ProofSearchStats,
  SolverResult,
  SolverScenario,
  TacticalCheckpoint,
} from './types';

interface ProofNode {
  checkpoint: TacticalCheckpoint;
  plan: PlannerAction[];
}

/**
 * Exhaustively answer a bounded fixed-seed feasibility question in the
 * supported headless model. `infeasible` is returned only after the complete
 * legal tree under the optional prefix is exhausted; a node limit returns
 * `unknown`, never a false proof.
 */
export function proveFixedSeedBound(
  db: Database,
  scenario: SolverScenario,
  policy: PolicyWeights = DEFAULT_POLICY,
  requested: ProofSearchOptions,
  prefix: PlannerAction[] = [],
): ProofSearchResult {
  validateOptions(requested);
  const started = performance.now();
  const workspace = createSimulatorFromPlan(db, scenario, policy, prefix);
  if (!workspace.isTerminal()) workspace.beginPlayerTurn();
  const rootCheckpoint = workspace.createCheckpoint(false);
  const transpositions = new DominanceTranspositionTable();
  transpositions.consider(workspace.getFutureStateKey(), workspace.getSearchCost());
  const stack: ProofNode[] = [{ checkpoint: rootCheckpoint, plan: structuredClone(prefix) }];
  const stats: ProofSearchStats = {
    maxNodes: requested.maxNodes,
    prefixActions: prefix.length,
    maxPlayerDeaths: requested.maxPlayerDeaths,
    maxDamage: requested.maxDamage,
    nodesGenerated: 0,
    nodesAccepted: 1,
    cacheHits: 0,
    dominancePrunes: 0,
    boundPrunes: 0,
    transpositionStates: 1,
    transpositionLabels: 1,
    frontierPeak: 1,
    deepestTurn: workspace.getCurrentTurn(),
    exhausted: false,
    elapsedMs: 0,
  };

  const rootResult = workspace.getResult();
  if (!withinBounds(rootResult, requested)) {
    stats.boundPrunes++;
    return finish('infeasible', undefined, stats, transpositions, started, true);
  }
  if (rootResult.metrics.cleared) {
    const result = replayPlannedSolution(db, scenario, policy, prefix);
    return finish('found', result, stats, transpositions, started, false);
  }

  while (stack.length > 0 && stats.nodesGenerated < requested.maxNodes) {
    const node = stack.pop()!;
    workspace.restoreCheckpoint(node.checkpoint);
    const legal = workspace.enumerateLegalActions({ includeWait: true });

    // Legal actions are heuristic-sorted best first. Push in reverse so DFS
    // explores the best-looking branch first without sacrificing completeness.
    for (let index = legal.length - 1; index >= 0; index--) {
      if (stats.nodesGenerated >= requested.maxNodes) break;
      const action = legal[index];
      stats.nodesGenerated++;
      workspace.restoreCheckpoint(node.checkpoint);
      workspace.applyPlayerAction(action);
      const plan = [...node.plan, structuredClone(action)];

      if (workspace.isPlayerTurnComplete() && !workspace.isTerminal()) {
        workspace.finishTurn();
        if (!workspace.isTerminal()) workspace.beginPlayerTurn();
      }

      const partial = workspace.getResult();
      if (!withinBounds(partial, requested)) {
        stats.boundPrunes++;
        continue;
      }
      if (workspace.isTerminal()) {
        if (partial.metrics.cleared) {
          const result = replayPlannedSolution(db, scenario, policy, plan);
          return finish('found', result, stats, transpositions, started, false);
        }
        continue;
      }

      const decision = transpositions.consider(workspace.getFutureStateKey(), workspace.getSearchCost());
      if (decision === 'duplicate' || decision === 'dominated') {
        stats.cacheHits++;
        if (decision === 'dominated') stats.dominancePrunes++;
        continue;
      }

      stats.nodesAccepted++;
      stats.deepestTurn = Math.max(stats.deepestTurn, workspace.getCurrentTurn());
      stack.push({ checkpoint: workspace.createCheckpoint(false), plan });
      stats.frontierPeak = Math.max(stats.frontierPeak, stack.length);
    }

    stats.transpositionStates = transpositions.stateCount;
    stats.transpositionLabels = transpositions.labelCount;
    stats.elapsedMs = performance.now() - started;
    requested.onProgress?.({ ...stats });
  }

  const exhausted = stack.length === 0;
  return finish(exhausted ? 'infeasible' : 'unknown', undefined, stats, transpositions, started, exhausted);
}

function withinBounds(result: SolverResult, options: ProofSearchOptions): boolean {
  if (options.maxPlayerDeaths !== undefined
    && result.metrics.playerDeaths > options.maxPlayerDeaths) return false;
  if (options.maxDamage !== undefined
    && result.metrics.damageTaken > options.maxDamage) return false;
  return true;
}

function finish(
  status: ProofSearchResult['status'],
  result: SolverResult | undefined,
  stats: ProofSearchStats,
  transpositions: DominanceTranspositionTable,
  started: number,
  exhausted: boolean,
): ProofSearchResult {
  stats.transpositionStates = transpositions.stateCount;
  stats.transpositionLabels = transpositions.labelCount;
  stats.exhausted = exhausted;
  stats.elapsedMs = performance.now() - started;
  if (result) result.proof = { ...stats };
  return { status, result, stats };
}

function validateOptions(options: ProofSearchOptions): void {
  if (!Number.isInteger(options.maxNodes) || options.maxNodes <= 0) {
    throw new Error('maxNodes must be a positive integer');
  }
  if (options.maxPlayerDeaths === undefined && options.maxDamage === undefined) {
    throw new Error('Proof search requires --max-deaths, --max-damage, or both');
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
