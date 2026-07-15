import { Worker } from 'node:worker_threads';
import { compareResults } from './search';
import type { PolicyWeights, SolverResult, SolverScenario } from './types';

interface WorkerPayload {
  projectPath: string;
  scenario: SolverScenario;
  policy: PolicyWeights;
  iterations: number;
  searchSeed: number;
  shardIndex: number;
  shardCount: number;
}

export async function searchPolicyParallel(
  projectPath: string,
  scenario: SolverScenario,
  policy: PolicyWeights,
  totalIterations: number,
  workerCount: number,
  searchSeed: number,
): Promise<SolverResult> {
  const count = Math.max(1, Math.min(workerCount, totalIterations || 1));
  const baseIterations = Math.floor(totalIterations / count);
  const remainder = totalIterations % count;
  const jobs: Array<Promise<SolverResult>> = [];

  for (let shardIndex = 0; shardIndex < count; shardIndex++) {
    jobs.push(runWorker({
      projectPath,
      scenario,
      policy,
      iterations: baseIterations + (shardIndex < remainder ? 1 : 0),
      searchSeed,
      shardIndex,
      shardCount: count,
    }));
  }

  const results = await Promise.all(jobs);
  return results.reduce((best, candidate) => compareResults(candidate, best) < 0 ? candidate : best);
}

function runWorker(payload: WorkerPayload): Promise<SolverResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: payload });
    let settled = false;
    worker.once('message', (message: SolverResult) => {
      settled = true;
      resolve(message);
    });
    worker.once('error', (error) => {
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`Solver worker exited with code ${code}`));
    });
  });
}
