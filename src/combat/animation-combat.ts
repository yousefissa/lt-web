import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { CombatStrike } from './combat-solver';
import { CombatPhaseSolver, type RngMode } from './combat-solver';
import type { CombatResults, DamagePopup } from './map-combat';
import { BattleAnimation, type BattleAnimDrawData } from './battle-animation';
import type { CombatEffectData, PaletteData } from './battle-anim-types';
import { loadEffectSpritesheet } from '../data/loaders/combat-anim-loader';
import { convertSpritesheetToFrames } from './sprite-loader';
import { computeHit, computeDamage, computeCrit } from './combat-calcs';


// ============================================================
// AnimationCombat — Full GBA-style battle scene controller.
// Coordinates two BattleAnimation instances through a multi-phase
// state machine, managing screen effects, HP bars, damage popups,
// and camera pans.
// ============================================================

// -- Screen shake patterns ---------------------------------------------------

const SHAKE_PATTERNS: Record<number, [number, number][]> = {
  1: [[3,3],[0,0],[0,0],[-3,-3],[0,0],[0,0],[3,3],[0,0],[-3,-3],[0,0],[3,3],[0,0],[-3,-3],[3,3],[0,0]],
  2: [[1,1],[1,1],[1,1],[-1,-1],[-1,-1],[-1,-1],[0,0]],
  3: [[3,3],[-3,-3],[3,3],[-3,3],[3,-3],[-3,-3],[3,3],[-3,3],[3,-3],[0,0],[3,3],[-3,-3],[3,3],[-3,3],[3,-3],[-3,-3],[3,3],[-3,3],[3,-3],[0,0],[0,0]],
  4: [[-6,6],[6,-6],[-5,5],[5,-5],[-4,4],[4,-4],[-3,3],[3,-3],[-2,2],[2,-2],[-1,1],[1,-1],[-1,1],[1,-1],[0,0],[0,0],[-5,5],[5,-5],[-4,4],[4,-4],[-3,3],[3,-3],[-2,2],[2,-2],[-1,1],[1,-1],[-1,1],[1,-1],[0,0],[0,0],[-3,3],[3,-3],[-2,2],[2,-2],[-1,1],[1,-1],[0,0],[0,0]],
};

const PLATFORM_SHAKE: [number, number][] = [[0,1],[0,0],[0,-1],[0,0],[0,1],[0,0],[-1,-1],[0,1],[0,0]];

// -- Duration constants ------------------------------------------------------

const FADE_DURATION_MS = 250;
const ENTRANCE_FRAMES = 14;
const INIT_PAUSE_FRAMES = 25;
const SPRITE_LOAD_WAIT_MS = 1500;
const HP_DRAIN_MIN_FRAMES = 10;
const HP_DRAIN_MAX_FRAMES = 40;
const FADE_OUT_DURATION_MS = 250;

// -- Pan config per range ----------------------------------------------------

interface PanConfig {
  max: number;
  speed: number;
}

/** Pan config keyed by at_range (distance - 1). 0 = melee, 1 = range 2, etc. */
function getPanConfig(atRange: number): PanConfig {
  if (atRange <= 0) return { max: 0, speed: 0 };
  if (atRange === 1) return { max: 16, speed: 4 };
  if (atRange === 2) return { max: 32, speed: 8 };
  return { max: 120, speed: 25 };
}

// Re-export for consumers that imported from this file
export type { BattleAnimDrawData } from './battle-animation';
export { BattleAnimation } from './battle-animation';

/** Callback interface that BattleAnimation expects on its owner. */
export interface AnimationCombatOwner {
  startHit(anim: BattleAnimation): void;
  handleMiss(anim: BattleAnimation): void;
  spellHit(anim: BattleAnimation): void;
  castSpell(anim: BattleAnimation, effectNid: string | null): void;
  shake(intensity: number): void;
  platformShake(): void;
  panAway(): void;
  panBack(): void;
  playSound(name: string): void;
  showHitSpark(anim: BattleAnimation): void;
  showCritSpark(anim: BattleAnimation): void;
  screenBlend(frames: number, color: [number, number, number]): void;
  darken(): void;
  lighten(): void;
  endParentLoop(anim: BattleAnimation): void;
  spawnEffect(anim: BattleAnimation, effectNid: string, under: boolean): void;
  getEffectData(effectNid: string): CombatEffectData | null;
  getEffectFrameImages(effectNid: string): Map<string, ImageBitmap | HTMLCanvasElement>;
}

// -- Render state interface --------------------------------------------------

export interface AnimationCombatRenderState {
  state: string;

  /** Viewbox iris rectangle (null when not active). */
  viewbox: { x: number; y: number; width: number; height: number } | null;

  /** Background dim level 0-1. */
  backgroundDim: number;

  /** Platform Y positions (animated). */
  leftPlatformY: number;
  rightPlatformY: number;
  platformShakeY: number;

  /** Battle sprite draw data. */
  leftDraw: BattleAnimDrawData;
  rightDraw: BattleAnimDrawData;

  /** Whole-screen shake pixel offset. */
  screenShake: [number, number];
  /** Full-screen color blend (null when inactive). */
  screenBlend: { color: [number, number, number]; alpha: number } | null;

  /** HP bar data per side (including combat stats). */
  leftHp: { current: number; max: number; name: string; weapon: string; hit: number | null; damage: number | null; crit: number | null };
  rightHp: { current: number; max: number; name: string; weapon: string; hit: number | null; damage: number | null; crit: number | null };

  /** Active damage popups. */
  damagePopups: DamagePopup[];

  /** Active spark effects. */
  sparks: { type: 'hit' | 'crit' | 'miss' | 'noDamage'; elapsed: number; duration: number; isLeft: boolean }[];

  /** Camera pan offset for ranged combat. */
  panOffset: number;

  /** Range offsets for sprite positioning (Python: left_range_offset, right_range_offset). */
  leftRangeOffset: number;
  rightRangeOffset: number;

  /** Whether combat is at range (at_range > 0). */
  isAtRange: boolean;

  /** Combined platform + screen shake offsets for sprite rendering. */
  totalShakeX: number;
  totalShakeY: number;

  /** Name tag slide progress 0 (hidden) to 1 (visible). */
  nameTagProgress: number;
  /** HP bar slide progress 0 (hidden) to 1 (visible). */
  hpBarProgress: number;
}

// -- State type --------------------------------------------------------------

type AnimCombatState =
  | 'init' | 'fade_in' | 'entrance' | 'init_pause'
  | 'begin_phase' | 'anim' | 'combat_hit' | 'hp_change' | 'end_phase'
  | 'end_combat' | 'exp_wait' | 'fade_out' | 'done';

// ============================================================
// AnimationCombat
// ============================================================

export class AnimationCombat implements AnimationCombatOwner {
  // -- Public references -----------------------------------------------------
  attacker: UnitObject;
  defender: UnitObject;

  // -- Constructor-assigned fields -------------------------------------------
  attackItem: ItemObject;
  defenseItem: ItemObject | null;
  db: any; // Database
  leftAnim: BattleAnimation;
  rightAnim: BattleAnimation;
  leftIsAttacker: boolean;

  // -- Solver / strikes ------------------------------------------------------
  strikes: CombatStrike[];
  currentStrikeIndex: number = 0;

  // -- State machine ---------------------------------------------------------
  state: AnimCombatState = 'init';
  stateTimer: number = 0;
  stateFrameCount: number = 0;

  // -- HP tracking -----------------------------------------------------------
  leftDisplayHp: number = 0;
  rightDisplayHp: number = 0;
  leftTargetHp: number = 0;
  rightTargetHp: number = 0;
  hpDrainStartLeft: number = 0;
  hpDrainStartRight: number = 0;
  hpDrainFrames: number = 0;
  hpDrainElapsedFrames: number = 0;
  attackerStartHp: number = 0;
  defenderStartHp: number = 0;

  // -- Screen shake ----------------------------------------------------------
  shakePattern: [number, number][] = [];
  shakeIndex: number = 0;
  platformShakePattern: [number, number][] = [];
  platformShakeIndex: number = 0;

  // -- Camera pan ------------------------------------------------------------
  panOffset: number = 0;
  panTarget: number = 0;
  panConfig: PanConfig = { max: 0, speed: 0 };
  panFocusLeft: boolean = true;

  // -- Screen blend ----------------------------------------------------------
  blendColor: [number, number, number] = [0, 0, 0];
  blendFramesTotal: number = 0;
  blendFramesRemaining: number = 0;

  // -- Background dim --------------------------------------------------------
  backgroundDim: number = 0;

  // -- Entrance / UI slide ---------------------------------------------------
  entranceProgress: number = 0;
  nameTagProgress: number = 0;
  hpBarProgress: number = 0;
  leftPlatformY: number = 80;
  rightPlatformY: number = 80;

  // -- Viewbox iris ----------------------------------------------------------
  viewPos: [number, number] = [0, 0];  // defender tile position
  cameraX: number = 0;  // camera offset in tile coords
  cameraY: number = 0;

  // -- Damage popups ---------------------------------------------------------
  damagePopups: DamagePopup[] = [];

  // -- Spark effects ---------------------------------------------------------
  sparks: { x: number; y: number; type: 'hit' | 'crit' | 'miss' | 'noDamage'; elapsed: number; duration: number; isLeft: boolean }[] = [];

  // -- Current strike tracking -----------------------------------------------
  currentStrikeAttackerAnim: BattleAnimation | null = null;
  currentStrikeDefenderAnim: BattleAnimation | null = null;
  awaitingHit: boolean = false;

  // -- Safety timeout for animation state (prevent infinite loops) ----------
  animFrameCounter: number = 0;

  // -- Results cache ---------------------------------------------------------
  cachedResults: CombatResults | null = null;

  // -- Combat range ----------------------------------------------------------
  combatRange: number = 1;
  /** Python-style at_range = distance - 1. 0 = melee, 1 = range 2, etc. */
  atRange: number = 0;

  // -- Frame timing accumulator (ensures animations run at 60fps rate) ------
  animFrameAccumulator: number = 0;
  panFrameAccumulator: number = 0;
  private static readonly FRAME_MS = 1000 / 60; // ~16.67ms per frame

  // -- Skip mode (START/ESC toggles 4x speed) --------------------------------
  skipMode: boolean = false;

  /** Instantly skip to the end of combat (no more animation). */
  skipToEnd(): void {
    this.state = 'done';
  }

  // -- Effect sprite cache ---------------------------------------------------
  effectFrameCache: Map<string, Map<string, ImageBitmap | HTMLCanvasElement>> = new Map();
  effectLoadingSet: Set<string> = new Set();

  // -- Audio (optional, set after construction to enable combat SFX) --------
  audioManager: { playSfx(name: string): void } | null = null;

  constructor(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: any,
    rngMode: string,
    leftAnim: BattleAnimation,
    rightAnim: BattleAnimation,
    leftIsAttacker: boolean,
    board?: any,
    script?: string[] | null,
  ) {
    this.attacker = attacker;
    this.defender = defender;
    this.attackItem = attackItem;
    this.defenseItem = defenseItem;
    this.db = db;
    this.leftAnim = leftAnim;
    this.rightAnim = rightAnim;
    this.leftIsAttacker = leftIsAttacker;

    // Wire up animation owner/partner references and set side/range.
    // pair() sets: owner, partner, right, atRange, entranceFrames, initPosition.
    // Left combatant: right=false (sprite x-offsets mirrored).
    // Right combatant: right=true (sprite x-offsets used as-authored).
    const aPos = attacker.position;
    const dPos = defender.position;
    const range = (aPos && dPos)
      ? Math.abs(aPos[0] - dPos[0]) + Math.abs(aPos[1] - dPos[1])
      : 1;
    // Python: at_range = distance - 1 (0 for melee, 1 for range-2, etc.)
    const atRange = range - 1;
    this.leftAnim.pair(this, this.rightAnim, false, atRange, ENTRANCE_FRAMES, [0, 0]);
    this.rightAnim.pair(this, this.leftAnim, true, atRange, ENTRANCE_FRAMES, [0, 0]);
    this.leftAnim.isLeft = true;
    this.rightAnim.isLeft = false;

    // Set initial standing pose so sprites are visible during entrance
    const standPose = atRange > 0 ? 'RangedStand' : 'Stand';
    this.leftAnim.setPose(standPose);
    this.rightAnim.setPose(standPose);

    // Solve strikes
    const solver = new CombatPhaseSolver();
    this.strikes = solver.resolve(attacker, attackItem, defender, defenseItem, db, rngMode as RngMode, board, script);

    // HP init
    const leftUnit = leftIsAttacker ? attacker : defender;
    const rightUnit = leftIsAttacker ? defender : attacker;
    this.leftDisplayHp = leftUnit.currentHp;
    this.rightDisplayHp = rightUnit.currentHp;
    this.leftTargetHp = leftUnit.currentHp;
    this.rightTargetHp = rightUnit.currentHp;
    this.attackerStartHp = attacker.currentHp;
    this.defenderStartHp = defender.currentHp;

    // Combat range (raw distance) and at_range (distance - 1)
    this.combatRange = range;
    this.atRange = atRange;
    this.panConfig = getPanConfig(atRange);

    // Initialize pan offset like Python: pan_offset starts at +pan_max or
    // -pan_max depending on which side has focus. Left starts focused, so
    // panOffset = +max (camera shifted right, viewing left unit).
    // Python: if focus_right: pan_offset = -pan_max; else: pan_offset = pan_max
    if (this.panConfig.max > 0) {
      this.panOffset = leftIsAttacker ? this.panConfig.max : -this.panConfig.max;
      this.panTarget = this.panOffset;
      this.panFocusLeft = leftIsAttacker;
    }

    // Viewbox iris target: defender's tile position
    if (dPos) {
      this.viewPos = [dPos[0], dPos[1]];
    }
  }

  // ================================================================
  // Main update
  // ================================================================

  /** How many animation frame ticks should happen this update, based on real delta. */
  private computeAnimTicks(deltaMs: number): number {
    // When in skip mode, animations run at 4x speed (matching Python's
    // battle_anim_speed = 0.25 which means each frame lasts 1/4 as long)
    const effectiveDelta = this.skipMode ? deltaMs * 4 : deltaMs;
    this.animFrameAccumulator += effectiveDelta;
    let ticks = 0;
    while (this.animFrameAccumulator >= AnimationCombat.FRAME_MS) {
      this.animFrameAccumulator -= AnimationCombat.FRAME_MS;
      ticks++;
    }
    // Cap at 4 ticks per update to avoid runaway in case of frame spikes
    return Math.min(ticks, 4);
  }

  /** Run BattleAnimation.update() the correct number of times for this frame. */
  private tickAnims(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this.leftAnim.update();
      this.rightAnim.update();
    }
  }

  /** The real deltaMs from the game loop (stored for use by state methods). */
  private currentDeltaMs: number = 0;

  update(deltaMs: number): boolean {
    this.currentDeltaMs = deltaMs;

    // Advance frame-based timers
    // When in skip mode, accelerate state timers too (matching Python where
    // _skip bypasses most timing waits)
    const effectiveMs = this.skipMode ? deltaMs * 4 : deltaMs;
    this.stateTimer += effectiveMs;

    // Update screen shake
    this.advanceShake();
    this.advancePlatformShake();
    this.advanceBlend();

    // Update damage popups
    for (const p of this.damagePopups) {
      p.elapsed += effectiveMs;
    }
    this.damagePopups = this.damagePopups.filter(p => p.elapsed < p.duration);

    // Update sparks
    for (const s of this.sparks) {
      s.elapsed += effectiveMs;
    }
    this.sparks = this.sparks.filter(s => s.elapsed < s.duration);

    // Advance pan (once per logical 60fps tick, matching Python's draw_ui)
    // Use separate accumulator to avoid consuming animation ticks.
    this.panFrameAccumulator += effectiveMs;
    while (this.panFrameAccumulator >= AnimationCombat.FRAME_MS) {
      this.panFrameAccumulator -= AnimationCombat.FRAME_MS;
      this.advancePan();
    }

    // Tick battle animations unconditionally (matches Python's update_anims()
    // which runs at the end of every update() call regardless of state).
    // This ensures consistent animation speed independent of browser refresh rate.
    const animTicks = this.computeAnimTicks(deltaMs);
    if (animTicks > 0) {
      this.tickAnims(animTicks);
    }

    switch (this.state) {
      case 'init':        return this.updateInit();
      case 'fade_in':     return this.updateFadeIn();
      case 'entrance':    return this.updateEntrance();
      case 'init_pause':  return this.updateInitPause();
      case 'begin_phase': return this.updateBeginPhase();
      case 'anim':        return this.updateAnim();
      case 'combat_hit':  return this.updateCombatHit();
      case 'hp_change':   return this.updateHpChange();
      case 'end_phase':   return this.updateEndPhase();
      case 'end_combat':  return this.updateEndCombat();
      case 'exp_wait':    return this.updateExpWait();
      case 'fade_out':    return this.updateFadeOut();
      case 'done':        return true;
    }
  }

  // ================================================================
  // State updates
  // ================================================================

  private updateInit(): boolean {
    // Wait for both combatants to have at least one resolved main frame before
    // entering the visible animation phases. This prevents placeholder debug
    // stubs (solid cyan/red blocks) from flashing on first-load combats while
    // spritesheets are still loading asynchronously.
    const leftReady = this.leftAnim.getDrawData().mainFrame != null;
    const rightReady = this.rightAnim.getDrawData().mainFrame != null;
    if (leftReady && rightReady) {
      this.transition('fade_in');
      return false;
    }

    // Fail-safe: if assets are still missing after a short wait, continue so
    // combat cannot stall forever due to missing/invalid resources.
    if (this.stateTimer >= SPRITE_LOAD_WAIT_MS) {
      this.transition('fade_in');
    }
    return false;
  }

  private updateFadeIn(): boolean {
    const progress = Math.min(1, this.stateTimer / FADE_DURATION_MS);
    // Background dims as iris closes
    this.backgroundDim = progress;
    if (progress >= 1) {
      this.backgroundDim = 1;
      this.transition('entrance');
    }
    return false;
  }

  private updateEntrance(): boolean {
    // Use ms-based progress for frame-rate independence
    // ENTRANCE_FRAMES at 60fps ≈ 233ms
    const entranceMs = ENTRANCE_FRAMES * AnimationCombat.FRAME_MS;
    const t = Math.min(1, this.stateTimer / entranceMs);
    this.entranceProgress = t;

    // Platforms slide up from below screen to resting position (offset 0)
    this.leftPlatformY = lerp(80, 0, easeOutQuad(t));
    this.rightPlatformY = lerp(80, 0, easeOutQuad(t));

    // Name tags and HP bars slide in
    this.nameTagProgress = t;
    this.hpBarProgress = Math.min(1, Math.max(0, (t - 0.3) / 0.7));

    if (t >= 1) {
      this.nameTagProgress = 1;
      this.hpBarProgress = 1;
      this.transition('init_pause');
    }
    return false;
  }

  private updateInitPause(): boolean {
    // stateTimer is ms-based; compare against INIT_PAUSE_FRAMES in ms
    const pauseMs = INIT_PAUSE_FRAMES * AnimationCombat.FRAME_MS;
    if (this.stateTimer >= pauseMs) {
      this.transition('begin_phase');
    }
    return false;
  }

  private updateBeginPhase(): boolean {
    if (this.currentStrikeIndex >= this.strikes.length) {
      this.transition('end_combat');
      return false;
    }

    const strike = this.strikes[this.currentStrikeIndex];
    const isLeftAttacking = this.isLeftUnit(strike.attacker);
    const atkAnim = isLeftAttacking ? this.leftAnim : this.rightAnim;
    const defAnim = isLeftAttacking ? this.rightAnim : this.leftAnim;

    this.currentStrikeAttackerAnim = atkAnim;
    this.currentStrikeDefenderAnim = defAnim;
    this.awaitingHit = true;

    // Set attacker pose
    const pose = strike.crit ? 'Critical' : 'Attack';
    atkAnim.setPose(pose);

    // Set defender to standing pose (ranged or melee)
    const defPose = this.atRange > 0 ? 'RangedStand' : 'Stand';
    defAnim.setPose(defPose);

    // Pan camera to focus on the attacking unit (Python: set_up_combat_animation -> move_camera)
    if (this.panConfig.max > 0) {
      const attackerIsRight = !isLeftAttacking;
      // Python: focus_right = (current_battle_anim is right_battle_anim)
      this.panFocusLeft = !attackerIsRight;
      this.panTarget = this.panFocusLeft ? this.panConfig.max : -this.panConfig.max;
    }

    this.animFrameCounter = 0; // Reset safety timeout
    this.transition('anim');
    return false;
  }

  private updateAnim(): boolean {
    // animFrameCounter tracks total calls for safety timeout
    this.animFrameCounter++;

    // The hit is processed via the startHit callback when the animation
    // fires the start_hit command. Once both anims return to idle/done,
    // proceed to end_phase.
    if (!this.awaitingHit && this.currentStrikeAttackerAnim) {
      const atkDone = this.currentStrikeAttackerAnim.isIdle() || this.currentStrikeAttackerAnim.isDone();
      const defDone = this.currentStrikeDefenderAnim!.isIdle() || this.currentStrikeDefenderAnim!.isDone();
      if (atkDone && defDone) {
        this.transition('end_phase');
      }
    }

    // Safety timeout: if animation is stuck for 600 frames (~10s at 60fps),
    // force-clear awaitingHit and advance.  This prevents infinite loops when
    // a spell effect fails to spawn or a command callback is missed.
    if (this.animFrameCounter > 600) {
      console.warn('[AnimationCombat] Safety timeout in anim state — forcing end_phase');
      this.awaitingHit = false;
      this.transition('end_phase');
    }
    return false;
  }

  private updateCombatHit(): boolean {
    // One-frame state: the actual hit processing happens in startHit()
    // which transitions us here. Now set up HP drain and go to hp_change.
    this.hpDrainElapsedFrames = 0;
    this.transition('hp_change');
    return false;
  }

  private updateHpChange(): boolean {
    // Use ms-based timing for HP drain
    const drainMs = this.hpDrainFrames * AnimationCombat.FRAME_MS;
    const t = Math.min(1, this.stateTimer / Math.max(1, drainMs));

    // Animate HP bars
    this.leftDisplayHp = lerp(this.hpDrainStartLeft, this.leftTargetHp, t);
    this.rightDisplayHp = lerp(this.hpDrainStartRight, this.rightTargetHp, t);

    // Check for death
    if (t >= 0.5) {
      if (this.leftTargetHp <= 0) {
        this.leftAnim.startDeath();
      }
      if (this.rightTargetHp <= 0) {
        this.rightAnim.startDeath();
      }
    }

    if (t >= 1) {
      // Snap HP
      this.leftDisplayHp = this.leftTargetHp;
      this.rightDisplayHp = this.rightTargetHp;

      // Resume attacker animation
      if (this.currentStrikeAttackerAnim) {
        this.currentStrikeAttackerAnim.resume();
      }
      this.awaitingHit = false;

      // Return to anim state so the attacker can finish its animation
      this.transition('anim');
    }
    return false;
  }

  private updateEndPhase(): boolean {
    // Advance to next strike
    this.currentStrikeIndex++;
    this.currentStrikeAttackerAnim = null;
    this.currentStrikeDefenderAnim = null;

    // If someone died, skip to end_combat
    if (this.leftTargetHp <= 0 || this.rightTargetHp <= 0) {
      this.transition('end_combat');
    } else {
      this.transition('begin_phase');
    }
    return false;
  }

  private updateEndCombat(): boolean {
    // Set both anims to Stand
    this.leftAnim.setPose('Stand');
    this.rightAnim.setPose('Stand');

    // Wait for both to settle
    const leftIdle = this.leftAnim.isIdle() || this.leftAnim.isDone();
    const rightIdle = this.rightAnim.isIdle() || this.rightAnim.isDone();
    if (leftIdle && rightIdle) {
      this.transition('exp_wait');
    }
    return false;
  }

  private updateExpWait(): boolean {
    // Cache results
    this.cachedResults = this.computeResults();
    this.transition('fade_out');
    return false;
  }

  private updateFadeOut(): boolean {
    const progress = Math.min(1, this.stateTimer / FADE_OUT_DURATION_MS);
    // Iris expands back
    this.backgroundDim = 1 - progress;
    if (progress >= 1) {
      this.state = 'done';
      return true;
    }
    return false;
  }

  // ================================================================
  // State transition helper
  // ================================================================

  private transition(newState: AnimCombatState): void {
    this.state = newState;
    this.stateTimer = 0;
    this.stateFrameCount = 0;
  }

  // ================================================================
  // BattleAnimation owner callbacks
  // ================================================================

  startHit(anim: BattleAnimation): void {
    if (this.currentStrikeIndex >= this.strikes.length) return;
    const strike = this.strikes[this.currentStrikeIndex];

    // Record HP drain start values
    this.hpDrainStartLeft = this.leftTargetHp;
    this.hpDrainStartRight = this.rightTargetHp;

    // Use currentStrikeDefenderAnim set during beginStrike() rather than
    // deriving from anim identity.  When a child spell effect fires
    // spell_hit, `anim` is the child effect (not leftAnim/rightAnim),
    // so `anim === this.leftAnim` would always fail.
    const defAnim = this.currentStrikeDefenderAnim ?? (
      (anim === this.leftAnim) ? this.rightAnim : this.leftAnim
    );
    const isLeftDefending = (defAnim === this.leftAnim);

    if (strike.hit) {
      // Apply damage to target HP
      if (isLeftDefending) {
        this.leftTargetHp = Math.max(0, this.leftTargetHp - strike.damage);
      } else {
        this.rightTargetHp = Math.max(0, this.rightTargetHp - strike.damage);
      }

      // Determine HP drain duration
      const hpChange = strike.damage;
      this.hpDrainFrames = Math.max(HP_DRAIN_MIN_FRAMES, Math.min(HP_DRAIN_MAX_FRAMES, hpChange));

      // Defender takes hit
      const damagedPose = this.atRange > 0 ? 'RangedDamaged' : 'Damaged';
      defAnim.setPose(damagedPose);

      // Screen shake
      const shakeIntensity = strike.crit ? 4 : 1;
      this.shake(shakeIntensity);
      this.platformShake();

      // Recoil offset
      defAnim.lrOffset = [-1, -2, -3, -2, -1];

      // --- Hit/Crit/Kill sounds (Python: _handle_playback + item_system_base) ---
      const defenderHp = isLeftDefending ? this.leftTargetHp : this.rightTargetHp;
      const isLethal = defenderHp <= 0;
      if (strike.damage === 0) {
        this.playSound('No Damage');
      } else if (strike.crit) {
        // Crit: play critical hit sound (+ final hit if lethal)
        if (isLethal) {
          this.playSound('Final Hit');
        }
        this.playSound('Critical Hit ' + (1 + Math.floor(Math.random() * 2)));
      } else {
        // Normal hit
        if (isLethal) {
          this.playSound('Final Hit');
        } else {
          this.playSound('Attack Hit ' + (1 + Math.floor(Math.random() * 5)));
        }
      }

      // Spawn damage popup
      const defUnit = strike.defender;
      if (defUnit.position) {
        this.damagePopups.push({
          x: defUnit.position[0],
          y: defUnit.position[1],
          value: strike.damage,
          isCrit: strike.crit,
          elapsed: 0,
          duration: 1200,
        });
      }
    } else {
      // Miss — Python replaces 'Attack Miss 2' with 'Miss' in animation combat
      this.playSound('Miss');
      this.hpDrainFrames = HP_DRAIN_MIN_FRAMES;
      defAnim.setPose('Dodge');

      const defUnit = strike.defender;
      if (defUnit.position) {
        this.damagePopups.push({
          x: defUnit.position[0],
          y: defUnit.position[1],
          value: 0,
          isCrit: false,
          elapsed: 0,
          duration: 1200,
        });
      }
    }

    // Transition to combat_hit so hp_change begins
    this.transition('combat_hit');
  }

  handleMiss(anim: BattleAnimation): void {
    this.playSound('Miss');
    const defAnim = (anim === this.leftAnim) ? this.rightAnim : this.leftAnim;
    defAnim.setPose('Dodge');
  }

  spellHit(anim: BattleAnimation): void {
    // Treat the same as startHit but with spell shake
    this.startHit(anim);
    // Override shake to spell type
    this.shakePattern = [...(SHAKE_PATTERNS[3] ?? [])];
    this.shakeIndex = 0;
  }

  castSpell(anim: BattleAnimation, effectNid: string | null): void {
    if (!effectNid) {
      // Check for battle_cast_anim component (the item's effect_animation hook).
      // Python: item_system.effect_animation(unit, item) returns the
      // battle_cast_anim value (e.g. "Gustblade", "Lightning", "Nosferatu").
      const battleCastAnim = this.attackItem.getComponent<string>('battle_cast_anim');
      effectNid = battleCastAnim ?? this.attackItem.nid;
    }

    // Check if the effect exists before spawning. If it doesn't exist,
    // immediately fire the hit so combat doesn't hang waiting for a
    // spell_hit that will never come.
    const effectData = this.getEffectData(effectNid);
    if (!effectData) {
      console.warn(`[AnimationCombat] castSpell: effect "${effectNid}" not found — firing hit immediately`);
      this.startHit(anim);
      return;
    }

    // Spawn the effect as a child of the calling animation
    anim.spawnEffect(effectNid, anim.effects);
  }

  shake(intensity: number): void {
    const pattern = SHAKE_PATTERNS[intensity];
    if (pattern) {
      this.shakePattern = [...pattern];
      this.shakeIndex = 0;
    }
  }

  platformShake(): void {
    this.platformShakePattern = [...PLATFORM_SHAKE];
    this.platformShakeIndex = 0;
  }

  /** Python: pan_away() — toggle focus and move camera. Called on first `pan` command. */
  panAway(): void {
    if (this.panConfig.max === 0) return;
    this.panFocusLeft = !this.panFocusLeft;
    this.panTarget = this.panFocusLeft ? this.panConfig.max : -this.panConfig.max;
  }

  /** Python: pan_back() — look at the next strike to determine focus, then move camera.
   *  Called on second `pan` command (returning from spell) and as safety in endCurrentPose. */
  panBack(): void {
    if (this.panConfig.max === 0) return;
    // Determine who attacks next (Python: state_machine.get_next_state())
    const nextStrike = this.currentStrikeIndex < this.strikes.length
      ? this.strikes[this.currentStrikeIndex]
      : null;
    if (nextStrike) {
      const nextAttackerIsLeft = this.isLeftUnit(nextStrike.attacker);
      // Python: focus_right = (attacker is self.right) for attacker phase
      //         focus_right = (defender is self.right) for defender phase
      // Since our strikes already resolve who the attacker is, just focus on them.
      // panFocusLeft = !focus_right
      this.panFocusLeft = nextAttackerIsLeft;
    } else {
      // No more strikes — focus_exp: focus on the player's unit (Python: focus_exp)
      // Python defaults to focus_right = True for exp display
      this.panFocusLeft = !this.leftIsAttacker;
    }
    this.panTarget = this.panFocusLeft ? this.panConfig.max : -this.panConfig.max;
  }

  /** Set camera offset (in pixels) so the viewbox iris can compute tile-relative positions. */
  setCameraOffset(pixelX: number, pixelY: number): void {
    this.cameraX = pixelX / 16;
    this.cameraY = pixelY / 16;
  }

  playSound(name: string): void {
    if (this.audioManager) {
      this.audioManager.playSfx(name);
    }
  }

  showHitSpark(anim: BattleAnimation): void {
    // Determine which side the defending unit is on
    const isLeftDefending = (anim === this.rightAnim);
    const strike = this.currentStrikeIndex < this.strikes.length ? this.strikes[this.currentStrikeIndex] : null;

    if (strike && strike.hit && strike.damage > 0) {
      this.sparks.push({
        x: 0, y: 0,
        type: 'hit',
        elapsed: 0,
        duration: 300,
        isLeft: isLeftDefending,
      });
    } else if (strike && !strike.hit) {
      this.sparks.push({
        x: 0, y: 0,
        type: 'miss',
        elapsed: 0,
        duration: 400,
        isLeft: isLeftDefending,
      });
    } else {
      this.sparks.push({
        x: 0, y: 0,
        type: 'noDamage',
        elapsed: 0,
        duration: 300,
        isLeft: isLeftDefending,
      });
    }
  }

  showCritSpark(anim: BattleAnimation): void {
    const isLeftDefending = (anim === this.rightAnim);
    const strike = this.currentStrikeIndex < this.strikes.length ? this.strikes[this.currentStrikeIndex] : null;

    if (strike && strike.hit && strike.damage > 0) {
      this.sparks.push({
        x: 0, y: 0,
        type: 'crit',
        elapsed: 0,
        duration: 500,
        isLeft: isLeftDefending,
      });
    } else {
      this.sparks.push({
        x: 0, y: 0,
        type: 'noDamage',
        elapsed: 0,
        duration: 300,
        isLeft: isLeftDefending,
      });
    }
  }

  screenBlend(frames: number, color: [number, number, number]): void {
    this.blendColor = color;
    this.blendFramesTotal = frames;
    this.blendFramesRemaining = frames;
  }

  darken(): void {
    this.backgroundDim = Math.min(1, this.backgroundDim + 0.3);
  }

  lighten(): void {
    this.backgroundDim = Math.max(0, this.backgroundDim - 0.3);
  }

  endParentLoop(_childAnim: BattleAnimation): void {
    // Called by child effect animations to break the parent's loop.
    // The parent is the current strike's attacker animation.
    if (this.currentStrikeAttackerAnim) {
      this.currentStrikeAttackerAnim.breakLoop();
    }
  }

  spawnEffect(anim: BattleAnimation, effectNid: string, under: boolean): void {
    const targetList = under ? anim.underEffects : anim.effects;
    anim.spawnEffect(effectNid, targetList);
  }

  // ================================================================
  // Effect data / sprites
  // ================================================================

  getEffectData(effectNid: string): CombatEffectData | null {
    return this.db.combatEffects?.get(effectNid) ?? null;
  }

  getEffectFrameImages(effectNid: string): Map<string, ImageBitmap | HTMLCanvasElement> {
    const cached = this.effectFrameCache.get(effectNid);
    if (cached) return cached;

    // Start async load if not already loading
    if (!this.effectLoadingSet.has(effectNid)) {
      this.effectLoadingSet.add(effectNid);
      this.loadEffectSprites(effectNid);
    }

    return new Map(); // return empty initially; sprites hot-swap in once loaded
  }

  private async loadEffectSprites(effectNid: string): Promise<void> {
    try {
      const effectData = this.db.combatEffects?.get(effectNid) as CombatEffectData | undefined;
      if (!effectData) return;

      const resources = (globalThis as any).__ltResources;
      if (!resources) return;

      // Load the effect spritesheet
      const img = await loadEffectSpritesheet(resources, effectNid);
      if (!img) return;

      // Get the palette for this effect (if any)
      const palettes = this.db.combatPalettes as Map<string, PaletteData> | undefined;
      let palette: PaletteData | null = null;

      if (effectData.palettes.length > 0) {
        // Use the first palette mapping
        const [, paletteNid] = effectData.palettes[0];
        palette = palettes?.get(paletteNid) ?? null;
      }

      // Convert spritesheet to frame images
      const frames = convertSpritesheetToFrames(img, effectData.frames, palette);

      this.effectFrameCache.set(effectNid, frames);

      // Hot-swap into any existing child effects
      this.hotSwapEffectFrames(effectNid, frames);
    } catch (e) {
      console.warn(`AnimationCombat: failed to load effect "${effectNid}":`, e);
    }
  }

  private hotSwapEffectFrames(effectNid: string, frames: Map<string, ImageBitmap | HTMLCanvasElement>): void {
    const updateAnim = (anim: BattleAnimation) => {
      // Check child effects
      for (const effect of anim.effects) {
        if (effect.animData?.nid === effectNid) {
          for (const [nid, canvas] of frames) {
            effect.frameImages.set(nid, canvas);
          }
        }
        updateAnim(effect);
      }
      for (const effect of anim.underEffects) {
        if (effect.animData?.nid === effectNid) {
          for (const [nid, canvas] of frames) {
            effect.frameImages.set(nid, canvas);
          }
        }
        updateAnim(effect);
      }
    };
    updateAnim(this.leftAnim);
    updateAnim(this.rightAnim);
  }

  // ================================================================
  // Results
  // ================================================================

  applyResults(): CombatResults {
    if (this.cachedResults) {
      return this.cachedResults;
    }
    return this.computeResults();
  }

  private computeResults(): CombatResults {
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

    atkHp = Math.max(0, atkHp);
    defHp = Math.max(0, defHp);

    this.attacker.currentHp = atkHp;
    this.defender.currentHp = defHp;

    const attackerDead = atkHp <= 0;
    const defenderDead = defHp <= 0;

    if (attackerDead) this.attacker.dead = true;
    if (defenderDead) this.defender.dead = true;

    // Weapon uses
    let attackWeaponBroke = false;
    let defenseWeaponBroke = false;

    if (attackerStrikeCount > 0 && this.attackItem.maxUses > 0) {
      attackWeaponBroke = this.attackItem.decrementUses();
      if (attackWeaponBroke) {
        const idx = this.attacker.items.indexOf(this.attackItem);
        if (idx !== -1) this.attacker.items.splice(idx, 1);
      }
    }

    if (defenderStrikeCount > 0 && this.defenseItem && this.defenseItem.maxUses > 0) {
      defenseWeaponBroke = this.defenseItem.decrementUses();
      if (defenseWeaponBroke) {
        const idx = this.defender.items.indexOf(this.defenseItem);
        if (idx !== -1) this.defender.items.splice(idx, 1);
      }
    }

    // EXP
    const expGained = this.calculateExp(attackerDead, defenderDead);

    let levelUps: Record<string, number>[] = [];
    const growthMode = (this.db.getConstant?.('growths_choice', 'random') as string) || 'random';

    if (!attackerDead && this.attacker.team === 'player' && expGained > 0) {
      this.attacker.exp += expGained;
      while (this.attacker.exp >= 100) {
        this.attacker.exp -= 100;
        const gains = this.attacker.levelUp(growthMode);
        levelUps.push(gains);
      }
    }

    let droppedItem: ItemObject | null = null;
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

  private calculateExp(attackerDead: boolean, defenderDead: boolean): number {
    if (attackerDead) return 0;

    const BASE_EXP = 30;
    const KILL_BONUS = 50;
    const levelDiff = this.defender.level - this.attacker.level;
    const levelScale = Math.max(0.1, 1 + levelDiff * 0.1);

    let exp = Math.round(BASE_EXP * levelScale);
    if (defenderDead) {
      exp += Math.round(KILL_BONUS * levelScale);
    }
    return Math.max(1, Math.min(100, exp));
  }

  // ================================================================
  // Render state
  // ================================================================

  getRenderState(): AnimationCombatRenderState {
    const leftUnit = this.leftIsAttacker ? this.attacker : this.defender;
    const rightUnit = this.leftIsAttacker ? this.defender : this.attacker;
    const leftItem = this.leftIsAttacker ? this.attackItem : this.defenseItem;
    const rightItem = this.leftIsAttacker ? this.defenseItem : this.attackItem;

    // Viewbox iris — Python-faithful asymmetric iris toward defender tile
    const TILEX = 15; // WINWIDTH / TILEWIDTH (240 / 16)
    const TILEY = 10; // WINHEIGHT / TILEHEIGHT (160 / 16)
    let viewbox: AnimationCombatRenderState['viewbox'] = null;
    if (this.state === 'fade_in') {
      const vbMul = Math.min(1, this.stateTimer / FADE_DURATION_MS);
      const trueX = this.viewPos[0] - this.cameraX + 0.5;
      const trueY = this.viewPos[1] - this.cameraY + 0.5;
      const vbX = Math.floor(vbMul * trueX * 16);
      const vbY = Math.floor(vbMul * trueY * 16);
      const vbW = Math.floor(240 - vbX - (vbMul * (TILEX - trueX)) * 16);
      const vbH = Math.floor(160 - vbY - (vbMul * (TILEY - trueY)) * 16);
      viewbox = { x: vbX, y: vbY, width: Math.max(0, vbW), height: Math.max(0, vbH) };
    } else if (this.state === 'fade_out') {
      const progress = Math.min(1, this.stateTimer / FADE_OUT_DURATION_MS);
      const vbMul = 1 - progress; // inverted: iris expands outward
      const trueX = this.viewPos[0] - this.cameraX + 0.5;
      const trueY = this.viewPos[1] - this.cameraY + 0.5;
      const vbX = Math.floor(vbMul * trueX * 16);
      const vbY = Math.floor(vbMul * trueY * 16);
      const vbW = Math.floor(240 - vbX - (vbMul * (TILEX - trueX)) * 16);
      const vbH = Math.floor(160 - vbY - (vbMul * (TILEY - trueY)) * 16);
      viewbox = { x: vbX, y: vbY, width: Math.max(0, vbW), height: Math.max(0, vbH) };
    }

    // Screen shake
    const screenShake = this.getCurrentShake();

    // Platform shake (both X and Y components)
    const platformShake = this.getCurrentPlatformShake();
    const platformShakeY = platformShake[1];

    // Combined total shake (Python: total_shake_x = shake_offset[0] + platform_shake_offset[0])
    const totalShakeX = screenShake[0] + platformShake[0];
    const totalShakeY = screenShake[1] + platformShake[1];

    // Range offsets for sprite positioning (Python: mock_combat.py lines 419-423)
    let leftRangeOffset = 0;
    let rightRangeOffset = 0;
    if (this.atRange > 0) {
      rightRangeOffset = 24 + this.panConfig.max;
      leftRangeOffset = -24 - this.panConfig.max;
    }

    // Screen blend
    let screenBlendData: AnimationCombatRenderState['screenBlend'] = null;
    if (this.blendFramesRemaining > 0 && this.blendFramesTotal > 0) {
      const alpha = this.blendFramesRemaining / this.blendFramesTotal;
      screenBlendData = { color: this.blendColor, alpha };
    }

    return {
      state: this.state,
      viewbox,
      backgroundDim: this.backgroundDim,
      leftPlatformY: this.leftPlatformY,
      rightPlatformY: this.rightPlatformY,
      platformShakeY,
      leftDraw: this.leftAnim.getDrawData(),
      rightDraw: this.rightAnim.getDrawData(),
      screenShake,
      screenBlend: screenBlendData,
      leftHp: {
        current: Math.max(0, Math.round(this.leftDisplayHp)),
        max: leftUnit.maxHp,
        name: leftUnit.name,
        weapon: leftItem?.name ?? '',
        hit: leftItem ? Math.min(100, Math.max(0, computeHit(leftUnit, leftItem, rightUnit, this.db))) : null,
        damage: leftItem ? Math.max(0, computeDamage(leftUnit, leftItem, rightUnit, this.db)) : null,
        crit: leftItem ? Math.min(100, Math.max(0, computeCrit(leftUnit, leftItem, rightUnit, this.db))) : null,
      },
      rightHp: {
        current: Math.max(0, Math.round(this.rightDisplayHp)),
        max: rightUnit.maxHp,
        name: rightUnit.name,
        weapon: rightItem?.name ?? '',
        hit: rightItem ? Math.min(100, Math.max(0, computeHit(rightUnit, rightItem, leftUnit, this.db))) : null,
        damage: rightItem ? Math.max(0, computeDamage(rightUnit, rightItem, leftUnit, this.db)) : null,
        crit: rightItem ? Math.min(100, Math.max(0, computeCrit(rightUnit, rightItem, leftUnit, this.db))) : null,
      },
      damagePopups: this.damagePopups,
      sparks: this.sparks.map(s => ({ type: s.type, elapsed: s.elapsed, duration: s.duration, isLeft: s.isLeft })),
      panOffset: this.panOffset,
      leftRangeOffset,
      rightRangeOffset,
      isAtRange: this.atRange > 0,
      totalShakeX,
      totalShakeY,
      nameTagProgress: this.nameTagProgress,
      hpBarProgress: this.hpBarProgress,
    };
  }

  // ================================================================
  // Internal helpers
  // ================================================================

  /** Determine if a unit corresponds to the left-side animation. */
  private isLeftUnit(unit: UnitObject): boolean {
    if (this.leftIsAttacker) {
      return unit === this.attacker;
    }
    return unit === this.defender;
  }

  private advanceShake(): void {
    if (this.shakeIndex < this.shakePattern.length) {
      this.shakeIndex++;
    }
  }

  private getCurrentShake(): [number, number] {
    if (this.shakeIndex > 0 && this.shakeIndex <= this.shakePattern.length) {
      return this.shakePattern[this.shakeIndex - 1];
    }
    return [0, 0];
  }

  private advancePlatformShake(): void {
    if (this.platformShakeIndex < this.platformShakePattern.length) {
      this.platformShakeIndex++;
    }
  }

  private getCurrentPlatformShake(): [number, number] {
    if (this.platformShakeIndex > 0 && this.platformShakeIndex <= this.platformShakePattern.length) {
      return this.platformShakePattern[this.platformShakeIndex - 1];
    }
    return [0, 0];
  }

  private advancePan(): void {
    if (this.panConfig.max === 0) return;
    if (this.panOffset < this.panTarget) {
      this.panOffset = Math.min(this.panTarget, this.panOffset + this.panConfig.speed);
    } else if (this.panOffset > this.panTarget) {
      this.panOffset = Math.max(this.panTarget, this.panOffset - this.panConfig.speed);
    }
  }

  private advanceBlend(): void {
    if (this.blendFramesRemaining > 0) {
      this.blendFramesRemaining--;
    }
  }
}

// ============================================================
// Utility
// ============================================================

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutQuad(t: number): number {
  return t * (2 - t);
}
