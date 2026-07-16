import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';
import type { GameBoard } from '../objects/game-board';
import * as calcs from './combat-calcs';
import * as skillSystem from './skill-system';
import { random, type RandomSource } from '../engine/random';

// ============================================================
// CombatPhaseSolver - Resolves a full combat encounter into a
// sequence of strikes.
// Matches LT's CombatPhaseSolver from app/engine/combat/solver.py
// Now with vantage, desperation, and full skill dispatch.
// ============================================================

export type RngMode = 'classic' | 'true_hit' | 'true_hit_plus' | 'grandmaster';

export interface CombatStrike {
  attacker: UnitObject;
  defender: UnitObject;
  item: ItemObject;
  hit: boolean;
  crit: boolean;
  damage: number;
  isCounter: boolean;
}

/** Valid CombatScript tokens for interact_unit. */
export type ScriptToken = 'hit1' | 'hit2' | 'crit1' | 'crit2' | 'miss1' | 'miss2' | '--' | 'end';

export class CombatPhaseSolver {
  private strikes: CombatStrike[];
  private randomSource: RandomSource;

  constructor(randomSource: RandomSource = random) {
    this.strikes = [];
    this.randomSource = randomSource;
  }

  /**
   * Resolve a scripted combat encounter (from interact_unit).
   * The script is an ordered list of tokens that control both:
   *   (a) which side strikes next, and
   *   (b) whether the strike is forced hit/crit/miss.
   *
   * Tokens:
   *   hit1/crit1/miss1 → attacker (unit 1) strikes with forced outcome
   *   hit2/crit2/miss2 → defender (unit 2) strikes with forced outcome
   *   '--' → next natural strike (uses normal combat ordering + RNG)
   *   'end' → terminate combat immediately
   *
   * When the script is exhausted, remaining natural strikes play out
   * if there are any.
   */
  resolveScripted(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
    script: string[],
    board?: GameBoard | null,
  ): CombatStrike[] {
    this.strikes = [];
    let attackerHp = attacker.currentHp;
    let defenderHp = defender.currentHp;
    const atkHp = { hp: attackerHp };
    const defHp = { hp: defenderHp };

    // Process each script token
    for (const rawToken of script) {
      const token = rawToken.toLowerCase().trim();
      if (token === 'end') break;
      if (atkHp.hp <= 0 || defHp.hp <= 0) break;

      if (token === '--') {
        // Natural strike: use normal resolution for the next expected strike.
        // For simplicity, default to attacker if no script context.
        // (In Python this falls through to the state machine's normal logic,
        // but for our pre-computed approach we just do one attacker strike.)
        const strike = this.resolveStrike(attacker, attackItem, defender, db, rngMode, false, board);
        this.strikes.push(strike);
        if (strike.hit) defHp.hp -= strike.damage;
      } else if (token === 'hit1' || token === 'crit1' || token === 'miss1') {
        // Attacker strikes with forced outcome
        const strike = this.resolveScriptedStrike(
          attacker, attackItem, defender, db, false, token, board,
        );
        this.strikes.push(strike);
        if (strike.hit) defHp.hp -= strike.damage;
      } else if (token === 'hit2' || token === 'crit2' || token === 'miss2') {
        // Defender strikes with forced outcome
        if (!defenseItem) continue; // Defender can't strike without a weapon
        const strike = this.resolveScriptedStrike(
          defender, defenseItem, attacker, db, true, token, board,
        );
        this.strikes.push(strike);
        if (strike.hit) atkHp.hp -= strike.damage;
      }
    }

    return this.strikes;
  }

  /**
   * Resolve a single strike with a forced outcome from a script token.
   */
  private resolveScriptedStrike(
    striker: UnitObject,
    item: ItemObject,
    target: UnitObject,
    db: Database,
    isCounter: boolean,
    token: string,
    board?: GameBoard | null,
  ): CombatStrike {
    const defWeapon = target.getEquippedWeapon();
    const wt = calcs.weaponTriangle(item, defWeapon, db, striker);

    const isMiss = token.startsWith('miss');
    const isCrit = token.startsWith('crit');
    const hit = !isMiss;
    const crit = isCrit;

    let dmg = 0;
    if (hit) {
      const baseDmg = calcs.computeDamage(striker, item, target, db, board);
      dmg = baseDmg + wt.damageBonus;
      if (crit) {
        const critDmgMod = skillSystem.modifyCritDamage(striker, item);
        const baseCritMult = 3;
        dmg = dmg * baseCritMult + critDmgMod;
      }
      dmg = Math.max(0, dmg);
    }

    return { attacker: striker, defender: target, item, hit, crit, damage: dmg, isCounter };
  }

  /**
   * Resolve a complete combat encounter.
   * Returns an ordered array of all strikes that should occur.
   *
   * Standard strike order:
   *   1. Attacker strikes (x brave)
   *   2. Defender counter (if able) (x brave)
   *   3. Attacker double (if speed check passes) (x brave)
   *   4. Defender double counter (if speed + defDouble) (x brave)
   *
   * Modified by:
   *   - Vantage: defender strikes first if they have vantage
   *   - Desperation: attacker does all strikes before counter
   *   - Disvantage: attacker goes second (opposite of vantage)
   *
   * If `script` is provided, uses resolveScripted() instead of
   * the normal combat flow.
   */
  resolve(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
    board?: GameBoard | null,
    script?: string[] | null,
  ): CombatStrike[] {
    // If a combat script is provided, use scripted resolution
    if (script && script.length > 0) {
      return this.resolveScripted(attacker, attackItem, defender, defenseItem, db, rngMode, script, board);
    }
    this.strikes = [];

    // Track simulated HP for lethality checks (stop attacking dead units)
    let attackerHp = attacker.currentHp;
    let defenderHp = defender.currentHp;

    // Determine capabilities
    const defenderCanCounter = calcs.canCounterattack(attacker, attackItem, defender, db);
    const attackerDoubles = calcs.canDouble(attacker, attackItem, defender, defenseItem, db);
    const defenderDoubles =
      defenderCanCounter && defenseItem
        ? calcs.canDefenderDouble(attacker, attackItem, defender, defenseItem, db)
        : false;

    // Compute strike counts (brave weapons, dynamic multiattacks from skills)
    const attackerStrikeCount = calcs.computeStrikeCount(
      attacker, attackItem, defender, defenseItem,
    );
    const defenderStrikeCount = defenseItem
      ? calcs.computeStrikeCount(defender, defenseItem, attacker, attackItem)
      : 1;

    // Check for skill-based ordering
    const defenderHasVantage = defenderCanCounter && defenseItem &&
      skillSystem.vantage(defender) && !skillSystem.disvantage(attacker);
    const attackerHasDesperation = skillSystem.desperation(attacker);
    const attackerHasDisvantage = skillSystem.disvantage(attacker) &&
      !skillSystem.vantage(attacker);

    // Check ignoreDyingInCombat (miracle)
    const attackerMiracle = skillSystem.ignoreDyingInCombat(attacker);
    const defenderMiracle = skillSystem.ignoreDyingInCombat(defender);

    // Helper: execute a series of strikes for one side
    const doStrikes = (
      striker: UnitObject,
      item: ItemObject,
      target: UnitObject,
      count: number,
      isCounter: boolean,
      strikerHpRef: { hp: number },
      targetHpRef: { hp: number },
      targetMiracle: boolean,
    ) => {
      for (let i = 0; i < count; i++) {
        if (targetHpRef.hp <= 0) break;
        if (strikerHpRef.hp <= 0) break;
        const strike = this.resolveStrike(striker, item, target, db, rngMode, isCounter, board);
        this.strikes.push(strike);
        if (strike.hit) {
          targetHpRef.hp -= strike.damage;
          // Miracle: target survives at 1 HP if they would die
          if (targetMiracle && targetHpRef.hp <= 0) {
            targetHpRef.hp = 1;
          }
        }
      }
    };

    const atkHp = { hp: attackerHp };
    const defHp = { hp: defenderHp };

    // ---- Determine strike ordering based on skills ----

    if (defenderHasVantage && defenseItem) {
      // VANTAGE: Defender strikes first
      // 1. Defender initial counter
      doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);

      // 2. Attacker strikes (all if desperation, normal otherwise)
      if (attackerHasDesperation) {
        // Desperation: attacker does initial + double together
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
        if (attackerDoubles) {
          doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
        }
      } else {
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      }

      // 3. Defender double counter (if not desperation, which already went)
      if (!attackerHasDesperation && defenderDoubles) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
      }

      // 4. Attacker double (if not desperation, which already went)
      if (!attackerHasDesperation && attackerDoubles) {
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      }

      // 5. If desperation, defender double counter last
      if (attackerHasDesperation && defenderDoubles) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
      }

    } else if (attackerHasDisvantage && defenderCanCounter && defenseItem) {
      // DISVANTAGE: Attacker goes second (similar to vantage but without being a skill on the defender)
      doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
      doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      if (defenderDoubles) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
      }
      if (attackerDoubles) {
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      }

    } else if (attackerHasDesperation) {
      // DESPERATION: All attacker strikes before any counter
      // 1. Attacker initial + double
      doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      if (attackerDoubles) {
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      }

      // 2. Defender counter
      if (defenderCanCounter && defenseItem) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
        // 3. Defender double counter
        if (defenderDoubles) {
          doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
        }
      }

    } else {
      // STANDARD: attacker -> counter -> attacker double -> counter double
      // 1. Attacker initial strikes
      doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);

      // 2. Defender counter
      if (defenderCanCounter && defenseItem) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
      }

      // 3. Attacker double
      if (attackerDoubles) {
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      }

      // 4. Defender double counter
      if (defenderDoubles && defenseItem) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
      }
    }

    return this.strikes;
  }

  /**
   * Roll for hit based on RNG mode.
   *
   * - classic: single RN, random(0..99) < hitChance
   * - true_hit: average of 2 RNs (standard Fire Emblem 2-RN system)
   * - true_hit_plus: average of 3 RNs
   * - grandmaster: always hits
   */
  private rollHit(hitChance: number, rngMode: RngMode): boolean {
    switch (rngMode) {
      case 'grandmaster':
        return true;

      case 'true_hit': {
        const r1 = Math.floor(this.randomSource() * 100);
        const r2 = Math.floor(this.randomSource() * 100);
        return (r1 + r2) / 2 < hitChance;
      }

      case 'true_hit_plus': {
        const r1 = Math.floor(this.randomSource() * 100);
        const r2 = Math.floor(this.randomSource() * 100);
        const r3 = Math.floor(this.randomSource() * 100);
        return (r1 + r2 + r3) / 3 < hitChance;
      }

      case 'classic':
      default: {
        return Math.floor(this.randomSource() * 100) < hitChance;
      }
    }
  }

  /**
   * Generate a single strike result.
   * Computes hit chance, crit chance, then rolls and determines damage.
   */
  private resolveStrike(
    striker: UnitObject,
    item: ItemObject,
    target: UnitObject,
    db: Database,
    rngMode: RngMode,
    isCounter: boolean,
    board?: GameBoard | null,
  ): CombatStrike {
    // Compute hit chance with weapon triangle bonus
    const defWeapon = target.getEquippedWeapon();
    const baseHit = calcs.computeHit(striker, item, target, db, board);
    const wt = calcs.weaponTriangle(item, defWeapon, db, striker);
    const finalHit = Math.max(0, Math.min(100, baseHit + wt.hitBonus));

    // Compute crit chance
    let critChance = calcs.computeCrit(striker, item, target, db);

    // critAnyway skill: ensure at least some crit chance
    if (skillSystem.critAnyway(striker) && critChance <= 0) {
      critChance = 1; // Minimal crit chance if skill is active
    }

    // Roll for hit
    const hit = this.rollHit(finalHit, rngMode);

    // Roll for crit (only if hit lands)
    const crit = hit ? Math.floor(this.randomSource() * 100) < critChance : false;

    // Compute damage (0 on miss)
    let dmg = 0;
    if (hit) {
      const baseDmg = calcs.computeDamage(striker, item, target, db, board);
      dmg = baseDmg + wt.damageBonus;

      // Crit damage
      if (crit) {
        const critDmgMod = skillSystem.modifyCritDamage(striker, item);
        const baseCritMult = 3; // LT default
        dmg = dmg * baseCritMult + critDmgMod;
      }

      dmg = Math.max(0, dmg);
    }

    return {
      attacker: striker,
      defender: target,
      item,
      hit,
      crit,
      damage: dmg,
      isCounter,
    };
  }
}
