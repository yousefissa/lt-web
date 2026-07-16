import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { Database } from '../src/data/database';
import { SeededRandom } from '../src/engine/random';
import { benchmarkFingerprintsEqual, computeBenchmarkFingerprint } from './benchmark';
import { beamSearchFixedSeed } from './beam-search';
import { loadSolverProject } from './project-loader';
import { proveFixedSeedBound } from './proof-search';
import { mutatePolicy } from './search';
import { TacticalSimulator } from './simulator';
import type {
  BeamSearchOptions,
  BenchmarkFingerprint,
  ClosedLoopPolicy,
  GlobalPolicyAggregate,
  GlobalPolicyArtifact,
  PlannerAction,
  PolicyEvaluationReport,
  PolicyLegalAction,
  PolicyObservation,
  PolicyRepresentatives,
  PolicySeedRun,
  PolicyTrainingCheckpoint,
  PolicyTrainingReport,
  PolicyWeights,
  ProofSearchOptions,
  SeedManifest,
  SeedManifestSplit,
  SeedSolveMode,
  SeedSolveReport,
  SeedSolveRun,
  SolverResult,
  SolverScenario,
} from './types';

const MANIFEST_VERSION = 1 as const;
const POLICY_VERSION = 1 as const;
const POLICY_KIND = 'deterministic-heuristic' as const;
const MANIFEST_DERIVATION = 'sha256-scenario-split-index-v1' as const;

export interface GlobalEvaluationOptions {
  workers: number;
  /** Trusted caller cache; still checked against manifest and policy fingerprints. */
  scenarioFingerprint?: BenchmarkFingerprint;
}

export interface GlobalTrainingOptions extends GlobalEvaluationOptions {
  iterations: number;
  searchSeed: number;
}

export interface SeedFarmOptions extends GlobalEvaluationOptions {
  mode: SeedSolveMode;
  beam: Partial<BeamSearchOptions>;
  proof: Partial<ProofSearchOptions>;
}

export interface GlobalWorkerEvaluationPayload {
  mode: 'evaluate-policy';
  projectPath: string;
  scenario: SolverScenario;
  weights: PolicyWeights;
  jobs: Array<{ index: number; seed: number }>;
}

export interface GlobalWorkerSolvePayload {
  mode: 'solve-seeds';
  projectPath: string;
  scenario: SolverScenario;
  weights: PolicyWeights;
  jobs: Array<{ index: number; seed: number }>;
  solveMode: SeedSolveMode;
  beam: Partial<BeamSearchOptions>;
  proof: Partial<ProofSearchOptions>;
}

export type GlobalWorkerPayload = GlobalWorkerEvaluationPayload | GlobalWorkerSolvePayload;

/** Fingerprint a scenario distribution without allowing its legacy single seed to influence the set. */
export async function computePolicyScenarioFingerprint(
  scenario: SolverScenario,
  projectPath: string,
): Promise<BenchmarkFingerprint> {
  return computeBenchmarkFingerprint({ ...scenario, seed: 0 }, projectPath);
}

export function deriveManifestSeed(
  scenarioFingerprint: string,
  split: SeedManifestSplit,
  index: number,
): number {
  if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid manifest index: ${index}`);
  const digest = createHash('sha256')
    .update(`lt-web:${MANIFEST_DERIVATION}:${scenarioFingerprint}:${split}:${index}`)
    .digest();
  const seed = digest.readUInt32BE(0) & 0x7fff_ffff;
  return seed === 0 ? 1 : seed;
}

export function createSeedManifest(
  scenario: SolverScenario,
  scenarioFingerprint: BenchmarkFingerprint,
  split: SeedManifestSplit,
  count: number,
): SeedManifest {
  if (!Number.isInteger(count) || count <= 0) throw new Error('Manifest count must be a positive integer');
  const manifest: Omit<SeedManifest, 'fingerprint'> = {
    version: MANIFEST_VERSION,
    kind: 'lt-web-seed-manifest',
    scenario: scenario.name,
    levelNid: scenario.levelNid,
    scenarioFingerprint,
    split,
    derivation: MANIFEST_DERIVATION,
    seeds: Array.from({ length: count }, (_, index) => deriveManifestSeed(
      scenarioFingerprint.instanceSha256,
      split,
      index,
    )),
  };
  return { ...manifest, fingerprint: hashStable(manifest) };
}

export function validateSeedManifest(
  manifest: SeedManifest,
  expectedScenario: BenchmarkFingerprint,
  expectedSplit?: SeedManifestSplit,
): void {
  if (manifest.version !== MANIFEST_VERSION || manifest.kind !== 'lt-web-seed-manifest') {
    throw new Error('Unsupported seed manifest format');
  }
  if (!benchmarkFingerprintsEqual(manifest.scenarioFingerprint, expectedScenario)) {
    throw new Error(
      `Seed manifest scenario mismatch: expected ${expectedScenario.instanceSha256}, `
      + `got ${manifest.scenarioFingerprint?.instanceSha256 ?? '<missing>'}`,
    );
  }
  if (expectedSplit && manifest.split !== expectedSplit) {
    throw new Error(`Expected a ${expectedSplit} seed manifest, got ${manifest.split}`);
  }
  if (manifest.derivation !== MANIFEST_DERIVATION || manifest.seeds.length === 0) {
    throw new Error('Seed manifest has an invalid derivation or empty seed list');
  }
  const expectedSeeds = manifest.seeds.map((_, index) => deriveManifestSeed(
    expectedScenario.instanceSha256,
    manifest.split,
    index,
  ));
  if (new Set(manifest.seeds).size !== manifest.seeds.length
    || JSON.stringify(manifest.seeds) !== JSON.stringify(expectedSeeds)) {
    throw new Error('Seed manifest seeds were changed, reordered, filtered, or not deterministically derived');
  }
  const { fingerprint: _fingerprint, ...unsigned } = manifest;
  const expectedFingerprint = hashStable(unsigned);
  if (manifest.fingerprint !== expectedFingerprint) {
    throw new Error(`Seed manifest fingerprint mismatch: expected ${expectedFingerprint}, got ${manifest.fingerprint}`);
  }
}

export function createPolicyArtifact(
  weights: PolicyWeights,
  scenarioFingerprint: BenchmarkFingerprint,
  selection?: GlobalPolicyArtifact['selection'],
): GlobalPolicyArtifact {
  const unsigned: Omit<GlobalPolicyArtifact, 'fingerprint'> = {
    version: POLICY_VERSION,
    kind: POLICY_KIND,
    deterministic: true,
    scenarioFingerprint,
    weights: clonePolicy(weights),
    ...(selection ? { selection: structuredClone(selection) } : {}),
  };
  return { ...unsigned, fingerprint: hashStable(unsigned) };
}

export function validatePolicyArtifact(
  artifact: GlobalPolicyArtifact,
  expectedScenario: BenchmarkFingerprint,
): void {
  if (artifact.version !== POLICY_VERSION || artifact.kind !== POLICY_KIND || artifact.deterministic !== true) {
    throw new Error('Unsupported or non-deterministic global policy artifact');
  }
  if (!benchmarkFingerprintsEqual(artifact.scenarioFingerprint, expectedScenario)) {
    throw new Error(
      `Policy scenario mismatch: expected ${expectedScenario.instanceSha256}, `
      + `got ${artifact.scenarioFingerprint?.instanceSha256 ?? '<missing>'}`,
    );
  }
  const { fingerprint: _fingerprint, ...unsigned } = artifact;
  const expectedFingerprint = hashStable(unsigned);
  if (artifact.fingerprint !== expectedFingerprint) {
    throw new Error(`Policy fingerprint mismatch: expected ${expectedFingerprint}, got ${artifact.fingerprint}`);
  }
}

/** Deterministic priority policy over complete legal actions scored by the current heuristic weights. */
export class DeterministicHeuristicPolicy implements ClosedLoopPolicy {
  readonly kind = POLICY_KIND;
  readonly deterministic = true as const;
  readonly weights: PolicyWeights;

  constructor(weights: PolicyWeights) {
    this.weights = clonePolicy(weights);
  }

  selectAction(observation: PolicyObservation): PlannerAction | null {
    const legal = observation.legalActions;
    const chosen = legal.find((candidate) => candidate.action.type === 'seize')
      ?? legal.find((candidate) => candidate.required)
      ?? legal.find((candidate) => candidate.action.type === 'attack')
      ?? legal.find((candidate) => candidate.action.type === 'heal' && candidate.action.heuristic > 0)
      ?? legal.find((candidate) => candidate.action.type === 'move')
      ?? legal.find((candidate) => candidate.action.type === 'wait');
    return chosen ? structuredClone(chosen.action) : null;
  }
}

/**
 * Execute a policy one observable action at a time. The policy never receives
 * the scenario object, simulator, numeric seed, RNG state, or future rolls.
 */
export function runClosedLoopPolicy(
  db: Database,
  scenario: SolverScenario,
  policy: ClosedLoopPolicy,
): SolverResult {
  const started = performance.now();
  const simulator = new TacticalSimulator(db, scenario, policy.weights);
  const plan: PlannerAction[] = [];
  let decisions = 0;

  while (!simulator.isTerminal()) {
    simulator.beginPlayerTurn();
    while (!simulator.isPlayerTurnComplete() && !simulator.isTerminal()) {
      if (++decisions > 100_000) throw new Error('Closed-loop policy exceeded the action safety limit');
      const legalActions = simulator.enumerateLegalActions();
      if (legalActions.length === 0) throw new Error('No legal action for an incomplete player turn');
      const observation = createPolicyObservation(simulator, legalActions);
      const selected = policy.selectAction(observation);
      if (!selected) throw new Error('Policy returned no action while legal actions remained');
      const matched = legalActions.find((action) => actionKey(action) === actionKey(selected));
      if (!matched) throw new Error(`Policy returned an action outside the legal set: ${actionKey(selected)}`);
      const action = structuredClone(matched);
      simulator.applyPlayerAction(action);
      plan.push(action);
    }
    if (!simulator.isTerminal()) simulator.finishTurn();
  }

  const result = simulator.getResult(performance.now() - started);
  return { ...result, plan };
}

export function createPolicyObservation(
  simulator: TacticalSimulator,
  legalActions: PlannerAction[] = simulator.enumerateLegalActions(),
): PolicyObservation {
  const parity = simulator.getParityState();
  const current = simulator.getResult(0);
  const policyActions: PolicyLegalAction[] = legalActions.map((action) => ({
    action: structuredClone(action),
    required: simulator.isRequiredPolicyAction(action),
  }));
  const observation: PolicyObservation = {
    version: 1,
    levelNid: current.levelNid,
    objective: current.objective,
    turn: parity.turn,
    phase: 'player',
    units: structuredClone(parity.units),
    activeRegions: [...parity.activeRegions],
    visibleLayers: [...parity.visibleLayers],
    interactions: structuredClone(current.interactions),
    map: structuredClone(current.map),
    legalActions: policyActions,
  };
  return deepFreeze(observation);
}

export function aggregatePolicyRuns(runs: PolicySeedRun[]): {
  aggregate: GlobalPolicyAggregate;
  score: number[];
} {
  if (runs.length === 0) throw new Error('Cannot aggregate an empty policy evaluation');
  const completed = runs.flatMap((run) => run.result ? [run.result.metrics] : []);
  const clears = runs.filter((run) => run.status === 'clear').length;
  const failedClears = runs.length - clears;
  const errors = runs.filter((run) => run.status === 'error').length;
  const seedsWithDeaths = completed.filter((metrics) => metrics.playerDeaths > 0).length;
  const totalDeaths = completed.reduce((sum, metrics) => sum + metrics.playerDeaths, 0);
  const damages = completed.map((metrics) => metrics.damageTaken).sort((a, b) => b - a);
  const worstDamage = damages[0] ?? 0;
  const cvarCount = Math.max(1, Math.ceil(runs.length * 0.05));
  const cvar95Damage = mean(damages.slice(0, cvarCount));
  const meanDamage = mean(completed.map((metrics) => metrics.damageTaken));
  const meanTurns = mean(completed.map((metrics) => metrics.turns));
  const meanActions = mean(completed.map((metrics) => metrics.actions));
  const aggregate: GlobalPolicyAggregate = {
    seeds: runs.length,
    clears,
    failedClears,
    errors,
    seedsWithDeaths,
    totalDeaths,
    worstDamage,
    cvar95Damage,
    meanDamage,
    meanTurns,
    meanActions,
    solveCoverage: clears / runs.length,
  };
  return {
    aggregate,
    score: [
      failedClears,
      seedsWithDeaths,
      totalDeaths,
      worstDamage,
      cvar95Damage,
      meanDamage,
      meanTurns,
      meanActions,
    ],
  };
}

export function compareGlobalScores(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function evaluatePolicyManifest(
  db: Database,
  projectPath: string,
  scenario: SolverScenario,
  manifest: SeedManifest,
  policyArtifact: GlobalPolicyArtifact,
  options: GlobalEvaluationOptions,
): Promise<PolicyEvaluationReport> {
  const scenarioFingerprint = options.scenarioFingerprint
    ?? await computePolicyScenarioFingerprint(scenario, projectPath);
  validateSeedManifest(manifest, scenarioFingerprint);
  validatePolicyArtifact(policyArtifact, scenarioFingerprint);
  const jobs = manifest.seeds.map((seed, index) => ({ index, seed }));
  const runs = options.workers > 1
    ? await runParallelEvaluation(projectPath, scenario, policyArtifact.weights, jobs, options.workers)
    : evaluateJobs(db, scenario, policyArtifact.weights, jobs);
  return buildEvaluationReport(scenario, manifest, policyArtifact, runs);
}

export async function trainGlobalPolicy(
  db: Database,
  projectPath: string,
  scenario: SolverScenario,
  trainManifest: SeedManifest,
  validationManifest: SeedManifest,
  initialWeights: PolicyWeights,
  options: GlobalTrainingOptions,
): Promise<PolicyTrainingReport> {
  const scenarioFingerprint = await computePolicyScenarioFingerprint(scenario, projectPath);
  validateSeedManifest(trainManifest, scenarioFingerprint, 'train');
  validateSeedManifest(validationManifest, scenarioFingerprint, 'validation');
  if (trainManifest.fingerprint === validationManifest.fingerprint) {
    throw new Error('Training and validation manifests must be different immutable splits');
  }

  const evaluate = async (weights: PolicyWeights, manifest: SeedManifest): Promise<PolicyEvaluationReport> => {
    const artifact = createPolicyArtifact(weights, scenarioFingerprint);
    return evaluatePolicyManifest(db, projectPath, scenario, manifest, artifact, {
      ...options,
      scenarioFingerprint,
    });
  };
  const rng = new SeededRandom(options.searchSeed);
  let incumbentWeights = clonePolicy(initialWeights);
  let incumbentTrain = await evaluate(incumbentWeights, trainManifest);
  let checkpointTrain = incumbentTrain;
  let selectedWeights = clonePolicy(incumbentWeights);
  let selectedValidation = await evaluate(selectedWeights, validationManifest);
  let selectedIteration = 0;
  const checkpoints: PolicyTrainingCheckpoint[] = [{
    iteration: 0,
    trainScore: [...checkpointTrain.score],
    validationScore: [...selectedValidation.score],
    policyFingerprint: createPolicyArtifact(selectedWeights, scenarioFingerprint).fingerprint,
  }];

  for (let iteration = 1; iteration <= options.iterations; iteration++) {
    const scale = Math.max(0.12, 0.55 * (1 - iteration / Math.max(1, options.iterations)));
    const candidateWeights = mutatePolicy(incumbentWeights, rng, scale);
    const candidateTrain = await evaluate(candidateWeights, trainManifest);
    if (compareGlobalScores(candidateTrain.score, incumbentTrain.score) <= 0 || rng.next() < 0.015) {
      incumbentWeights = clonePolicy(candidateWeights);
      incumbentTrain = candidateTrain;
    }
    if (compareGlobalScores(candidateTrain.score, checkpointTrain.score) >= 0) continue;

    checkpointTrain = candidateTrain;
    const candidateValidation = await evaluate(candidateWeights, validationManifest);
    const checkpointArtifact = createPolicyArtifact(candidateWeights, scenarioFingerprint);
    checkpoints.push({
      iteration,
      trainScore: [...candidateTrain.score],
      validationScore: [...candidateValidation.score],
      policyFingerprint: checkpointArtifact.fingerprint,
    });
    if (compareGlobalScores(candidateValidation.score, selectedValidation.score) < 0) {
      selectedWeights = clonePolicy(candidateWeights);
      selectedValidation = candidateValidation;
      selectedIteration = iteration;
    }
  }

  const selectedTrain = await evaluate(selectedWeights, trainManifest);
  const selection: GlobalPolicyArtifact['selection'] = {
    trainManifestFingerprint: trainManifest.fingerprint,
    validationManifestFingerprint: validationManifest.fingerprint,
    iterations: options.iterations,
    searchSeed: options.searchSeed,
    selectedCheckpointIteration: selectedIteration,
    checkpointsEvaluated: checkpoints.length,
    trainScore: [...selectedTrain.score],
    validationScore: [...selectedValidation.score],
  };
  const selectedPolicy = createPolicyArtifact(selectedWeights, scenarioFingerprint, selection);
  return {
    version: 1,
    kind: 'global-policy-training',
    scenario: scenario.name,
    levelNid: scenario.levelNid,
    scenarioFingerprint,
    trainManifestFingerprint: trainManifest.fingerprint,
    validationManifestFingerprint: validationManifest.fingerprint,
    iterations: options.iterations,
    searchSeed: options.searchSeed,
    selectedPolicy,
    checkpoints,
  };
}

export async function solveSeedManifest(
  db: Database,
  projectPath: string,
  scenario: SolverScenario,
  manifest: SeedManifest,
  policyArtifact: GlobalPolicyArtifact,
  options: SeedFarmOptions,
): Promise<SeedSolveReport> {
  const scenarioFingerprint = options.scenarioFingerprint
    ?? await computePolicyScenarioFingerprint(scenario, projectPath);
  validateSeedManifest(manifest, scenarioFingerprint);
  validatePolicyArtifact(policyArtifact, scenarioFingerprint);
  const jobs = manifest.seeds.map((seed, index) => ({ index, seed }));
  const runs = options.workers > 1
    ? await runParallelSolve(projectPath, scenario, policyArtifact.weights, jobs, options)
    : solveJobs(db, scenario, policyArtifact.weights, jobs, options.mode, options.beam, options.proof);
  const ordered = runs.sort((a, b) => a.index - b.index);
  const solvedSeeds = ordered.filter((run) => run.status === 'clear').length;
  return {
    version: 1,
    kind: 'per-seed-solve-coverage',
    mode: options.mode,
    scenario: scenario.name,
    levelNid: scenario.levelNid,
    scenarioFingerprint,
    manifestFingerprint: manifest.fingerprint,
    manifestSplit: manifest.split,
    policyFingerprint: policyArtifact.fingerprint,
    attemptedSeeds: ordered.length,
    solvedSeeds,
    solveCoverage: solvedSeeds / ordered.length,
    runs: ordered,
  };
}

export function selectPolicyRepresentatives(runs: PolicySeedRun[]): PolicyRepresentatives {
  const successful = runs.filter((run): run is PolicySeedRun & { result: SolverResult } => (
    run.status === 'clear' && !!run.result
  ));
  const failed = runs.find((run) => run.status !== 'clear');
  if (successful.length === 0) return failed ? { failedSeed: failed.seed } : {};
  const byDamage = [...successful].sort((a, b) => (
    a.result.metrics.damageTaken - b.result.metrics.damageTaken || a.seed - b.seed
  ));
  const typical = byDamage[Math.floor((byDamage.length - 1) / 2)];
  const worst = [...successful].sort((a, b) => (
    b.result.metrics.playerDeaths - a.result.metrics.playerDeaths
    || b.result.metrics.damageTaken - a.result.metrics.damageTaken
    || b.result.metrics.turns - a.result.metrics.turns
    || b.result.metrics.actions - a.result.metrics.actions
    || a.seed - b.seed
  ))[0];
  return {
    typicalSeed: typical.seed,
    worstSuccessfulSeed: worst.seed,
    ...(failed ? { failedSeed: failed.seed } : {}),
  };
}

export function evaluateJobs(
  db: Database,
  scenario: SolverScenario,
  weights: PolicyWeights,
  jobs: Array<{ index: number; seed: number }>,
): PolicySeedRun[] {
  return jobs.map(({ index, seed }) => {
    try {
      const result = runClosedLoopPolicy(
        db,
        { ...scenario, seed },
        new DeterministicHeuristicPolicy(weights),
      );
      return { index, seed, status: result.metrics.cleared ? 'clear' : 'failed', result };
    } catch (error) {
      return { index, seed, status: 'error', error: errorMessage(error) };
    }
  });
}

export function solveJobs(
  db: Database,
  scenario: SolverScenario,
  weights: PolicyWeights,
  jobs: Array<{ index: number; seed: number }>,
  mode: SeedSolveMode,
  beam: Partial<BeamSearchOptions>,
  proof: Partial<ProofSearchOptions>,
): SeedSolveRun[] {
  return jobs.map(({ index, seed }) => {
    try {
      const seededScenario = { ...scenario, seed };
      if (mode === 'proof') {
        const attempt = proveFixedSeedBound(db, seededScenario, weights, {
          maxNodes: proof.maxNodes ?? 30_000,
          maxPlayerDeaths: proof.maxPlayerDeaths,
          maxDamage: proof.maxDamage,
        });
        return {
          index,
          seed,
          status: attempt.status === 'found'
            ? (attempt.result?.metrics.cleared ? 'clear' : 'failed')
            : attempt.status,
          result: attempt.result,
          proof: attempt.stats,
        };
      }
      const attempt = beamSearchFixedSeed(db, seededScenario, weights, beam);
      return {
        index,
        seed,
        status: attempt.result.metrics.cleared ? 'clear' : 'failed',
        result: attempt.result,
      };
    } catch (error) {
      return { index, seed, status: 'error', error: errorMessage(error) };
    }
  });
}

export async function runGlobalWorkerPayload(payload: GlobalWorkerPayload): Promise<PolicySeedRun[] | SeedSolveRun[]> {
  const { db } = await loadSolverProject(payload.projectPath);
  if (payload.mode === 'evaluate-policy') {
    return evaluateJobs(db, payload.scenario, payload.weights, payload.jobs);
  }
  return solveJobs(
    db,
    payload.scenario,
    payload.weights,
    payload.jobs,
    payload.solveMode,
    payload.beam,
    payload.proof,
  );
}

function buildEvaluationReport(
  scenario: SolverScenario,
  manifest: SeedManifest,
  policy: GlobalPolicyArtifact,
  runs: PolicySeedRun[],
): PolicyEvaluationReport {
  const ordered = runs.sort((a, b) => a.index - b.index);
  const { aggregate, score } = aggregatePolicyRuns(ordered);
  return {
    version: 1,
    kind: 'global-policy-evaluation',
    scenario: scenario.name,
    levelNid: scenario.levelNid,
    scenarioFingerprint: manifest.scenarioFingerprint,
    manifestFingerprint: manifest.fingerprint,
    manifestSplit: manifest.split,
    policyFingerprint: policy.fingerprint,
    policy,
    aggregate,
    score,
    representatives: selectPolicyRepresentatives(ordered),
    runs: ordered,
  };
}

async function runParallelEvaluation(
  projectPath: string,
  scenario: SolverScenario,
  weights: PolicyWeights,
  jobs: Array<{ index: number; seed: number }>,
  workers: number,
): Promise<PolicySeedRun[]> {
  const shards = shardJobs(jobs, workers);
  const results = await Promise.all(shards.map((shard) => runWorker({
    mode: 'evaluate-policy',
    projectPath,
    scenario,
    weights,
    jobs: shard,
  }) as Promise<PolicySeedRun[]>));
  return results.flat().sort((a, b) => a.index - b.index);
}

async function runParallelSolve(
  projectPath: string,
  scenario: SolverScenario,
  weights: PolicyWeights,
  jobs: Array<{ index: number; seed: number }>,
  options: SeedFarmOptions,
): Promise<SeedSolveRun[]> {
  const shards = shardJobs(jobs, options.workers);
  const results = await Promise.all(shards.map((shard) => runWorker({
    mode: 'solve-seeds',
    projectPath,
    scenario,
    weights,
    jobs: shard,
    solveMode: options.mode,
    beam: options.beam,
    proof: options.proof,
  }) as Promise<SeedSolveRun[]>));
  return results.flat().sort((a, b) => a.index - b.index);
}

function runWorker(payload: GlobalWorkerPayload): Promise<PolicySeedRun[] | SeedSolveRun[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./global-policy-worker.ts', import.meta.url), { workerData: payload });
    let settled = false;
    worker.once('message', (message: PolicySeedRun[] | SeedSolveRun[]) => {
      settled = true;
      resolve(message);
    });
    worker.once('error', (error) => {
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`Global policy worker exited with code ${code}`));
    });
  });
}

function shardJobs<T>(jobs: T[], requestedWorkers: number): T[][] {
  const count = Math.max(1, Math.min(Math.floor(requestedWorkers), jobs.length));
  const shards = Array.from({ length: count }, () => [] as T[]);
  jobs.forEach((job, index) => shards[index % count].push(job));
  return shards.filter((shard) => shard.length > 0);
}

function actionKey(action: PlannerAction): string {
  return [
    action.turn,
    action.type,
    action.actor,
    action.position.join(','),
    action.target ?? '',
    action.item ?? '',
    action.itemIndex ?? '',
    action.region ?? '',
  ].join('|');
}

function clonePolicy(policy: PolicyWeights): PolicyWeights {
  return {
    ...policy,
    unitBias: { ...policy.unitBias },
    unitRisk: { ...(policy.unitRisk ?? {}) },
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
