import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';
import type { GameBoard } from '../objects/game-board';
import type { CombatStrike } from './combat-solver';
import { CombatPhaseSolver, type RngMode } from './combat-solver';
import { consumeCombatItemUses } from './combat-uses';

// ============================================================
// MapCombat - Manages the visual presentation of combat on the
// map.  Shows health bar changes, hit/miss effects frame by
// frame.
// ============================================================

export type MapCombatState = 'init' | 'strike' | 'hp_change' | 'waiting' | 'cleanup' | 'done';

/** Detailed combat results returned by applyResults(). */
export interface CombatResults {
  attackerDead: boolean;
  defenderDead: boolean;
  expGained: number;
  /** Stat gains from each level-up (may be empty). */
  levelUps: Record<string, number>[];
  /** Whether the attacker's weapon broke. */
  attackWeaponBroke: boolean;
  /** Whether the defender's weapon broke. */
  defenseWeaponBroke: boolean;
  /** Item dropped by the defender on death, or null. */
  droppedItem: import('../objects/item').ItemObject | null;
}

/** Duration constants (milliseconds) */
const INIT_DURATION_MS = 150;  // Pre-combat pause
const STRIKE_DURATION_MS = 130; // Lunge + strike animation
const HP_DRAIN_DURATION_MS = 250; // HP bar drain animation
const WAITING_DURATION_MS = 80;  // Pause between strikes
const CLEANUP_DURATION_MS = 180; // Pause before done

/** Animation sub-timings within STRIKE phase (ms) */
const LUNGE_DURATION_MS = 80;  // Attacker moves toward defender
const LUNGE_RETURN_MS = 50;    // Attacker snaps back

/** Shake animation during HP drain */
const SHAKE_FREQUENCY = 40;    // ms per oscillation
const SHAKE_AMPLITUDE = 2;     // pixels

/** Floating damage number */
export interface DamagePopup {
  x: number;         // tile x
  y: number;         // tile y
  value: number;     // damage amount (0 = miss)
  isCrit: boolean;
  elapsed: number;   // ms since spawn
  duration: number;  // total lifetime ms
}

/** Per-unit animation offsets for rendering */
export interface CombatAnimState {
  /** Pixel offset for lunge animation [dx, dy] */
  lungeOffset: [number, number];
  /** Pixel offset for hit-shake [dx, dy] */
  shakeOffset: [number, number];
  /** Flash alpha (0 = no flash, 1 = full white overlay) */
  flashAlpha: number;
}

export class MapCombat {
  attacker: UnitObject;
  defender: UnitObject;
  attackItem: ItemObject;
  defenseItem: ItemObject | null;
  strikes: CombatStrike[];

  state: MapCombatState;
  currentStrikeIndex: number;
  frameTimer: number;

  // HP display state (for animated HP drain)
  attackerDisplayHp: number;
  defenderDisplayHp: number;

  // Internal targets for HP animation
  private attackerTargetHp: number;
  private defenderTargetHp: number;
  private hpDrainElapsed: number;
  private hpDrainStartAttacker: number;
  private hpDrainStartDefender: number;

  // Snapshot of real HP before combat (for result calculation)
  private attackerStartHp: number;
  private defenderStartHp: number;

  // Reference to DB for exp calculation
  private db: Database;

  // Animation state for rendering
  attackerAnim: CombatAnimState;
  defenderAnim: CombatAnimState;
  damagePopups: DamagePopup[];

  // Audio (optional, set after construction to enable combat SFX)
  audioManager: { playSfx(name: string): void } | null = null;
  private hitSoundPlayed: boolean = false;

  constructor(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
    board?: GameBoard | null,
    script?: string[] | null,
  ) {
    this.attacker = attacker;
    this.attackItem = attackItem;
    this.defender = defender;
    this.defenseItem = defenseItem;
    this.db = db;

    // Solve the combat to get the strike sequence
    const solver = new CombatPhaseSolver();
    this.strikes = solver.resolve(attacker, attackItem, defender, defenseItem, db, rngMode, board, script);

    this.state = 'init';
    this.currentStrikeIndex = 0;
    this.frameTimer = 0;

    // Initialise HP display from current unit state
    this.attackerDisplayHp = attacker.currentHp;
    this.defenderDisplayHp = defender.currentHp;
    this.attackerTargetHp = attacker.currentHp;
    this.defenderTargetHp = defender.currentHp;
    this.hpDrainElapsed = 0;
    this.hpDrainStartAttacker = attacker.currentHp;
    this.hpDrainStartDefender = defender.currentHp;

    this.attackerStartHp = attacker.currentHp;
    this.defenderStartHp = defender.currentHp;

    // Animation state
    this.attackerAnim = { lungeOffset: [0, 0], shakeOffset: [0, 0], flashAlpha: 0 };
    this.defenderAnim = { lungeOffset: [0, 0], shakeOffset: [0, 0], flashAlpha: 0 };
    this.damagePopups = [];
  }

  /** Instantly skip to the end of combat (no more animation). */
  skipToEnd(): void {
    this.state = 'done';
  }

  /**
   * Advance the combat by one frame.
   * Returns true when the combat is fully complete.
   */
  update(deltaMs: number): boolean {
    switch (this.state) {
      case 'init':
        return this.updateInit(deltaMs);
      case 'strike':
        return this.updateStrike(deltaMs);
      case 'hp_change':
        return this.updateHpChange(deltaMs);
      case 'waiting':
        return this.updateWaiting(deltaMs);
      case 'cleanup':
        return this.updateCleanup(deltaMs);
      case 'done':
        return true;
    }
  }

  /** Get the current combat state for rendering. */
  getRenderState(): {
    state: MapCombatState;
    currentStrike: CombatStrike | null;
    attackerHp: number;
    defenderHp: number;
    attackerMaxHp: number;
    defenderMaxHp: number;
    attackerAnim: CombatAnimState;
    defenderAnim: CombatAnimState;
    damagePopups: DamagePopup[];
  } {
    const strike =
      this.currentStrikeIndex < this.strikes.length
        ? this.strikes[this.currentStrikeIndex]
        : null;

    return {
      state: this.state,
      currentStrike: strike,
      attackerHp: Math.max(0, Math.round(this.attackerDisplayHp)),
      defenderHp: Math.max(0, Math.round(this.defenderDisplayHp)),
      attackerMaxHp: this.attacker.maxHp,
      defenderMaxHp: this.defender.maxHp,
      attackerAnim: this.attackerAnim,
      defenderAnim: this.defenderAnim,
      damagePopups: this.damagePopups,
    };
  }

  /**
   * Apply final combat results to units (HP changes, death, exp, weapon uses).
   * Should be called once after the combat is done.
   *
   * Returns detailed results including stat gains from level-ups and
   * weapon breakage information.
   */
  applyResults(): CombatResults {
    // Walk through all strikes and apply HP changes to actual units
    let atkHp = this.attackerStartHp;
    let defHp = this.defenderStartHp;
    let attackerStrikeCount = 0;
    let defenderStrikeCount = 0;

    for (const strike of this.strikes) {
      if (strike.attacker === this.attacker) {
        attackerStrikeCount++;
      } else {
        defenderStrikeCount++;
      }

      if (!strike.hit) continue;

      if (strike.attacker === this.attacker) {
        defHp -= strike.damage;
      } else {
        atkHp -= strike.damage;
      }
    }

    // Clamp HP
    atkHp = Math.max(0, atkHp);
    defHp = Math.max(0, defHp);

    // Apply to units
    this.attacker.currentHp = atkHp;
    this.defender.currentHp = defHp;

    const attackerDead = atkHp <= 0;
    const defenderDead = defHp <= 0;

    if (attackerDead) {
      this.attacker.dead = true;
    }
    if (defenderDead) {
      this.defender.dead = true;
    }

    // Decrement weapon uses
    let attackWeaponBroke = false;
    let defenseWeaponBroke = false;

    if (attackerStrikeCount > 0) {
      attackWeaponBroke = consumeCombatItemUses(this.attacker, this.attackItem, this.strikes);
    }

    if (defenderStrikeCount > 0 && this.defenseItem) {
      defenseWeaponBroke = consumeCombatItemUses(this.defender, this.defenseItem, this.strikes);
    }

    // Calculate EXP
    const expGained = this.calculateExp(attackerDead, defenderDead);

    // Grant EXP and perform level-ups with growth rolls
    let levelUps: Record<string, number>[] = [];
    const growthMode = (this.db.getConstant('growths_choice', 'random') as string) || 'random';

    if (!attackerDead && this.attacker.team === 'player' && expGained > 0) {
      this.attacker.exp += expGained;
      while (this.attacker.exp >= 100) {
        this.attacker.exp -= 100;
        const gains = this.attacker.levelUp(growthMode);
        levelUps.push(gains);
      }
    }

    // Check for droppable items from dead defender
    let droppedItem: import('../objects/item').ItemObject | null = null;
    if (defenderDead && !attackerDead) {
      for (const item of this.defender.items) {
        if (item.droppable) {
          droppedItem = item;
          break;
        }
      }
    }

    return {
      attackerDead,
      defenderDead,
      expGained,
      levelUps,
      attackWeaponBroke,
      defenseWeaponBroke,
      droppedItem,
    };
  }

  // ------------------------------------------------------------------
  // State update methods
  // ------------------------------------------------------------------

  private updateInit(deltaMs: number): boolean {
    this.frameTimer += deltaMs;
    if (this.frameTimer >= INIT_DURATION_MS) {
      this.frameTimer = 0;

      if (this.strikes.length === 0) {
        this.state = 'cleanup';
      } else {
        this.state = 'strike';
      }
    }
    return false;
  }

  private updateStrike(deltaMs: number): boolean {
    this.frameTimer += deltaMs;

    // Compute lunge animation: attacker moves toward defender
    const strike = this.strikes[this.currentStrikeIndex];
    if (strike) {
      const isAttackerStriking = (strike.attacker === this.attacker);
      const strikerAnim = isAttackerStriking ? this.attackerAnim : this.defenderAnim;
      const targetAnim = isAttackerStriking ? this.defenderAnim : this.attackerAnim;

      // Compute direction from striker to target (in tile coords)
      const strikerUnit = strike.attacker;
      const targetUnit = strike.defender;
      if (strikerUnit.position && targetUnit.position) {
        const dx = targetUnit.position[0] - strikerUnit.position[0];
        const dy = targetUnit.position[1] - strikerUnit.position[1];
        const dist = Math.abs(dx) + Math.abs(dy);
        const ndx = dist > 0 ? dx / dist : 0;
        const ndy = dist > 0 ? dy / dist : 0;

        if (this.frameTimer <= LUNGE_DURATION_MS) {
          // Lunge forward
          const t = this.frameTimer / LUNGE_DURATION_MS;
          const lungePixels = 6; // max pixels to lunge
          strikerAnim.lungeOffset = [ndx * lungePixels * t, ndy * lungePixels * t];
        } else {
          // Snap back
          const returnT = (this.frameTimer - LUNGE_DURATION_MS) / LUNGE_RETURN_MS;
          const lungePixels = 6;
          const eased = Math.min(1, returnT);
          strikerAnim.lungeOffset = [ndx * lungePixels * (1 - eased), ndy * lungePixels * (1 - eased)];
        }

        // Flash on the target at the moment of impact (peak of lunge)
        if (this.frameTimer >= LUNGE_DURATION_MS * 0.8 && this.frameTimer <= LUNGE_DURATION_MS * 1.2) {
          if (strike.hit) {
            targetAnim.flashAlpha = strike.crit ? 0.8 : 0.5;
          }
          // Play hit/miss sound at impact
          if (!this.hitSoundPlayed && this.audioManager) {
            this.hitSoundPlayed = true;
            if (strike.hit) {
              if (strike.crit) {
                this.audioManager.playSfx('Critical Hit 1');
              } else {
                this.audioManager.playSfx('Attack Hit ' + (Math.random() < 0.5 ? '1' : '2'));
              }
            } else {
              this.audioManager.playSfx('Attack Miss 2');
            }
          }
        } else {
          targetAnim.flashAlpha = Math.max(0, targetAnim.flashAlpha - deltaMs * 0.005);
        }
      }
    }

    if (this.frameTimer >= STRIKE_DURATION_MS) {
      this.frameTimer = 0;
      this.hitSoundPlayed = false;

      // Reset lunge offsets
      this.attackerAnim.lungeOffset = [0, 0];
      this.defenderAnim.lungeOffset = [0, 0];

      // Apply this strike's damage to display HP targets
      if (strike && strike.hit) {
        // Record drain animation start points
        this.hpDrainStartAttacker = this.attackerTargetHp;
        this.hpDrainStartDefender = this.defenderTargetHp;

        if (strike.attacker === this.attacker) {
          this.defenderTargetHp = Math.max(0, this.defenderTargetHp - strike.damage);
        } else {
          this.attackerTargetHp = Math.max(0, this.attackerTargetHp - strike.damage);
        }

        // Spawn damage popup on the defender
        const targetUnit = strike.defender;
        if (targetUnit.position) {
          this.damagePopups.push({
            x: targetUnit.position[0],
            y: targetUnit.position[1],
            value: strike.damage,
            isCrit: strike.crit,
            elapsed: 0,
            duration: 600,
          });
        }
      } else if (strike && !strike.hit) {
        // Miss - still need drain start points for the (no-op) animation
        this.hpDrainStartAttacker = this.attackerTargetHp;
        this.hpDrainStartDefender = this.defenderTargetHp;

        // Spawn "MISS" popup
        const targetUnit = strike.defender;
        if (targetUnit.position) {
          this.damagePopups.push({
            x: targetUnit.position[0],
            y: targetUnit.position[1],
            value: 0, // 0 = miss
            isCrit: false,
            elapsed: 0,
            duration: 500,
          });
        }
      } else {
        this.hpDrainStartAttacker = this.attackerTargetHp;
        this.hpDrainStartDefender = this.defenderTargetHp;
      }

      this.hpDrainElapsed = 0;
      this.state = 'hp_change';
    }
    return false;
  }

  private updateHpChange(deltaMs: number): boolean {
    this.hpDrainElapsed += deltaMs;
    const t = Math.min(1, this.hpDrainElapsed / HP_DRAIN_DURATION_MS);

    // Linearly interpolate display HP toward target
    this.attackerDisplayHp = lerp(this.hpDrainStartAttacker, this.attackerTargetHp, t);
    this.defenderDisplayHp = lerp(this.hpDrainStartDefender, this.defenderTargetHp, t);

    // Hit-shake on the unit that took damage
    const strike = this.currentStrikeIndex < this.strikes.length
      ? this.strikes[this.currentStrikeIndex]
      : null;
    if (strike && strike.hit && t < 0.6) {
      // Oscillating shake
      const shakeT = this.hpDrainElapsed / SHAKE_FREQUENCY;
      const decay = 1 - t / 0.6; // fade shake out over first 60% of drain
      const shakeX = Math.round(Math.sin(shakeT * Math.PI * 2) * SHAKE_AMPLITUDE * decay);

      const isAttackerStriking = (strike.attacker === this.attacker);
      const targetAnim = isAttackerStriking ? this.defenderAnim : this.attackerAnim;
      targetAnim.shakeOffset = [shakeX, 0];
    } else {
      // Reset shakes
      this.attackerAnim.shakeOffset = [0, 0];
      this.defenderAnim.shakeOffset = [0, 0];
    }

    // Decay flash alpha
    this.attackerAnim.flashAlpha = Math.max(0, this.attackerAnim.flashAlpha - deltaMs * 0.004);
    this.defenderAnim.flashAlpha = Math.max(0, this.defenderAnim.flashAlpha - deltaMs * 0.004);

    // Update damage popups
    this.updateDamagePopups(deltaMs);

    if (t >= 1) {
      // Snap to target
      this.attackerDisplayHp = this.attackerTargetHp;
      this.defenderDisplayHp = this.defenderTargetHp;

      // Reset shakes
      this.attackerAnim.shakeOffset = [0, 0];
      this.defenderAnim.shakeOffset = [0, 0];

      // Move to next strike or cleanup
      this.currentStrikeIndex++;
      this.frameTimer = 0;

      if (this.currentStrikeIndex >= this.strikes.length) {
        this.state = 'cleanup';
      } else if (this.attackerTargetHp <= 0 || this.defenderTargetHp <= 0) {
        // Someone died - end combat
        this.state = 'cleanup';
      } else {
        this.state = 'waiting';
      }
    }

    return false;
  }

  private updateWaiting(deltaMs: number): boolean {
    this.frameTimer += deltaMs;
    // Keep updating popups during pauses
    this.updateDamagePopups(deltaMs);
    if (this.frameTimer >= WAITING_DURATION_MS) {
      this.frameTimer = 0;
      this.state = 'strike';
    }
    return false;
  }

  private updateCleanup(deltaMs: number): boolean {
    this.frameTimer += deltaMs;
    this.updateDamagePopups(deltaMs);
    // Reset all animation offsets during cleanup
    this.attackerAnim.lungeOffset = [0, 0];
    this.attackerAnim.shakeOffset = [0, 0];
    this.defenderAnim.lungeOffset = [0, 0];
    this.defenderAnim.shakeOffset = [0, 0];
    this.attackerAnim.flashAlpha = 0;
    this.defenderAnim.flashAlpha = 0;
    if (this.frameTimer >= CLEANUP_DURATION_MS) {
      this.frameTimer = 0;
      this.state = 'done';
      return true;
    }
    return false;
  }

  /** Advance all active damage popups, removing expired ones. */
  private updateDamagePopups(deltaMs: number): void {
    for (const popup of this.damagePopups) {
      popup.elapsed += deltaMs;
    }
    this.damagePopups = this.damagePopups.filter(p => p.elapsed < p.duration);
  }

  // ------------------------------------------------------------------
  // EXP calculation
  // ------------------------------------------------------------------

  /**
   * Calculate experience gained.
   * Base 30 exp for combat, +50 bonus for kill.
   * Scaled by level difference between attacker and defender.
   */
  private calculateExp(attackerDead: boolean, defenderDead: boolean): number {
    if (attackerDead) return 0;

    const BASE_EXP = 30;
    const KILL_BONUS = 50;

    // Level difference scaling: higher-level enemies give more exp
    const levelDiff = this.defender.level - this.attacker.level;
    // Scale factor: +/- 5 exp per level difference, clamped so exp doesn't go negative
    const levelScale = Math.max(0.1, 1 + levelDiff * 0.1);

    let exp = Math.round(BASE_EXP * levelScale);

    if (defenderDead) {
      exp += Math.round(KILL_BONUS * levelScale);
    }

    // Clamp to 1..100
    return Math.max(1, Math.min(100, exp));
  }
}

// ------------------------------------------------------------------
// Utility
// ------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
