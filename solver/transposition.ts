import type { SearchCost } from './types';

export type TranspositionDecision = 'accepted' | 'duplicate' | 'dominated' | 'improved';

/**
 * Retain the Pareto-minimal costs that reached each exact future state.
 * Tactical identity (including RNG) is supplied separately from path cost so
 * an otherwise identical route with extra deaths, damage, or actions cannot
 * occupy another cache entry.
 */
export class DominanceTranspositionTable {
  private entries: Map<string, SearchCost[]> = new Map();
  private labels: number = 0;

  consider(key: string, candidate: SearchCost): TranspositionDecision {
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, [{ ...candidate }]);
      this.labels++;
      return 'accepted';
    }

    for (const label of existing) {
      if (equalCost(label, candidate)) return 'duplicate';
      if (dominates(label, candidate)) return 'dominated';
    }

    const retained = existing.filter((label) => !dominates(candidate, label));
    const removed = existing.length - retained.length;
    retained.push({ ...candidate });
    this.entries.set(key, retained);
    this.labels += 1 - removed;
    return removed > 0 ? 'improved' : 'accepted';
  }

  get stateCount(): number {
    return this.entries.size;
  }

  get labelCount(): number {
    return this.labels;
  }
}

export function dominates(a: SearchCost, b: SearchCost): boolean {
  return a.playerDeaths <= b.playerDeaths
    && a.damageTaken <= b.damageTaken
    && a.actions <= b.actions
    && (a.playerDeaths < b.playerDeaths
      || a.damageTaken < b.damageTaken
      || a.actions < b.actions);
}

function equalCost(a: SearchCost, b: SearchCost): boolean {
  return a.playerDeaths === b.playerDeaths
    && a.damageTaken === b.damageTaken
    && a.actions === b.actions;
}
