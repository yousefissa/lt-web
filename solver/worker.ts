import { parentPort, workerData } from 'node:worker_threads';
import { loadSolverProject } from './project-loader';
import { searchPolicy } from './search';
import type { PolicyWeights, SolverScenario } from './types';

interface WorkerPayload {
  projectPath: string;
  scenario: SolverScenario;
  policy: PolicyWeights;
  iterations: number;
  searchSeed: number;
  shardIndex: number;
  shardCount: number;
}

const payload = workerData as WorkerPayload;
const { db } = await loadSolverProject(payload.projectPath);
const result = searchPolicy(db, payload.scenario, {
  iterations: payload.iterations,
  searchSeed: payload.searchSeed,
  shardIndex: payload.shardIndex,
  shardCount: payload.shardCount,
}, payload.policy as PolicyWeights);
parentPort?.postMessage(result);
