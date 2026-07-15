import type { Database } from '../src/data/database';
import { SeededRandom } from '../src/engine/random';
import { DEFAULT_POLICY, TacticalSimulator } from './simulator';
import type { PolicyWeights, SearchOptions, SolverResult, SolverScenario } from './types';

const NUMERIC_KEYS: Array<Exclude<keyof PolicyWeights, 'unitBias' | 'unitRisk'>> = [
  'kill',
  'bossKill',
  'damage',
  'counterDamage',
  'lethalRisk',
  'progress',
  'danger',
  'wall',
  'heal',
  'stayHealthy',
];

export function compareResults(a: SolverResult, b: SolverResult): number {
  const length = Math.max(a.score.length, b.score.length);
  for (let index = 0; index < length; index++) {
    const aValue = a.score[index] ?? 0;
    const bValue = b.score[index] ?? 0;
    if (aValue !== bValue) return aValue - bValue;
  }
  return 0;
}

export function mutatePolicy(base: PolicyWeights, rng: SeededRandom, scale = 0.45): PolicyWeights {
  const next: PolicyWeights = {
    ...base,
    unitBias: { ...base.unitBias },
    unitRisk: { ...(base.unitRisk ?? {}) },
  };
  const mutationCount = 1 + Math.floor(rng.next() * 4);

  for (let mutation = 0; mutation < mutationCount; mutation++) {
    const mutationType = rng.next();
    if (mutationType < 0.65) {
      const key = NUMERIC_KEYS[Math.floor(rng.next() * NUMERIC_KEYS.length)];
      const factor = Math.exp((rng.next() * 2 - 1) * scale);
      next[key] = Math.max(0.001, Math.min(5000, next[key] * factor));
    } else if (mutationType < 0.83) {
      const units = Object.keys(next.unitBias);
      if (units.length > 0) {
        const unit = units[Math.floor(rng.next() * units.length)];
        next.unitBias[unit] = Math.max(-100, Math.min(100, (next.unitBias[unit] ?? 0) + (rng.next() * 2 - 1) * 12));
      }
    } else {
      const unitRisk = next.unitRisk ?? {};
      const units = Object.keys(unitRisk);
      if (units.length > 0) {
        const unit = units[Math.floor(rng.next() * units.length)];
        const factor = Math.exp((rng.next() * 2 - 1) * scale);
        unitRisk[unit] = Math.max(0.05, Math.min(20, (unitRisk[unit] ?? 1) * factor));
      }
    }
  }
  return next;
}

export function randomPolicy(rng: SeededRandom): PolicyWeights {
  let policy: PolicyWeights = {
    ...DEFAULT_POLICY,
    unitBias: { ...DEFAULT_POLICY.unitBias },
    unitRisk: { ...(DEFAULT_POLICY.unitRisk ?? {}) },
  };
  for (let index = 0; index < 12; index++) policy = mutatePolicy(policy, rng, 1.1);
  return policy;
}

export function searchPolicy(
  db: Database,
  scenario: SolverScenario,
  options: SearchOptions,
  initialPolicy: PolicyWeights = DEFAULT_POLICY,
): SolverResult {
  const shardIndex = options.shardIndex ?? 0;
  const shardCount = Math.max(1, options.shardCount ?? 1);
  const rng = new SeededRandom(options.searchSeed + Math.imul(shardIndex + 1, 0x9e3779b1));

  let incumbent = new TacticalSimulator(db, scenario, initialPolicy).run();
  let best = incumbent;
  options.onImprovement?.(best, 0);

  for (let localIteration = 1; localIteration <= options.iterations; localIteration++) {
    const globalIteration = shardIndex + localIteration * shardCount;
    const restart = globalIteration % 29 === 0;
    const source = restart ? randomPolicy(rng) : incumbent.policy;
    const scale = restart ? 0.8 : Math.max(0.12, 0.55 * (1 - localIteration / Math.max(1, options.iterations)));
    const candidatePolicy = mutatePolicy(source, rng, scale);
    const candidate = new TacticalSimulator(db, scenario, candidatePolicy).run();

    if (compareResults(candidate, incumbent) <= 0 || rng.next() < 0.015) incumbent = candidate;
    if (compareResults(candidate, best) < 0) {
      best = candidate;
      options.onImprovement?.(best, globalIteration);
    }
  }
  return best;
}

export function searchSeedRange(
  db: Database,
  scenario: SolverScenario,
  fromSeed: number,
  toSeed: number,
  policy: PolicyWeights = DEFAULT_POLICY,
): SolverResult {
  let best: SolverResult | null = null;
  const start = Math.min(fromSeed, toSeed);
  const end = Math.max(fromSeed, toSeed);
  for (let seed = start; seed <= end; seed++) {
    const candidate = new TacticalSimulator(db, { ...scenario, seed }, policy).run();
    if (!best || compareResults(candidate, best) < 0) best = candidate;
  }
  if (!best) throw new Error('Seed range is empty');
  return best;
}
