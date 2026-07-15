import { parentPort, workerData } from 'node:worker_threads';
import { loadSolverProject } from './project-loader';
import { searchPolicy, searchSeedRange } from './search';
import type { PolicyWeights, SolverScenario } from './types';

interface PolicyWorkerPayload {
  mode: 'policy';
  projectPath: string;
  scenario: SolverScenario;
  policy: PolicyWeights;
  iterations: number;
  searchSeed: number;
  shardIndex: number;
  shardCount: number;
}

interface SeedWorkerPayload {
  mode: 'seed';
  projectPath: string;
  scenario: SolverScenario;
  policy: PolicyWeights;
  fromSeed: number;
  toSeed: number;
}

const payload = workerData as PolicyWorkerPayload | SeedWorkerPayload;
const { db } = await loadSolverProject(payload.projectPath);
const result = payload.mode === 'seed'
  ? searchSeedRange(db, payload.scenario, payload.fromSeed, payload.toSeed, payload.policy)
  : searchPolicy(db, payload.scenario, {
    iterations: payload.iterations,
    searchSeed: payload.searchSeed,
    shardIndex: payload.shardIndex,
    shardCount: payload.shardCount,
  }, payload.policy as PolicyWeights);
parentPort?.postMessage(result);
