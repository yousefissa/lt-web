/**
 * skill_system.ts — Dispatch layer for skill component hooks.
 *
 * Mirrors LT's generated skill_system.py. For each hook, iterates all
 * skills on a unit and resolves results via the appropriate policy.
 *
 * Skills are stored as SkillObject[] on UnitObject. Each SkillObject
 * has a components: Map<string, any>.
 */

import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';

// ============================================================
// Helper: iterate all skill components that define a given hook
// ============================================================

function getSkillValue<T>(unit: UnitObject, componentNid: string): T | undefined {
  for (const skill of unit.skills) {
    if (skill.hasComponent(componentNid)) {
      return skill.getComponent<T>(componentNid);
    }
  }
  return undefined;
}

function hasAnySkill(unit: UnitObject, componentNid: string): boolean {
  return unit.skills.some(s => s.hasComponent(componentNid));
}

/** Sum all numeric values for a component across all skills. */
function sumSkillValues(unit: UnitObject, componentNid: string): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>(componentNid);
    if (typeof val === 'number') total += val;
  }
  return total;
}

/** Sum values from LT's serialized component NID and an optional hook alias. */
function sumSkillAliases(unit: UnitObject, ...componentNids: string[]): number {
  return componentNids.reduce((total, nid) => total + sumSkillValues(unit, nid), 0);
}

/** Product of all numeric values for a component across all skills. */
function productSkillValues(unit: UnitObject, componentNid: string, defaultVal: number = 1): number {
  let result = defaultVal;
  let found = false;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>(componentNid);
    if (typeof val === 'number') {
      result *= val;
      found = true;
    }
  }
  return found ? result : defaultVal;
}

// ============================================================
// Boolean hooks (ALL_DEFAULT_FALSE)
// ============================================================

/** Unit attacks first regardless of speed. */
export function vantage(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'vantage');
}

/** Unit performs all attacks before enemy retaliates. */
export function desperation(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'desperation');
}

/** Unit cannot double. */
export function noDouble(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'no_double');
}

/** Defender can double (even though normally only attackers can). */
export function defDouble(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'def_double');
}

/** Can always crit, even if crit is disabled globally. */
export function critAnyway(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'crit_anyway');
}

/** Unit ignores terrain costs. */
export function ignoreTerrain(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'ignore_terrain');
}

/** Unit can counter at any range. */
export function distantCounter(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'distant_counter');
}

/** Unit can counter at range 1 even with ranged weapon. */
export function closeCounter(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'close_counter');
}

/** Unit should not move after attacking (no canto override). */
export function noAttackAfterMove(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'no_attack_after_move');
}

/** Pass through terrain (flying). */
export function passThrough(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'pass_through');
}

/** Attacker goes second (opposite of vantage). */
export function disvantage(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'disvantage');
}

/** Unit persists at 0 HP during combat (miracle-like). */
export function ignoreDyingInCombat(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'ignore_dying_in_combat');
}

// ============================================================
// Boolean hooks (ALL_DEFAULT_TRUE)
// ============================================================

/** Can this unit counter? (Default true unless a skill disables it.) */
export function canCounter(unit: UnitObject): boolean {
  for (const skill of unit.skills) {
    if (skill.hasComponent('cannot_counter')) return false;
  }
  return true;
}

// ============================================================
// Boolean hooks (ANY_DEFAULT_FALSE)
// ============================================================

/** Does the unit have canto? */
export function hasCanto(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'canto');
}

// ============================================================
// Stat change hooks
// ============================================================

/**
 * Get the total stat change bonus from all skills for a given stat.
 * Skills with 'stat_change' component store [[statNid, amount], ...].
 */
export function statChange(unit: UnitObject, statNid: string): number {
  let total = 0;
  for (const skill of unit.skills) {
    const changes = skill.getComponent<any>('stat_change');
    if (Array.isArray(changes)) {
      for (const entry of changes) {
        if (Array.isArray(entry) && entry[0] === statNid && typeof entry[1] === 'number') {
          total += entry[1];
        }
      }
    }
  }
  return total;
}

/**
 * Get the total growth change bonus from all skills for a given stat.
 */
export function growthChange(unit: UnitObject, statNid: string): number {
  let total = 0;
  for (const skill of unit.skills) {
    const changes = skill.getComponent<any>('growth_change');
    if (Array.isArray(changes)) {
      for (const entry of changes) {
        if (Array.isArray(entry) && entry[0] === statNid && typeof entry[1] === 'number') {
          total += entry[1];
        }
      }
    }
  }
  return total;
}

// ============================================================
// Static modifier hooks (NUMERIC_ACCUM)
// ============================================================

/** Bonus damage from skills. */
export function modifyDamage(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillAliases(unit, 'damage', 'modify_damage');
}

/** Bonus resist from skills. */
export function modifyResist(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillAliases(unit, 'resist', 'modify_resist');
}

/** Bonus accuracy from skills. */
export function modifyAccuracy(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillAliases(unit, 'hit', 'modify_accuracy');
}

/** Bonus avoid from skills. */
export function modifyAvoid(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillAliases(unit, 'avoid', 'modify_avoid');
}

/** Bonus crit accuracy from skills. */
export function modifyCritAccuracy(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillAliases(unit, 'crit', 'modify_crit_accuracy');
}

/** Bonus crit avoid from skills. */
export function modifyCritAvoid(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillAliases(unit, 'crit_avoid', 'modify_crit_avoid');
}

/** Bonus crit damage from skills. */
export function modifyCritDamage(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillValues(unit, 'modify_crit_damage');
}

/** Attack speed modifier from skills. */
export function modifyAttackSpeed(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillAliases(unit, 'attack_speed', 'modify_attack_speed');
}

/** Defense speed modifier from skills. */
export function modifyDefenseSpeed(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillAliases(unit, 'defense_speed', 'modify_defense_speed');
}

// ============================================================
// Dynamic modifier hooks (NUMERIC_ACCUM with combat context)
// ============================================================

/** Dynamic damage modifier (situational bonuses). */
export function dynamicDamage(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>('dynamic_damage');
    if (typeof val === 'number') total += val;
  }
  return total;
}

/** Dynamic resist modifier. */
export function dynamicResist(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>('dynamic_resist');
    if (typeof val === 'number') total += val;
  }
  return total;
}

/** Dynamic accuracy modifier. */
export function dynamicAccuracy(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>('dynamic_accuracy');
    if (typeof val === 'number') total += val;
  }
  return total;
}

/** Dynamic avoid modifier. */
export function dynamicAvoid(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>('dynamic_avoid');
    if (typeof val === 'number') total += val;
  }
  return total;
}

/** Dynamic extra attacks from skills. */
export function dynamicMultiattacks(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>('dynamic_multiattacks');
    if (typeof val === 'number') total += val;
  }
  return total;
}

// ============================================================
// Multiplier hooks (NUMERIC_MULTIPLY)
// ============================================================

/** Final damage multiplier (product of all). */
export function damageMultiplier(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  return productSkillValues(unit, 'damage_multiplier');
}

/** Final resist multiplier (product of all). */
export function resistMultiplier(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  return productSkillValues(unit, 'resist_multiplier');
}

// ============================================================
// Formula hooks (UNIQUE — override the default formula name)
// ============================================================

/** Override the damage formula name. Default: null (use standard). */
export function damageFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'damage_formula');
}

/** Override the resist formula name. */
export function resistFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'resist_formula');
}

/** Override the accuracy formula name. */
export function accuracyFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'accuracy_formula');
}

/** Override the avoid formula name. */
export function avoidFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'avoid_formula');
}

/** Override the attack speed formula name. */
export function attackSpeedFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'attack_speed_formula');
}

/** Override the defense speed formula name. */
export function defenseSpeedFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'defense_speed_formula');
}

// ============================================================
// Exp / WExp multipliers (UNIQUE, default 1)
// ============================================================

export function expMultiplier(unit: UnitObject, _target: UnitObject): number {
  return getSkillValue<number>(unit, 'exp_multiplier') ?? 1;
}

export function wexpMultiplier(unit: UnitObject, _target: UnitObject): number {
  return getSkillValue<number>(unit, 'wexp_multiplier') ?? 1;
}

// ============================================================
// Fog of War — Sight Range
// ============================================================

/**
 * Get the total sight range bonus from all skills on a unit.
 *
 * Checks for 'sight_range_bonus' (flat bonus) and
 * 'decreasing_sight_range_bonus' (bonus that decreases by 1 each turn,
 * tracked via skill data 'torch_counter').
 *
 * Port of LT's sight_range hook in skill_components/base_components.py.
 */
export function sightRange(unit: UnitObject): number {
  let total = 0;
  for (const skill of unit.skills) {
    // Flat sight range bonus
    const flatBonus = skill.getComponent<number>('sight_range_bonus');
    if (typeof flatBonus === 'number') {
      total += flatBonus;
    }

    // Decreasing sight range bonus (torch effect)
    const decBonus = skill.getComponent<number>('decreasing_sight_range_bonus');
    if (typeof decBonus === 'number') {
      const counter = (skill.data.get('torch_counter') as number) ?? 0;
      total += Math.max(0, decBonus - counter);
    }
  }
  return total;
}
