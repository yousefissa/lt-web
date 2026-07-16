#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { benchmarkFingerprintsEqual, computeBenchmarkFingerprint } from './benchmark';
import { beamSearchFixedSeed, replayPlannedSolution } from './beam-search';
import {
  computePolicyScenarioFingerprint,
  createPolicyArtifact,
  createSeedManifest,
  evaluatePolicyManifest,
  solveSeedManifest,
  trainGlobalPolicy,
  validateSeedManifest,
} from './global-policy';
import { writePolicyReportHtml } from './policy-report';
import { loadSolverProject } from './project-loader';
import { proveFixedSeedBound } from './proof-search';
import { searchPolicyParallel, searchSeedRangeParallel } from './parallel-search';
import { compareResults, searchPolicy, searchSeedRange } from './search';
import { DEFAULT_POLICY, TacticalSimulator } from './simulator';
import type {
  BenchmarkFingerprint,
  GlobalPolicyArtifact,
  PlannerAction,
  PolicyEvaluationReport,
  PolicyTrainingReport,
  PolicyWeights,
  ProofSearchResult,
  SeedManifest,
  SeedManifestSplit,
  SeedSolveMode,
  SeedSolveReport,
  SolverResult,
  SolverScenario,
} from './types';
import { writeReplayFragment, writeReplayHtml } from './visualize';

interface CliOptions {
  command: string;
  scenarioPath: string;
  projectPath?: string;
  seed?: number;
  maxTurns?: number;
  iterations: number;
  workers: number;
  searchSeed: number;
  seedRange?: [number, number];
  allowSeedSearch: boolean;
  beamWidth: number;
  branchLimit: number;
  maxNodes: number;
  damageFrontierRatio: number;
  maxPlayerDeaths?: number;
  maxDamage?: number;
  maxMovesPerUnit: number;
  maxAttacksPerUnit: number;
  maxHealsPerUnit: number;
  outputPath?: string;
  solutionOutputPath?: string;
  htmlPath?: string;
  fragmentPath?: string;
  solutionPath?: string;
  policyPath?: string;
  prefixPath?: string;
  seedManifestPath?: string;
  trainSeedsPath?: string;
  validationSeedsPath?: string;
  testSeedsPath?: string;
  resultsPath?: string;
  replayDirectory?: string;
  manifestSplit?: SeedManifestSplit;
  manifestCount?: number;
  seedSolveMode: SeedSolveMode;
  json: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    printHelp();
    return;
  }

  if (options.command === 'report-policy') {
    if (!options.resultsPath) throw new Error('report-policy requires --results <path>');
    if (!options.htmlPath) throw new Error('report-policy requires --html <path>');
    const report = JSON.parse(await readFile(path.resolve(options.resultsPath), 'utf8')) as PolicyEvaluationReport;
    if (report.kind !== 'global-policy-evaluation' || !Array.isArray(report.runs)) {
      throw new Error(`${options.resultsPath} is not a global policy evaluation report`);
    }
    await writePolicyReportHtml(options.htmlPath, report, options.replayDirectory);
    console.log(`policy report: ${path.resolve(options.htmlPath)}`);
    return;
  }

  const scenario = await readScenario(options.scenarioPath);
  if (options.seed !== undefined) scenario.seed = options.seed;
  if (options.maxTurns !== undefined) scenario.maxTurns = options.maxTurns;
  const projectPath = await resolveProjectPath(options.projectPath ?? scenario.project);
  const { db } = await loadSolverProject(projectPath);
  let benchmark = await computeBenchmarkFingerprint(scenario, projectPath);

  if (options.command === 'create-seed-manifest') {
    if (!options.manifestSplit) throw new Error('create-seed-manifest requires --split train|validation|test');
    if (!options.manifestCount) throw new Error('create-seed-manifest requires --count <positive integer>');
    if (!options.outputPath) throw new Error('create-seed-manifest requires --out <path>');
    const scenarioFingerprint = await computePolicyScenarioFingerprint(scenario, projectPath);
    const manifest = createSeedManifest(
      scenario,
      scenarioFingerprint,
      options.manifestSplit,
      options.manifestCount,
    );
    await writeJson(options.outputPath, manifest);
    console.log(formatManifestSummary(manifest));
    return;
  }

  if (options.command === 'evaluate-policy' || options.command === 'verify-policy') {
    const manifestPath = options.command === 'verify-policy'
      ? options.testSeedsPath
      : options.seedManifestPath;
    if (!manifestPath) {
      throw new Error(`${options.command} requires ${options.command === 'verify-policy' ? '--test-seeds' : '--seed-manifest'} <path>`);
    }
    if (options.command === 'verify-policy' && !options.policyPath) {
      throw new Error('verify-policy requires the selected --policy <path>');
    }
    const scenarioFingerprint = await computePolicyScenarioFingerprint(scenario, projectPath);
    const manifest = await readSeedManifest(manifestPath);
    if (options.command === 'verify-policy') validateSeedManifest(manifest, scenarioFingerprint, 'test');
    const policy = await readGlobalPolicyArtifact(options.policyPath, scenarioFingerprint);
    const report = await evaluatePolicyManifest(db, projectPath, scenario, manifest, policy, {
      workers: options.workers,
      scenarioFingerprint,
    });
    if (options.outputPath) await writeJson(options.outputPath, report);
    if (options.htmlPath) await writePolicyReportHtml(options.htmlPath, report, options.replayDirectory);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatPolicySummary(report));
    return;
  }

  if (options.command === 'train-policy') {
    if (!options.trainSeedsPath || !options.validationSeedsPath) {
      throw new Error('train-policy requires --train-seeds <path> and --validation-seeds <path>');
    }
    if (!options.outputPath) throw new Error('train-policy requires --out <selected-policy-path>');
    const scenarioFingerprint = await computePolicyScenarioFingerprint(scenario, projectPath);
    const trainManifest = await readSeedManifest(options.trainSeedsPath);
    const validationManifest = await readSeedManifest(options.validationSeedsPath);
    const initial = await readGlobalPolicyArtifact(options.policyPath, scenarioFingerprint);
    const training = await trainGlobalPolicy(
      db,
      projectPath,
      scenario,
      trainManifest,
      validationManifest,
      initial.weights,
      { iterations: options.iterations, searchSeed: options.searchSeed, workers: options.workers },
    );
    await writeJson(options.outputPath, training.selectedPolicy);
    if (options.resultsPath) await writeJson(options.resultsPath, training);
    console.log(formatTrainingSummary(training));
    return;
  }

  if (options.command === 'solve-seeds') {
    if (!options.seedManifestPath) throw new Error('solve-seeds requires --seed-manifest <path>');
    const scenarioFingerprint = await computePolicyScenarioFingerprint(scenario, projectPath);
    const manifest = await readSeedManifest(options.seedManifestPath);
    const policy = await readGlobalPolicyArtifact(options.policyPath, scenarioFingerprint);
    const report = await solveSeedManifest(db, projectPath, scenario, manifest, policy, {
      mode: options.seedSolveMode,
      workers: options.workers,
      scenarioFingerprint,
      beam: {
        beamWidth: options.beamWidth,
        branchLimit: options.branchLimit,
        maxNodes: options.maxNodes,
        damageFrontierRatio: options.damageFrontierRatio,
        maxPlayerDeaths: options.maxPlayerDeaths,
        maxDamage: options.maxDamage,
        maxMovesPerUnit: options.maxMovesPerUnit,
        maxAttacksPerUnit: options.maxAttacksPerUnit,
        maxHealsPerUnit: options.maxHealsPerUnit,
      },
      proof: {
        maxNodes: options.maxNodes,
        maxPlayerDeaths: options.maxPlayerDeaths,
        maxDamage: options.maxDamage,
      },
    });
    if (options.outputPath) await writeJson(options.outputPath, report);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatSeedSolveSummary(report));
    return;
  }

  if (options.command === 'inspect') {
    const simulator = new TacticalSimulator(db, scenario);
    console.log(
      `${scenario.name}\nproject: ${projectPath}\nlevel: ${scenario.levelNid}\nseed: ${scenario.seed}`
      + `\nbenchmark: ${benchmark.instanceSha256}\n`,
    );
    console.log(simulator.getAsciiMap());
    console.log('\nRoster:');
    for (const unit of simulator.getInitialUnits()) {
      console.log(`${unit.team.padEnd(6)} ${unit.nid.padEnd(10)} Lv ${String(unit.level).padStart(2)}.${String(unit.exp).padStart(2, '0')} HP ${unit.hp}/${unit.maxHp} @ ${unit.position?.join(',') ?? '-'}`);
    }
    return;
  }

  if (options.command === 'verify') {
    if (!options.solutionPath) throw new Error('verify requires --solution <path>');
    const saved = JSON.parse(await readFile(path.resolve(options.solutionPath), 'utf8')) as SolverResult;
    assertFixedSeed(scenario.seed, saved.seed, options);
    assertBenchmarkFingerprint(saved.benchmark, benchmark, options.solutionPath);
    if (options.allowSeedSearch) scenario.seed = saved.seed;
    const rerun = saved.plan
      ? replayPlannedSolution(db, scenario, saved.policy, saved.plan)
      : new TacticalSimulator(db, scenario, saved.policy).run();
    rerun.benchmark = benchmark;
    const matches = compareResults(rerun, saved) === 0 && JSON.stringify(rerun.metrics) === JSON.stringify(saved.metrics);
    console.log(formatSummary(rerun));
    if (!matches) throw new Error(`Verification mismatch: saved [${saved.score}] rerun [${rerun.score}]`);
    if (options.outputPath) await writeJson(options.outputPath, rerun);
    if (options.solutionOutputPath) await writeSolution(options.solutionOutputPath, rerun);
    if (options.htmlPath) await writeReplayHtml(options.htmlPath, rerun);
    if (options.fragmentPath) await writeReplayFragment(options.fragmentPath, rerun);
    console.log('verification: deterministic replay matches saved solution');
    return;
  }

  if (options.command === 'refresh') {
    if (!options.solutionPath) throw new Error('refresh requires --solution <path>');
    if (!options.solutionOutputPath) throw new Error('refresh requires --solution-out <path>');
    const saved = JSON.parse(await readFile(path.resolve(options.solutionPath), 'utf8')) as SolverResult;
    assertFixedSeed(scenario.seed, saved.seed, options);
    if (saved.levelNid !== scenario.levelNid) {
      throw new Error(`Level mismatch: scenario is ${scenario.levelNid}, saved route is ${saved.levelNid}`);
    }
    if (!saved.plan?.length) throw new Error(`Saved artifact ${options.solutionPath} does not contain a plan`);
    console.error(
      `refreshing ${saved.plan.length} fixed-seed actions from ${options.solutionPath}; `
      + 'saved metrics and benchmark fingerprints are ignored',
    );
    const refreshed = replayPlannedSolution(db, scenario, saved.policy, saved.plan);
    if (!refreshed.metrics.cleared) {
      throw new Error(`Refreshed route no longer clears: score [${refreshed.score.join(', ')}]`);
    }
    refreshed.benchmark = benchmark;
    if (options.outputPath) await writeJson(options.outputPath, refreshed);
    await writeSolution(options.solutionOutputPath, refreshed);
    if (options.htmlPath) await writeReplayHtml(options.htmlPath, refreshed);
    if (options.fragmentPath) await writeReplayFragment(options.fragmentPath, refreshed);
    console.log(options.json ? JSON.stringify(refreshed, null, 2) : formatSummary(refreshed));
    console.log('refresh: every saved action replayed against the current fixed-seed benchmark');
    return;
  }

  if (options.command === 'prove') {
    if (options.allowSeedSearch || options.seedRange || options.seed !== undefined) {
      throw new Error('prove searches exactly the scenario seed; seed overrides and seed search are not supported');
    }
    let policy: PolicyWeights = DEFAULT_POLICY;
    if (options.policyPath) policy = await readPolicy(options.policyPath);
    if (options.solutionPath) {
      const saved = JSON.parse(await readFile(path.resolve(options.solutionPath), 'utf8')) as SolverResult;
      assertFixedSeed(scenario.seed, saved.seed, options);
      assertBenchmarkFingerprint(saved.benchmark, benchmark, options.solutionPath);
      policy = saved.policy;
    }
    const prefix = options.prefixPath
      ? await readPlanPrefix(options.prefixPath, scenario.seed, benchmark, options)
      : [];
    let reportedTurn = 0;
    const proof = proveFixedSeedBound(db, scenario, policy, {
      maxNodes: options.maxNodes,
      maxPlayerDeaths: options.maxPlayerDeaths,
      maxDamage: options.maxDamage,
      onProgress: (stats) => {
        if (stats.deepestTurn <= reportedTurn) return;
        reportedTurn = stats.deepestTurn;
        console.error(
          `proof turn ${stats.deepestTurn}: generated=${stats.nodesGenerated} `
          + `cache=${stats.cacheHits} dominance=${stats.dominancePrunes}`,
        );
      },
    }, prefix);
    if (proof.result) {
      proof.result.benchmark = benchmark;
      if (options.outputPath) await writeJson(options.outputPath, proof.result);
      if (options.solutionOutputPath) await writeSolution(options.solutionOutputPath, proof.result);
      if (options.htmlPath) await writeReplayHtml(options.htmlPath, proof.result);
      if (options.fragmentPath) await writeReplayFragment(options.fragmentPath, proof.result);
    } else if (options.outputPath || options.solutionOutputPath || options.htmlPath || options.fragmentPath) {
      throw new Error(`Proof status ${proof.status} has no solution artifact to write`);
    }
    console.log(options.json ? JSON.stringify(proof, null, 2) : formatProofSummary(proof));
    return;
  }

  let result: SolverResult;
  if (options.command === 'plan') {
    if (options.allowSeedSearch || options.seedRange) {
      throw new Error('plan searches actions for exactly one fixed seed; seed search is not supported');
    }
    let startingPolicy: PolicyWeights = DEFAULT_POLICY;
    let startingSolution: SolverResult | undefined;
    let prefix: PlannerAction[] = [];
    if (options.policyPath) startingPolicy = await readPolicy(options.policyPath);
    if (options.solutionPath) {
      const saved = JSON.parse(await readFile(path.resolve(options.solutionPath), 'utf8')) as SolverResult;
      assertFixedSeed(scenario.seed, saved.seed, options);
      assertBenchmarkFingerprint(saved.benchmark, benchmark, options.solutionPath);
      startingPolicy = saved.policy;
      startingSolution = saved;
    }
    if (options.prefixPath) {
      prefix = await readPlanPrefix(options.prefixPath, scenario.seed, benchmark, options);
    }
    let reportedTurn = 0;
    const planned = beamSearchFixedSeed(db, scenario, startingPolicy, {
      beamWidth: options.beamWidth,
      branchLimit: options.branchLimit,
      maxNodes: options.maxNodes,
      damageFrontierRatio: options.damageFrontierRatio,
      maxPlayerDeaths: options.maxPlayerDeaths,
      maxDamage: options.maxDamage,
      maxMovesPerUnit: options.maxMovesPerUnit,
      maxAttacksPerUnit: options.maxAttacksPerUnit,
      maxHealsPerUnit: options.maxHealsPerUnit,
      onProgress: (stats, incumbent) => {
        if (stats.deepestTurn <= reportedTurn) return;
        reportedTurn = stats.deepestTurn;
        console.error(
          `beam turn ${stats.deepestTurn}: generated=${stats.nodesGenerated} cache=${stats.cacheHits} `
          + `incumbent=[${incumbent.score.join(', ')}] source=${stats.incumbentSource}`,
        );
      },
    }, startingSolution, prefix);
    result = planned.result;
    console.error(
      `beam complete: ${planned.stats.nodesGenerated} nodes, ${planned.stats.cacheHits} cache hits `
      + `(${planned.stats.dominancePrunes} dominated), ${planned.stats.boundPrunes} bound prunes, `
      + `${planned.stats.transpositionStates} states/${planned.stats.transpositionLabels} labels, `
      + `peak ${planned.stats.frontierPeak}, incumbent ${planned.stats.incumbentSource}`,
    );
  } else if (options.command === 'solve') {
    let startingPolicy: PolicyWeights = DEFAULT_POLICY;
    if (options.policyPath) {
      startingPolicy = await readPolicy(options.policyPath);
      console.error(`importing policy weights from ${options.policyPath}; saved metrics and fingerprints are not reused`);
    }
    if (options.solutionPath) {
      const saved = JSON.parse(await readFile(path.resolve(options.solutionPath), 'utf8')) as SolverResult;
      assertFixedSeed(scenario.seed, saved.seed, options);
      assertBenchmarkFingerprint(saved.benchmark, benchmark, options.solutionPath);
      if (options.allowSeedSearch) scenario.seed = saved.seed;
      startingPolicy = saved.policy;
      console.error(`continuing from ${options.solutionPath}: seed ${saved.seed} score [${saved.score.join(', ')}]`);
    }
    if (options.seedRange) {
      if (!options.allowSeedSearch) {
        throw new Error('--seed-range is disabled for fixed-seed benchmarks; add --allow-seed-search only for explicitly non-benchmark diagnostics');
      }
      console.error('warning: seed search is non-benchmark diagnostic work and must not become the canonical solution');
      const seedBest = options.workers > 1
        ? await searchSeedRangeParallel(
          projectPath,
          scenario,
          startingPolicy,
          options.seedRange[0],
          options.seedRange[1],
          options.workers,
        )
        : searchSeedRange(db, scenario, options.seedRange[0], options.seedRange[1], startingPolicy);
      scenario.seed = seedBest.seed;
      benchmark = await computeBenchmarkFingerprint(scenario, projectPath);
      startingPolicy = seedBest.policy;
      console.error(`seed search best${options.workers > 1 ? ` (${options.workers} workers)` : ''}: ${seedBest.seed} score [${seedBest.score.join(', ')}]`);
    }
    if (options.workers > 1) {
      result = await searchPolicyParallel(
        projectPath,
        scenario,
        startingPolicy,
        options.iterations,
        options.workers,
        options.searchSeed,
      );
      console.error(`parallel search: ${options.iterations} candidates across ${options.workers} workers`);
    } else {
      result = searchPolicy(db, scenario, {
        iterations: options.iterations,
        searchSeed: options.searchSeed,
        onImprovement: (improved, iteration) => {
          console.error(`iteration ${iteration}: score [${improved.score.join(', ')}] clear=${improved.metrics.cleared} damage=${improved.metrics.damageTaken} turns=${improved.metrics.turns}`);
        },
      }, startingPolicy);
    }
  } else if (options.command === 'run') {
    const policy = options.policyPath ? await readPolicy(options.policyPath) : DEFAULT_POLICY;
    result = new TacticalSimulator(db, scenario, policy).run();
  } else {
    throw new Error(`Unknown command: ${options.command}`);
  }

  benchmark = await computeBenchmarkFingerprint(scenario, projectPath);
  result.benchmark = benchmark;
  if (options.outputPath) await writeJson(options.outputPath, result);
  if (options.solutionOutputPath) await writeSolution(options.solutionOutputPath, result);
  if (options.htmlPath) await writeReplayHtml(options.htmlPath, result);
  if (options.fragmentPath) await writeReplayFragment(options.fragmentPath, result);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatSummary(result));
}

function parseArgs(args: string[]): CliOptions {
  const command = args[0]?.startsWith('-') ? 'run' : (args.shift() ?? 'run');
  const options: CliOptions = {
    command,
    scenarioPath: 'solver/scenarios/chapter-3.json',
    iterations: 250,
    workers: 1,
    searchSeed: 1,
    allowSeedSearch: false,
    beamWidth: 32,
    branchLimit: 12,
    maxNodes: 30_000,
    damageFrontierRatio: 0.35,
    maxMovesPerUnit: 4,
    maxAttacksPerUnit: 4,
    maxHealsPerUnit: 2,
    seedSolveMode: 'beam',
    json: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === '--scenario') { options.scenarioPath = required(value, arg); index++; }
    else if (arg === '--project') { options.projectPath = required(value, arg); index++; }
    else if (arg === '--seed') { options.seed = Number(required(value, arg)); index++; }
    else if (arg === '--max-turns') { options.maxTurns = Number(required(value, arg)); index++; }
    else if (arg === '--iterations') { options.iterations = Number(required(value, arg)); index++; }
    else if (arg === '--workers') { options.workers = Number(required(value, arg)); index++; }
    else if (arg === '--search-seed') { options.searchSeed = Number(required(value, arg)); index++; }
    else if (arg === '--seed-range') { options.seedRange = parseRange(required(value, arg)); index++; }
    else if (arg === '--allow-seed-search') options.allowSeedSearch = true;
    else if (arg === '--beam-width') { options.beamWidth = Number(required(value, arg)); index++; }
    else if (arg === '--branch-limit') { options.branchLimit = Number(required(value, arg)); index++; }
    else if (arg === '--max-nodes') { options.maxNodes = Number(required(value, arg)); index++; }
    else if (arg === '--damage-frontier') { options.damageFrontierRatio = Number(required(value, arg)); index++; }
    else if (arg === '--max-deaths') { options.maxPlayerDeaths = Number(required(value, arg)); index++; }
    else if (arg === '--max-damage') { options.maxDamage = Number(required(value, arg)); index++; }
    else if (arg === '--max-moves-per-unit') { options.maxMovesPerUnit = Number(required(value, arg)); index++; }
    else if (arg === '--max-attacks-per-unit') { options.maxAttacksPerUnit = Number(required(value, arg)); index++; }
    else if (arg === '--max-heals-per-unit') { options.maxHealsPerUnit = Number(required(value, arg)); index++; }
    else if (arg === '--out') { options.outputPath = required(value, arg); index++; }
    else if (arg === '--solution-out') { options.solutionOutputPath = required(value, arg); index++; }
    else if (arg === '--html') { options.htmlPath = required(value, arg); index++; }
    else if (arg === '--fragment') { options.fragmentPath = required(value, arg); index++; }
    else if (arg === '--solution') { options.solutionPath = required(value, arg); index++; }
    else if (arg === '--policy') { options.policyPath = required(value, arg); index++; }
    else if (arg === '--prefix') { options.prefixPath = required(value, arg); index++; }
    else if (arg === '--seed-manifest') { options.seedManifestPath = required(value, arg); index++; }
    else if (arg === '--train-seeds') { options.trainSeedsPath = required(value, arg); index++; }
    else if (arg === '--validation-seeds') { options.validationSeedsPath = required(value, arg); index++; }
    else if (arg === '--test-seeds') { options.testSeedsPath = required(value, arg); index++; }
    else if (arg === '--results') { options.resultsPath = required(value, arg); index++; }
    else if (arg === '--replays-dir') { options.replayDirectory = required(value, arg); index++; }
    else if (arg === '--split') { options.manifestSplit = parseManifestSplit(required(value, arg)); index++; }
    else if (arg === '--count') { options.manifestCount = Number(required(value, arg)); index++; }
    else if (arg === '--planner') { options.seedSolveMode = parseSeedSolveMode(required(value, arg)); index++; }
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.command = 'help';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.solutionPath && options.policyPath) {
    throw new Error('--solution and --policy are mutually exclusive');
  }
  return options;
}

async function readPolicy(filename: string): Promise<PolicyWeights> {
  const parsed = JSON.parse(await readFile(path.resolve(filename), 'utf8')) as unknown;
  const candidate = isRecord(parsed) && 'policy' in parsed
    ? parsed.policy
    : isRecord(parsed) && 'weights' in parsed
      ? parsed.weights
      : parsed;
  if (!isPolicyWeights(candidate)) {
    throw new Error(`Policy file ${filename} does not contain valid policy weights`);
  }
  return candidate;
}

async function readGlobalPolicyArtifact(
  filename: string | undefined,
  scenarioFingerprint: BenchmarkFingerprint,
): Promise<GlobalPolicyArtifact> {
  if (!filename) return createPolicyArtifact(DEFAULT_POLICY, scenarioFingerprint);
  const parsed = JSON.parse(await readFile(path.resolve(filename), 'utf8')) as unknown;
  if (isRecord(parsed)
    && parsed.kind === 'deterministic-heuristic'
    && 'weights' in parsed
    && 'fingerprint' in parsed) {
    return parsed as unknown as GlobalPolicyArtifact;
  }
  return createPolicyArtifact(await readPolicy(filename), scenarioFingerprint);
}

async function readSeedManifest(filename: string): Promise<SeedManifest> {
  return JSON.parse(await readFile(path.resolve(filename), 'utf8')) as SeedManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPolicyWeights(value: unknown): value is PolicyWeights {
  if (!isRecord(value) || !isRecord(value.unitBias)) return false;
  const requiredWeights: Array<keyof Omit<PolicyWeights, 'unitBias' | 'unitRisk'>> = [
    'kill', 'bossKill', 'damage', 'counterDamage', 'lethalRisk', 'progress',
    'danger', 'wall', 'heal', 'stayHealthy',
  ];
  return requiredWeights.every((key) => typeof value[key] === 'number')
    && Object.values(value.unitBias).every((bias) => typeof bias === 'number')
    && (value.unitRisk === undefined
      || (isRecord(value.unitRisk) && Object.values(value.unitRisk).every((risk) => typeof risk === 'number')));
}

function required(value: string | undefined, flag: string): string {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseRange(value: string): [number, number] {
  const match = value.match(/^(-?\d+):(-?\d+)$/);
  if (!match) throw new Error('--seed-range must be FROM:TO');
  return [Number(match[1]), Number(match[2])];
}

function parseManifestSplit(value: string): SeedManifestSplit {
  if (value === 'train' || value === 'validation' || value === 'test') return value;
  throw new Error('--split must be train, validation, or test');
}

function parseSeedSolveMode(value: string): SeedSolveMode {
  if (value === 'beam' || value === 'proof') return value;
  throw new Error('--planner must be beam or proof');
}

function assertFixedSeed(scenarioSeed: number, solutionSeed: number, options: CliOptions): void {
  if (scenarioSeed === solutionSeed || options.allowSeedSearch) return;
  throw new Error(
    `Fixed-seed mismatch: scenario requires seed ${scenarioSeed}, but the solution uses ${solutionSeed}. `
    + 'Use a matching solution; --allow-seed-search is reserved for non-benchmark diagnostics.',
  );
}

async function readScenario(filename: string): Promise<SolverScenario> {
  return JSON.parse(await readFile(path.resolve(filename), 'utf8')) as SolverScenario;
}

async function readPlanPrefix(
  filename: string,
  scenarioSeed: number,
  benchmark: BenchmarkFingerprint,
  options: CliOptions,
): Promise<PlannerAction[]> {
  const saved = JSON.parse(await readFile(path.resolve(filename), 'utf8')) as {
    seed: number;
    plan: PlannerAction[];
    benchmark?: BenchmarkFingerprint;
  };
  assertFixedSeed(scenarioSeed, saved.seed, options);
  assertBenchmarkFingerprint(saved.benchmark, benchmark, filename);
  if (!Array.isArray(saved.plan)) throw new Error(`Prefix ${filename} does not contain a plan`);
  return saved.plan;
}

function assertBenchmarkFingerprint(
  saved: BenchmarkFingerprint | undefined,
  expected: BenchmarkFingerprint,
  filename: string,
): void {
  if (benchmarkFingerprintsEqual(saved, expected)) return;
  if (!saved) {
    throw new Error(
      `Saved artifact ${filename} has no benchmark fingerprint. Regenerate it against the fixed scenario before use.`,
    );
  }
  throw new Error(
    `Benchmark mismatch for ${filename}: expected ${expected.instanceSha256}, got ${saved.instanceSha256}. `
    + 'The scenario, seed/RNG mode, roster, or project gameplay data changed.',
  );
}

async function resolveProjectPath(configured?: string): Promise<string> {
  const candidates = [configured, 'public/game-data/default.ltproj', 'lt-maker/default.ltproj'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    try {
      await access(path.join(resolved, 'game_data'));
      return resolved;
    } catch {
      // Try the next conventional project location.
    }
  }
  throw new Error(`Could not find a .ltproj. Tried: ${candidates.join(', ')}`);
}

async function writeJson(filename: string, result: unknown): Promise<void> {
  const resolved = path.resolve(filename);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

async function writeSolution(filename: string, result: SolverResult): Promise<void> {
  const resolved = path.resolve(filename);
  await mkdir(path.dirname(resolved), { recursive: true });
  const compact = {
    scenario: result.scenario,
    levelNid: result.levelNid,
    objective: result.objective,
    seed: result.seed,
    rngState: result.rngState,
    rngMode: result.rngMode,
    policy: result.policy,
    metrics: result.metrics,
    score: result.score,
    plan: result.plan,
    planner: result.planner,
    proof: result.proof,
    interactions: result.interactions,
    benchmark: result.benchmark,
  };
  await writeFile(resolved, `${JSON.stringify(compact, null, 2)}\n`, 'utf8');
}

function formatProofSummary(proof: ProofSearchResult): string {
  const constraints = [
    proof.stats.maxPlayerDeaths === undefined ? null : `deaths <= ${proof.stats.maxPlayerDeaths}`,
    proof.stats.maxDamage === undefined ? null : `damage <= ${proof.stats.maxDamage}`,
  ].filter((value): value is string => value !== null).join(', ');
  const status = proof.status === 'found'
    ? 'FOUND'
    : proof.status === 'infeasible'
      ? 'INFEASIBLE (exhaustive in supported model)'
      : 'UNKNOWN (node limit reached)';
  const scope = proof.stats.prefixActions > 0
    ? ` under ${proof.stats.prefixActions}-action prefix`
    : '';
  return [
    `${status}${scope} — fixed seed, ${constraints}`,
    `${proof.stats.nodesGenerated} nodes, ${proof.stats.cacheHits} cache hits, `
      + `${proof.stats.dominancePrunes} dominance prunes, ${proof.stats.boundPrunes} bound prunes`,
    `${proof.stats.transpositionStates} tactical states / ${proof.stats.transpositionLabels} Pareto labels, `
      + `${proof.stats.elapsedMs.toFixed(1)} ms`,
    proof.result ? formatSummary(proof.result) : null,
  ].filter((line): line is string => line !== null).join('\n');
}

function formatSummary(result: SolverResult): string {
  const metrics = result.metrics;
  return [
    `${metrics.cleared ? 'CLEAR' : metrics.lost ? 'LOSS' : 'INCOMPLETE'} — ${result.scenario}`,
    `objective ${result.objective}, seed ${result.seed} (${result.rngMode}), score [${result.score.join(', ')}]`,
    `${metrics.turns} turns, ${metrics.actions} actions, ${metrics.combats} combats`,
    `${metrics.damageTaken} damage taken, ${metrics.healingReceived} healed, ${metrics.playerDeaths} player deaths`,
    `${metrics.enemiesDefeated} enemies defeated, ${metrics.wallsBroken} walls broken`,
    `visits ${result.interactions.visitedRegions.length}, recruits ${result.interactions.recruitedUnits.length}, `
      + `chests ${result.interactions.openedChests.length}, doors ${result.interactions.openedDoors.length}`,
    `simulation ${result.elapsedMs.toFixed(1)} ms, replay ${result.replay.length} steps`,
  ].join('\n');
}

function formatManifestSummary(manifest: SeedManifest): string {
  return [
    `PRECOMMITTED ${manifest.split.toUpperCase()} SEED MANIFEST — ${manifest.scenario}`,
    `${manifest.seeds.length} deterministic seeds; no filtering or seed optimization`,
    `scenario ${manifest.scenarioFingerprint.instanceSha256}`,
    `manifest ${manifest.fingerprint}`,
  ].join('\n');
}

function formatPolicySummary(report: PolicyEvaluationReport): string {
  const aggregate = report.aggregate;
  return [
    `GLOBAL POLICY ${report.manifestSplit.toUpperCase()} — ${report.scenario}`,
    `${aggregate.clears}/${aggregate.seeds} clears (${(aggregate.solveCoverage * 100).toFixed(1)}%); every manifest seed reported`,
    `${aggregate.seedsWithDeaths} seeds with deaths, ${aggregate.totalDeaths} total deaths`,
    `damage worst ${aggregate.worstDamage}, CVaR-95 ${aggregate.cvar95Damage.toFixed(3)}, mean ${aggregate.meanDamage.toFixed(3)}`,
    `mean ${aggregate.meanTurns.toFixed(3)} turns, ${aggregate.meanActions.toFixed(3)} actions`,
    `global score [${report.score.join(', ')}]`,
    `manifest ${report.manifestFingerprint}`,
    `policy ${report.policyFingerprint}`,
  ].join('\n');
}

function formatTrainingSummary(training: PolicyTrainingReport): string {
  const selection = training.selectedPolicy.selection;
  return [
    `GLOBAL POLICY TRAINING — ${training.scenario}`,
    `${training.iterations} training-only iterations; ${training.checkpoints.length} validation checkpoints`,
    `selected checkpoint ${selection?.selectedCheckpointIteration ?? 0}`,
    `train score [${selection?.trainScore.join(', ') ?? ''}]`,
    `validation score [${selection?.validationScore.join(', ') ?? ''}]`,
    `policy ${training.selectedPolicy.fingerprint}`,
    'held-out test seeds were not loaded or evaluated',
  ].join('\n');
}

function formatSeedSolveSummary(report: SeedSolveReport): string {
  const failures = report.runs.filter((run) => run.status !== 'clear');
  return [
    `PER-SEED ${report.mode.toUpperCase()} FARM — ${report.scenario}`,
    `${report.solvedSeeds}/${report.attemptedSeeds} seeds solved (${(report.solveCoverage * 100).toFixed(1)}% coverage)`,
    `${failures.length} failures/unknowns/errors retained in the report`,
    `manifest ${report.manifestFingerprint}`,
    'Routes are per-seed best-found witnesses unless proof status says exhaustive infeasible.',
  ].join('\n');
}

function printHelp(): void {
  console.log(`Fire Emblem level solver\n\n` +
    `  npm run solver -- inspect [--scenario FILE] [--project PATH]\n` +
    `  npm run solver -- run [--seed N] [--policy FILE] [--out FILE] [--html FILE] [--json]\n` +
    `  npm run solver -- plan --scenario FILE [--solution FILE | --policy FILE] [--beam-width N] [--branch-limit N]\n` +
    `                         [--max-nodes N] [--damage-frontier 0..1] [--max-deaths N]\n` +
    `                         [--max-damage N] [--prefix FILE] [--solution-out FILE] [--html FILE]\n` +
    `  npm run solver -- prove --scenario FILE --max-damage N [--max-deaths N]\n` +
    `                          [--max-nodes N] [--prefix FILE] [--solution FILE | --policy FILE]\n` +
    `  npm run solver -- solve [--iterations N] [--workers N] [--solution FILE | --policy FILE] [--solution-out FILE] [--html FILE] [--fragment FILE]\n` +
    `  npm run solver -- verify --solution FILE\n\n` +
    `  npm run solver -- refresh --scenario FILE --solution FILE --solution-out FILE\n\n` +
    `Global seed-agnostic policy pipeline:\n` +
    `  npm run solver -- create-seed-manifest --scenario FILE --split train|validation|test --count N --out FILE\n` +
    `  npm run solver -- evaluate-policy --scenario FILE --seed-manifest FILE [--policy FILE] [--workers N] --out FILE\n` +
    `  npm run solver -- train-policy --scenario FILE --train-seeds FILE --validation-seeds FILE [--policy FILE] --iterations N --out POLICY [--results FILE]\n` +
    `  npm run solver -- verify-policy --scenario FILE --test-seeds FILE --policy FILE [--workers N] --out FILE\n` +
    `  npm run solver -- solve-seeds --scenario FILE --seed-manifest FILE [--planner beam|proof] [--workers N] --out FILE\n` +
    `  npm run solver -- report-policy --results FILE --html FILE [--replays-dir DIR]\n\n` +
    `The scenario seed is a fixed benchmark input. --policy imports only heuristic weights and never trusts stale metrics. ` +
    `refresh revalidates every action before migrating an old plan. Non-benchmark RNG diagnostics require both ` +
    `--seed-range A:B and --allow-seed-search.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
