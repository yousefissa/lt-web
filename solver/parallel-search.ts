import { Worker } from 'node:worker_threads';
import { compareResults } from './search';
import type { PolicyWeights, SolverResult, SolverScenario } from './types';

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

type WorkerPayload = PolicyWorkerPayload | SeedWorkerPayload;

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
      mode: 'policy',
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

export async function searchSeedRangeParallel(
  projectPath: string,
  scenario: SolverScenario,
  policy: PolicyWeights,
  fromSeed: number,
  toSeed: number,
  workerCount: number,
): Promise<SolverResult> {
  const start = Math.min(fromSeed, toSeed);
  const end = Math.max(fromSeed, toSeed);
  const total = end - start + 1;
  const count = Math.max(1, Math.min(workerCount, total));
  const baseSize = Math.floor(total / count);
  const remainder = total % count;
  const jobs: Array<Promise<SolverResult>> = [];
  let cursor = start;

  for (let shardIndex = 0; shardIndex < count; shardIndex++) {
    const size = baseSize + (shardIndex < remainder ? 1 : 0);
    jobs.push(runWorker({
      mode: 'seed',
      projectPath,
      scenario,
      policy,
      fromSeed: cursor,
      toSeed: cursor + size - 1,
    }));
    cursor += size;
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
