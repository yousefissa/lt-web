import type { NID, UnitPrefab, KlassDef, AlliancePair } from '../data/types';
import type { ItemObject } from './item';
import type { SkillObject } from './skill';
import { random } from '../engine/random';

/**
 * Opaque handle for whatever map-sprite representation the renderer uses.
 * Kept intentionally loose so the object layer doesn't depend on rendering.
 */
export type MapSprite = unknown;

/**
 * Runtime status effect applied to a unit.
 * Status effects have a type, optional stat modifiers, and a duration.
 */
export interface StatusEffect {
  nid: string;
  name: string;
  /** Number of turns remaining. -1 = permanent until removed. */
  turnsRemaining: number;
  /** Stat modifiers applied while the status is active. */
  statMods: Record<string, number>;
  /** Damage per turn (positive = damage, negative = healing). */
  dotDamage: number;
  /** Whether this status prevents movement. */
  immobilize: boolean;
  /** Whether this status prevents action. */
  stun: boolean;
}

/**
 * Runtime representation of a unit on the map.
 *
 * Constructed from a `UnitPrefab` (the serialised template) and the unit's
 * `KlassDef`.  Initial stat values are taken directly from the prefab's
 * bases (unique units have full stats; generic units' synthetic prefabs
 * already contain class bases).
 */
export class UnitObject {
  readonly nid: NID;
  name: string;

  position: [number, number] | null;
  team: string;
  klass: NID;
  level: number;
  exp: number;

  /** Current effective stats (from prefab bases at construction). */
  stats: Record<string, number>;
  currentHp: number;
  growths: Record<string, number>;

  /** Max stat caps from class definition. */
  maxStats: Record<string, number>;

  items: ItemObject[];
  /** Explicitly equipped weapon. Equipment does not reorder inventory in LT. */
  equippedWeapon: ItemObject | null;
  skills: SkillObject[];
  tags: string[];
  ai: NID;

  /** Accumulated weapon experience per weapon-type NID. */
  wexp: Record<string, number>;

  /** Optional renderer-managed map sprite handle. */
  sprite: MapSprite | null;

  /** Where this unit was originally placed (for Defend AI / return-home). */
  startingPosition: [number, number] | null;

  /** AI group NID (for coordinated activation). */
  aiGroup: NID;

  /** Portrait NID for this unit (used for chibi display in HUD). */
  portraitNid: NID;

  /** Affinity NID for support bonuses. */
  affinity: string;

  // -- Turn-state flags ---------------------------------------------------
  hasAttacked: boolean;
  hasMoved: boolean;
  hasTraded: boolean;
  finished: boolean;
  dead: boolean;

  // -- Rescue state -------------------------------------------------------
  /** The unit currently being carried by this unit, or null. */
  rescuing: UnitObject | null;
  /** The unit currently carrying this unit, or null. */
  rescuedBy: UnitObject | null;

  // -- Canto / post-combat movement ---------------------------------------
  /** Whether this unit has Canto (can move after attacking). */
  hasCanto: boolean;

  // -- Party membership ---------------------------------------------------
  /** Party NID this unit belongs to. Empty string if unassigned. */
  party: NID;
  /** Whether this unit persists across levels. DB-loaded units are persistent; event-spawned generics may not be. */
  persistent: boolean;

  // -- Status effects -----------------------------------------------------
  statusEffects: StatusEffect[];

  constructor(prefab: UnitPrefab, klass: KlassDef) {
    this.nid = prefab.nid;
    this.name = prefab.name;
    this.position = null;
    this.team = 'player'; // caller should set the real team
    this.klass = prefab.klass;
    this.level = prefab.level;
    this.exp = 0;

    // --- Stats: use prefab bases directly ---
    // In LT, unique units store their full base stats in the prefab.
    // Class bases are only added if the `unit_stats_as_bonus` constant is true
    // (default: false). For generic units, the caller (spawnGenericUnit) already
    // sets the synthetic prefab's bases to the class bases, so this works for
    // both cases without double-counting.
    this.stats = {};
    for (const key of Object.keys(prefab.bases)) {
      this.stats[key] = prefab.bases[key] ?? 0;
    }

    // --- HP initialisation ---
    this.currentHp = this.stats['HP'] ?? 0;

    // --- Growths: use prefab growths directly ---
    // Same logic as stats: unique units have full growths in the prefab.
    // The class has a separate `growth_bonus` field used during leveling,
    // NOT added at construction time (unless `unit_stats_as_bonus` is true).
    this.growths = {};
    for (const key of Object.keys(prefab.growths)) {
      this.growths[key] = prefab.growths[key] ?? 0;
    }

    // --- Max stat caps from class ---
    this.maxStats = { ...klass.max_stats };

    // Items and skills are populated externally after construction
    // (they require their own prefab look-ups).
    this.items = [];
    this.equippedWeapon = null;
    this.skills = [];
    this.tags = [...prefab.tags];
    this.ai = 'None';

    // --- Weapon experience ---
    // wexp_gain format: { "Sword": [usable, starting_wexp, cap], ... }
    // We store the starting wexp value for each weapon type the unit can use.
    // The `usable` flag indicates whether the class allows this weapon type.
    // The `cap` limits maximum wexp gain (not enforced at construction).
    this.wexp = {};
    for (const [wtype, entry] of Object.entries(prefab.wexp_gain)) {
      const [usable, startingWexp, _cap] = entry;
      if (usable) {
        this.wexp[wtype] = startingWexp;
      }
    }

    this.sprite = null;
    this.startingPosition = null;
    this.aiGroup = '';
    this.portraitNid = prefab.portrait_nid ?? '';
    this.affinity = prefab.affinity ?? '';
    this.hasAttacked = false;
    this.hasMoved = false;
    this.hasTraded = false;
    this.finished = false;
    this.dead = false;
    this.rescuing = null;
    this.rescuedBy = null;
    this.hasCanto = false;
    this.party = '';
    this.persistent = true;
    this.statusEffects = [];
  }

  // ------------------------------------------------------------------
  // Stat helpers
  // ------------------------------------------------------------------

  /** Maximum HP derived from the stats record. */
  get maxHp(): number {
    return this.stats['HP'] ?? 0;
  }

  getMaxHP(): number {
    return this.maxHp;
  }

  getStatValue(stat: string): number {
    return this.stats[stat] ?? 0;
  }

  /**
   * Get the movement stat for this unit.
   * Returns the MOV stat from the stats record.
   */
  getMovement(): number {
    return this.stats['MOV'] ?? this.stats['movement'] ?? 5;
  }

  // ------------------------------------------------------------------
  // Level-up
  // ------------------------------------------------------------------

  /**
   * Perform a level-up with growth-based stat rolls.
   *
   * For each stat, generates a random number 0-99. If the growth percentage
   * for that stat exceeds the roll, the stat increases by 1 (capped at
   * max_stats from the class).
   *
   * @param mode Growth mode: 'random' (default FE), 'fixed' (deterministic),
   *             'dynamic' (weighted random). Currently only 'random' is fully
   *             implemented; 'fixed' and 'dynamic' fall back to random.
   * @returns Record of stat gains (e.g. { HP: 1, STR: 1, SPD: 0 })
   */
  levelUp(mode: string = 'random', randomSource: () => number = random): Record<string, number> {
    const gains: Record<string, number> = {};

    for (const [stat, growth] of Object.entries(this.growths)) {
      let gained = 0;
      const cap = this.maxStats[stat] ?? 99;

      if (mode === 'fixed') {
        // Fixed mode: growth / 100 determines guaranteed gain, remainder accumulates
        // Simplified: if growth >= 50, always gain 1
        gained = growth >= 50 ? 1 : 0;
      } else {
        // Random / dynamic mode: roll against growth percentage
        // Growths can exceed 100 (guaranteed +1, then roll for +2)
        let remaining = growth;
        while (remaining > 0) {
          const roll = randomSource() * 100;
          if (roll < remaining) {
            gained++;
          }
          remaining -= 100;
        }
      }

      // Apply cap
      if (this.stats[stat] !== undefined) {
        const maxGain = Math.max(0, cap - this.stats[stat]);
        gained = Math.min(gained, maxGain);
      }

      gains[stat] = gained;
      if (gained > 0 && this.stats[stat] !== undefined) {
        this.stats[stat] += gained;
      }
    }

    // If HP grew, also increase current HP by the same amount
    if (gains['HP'] && gains['HP'] > 0) {
      this.currentHp += gains['HP'];
    }

    this.level += 1;
    return gains;
  }

  // ------------------------------------------------------------------
  // Item helpers
  // ------------------------------------------------------------------

  /** Get the equipped weapon, auto-equipping the first usable weapon if needed. */
  getEquippedWeapon(): ItemObject | null {
    if (
      this.equippedWeapon &&
      this.items.includes(this.equippedWeapon) &&
      this.equippedWeapon.isWeapon() &&
      this.equippedWeapon.hasUsesRemaining()
    ) {
      return this.equippedWeapon;
    }
    this.equippedWeapon = this.items.find(
      (item) => item.isWeapon() && item.hasUsesRemaining(),
    ) ?? null;
    return this.equippedWeapon;
  }

  /** Equip a weapon without changing inventory order, matching Python LT. */
  equipWeapon(item: ItemObject): void {
    if (!this.items.includes(item) || !item.isWeapon() || !item.hasUsesRemaining()) {
      throw new Error(`Cannot equip ${item.nid} on ${this.nid}`);
    }
    this.equippedWeapon = item;
  }

  /** Clear a removed/broken weapon and select the next usable inventory weapon. */
  unequipWeapon(item: ItemObject): void {
    if (this.equippedWeapon !== item) return;
    this.equippedWeapon = null;
    this.getEquippedWeapon();
  }

  /** Get all healing/consumable items that can be used. */
  getUsableItems(): ItemObject[] {
    return this.items.filter(
      (item) =>
        !item.isWeapon() &&
        item.hasComponent('heal') &&
        (!item.maxUses || item.uses > 0),
    );
  }

  /** Whether this unit has any usable items (healing/consumables). */
  hasUsableItems(): boolean {
    return this.getUsableItems().length > 0;
  }

  /** Get adjacent ally positions for trading. */
  canTrade(): boolean {
    return !this.hasTraded && !this.hasAttacked;
  }

  // ------------------------------------------------------------------
  // Status effect management
  // ------------------------------------------------------------------

  /** Add a status effect to this unit. */
  addStatusEffect(effect: StatusEffect): void {
    // Don't stack the same status
    const existing = this.statusEffects.find((e) => e.nid === effect.nid);
    if (existing) {
      // Refresh duration
      existing.turnsRemaining = effect.turnsRemaining;
      return;
    }
    this.statusEffects.push(effect);
  }

  /** Remove a status effect by NID. */
  removeStatusEffect(nid: string): void {
    const idx = this.statusEffects.findIndex((e) => e.nid === nid);
    if (idx !== -1) {
      this.statusEffects.splice(idx, 1);
    }
  }

  /** Check if this unit has a specific status effect. */
  hasStatusEffect(nid: string): boolean {
    return this.statusEffects.some((e) => e.nid === nid);
  }

  /**
   * Process turn-based status effects.
   * Called at the start of the unit's team's phase.
   * Returns total DOT damage dealt (for display).
   */
  processStatusEffects(): number {
    let totalDot = 0;

    for (let i = this.statusEffects.length - 1; i >= 0; i--) {
      const effect = this.statusEffects[i];

      // Apply DOT damage/healing
      if (effect.dotDamage !== 0) {
        if (effect.dotDamage > 0) {
          // Damage
          this.currentHp = Math.max(1, this.currentHp - effect.dotDamage);
          totalDot += effect.dotDamage;
        } else {
          // Healing
          this.currentHp = Math.min(this.maxHp, this.currentHp - effect.dotDamage);
          totalDot += effect.dotDamage;
        }
      }

      // Decrement duration
      if (effect.turnsRemaining > 0) {
        effect.turnsRemaining--;
        if (effect.turnsRemaining <= 0) {
          this.statusEffects.splice(i, 1);
        }
      }
    }

    return totalDot;
  }

  /**
   * Get the effective stat value including status effect modifiers.
   * Does NOT include terrain bonuses (those are calculated at combat time).
   */
  getEffectiveStat(stat: string): number {
    let value = this.stats[stat] ?? 0;
    for (const effect of this.statusEffects) {
      if (effect.statMods[stat]) {
        value += effect.statMods[stat];
      }
    }
    return Math.max(0, value);
  }

  /** Whether this unit is immobilized by a status effect. */
  isImmobilized(): boolean {
    return this.statusEffects.some((e) => e.immobilize);
  }

  /** Whether this unit is stunned (cannot act) by a status effect. */
  isStunned(): boolean {
    return this.statusEffects.some((e) => e.stun);
  }

  // ------------------------------------------------------------------
  // State queries
  // ------------------------------------------------------------------

  isDead(): boolean {
    return this.dead || this.currentHp <= 0;
  }

  /** Whether this unit is currently being rescued/carried. */
  isRescued(): boolean {
    return this.rescuedBy !== null;
  }

  /** Whether this unit is currently carrying another unit. */
  isRescuing(): boolean {
    return this.rescuing !== null;
  }

  /**
   * Returns `true` when this unit and `otherTeam` are on the same side,
   * as determined by the alliance pair list (symmetric).
   */
  isAlly(otherTeam: string, alliances: AlliancePair[]): boolean {
    if (this.team === otherTeam) return true;
    for (const [a, b] of alliances) {
      if (
        (a === this.team && b === otherTeam) ||
        (b === this.team && a === otherTeam)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether this unit still has actions available this turn.
   * A unit can still act if it hasn't finished and hasn't both
   * attacked and moved (or traded).
   */
  canStillAct(): boolean {
    if (this.finished || this.dead) return false;
    if (this.isStunned()) return false;
    // A unit that has attacked is done; trading also consumes the action.
    if (this.hasAttacked) return false;
    return true;
  }

  // ------------------------------------------------------------------
  // Turn-state management
  // ------------------------------------------------------------------

  /** Reset per-turn action flags (called at the start of a new phase). */
  resetTurnState(): void {
    this.hasAttacked = false;
    this.hasMoved = false;
    this.hasTraded = false;
    this.finished = false;
  }
}
