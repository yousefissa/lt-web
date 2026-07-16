import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';
import type { GameBoard } from '../objects/game-board';
import * as itemSystem from './item-system';
import * as skillSystem from './skill-system';
import { getTerrainBonusesForUnit } from './terrain-bonuses';
import type { SupportEffect } from '../engine/support-system';

// ============================================================
// CombatCalcs - All combat calculation formulas.
// Matches LT's combat_calcs.py formulas.
// Now wired through item-system.ts and skill-system.ts dispatch.
// ============================================================

// ------------------------------------------------------------------
// Stat name tokens recognised in equation strings
// ------------------------------------------------------------------

const STAT_NAMES = [
  'HP', 'STR', 'MAG', 'SKL', 'SPD', 'LCK', 'DEF', 'RES', 'CON', 'MOV',
];

// ------------------------------------------------------------------
// Lazy game/db reference for equation context
// ------------------------------------------------------------------

let _eqGameRef: (() => any) | null = null;

/** Set the game reference getter for equation evaluation context. */
export function setEquationGameRef(getter: () => any): void {
  _eqGameRef = getter;
}

// ------------------------------------------------------------------
// Expression evaluator
// ------------------------------------------------------------------

/**
 * Extended equation evaluation context. When provided, allows equations
 * to reference other named equations, game constants, query functions,
 * and additional variables beyond bare stat tokens.
 */
interface EquationContext {
  /** Secondary unit for two-unit equations (e.g., combat formulas). */
  unit2?: UnitObject | null;
  /** Specific item context (e.g., for item component expressions). */
  item?: ItemObject | null;
  /** Database for equation/constant lookups. */
  db?: Database | null;
}

/**
 * Evaluate an equation string with stat substitution and extended context.
 *
 * Supports:
 *   - Stat token substitution: HP, STR, MAG, ... → unit stat values
 *   - Python ternary: `X if COND else Y`
 *   - Python integer division: `a // b` → `Math.floor(a/b)`
 *   - Named equation references: equation names → recursive evaluation
 *   - `max()`, `min()`, `abs()`, `int()`, `float()` builtins
 *   - `unit.level`, `unit.klass`, `unit.get_internal_level()` access
 *   - `clamp(value, lo, hi)` utility
 *   - Game constants via `DB.constants.value('name')` pattern
 */
export function evaluateEquation(
  expr: string,
  unit: UnitObject,
  ctx?: EquationContext,
): number {
  let processed = expr;

  // Handle Python ternary: "X if COND else Y" -> JS ternary
  const ternaryRe = /^(.+?)\s+if\s+(.+?)\s+else\s+(.+)$/;
  const ternaryMatch = processed.match(ternaryRe);
  if (ternaryMatch) {
    const valueExpr = ternaryMatch[1].trim();
    const condExpr = ternaryMatch[2].trim();
    const elseExpr = ternaryMatch[3].trim();

    const condResult = evaluateEquationCondition(condExpr, unit, ctx);
    return condResult
      ? evaluateEquation(valueExpr, unit, ctx)
      : evaluateEquation(elseExpr, unit, ctx);
  }

  // Resolve the database for equation lookups
  const db = ctx?.db ?? (_eqGameRef?.()?.db as Database | undefined) ?? null;

  // Replace named equation references FIRST (before stat substitution)
  // so that e.g. HIT (equation) doesn't collide with HIT (stat if it existed).
  // Named equations are identifiers that exist in db.equations but NOT in STAT_NAMES.
  if (db) {
    const eqNames = db.getEquationNames?.() ?? [];
    // Sort longest-first to avoid partial matches
    const sortedEqs = [...eqNames].sort((a, b) => b.length - a.length);
    for (const eqName of sortedEqs) {
      // Don't replace stat names — those are handled below
      if (STAT_NAMES.includes(eqName)) continue;
      const re = new RegExp(`\\b${eqName}\\b`, 'g');
      if (re.test(processed)) {
        // Avoid infinite recursion: only resolve if the equation differs
        const eqExpr = db.getEquation(eqName);
        if (eqExpr && eqExpr !== expr) {
          const eqValue = evaluateEquation(eqExpr, unit, ctx);
          processed = processed.replace(re, String(eqValue));
        }
      }
    }
  }

  // Replace stat tokens with their numeric values
  const sortedStats = [...STAT_NAMES].sort((a, b) => b.length - a.length);
  for (const stat of sortedStats) {
    const re = new RegExp(`\\b${stat}\\b`, 'g');
    processed = processed.replace(re, String(unit.getStatValue(stat)));
  }

  // Replace unit.level, unit.klass, etc. with actual values
  processed = processed.replace(/\bunit\.level\b/g, String(unit.level));
  processed = processed.replace(/\bunit\.klass\b/g, `"${unit.klass}"`);
  processed = processed.replace(
    /\bunit\.get_internal_level\s*\(\s*\)/g,
    String(_getInternalLevel(unit, db)),
  );

  // Replace DB.constants.value('name') with the constant value
  if (db) {
    processed = processed.replace(
      /\bDB\.constants\.value\s*\(\s*['"](.+?)['"]\s*\)/g,
      (_m, constName) => {
        const val = db.getConstant(constName, 0);
        return typeof val === 'number' ? String(val) : `"${val}"`;
      },
    );
  }

  // Convert Python-style integer division `//` to Math.floor
  processed = processed.replace(
    /(\b[\d.]+)\s*\/\/\s*([\d.]+\b)/g,
    (_match, a, b) => `Math.floor((${a})/(${b}))`,
  );

  // Wrap bare max/min/abs/int/float with Math/JS equivalents
  processed = processed.replace(/(?<!Math\.)(?<![\w.])\bmax\b/g, 'Math.max');
  processed = processed.replace(/(?<!Math\.)(?<![\w.])\bmin\b/g, 'Math.min');
  processed = processed.replace(/(?<!Math\.)(?<![\w.])\babs\b/g, 'Math.abs');
  // Python int() -> Math.floor()
  processed = processed.replace(/(?<![\w.])\bint\s*\(/g, 'Math.floor(');
  // Python float() -> Number()
  processed = processed.replace(/(?<![\w.])\bfloat\s*\(/g, 'Number(');

  try {
    // Build evaluation context with clamp utility and math
    const clamp = (val: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, val));
    const fn = new Function(
      'Math', 'clamp',
      `"use strict"; return (${processed});`,
    );
    const result = fn(Math, clamp);
    return typeof result === 'number' && Number.isFinite(result)
      ? Math.floor(result)
      : 0;
  } catch {
    console.warn(`CombatCalcs: failed to evaluate equation "${expr}" -> "${processed}"`);
    return 0;
  }
}

/** Helper: compute a unit's internal level (accounting for promotion tiers). */
function _getInternalLevel(unit: UnitObject, db: Database | null): number {
  if (!db) return unit.level;
  const klassDef = db.classes?.get(unit.klass);
  if (!klassDef) return unit.level;
  const tier = klassDef.tier ?? 0;
  if (tier > 0) {
    // For promoted classes, add the max level of the base (unpromoted) tier
    const maxLevel = db.getConstant('max_level', 20) as number;
    return unit.level + maxLevel * tier;
  }
  return unit.level;
}

/**
 * Evaluate a condition within an equation expression.
 * Handles: tag membership, boolean literals, comparisons, unit properties.
 */
function evaluateEquationCondition(
  cond: string,
  unit: UnitObject,
  ctx?: EquationContext,
): boolean {
  // 'Tag' in unit.tags
  const inTagsMatch = cond.match(/^['"](.+?)['"]\s+in\s+unit\.tags$/);
  if (inTagsMatch) {
    return unit.tags?.includes(inTagsMatch[1]) ?? false;
  }

  // 'Tag' not in unit.tags
  const notInTagsMatch = cond.match(/^['"](.+?)['"]\s+not\s+in\s+unit\.tags$/);
  if (notInTagsMatch) {
    return !(unit.tags?.includes(notInTagsMatch[1]) ?? false);
  }

  // Boolean literals
  if (cond === 'True' || cond === 'true') return true;
  if (cond === 'False' || cond === 'false') return false;

  // unit.klass == 'ClassName'
  const klassMatch = cond.match(/^unit\.klass\s*(==|!=)\s*['"](.+?)['"]$/);
  if (klassMatch) {
    const eq = klassMatch[1] === '==';
    return eq ? unit.klass === klassMatch[2] : unit.klass !== klassMatch[2];
  }

  // Simple numeric comparison: LHS op RHS (after stat substitution)
  const compMatch = cond.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (compMatch) {
    const lhs = evaluateEquation(compMatch[1].trim(), unit, ctx);
    const rhs = evaluateEquation(compMatch[3].trim(), unit, ctx);
    switch (compMatch[2]) {
      case '==': return lhs === rhs;
      case '!=': return lhs !== rhs;
      case '>': return lhs > rhs;
      case '<': return lhs < rhs;
      case '>=': return lhs >= rhs;
      case '<=': return lhs <= rhs;
    }
  }

  console.warn(`CombatCalcs: unknown equation condition "${cond}"`);
  return true;
}

// ------------------------------------------------------------------
// Helper: resolve an equation from the DB, falling back to a default
// ------------------------------------------------------------------

function resolveEquation(
  db: Database,
  eqName: string,
  defaultExpr: string,
  unit: UnitObject,
): number {
  const expr = db.getEquation(eqName) ?? defaultExpr;
  return evaluateEquation(expr, unit, { db });
}

// ------------------------------------------------------------------
// Damage type helpers
// ------------------------------------------------------------------

export function isMagic(item: ItemObject): boolean {
  // LT's `magic` component replaces DAMAGE/DEFENSE with their magic
  // equations. `magic_at_range` stays physical at melee and applies its
  // formula swap dynamically only beyond range 1.
  if (item.hasComponent('magic')) {
    return true;
  }
  const wtype = item.getWeaponType();
  if (wtype) {
    const lower = wtype.toLowerCase();
    if (
      lower === 'dark' ||
      lower === 'light' ||
      lower === 'anima' ||
      lower === 'tome' ||
      lower === 'fire' ||
      lower === 'thunder' ||
      lower === 'wind' ||
      lower === 'staff'
    ) {
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------
// Core formulas (now with component dispatch)
// ------------------------------------------------------------------

/** Calculate hit rate for an attacker. */
export function accuracy(unit: UnitObject, item: ItemObject, db: Database): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.accuracyFormula(unit);
  const eqName = formulaOverride ?? 'HIT';

  const baseHit = resolveEquation(db, eqName, 'SKL * 2 + LCK // 2', unit);
  const itemHit = item.getHit();

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyAccuracy(unit, item);
  const skillMod = skillSystem.modifyAccuracy(unit, item);

  return baseHit + itemHit + itemMod + skillMod;
}

/** Calculate avoid for a defender. */
export function avoid(unit: UnitObject, db: Database, board?: GameBoard | null): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.avoidFormula(unit);
  const eqName = formulaOverride ?? 'AVOID';

  // Avoid uses AS (attack speed), which factors in equipped weapon weight.
  const equippedWeapon = unit.getEquippedWeapon();
  const weaponWeight = equippedWeapon ? equippedWeapon.getWeight() : 0;
  const spd = unit.getStatValue('SPD');
  const con = unit.getStatValue('CON');
  const as = spd - Math.max(0, weaponWeight - con);

  const avoidExpr = db.getEquation(eqName) ?? 'SPD * 2 + LCK // 2';
  // Replace SPD with AS value in the avoid formula
  const processed = avoidExpr.replace(/\bSPD\b/g, String(as));
  const baseAvoid = evaluateEquation(processed, unit);

  // Add skill static modifier
  const skillMod = skillSystem.modifyAvoid(unit, equippedWeapon);

  // Add terrain avoid bonus
  const terrainAvo = board ? getTerrainBonusesForUnit(unit, board, db)[1] : 0;

  return baseAvoid + skillMod + terrainAvo;
}

/** Calculate damage output. */
export function damage(unit: UnitObject, item: ItemObject, db: Database): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.damageFormula(unit);

  const magic = isMagic(item);
  const defaultExpr = magic ? 'MAG' : 'STR';
  const eqName = formulaOverride ?? (magic ? 'MAGIC_DAMAGE' : 'DAMAGE');
  const baseDmg = resolveEquation(db, eqName, defaultExpr, unit);
  const itemDmg = item.getDamage();

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyDamage(unit, item);
  const skillMod = skillSystem.modifyDamage(unit, item);

  return baseDmg + itemDmg + itemMod + skillMod;
}

/** Calculate defense/resistance against an incoming attack item. */
export function defense(unit: UnitObject, attackItem: ItemObject, db: Database, board?: GameBoard | null): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.resistFormula(unit);

  const magic = isMagic(attackItem);
  const defaultExpr = magic ? 'RES' : 'DEF';
  const eqName = formulaOverride ?? (magic ? 'MAGIC_DEFENSE' : 'DEFENSE');
  const baseDef = resolveEquation(db, eqName, defaultExpr, unit);

  // Add skill static modifier for resist
  const skillMod = skillSystem.modifyResist(unit, null);

  // Add terrain defense bonus (only for physical attacks)
  const terrainDef = (!magic && board) ? getTerrainBonusesForUnit(unit, board, db)[0] : 0;

  return baseDef + skillMod + terrainDef;
}

/** Calculate attack speed (for doubling checks). */
export function attackSpeed(unit: UnitObject, item: ItemObject, db: Database): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.attackSpeedFormula(unit);

  const spd = unit.getStatValue('SPD');
  const con = unit.getStatValue('CON');
  const weight = item.getWeight();

  let baseAS: number;

  // Try DB equation first
  const asExpr = db.getEquation(formulaOverride ?? 'ATTACK_SPEED');
  if (asExpr) {
    // Replace 'weight' token if present
    const processed = asExpr.replace(/\bweight\b/gi, String(weight));
    baseAS = evaluateEquation(processed, unit);
  } else {
    // Default: SPD - max(0, weight - CON)
    baseAS = spd - Math.max(0, weight - con);
  }

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyAttackSpeed(unit, item);
  const skillMod = skillSystem.modifyAttackSpeed(unit, item);

  return baseAS + itemMod + skillMod;
}

/** Calculate defense speed (for doubling checks on the defender side). */
export function defenseSpeed(unit: UnitObject, item: ItemObject, db: Database): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.defenseSpeedFormula(unit);

  // If there's a dedicated defense speed formula, use it; otherwise same as attack speed
  const asExpr = db.getEquation(formulaOverride ?? 'DEFENSE_SPEED');
  if (asExpr) {
    const weight = item.getWeight();
    const processed = asExpr.replace(/\bweight\b/gi, String(weight));
    const base = evaluateEquation(processed, unit);
    const skillMod = skillSystem.modifyDefenseSpeed(unit, item);
    return base + skillMod;
  }

  // Fallback: use attack speed + defense speed modifier from skills
  const base = attackSpeed(unit, item, db);
  const defSpeedMod = skillSystem.modifyDefenseSpeed(unit, item);
  return base + defSpeedMod;
}

// ------------------------------------------------------------------
// Composite formulas (with dynamic modifiers + multipliers)
// ------------------------------------------------------------------

/**
 * Compute final hit chance (attacker accuracy - defender avoid, clamped 0-100).
 * Includes dynamic modifiers from items and skills, plus support bonuses.
 */
export function computeHit(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
  board?: GameBoard | null,
  game?: any,
): number {
  const acc = accuracy(attacker, attackItem, db);
  const avo = avoid(defender, db, board);

  // Dynamic modifiers from items and skills (combat context)
  const defWeapon = defender.getEquippedWeapon();
  const itemDynAcc = itemSystem.dynamicAccuracy(attacker, attackItem, defender, defWeapon, 'attack', null, acc);
  const skillDynAcc = skillSystem.dynamicAccuracy(attacker, attackItem, defender, defWeapon, 'attack', null, acc);
  const skillDynAvo = skillSystem.dynamicAvoid(defender, defWeapon, attacker, attackItem, 'defense', null, avo);

  // Support bonuses
  const atkSupport = getSupportBonusForCombat(attacker, game);
  const defSupport = getSupportBonusForCombat(defender, game);

  const raw = acc + itemDynAcc + skillDynAcc + atkSupport.accuracy - avo - skillDynAvo - defSupport.avoid;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Compute final damage (attacker damage - defender defense, min 0).
 * Includes dynamic modifiers, effective damage, multipliers, and support bonuses.
 */
export function computeDamage(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
  board?: GameBoard | null,
  game?: any,
): number {
  const atk = damage(attacker, attackItem, db);
  const def = defense(defender, attackItem, db, board);

  // Dynamic modifiers from items and skills
  const defWeapon = defender.getEquippedWeapon();
  const baseDmg = atk - def;

  const itemDynDmg = itemSystem.dynamicDamage(attacker, attackItem, defender, defWeapon, 'attack', null, baseDmg);
  const skillDynDmg = skillSystem.dynamicDamage(attacker, attackItem, defender, defWeapon, 'attack', null, baseDmg);
  const skillDynResist = skillSystem.dynamicResist(defender, defWeapon, attacker, attackItem, 'defense', null, def);

  // Support bonuses
  const atkSupport = getSupportBonusForCombat(attacker, game);
  const defSupport = getSupportBonusForCombat(defender, game);

  let finalDmg = baseDmg + itemDynDmg + skillDynDmg - skillDynResist + atkSupport.damage - defSupport.resist;

  // Apply damage multiplier from attacker skills
  const dmgMult = skillSystem.damageMultiplier(attacker, attackItem, defender, defWeapon, 'attack', null, finalDmg);
  finalDmg = Math.floor(finalDmg * dmgMult);

  // Apply resist multiplier from defender skills
  const resMult = skillSystem.resistMultiplier(defender, defWeapon, attacker, attackItem, 'defense', null, finalDmg);
  if (resMult !== 1) {
    finalDmg = Math.floor(finalDmg / resMult);
  }

  return Math.max(0, finalDmg);
}

/**
 * Check if attacker doubles defender.
 * Now checks item canDouble and skill noDouble/defDouble.
 */
export function canDouble(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  defenseItem: ItemObject | null,
  db: Database,
): boolean {
  // Item can't double? (e.g., cannot_double component)
  if (!itemSystem.canDouble(attacker, attackItem)) return false;

  // Skill prevents doubling?
  if (skillSystem.noDouble(attacker)) return false;

  const attackerAS = attackSpeed(attacker, attackItem, db);

  // Use defense speed for the defender's side
  const defenderWeapon = defenseItem ?? defender.getEquippedWeapon();
  const defenderAS = defenderWeapon
    ? defenseSpeed(defender, defenderWeapon, db)
    : defender.getStatValue('SPD');

  const thresholdExpr = db.getEquation('SPEED_TO_DOUBLE');
  const threshold = thresholdExpr ? evaluateEquation(thresholdExpr, attacker) : 4;

  return attackerAS - defenderAS >= threshold;
}

/**
 * Check if defender can counter-double (double on the counter).
 * Only possible if defender has defDouble skill or via normal speed comparison.
 */
export function canDefenderDouble(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  defenseItem: ItemObject,
  db: Database,
): boolean {
  // defDouble skill allows the defender to double
  if (skillSystem.defDouble(defender)) {
    return canDouble(defender, defenseItem, attacker, attackItem, db);
  }
  // Standard: defender can double if their AS exceeds the attacker's
  return canDouble(defender, defenseItem, attacker, attackItem, db);
}

/**
 * Check if defender can counterattack.
 * Now checks distant_counter, close_counter, and item canCounter/canBeCountered.
 */
export function canCounterattack(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  _db: Database,
): boolean {
  // Check if attacker's weapon can't be countered
  if (!itemSystem.canBeCountered(attacker, attackItem)) return false;

  // Check if defender's skills prevent countering
  if (!skillSystem.canCounter(defender)) return false;

  // Find the defender's equipped weapon
  const defWeapon = defender.getEquippedWeapon();
  if (!defWeapon) return false;

  // Check if the weapon itself can counter
  if (!itemSystem.canCounter(defender, defWeapon)) return false;

  // Compute the Manhattan distance between the two units
  const aPos = attacker.position;
  const dPos = defender.position;
  if (!aPos || !dPos) return false;

  const dist = Math.abs(aPos[0] - dPos[0]) + Math.abs(aPos[1] - dPos[1]);

  // Check if defender has distant_counter (can counter at any range)
  if (skillSystem.distantCounter(defender)) return true;

  // Check if defender has close_counter (can counter at range 1 with ranged weapon)
  if (dist === 1 && skillSystem.closeCounter(defender)) return true;

  // Standard range check: defender can counter if distance is within their weapon's range
  const minRange = defWeapon.getMinRange();
  const maxRange = defWeapon.getMaxRange();
  return dist >= minRange && dist <= maxRange;
}

/**
 * Get weapon triangle advantage bonus.
 * Now checks ignoreWeaponAdvantage from items.
 */
export function weaponTriangle(
  attackItem: ItemObject,
  defenseItem: ItemObject | null,
  db: Database,
  attacker?: UnitObject,
): { hitBonus: number; damageBonus: number } {
  const noBonus = { hitBonus: 0, damageBonus: 0 };
  if (!defenseItem) return noBonus;

  // Check if either item ignores weapon advantage
  if (attacker && itemSystem.ignoreWeaponAdvantage(attacker, attackItem)) return noBonus;

  const atkType = attackItem.getWeaponType();
  const defType = defenseItem.getWeaponType();
  if (!atkType || !defType) return noBonus;

  // Look up the attacker's weapon type definition
  const atkWeaponDef = db.weapons.find((w) => w.nid === atkType);
  if (!atkWeaponDef) return noBonus;

  // Check advantages
  for (const adv of atkWeaponDef.advantage) {
    if (adv.weapon_type === defType) {
      return {
        hitBonus: parseNumericValue(adv.accuracy),
        damageBonus: parseNumericValue(adv.damage),
      };
    }
  }

  // Check disadvantages
  // Note: disadvantage entries already store negative values in the data
  // (e.g. damage: "-1", accuracy: "-15"), so we use them directly.
  for (const dis of atkWeaponDef.disadvantage) {
    if (dis.weapon_type === defType) {
      return {
        hitBonus: parseNumericValue(dis.accuracy),
        damageBonus: parseNumericValue(dis.damage),
      };
    }
  }

  return noBonus;
}

/** Parse a numeric value from a weapon advantage string (may be a number or equation). */
function parseNumericValue(value: string): number {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  return 0;
}

/**
 * Compute crit rate.
 * Crit = attacker crit - defender crit avoid, clamped 0-100.
 * Now includes item + skill crit modifiers and support bonuses.
 */
export function computeCrit(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
  game?: any,
): number {
  const baseCrit = resolveEquation(db, 'CRIT', 'SKL // 2', attacker);
  const itemCrit = attackItem.getComponent<number>('crit') ?? 0;
  const critAvoid = resolveEquation(db, 'CRIT_AVOID', 'LCK', defender);

  // Skill modifiers
  const skillCritAcc = skillSystem.modifyCritAccuracy(attacker, attackItem);
  const skillCritAvo = skillSystem.modifyCritAvoid(defender, null);

  // Item crit modifier
  const itemCritMod = itemSystem.modifyCritAccuracy(attacker, attackItem);

  // Support bonuses
  const atkSupport = getSupportBonusForCombat(attacker, game);
  const defSupport = getSupportBonusForCombat(defender, game);

  const raw = baseCrit + itemCrit + skillCritAcc + itemCritMod + atkSupport.crit
    - critAvoid - skillCritAvo - defSupport.dodge;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Compute the number of strikes for one side (base + brave + dynamic multiattacks).
 */
export function computeStrikeCount(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  defenseItem: ItemObject | null,
): number {
  let count = 1;

  // Brave from items
  const itemExtra = itemSystem.dynamicMultiattacks(unit, item, target, defenseItem, 'attack', null, 0);
  count += itemExtra;

  // Dynamic multiattacks from skills
  const skillExtra = skillSystem.dynamicMultiattacks(unit, item, target, defenseItem, 'attack', null, 0);
  count += skillExtra;

  return count;
}

// ------------------------------------------------------------------
// Support bonus helper
// ------------------------------------------------------------------

const EMPTY_SUPPORT_EFFECT: SupportEffect = {
  damage: 0, resist: 0, accuracy: 0, avoid: 0,
  crit: 0, dodge: 0, attack_speed: 0, defense_speed: 0,
};

/**
 * Get the aggregate support bonus for a unit in combat.
 * Calls the SupportController if available, otherwise returns zeros.
 */
export function getSupportBonusForCombat(unit: UnitObject, game?: any): SupportEffect {
  if (!game?.supports) return EMPTY_SUPPORT_EFFECT;
  try {
    return game.supports.getSupportRankBonus(unit, game.board, game.db, game);
  } catch {
    return EMPTY_SUPPORT_EFFECT;
  }
}

// ------------------------------------------------------------------
// Legacy convenience wrappers (used by AI / other subsystems)
// ------------------------------------------------------------------

/** Get the unit's explicit equipped weapon, auto-equipping if needed. */
export function getEquippedWeapon(unit: UnitObject): ItemObject | null {
  return unit.getEquippedWeapon();
}
