import type { Database } from '../data/database';
import type { UnitObject } from '../objects/unit';

export interface CombatExperienceResult {
  expGained: number;
  levelUps: Record<string, number>[];
}

/** Current shared web-engine combat EXP formula. */
export function calculateCombatExp(
  attacker: UnitObject,
  defender: UnitObject,
  attackerDead: boolean,
  defenderDead: boolean,
): number {
  if (attackerDead) return 0;
  const levelScale = Math.max(0.1, 1 + (defender.level - attacker.level) * 0.1);
  let exp = Math.round(30 * levelScale);
  if (defenderDead) exp += Math.round(50 * levelScale);
  return Math.max(1, Math.min(100, exp));
}

/** Grant combat EXP and consume deterministic growth rolls on level-up. */
export function grantCombatExperience(
  attacker: UnitObject,
  defender: UnitObject,
  attackerDead: boolean,
  defenderDead: boolean,
  db: Database,
  randomSource?: () => number,
): CombatExperienceResult {
  const expGained = calculateCombatExp(attacker, defender, attackerDead, defenderDead);
  const levelUps: Record<string, number>[] = [];
  if (attackerDead || attacker.team !== 'player' || expGained <= 0) {
    return { expGained, levelUps };
  }

  attacker.exp += expGained;
  const growthMode = (db.getConstant('growths_choice', 'random') as string) || 'random';
  while (attacker.exp >= 100) {
    attacker.exp -= 100;
    levelUps.push(attacker.levelUp(growthMode, randomSource));
  }
  return { expGained, levelUps };
}
