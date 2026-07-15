#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { beamSearchFixedSeed, replayPlannedSolution } from './beam-search';
import { loadSolverProject } from './project-loader';
import { searchPolicyParallel, searchSeedRangeParallel } from './parallel-search';
import { compareResults, searchPolicy, searchSeedRange } from './search';
import { DEFAULT_POLICY, TacticalSimulator } from './simulator';
import type { PolicyWeights, SolverResult, SolverScenario } from './types';
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
  maxMovesPerUnit: number;
  maxAttacksPerUnit: number;
  maxHealsPerUnit: number;
  outputPath?: string;
  solutionOutputPath?: string;
  htmlPath?: string;
  fragmentPath?: string;
  solutionPath?: string;
  json: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    printHelp();
    return;
  }

  const scenario = await readScenario(options.scenarioPath);
  if (options.seed !== undefined) scenario.seed = options.seed;
  if (options.maxTurns !== undefined) scenario.maxTurns = options.maxTurns;
  const projectPath = await resolveProjectPath(options.projectPath ?? scenario.project);
  const { db } = await loadSolverProject(projectPath);

  if (options.command === 'inspect') {
    const simulator = new TacticalSimulator(db, scenario);
    console.log(`${scenario.name}\nproject: ${projectPath}\nlevel: ${scenario.levelNid}\nseed: ${scenario.seed}\n`);
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
    if (options.allowSeedSearch) scenario.seed = saved.seed;
    const rerun = saved.plan
      ? replayPlannedSolution(db, scenario, saved.policy, saved.plan)
      : new TacticalSimulator(db, scenario, saved.policy).run();
    const matches = compareResults(rerun, saved) === 0 && JSON.stringify(rerun.metrics) === JSON.stringify(saved.metrics);
    console.log(formatSummary(rerun));
    if (!matches) throw new Error(`Verification mismatch: saved [${saved.score}] rerun [${rerun.score}]`);
    console.log('verification: deterministic replay matches saved solution');
    return;
  }

  let result: SolverResult;
  if (options.command === 'plan') {
    if (options.allowSeedSearch || options.seedRange) {
      throw new Error('plan searches actions for exactly one fixed seed; seed search is not supported');
    }
    let startingPolicy: PolicyWeights = DEFAULT_POLICY;
    if (options.solutionPath) {
      const saved = JSON.parse(await readFile(path.resolve(options.solutionPath), 'utf8')) as SolverResult;
      assertFixedSeed(scenario.seed, saved.seed, options);
      startingPolicy = saved.policy;
    }
    let reportedTurn = 0;
    const planned = beamSearchFixedSeed(db, scenario, startingPolicy, {
      beamWidth: options.beamWidth,
      branchLimit: options.branchLimit,
      maxNodes: options.maxNodes,
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
    });
    result = planned.result;
    console.error(
      `beam complete: ${planned.stats.nodesGenerated} nodes, ${planned.stats.cacheHits} cache hits, `
      + `peak ${planned.stats.frontierPeak}, incumbent ${planned.stats.incumbentSource}`,
    );
  } else if (options.command === 'solve') {
    let startingPolicy: PolicyWeights = DEFAULT_POLICY;
    if (options.solutionPath) {
      const saved = JSON.parse(await readFile(path.resolve(options.solutionPath), 'utf8')) as SolverResult;
      assertFixedSeed(scenario.seed, saved.seed, options);
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
    result = new TacticalSimulator(db, scenario).run();
  } else {
    throw new Error(`Unknown command: ${options.command}`);
  }

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
    maxMovesPerUnit: 4,
    maxAttacksPerUnit: 4,
    maxHealsPerUnit: 2,
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
    else if (arg === '--max-moves-per-unit') { options.maxMovesPerUnit = Number(required(value, arg)); index++; }
    else if (arg === '--max-attacks-per-unit') { options.maxAttacksPerUnit = Number(required(value, arg)); index++; }
    else if (arg === '--max-heals-per-unit') { options.maxHealsPerUnit = Number(required(value, arg)); index++; }
    else if (arg === '--out') { options.outputPath = required(value, arg); index++; }
    else if (arg === '--solution-out') { options.solutionOutputPath = required(value, arg); index++; }
    else if (arg === '--html') { options.htmlPath = required(value, arg); index++; }
    else if (arg === '--fragment') { options.fragmentPath = required(value, arg); index++; }
    else if (arg === '--solution') { options.solutionPath = required(value, arg); index++; }
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.command = 'help';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
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

async function writeJson(filename: string, result: SolverResult): Promise<void> {
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
  };
  await writeFile(resolved, `${JSON.stringify(compact, null, 2)}\n`, 'utf8');
}

function formatSummary(result: SolverResult): string {
  const metrics = result.metrics;
  return [
    `${metrics.cleared ? 'CLEAR' : metrics.lost ? 'LOSS' : 'INCOMPLETE'} — ${result.scenario}`,
    `objective ${result.objective}, seed ${result.seed} (${result.rngMode}), score [${result.score.join(', ')}]`,
    `${metrics.turns} turns, ${metrics.actions} actions, ${metrics.combats} combats`,
    `${metrics.damageTaken} damage taken, ${metrics.healingReceived} healed, ${metrics.playerDeaths} player deaths`,
    `${metrics.enemiesDefeated} enemies defeated, ${metrics.wallsBroken} walls broken`,
    `simulation ${result.elapsedMs.toFixed(1)} ms, replay ${result.replay.length} steps`,
  ].join('\n');
}

function printHelp(): void {
  console.log(`Fire Emblem level solver\n\n` +
    `  npm run solver -- inspect [--scenario FILE] [--project PATH]\n` +
    `  npm run solver -- run [--seed N] [--out FILE] [--html FILE] [--json]\n` +
    `  npm run solver -- plan --scenario FILE [--solution FILE] [--beam-width N] [--branch-limit N]\n` +
    `                         [--max-nodes N] [--solution-out FILE] [--html FILE]\n` +
    `  npm run solver -- solve [--iterations N] [--workers N] [--solution FILE] [--solution-out FILE] [--html FILE] [--fragment FILE]\n` +
    `  npm run solver -- verify --solution FILE\n\n` +
    `The scenario seed is a fixed benchmark input. Non-benchmark RNG diagnostics require both --seed-range A:B and --allow-seed-search.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
