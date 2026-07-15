/**
 * Deterministic pseudo-random source used by gameplay systems.
 *
 * The default source delegates to Math.random so normal browser play keeps its
 * existing behaviour. Tests, the harness, and the solver can install a seed and
 * reproduce the exact combat/growth roll stream.
 */

export type RandomSource = () => number;

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = SeededRandom.normalizeSeed(seed);
  }

  static normalizeSeed(seed: number): number {
    if (!Number.isFinite(seed)) return 0x6d2b79f5;
    return Math.trunc(seed) >>> 0;
  }

  /** Mulberry32: compact, fast, and stable across JS runtimes. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  }

  getState(): number {
    return this.state >>> 0;
  }

  setState(state: number): void {
    this.state = SeededRandom.normalizeSeed(state);
  }
}

let seeded: SeededRandom | null = null;

export function random(): number {
  return seeded ? seeded.next() : Math.random();
}

export function setRandomSeed(seed: number): void {
  seeded = new SeededRandom(seed);
}

export function clearRandomSeed(): void {
  seeded = null;
}

export function getRandomState(): number | null {
  return seeded?.getState() ?? null;
}
