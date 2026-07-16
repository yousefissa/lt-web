// ---------------------------------------------------------------------------
// AIController -- Decides actions for AI-controlled units.
// Implements LT's AI system with primary (attack) and secondary (move toward)
// behaviors. Supports all view_range modes, target/target_spec filtering,
// guard mode, defend (return to starting position), and move_away_from.
//
// Ported from: app/engine/ai_controller.py
// ---------------------------------------------------------------------------

import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { GameBoard } from '../objects/game-board';
import type { Database } from '../data/database';
import type { PathSystem } from '../pathfinding/path-system';
import type { AiBehavior } from '../data/types';
import {
  computeDamage,
  computeHit,
  computeCrit,
  canDouble,
  getEquippedWeapon,
} from '../combat/combat-calcs';
import { evaluateCondition } from '../events/event-manager';
import type { ConditionContext } from '../events/event-manager';

export interface AIAction {
  type: 'attack' | 'move' | 'wait' | 'use_item' | 'interact';
  unit: UnitObject;
  targetPosition?: [number, number]; // position to move to
  targetUnit?: UnitObject; // unit to attack/heal
  item?: ItemObject; // weapon or item to use
  movePath?: [number, number][]; // path to follow
  regionNid?: string; // region NID for interact actions
  regionSubNid?: string; // region sub_nid for interact actions (e.g., 'Destructible')
}

/**
 * AIController -- Decides actions for AI-controlled units.
 * Faithfully implements LT's AI system with:
 * - Behaviour iteration with fallback
 * - All view_range modes (-4 through positive)
 * - target/target_spec filtering with invert_targeting
 * - Guard mode movement restriction
 * - Defend AI (return to starting position)
 * - Move_away_from (smart retreat)
 * - Primary -> Secondary fallback per behaviour
 */
export class AIController {
  private db: Database;
  private board: GameBoard;
  private pathSystem: PathSystem;
  /** Reference to the game state for region lookups. Set after construction. */
  gameRef: any;

  constructor(db: Database, board: GameBoard, pathSystem: PathSystem) {
    this.db = db;
    this.board = board;
    this.pathSystem = pathSystem;
    this.gameRef = null;
  }

  /**
   * Order a phase's AI units like Python LT's AIState.get_next_unit(): AI
   * priority first, then Manhattan distance to the closest enemy, preserving
   * insertion order for exact ties.
   */
  orderUnitsForTurn(units: UnitObject[]): UnitObject[] {
    return units.map((unit, index) => ({
      unit,
      index,
      priority: this.db.ai.get(unit.ai)?.priority ?? 0,
      distance: this.distanceToClosestEnemy(unit),
    })).sort((a, b) =>
      b.priority - a.priority
      || a.distance - b.distance
      || a.index - b.index,
    ).map((entry) => entry.unit);
  }

  /**
   * Determine the best action for an AI unit.
   * Iterates through behaviours in priority order, trying each until one succeeds.
   */
  getAction(unit: UnitObject): AIAction {
    const aiDef = this.db.ai.get(unit.ai);

    // Default: just wait if no AI definition found
    if (!aiDef) {
      return { type: 'wait', unit };
    }

    // Walk through behaviours in priority order
    for (const behaviour of aiDef.behaviours) {
      // Skip 'None' action behaviours
      if (behaviour.action === 'None' || behaviour.action === '') continue;

      // Skip view_range 0 (disabled)
      if (behaviour.view_range === 0) continue;

      // Check condition (empty string = always true)
      if (behaviour.condition && behaviour.condition.trim() !== '') {
        const ctx: ConditionContext = {
          game: this.gameRef,
          unit1: unit,
          position: unit.position ?? undefined,
          gameVars: this.gameRef?.gameVars,
          levelVars: this.gameRef?.levelVars,
        };
        if (!evaluateCondition(behaviour.condition, ctx)) {
          continue;
        }
      }

      // Compute valid moves (guard mode restricts to current position)
      const validMoves = this.getValidMovesForBehaviour(unit, behaviour.view_range);

      // Try the behaviour
      const action = this.tryBehaviour(unit, behaviour, validMoves, aiDef.offense_bias);
      if (action) return action;
    }

    // All behaviours exhausted -- wait
    return { type: 'wait', unit };
  }

  /**
   * Get valid moves for a unit, accounting for guard mode.
   * Guard mode (view_range -1): unit can only stay in place.
   */
  private getValidMovesForBehaviour(
    unit: UnitObject,
    viewRange: number,
  ): [number, number][] {
    if (viewRange === -1) {
      // Guard mode: can only stay at current position
      return unit.position ? [unit.position] : [];
    }
    return this.pathSystem.getValidMoves(unit, this.board);
  }

  /**
   * Try a single behaviour. Returns an action if successful, null if not.
   * For Attack/Support/Steal: tries primary AI, falls back to secondary if no target.
   * For Move_to/Interact: uses secondary AI directly.
   * For Move_away_from: uses smart retreat.
   */
  private tryBehaviour(
    unit: UnitObject,
    behaviour: AiBehavior,
    validMoves: [number, number][],
    offenseBias: number,
  ): AIAction | null {
    const action = behaviour.action;

    if (action === 'Attack') {
      // Get targets based on target type and spec
      const targets = this.getTargets(unit, behaviour);
      const enemies = this.filterByViewRange(unit, targets, behaviour.view_range);

      // Try primary AI (attack)
      const primaryAction = this.primaryAI(unit, validMoves, enemies, offenseBias);
      if (primaryAction) return primaryAction;

      // Fall back to secondary AI (move toward nearest target)
      const secondaryAction = this.secondaryAI(unit, validMoves, enemies, behaviour.view_range);
      if (secondaryAction) return secondaryAction;

      return null;
    }

    if (action === 'Support') {
      // Support targets are allies that need healing (HP < max)
      const allies = this.getAllies(unit).filter(ally => {
        return ally.currentHp < ally.maxHp;
      });
      // Also include self if the unit is damaged (for self-heal consumables)
      const selfDamaged = unit.currentHp < unit.maxHp;
      const filtered = this.filterByTargetSpec(allies, behaviour);
      const inRange = this.filterByViewRange(unit, filtered, behaviour.view_range);

      // Try primary AI: use a healing item/staff on an ally (or self)
      const primaryAction = this.supportPrimaryAI(unit, validMoves, inRange, selfDamaged);
      if (primaryAction) return primaryAction;

      // Fall back to secondary AI: move toward most injured ally
      const secondaryAction = this.supportSecondaryAI(unit, validMoves, inRange, behaviour.view_range);
      if (secondaryAction) return secondaryAction;

      return null;
    }

    if (action === 'Steal') {
      // Steal behaves like Attack but uses steal ability
      // For now, fall through to attack logic
      const targets = this.getTargets(unit, behaviour);
      const enemies = this.filterByViewRange(unit, targets, behaviour.view_range);
      const primaryAction = this.primaryAI(unit, validMoves, enemies, offenseBias);
      if (primaryAction) return primaryAction;
      const secondaryAction = this.secondaryAI(unit, validMoves, enemies, behaviour.view_range);
      return secondaryAction;
    }

    if (action === 'Interact') {
      // Move to a region/event position
      const targetPositions = this.getTargetPositions(unit, behaviour);
      if (targetPositions.length === 0) return null;

      // Check if any target position is directly reachable this turn
      const targetSpec = typeof behaviour.target_spec === 'string' ? behaviour.target_spec : '';
      for (const targetPos of targetPositions) {
        const reachable = validMoves.some(([mx, my]) => mx === targetPos[0] && my === targetPos[1]);
        if (reachable) {
          // Find the matching region for this position
          const regions = this.gameRef?.currentLevel?.regions ?? [];
          const region = regions.find((r: any) =>
            r.region_type === 'event' &&
            r.sub_nid === targetSpec &&
            targetPos[0] >= r.position[0] && targetPos[0] < r.position[0] + (r.size?.[0] ?? 1) &&
            targetPos[1] >= r.position[1] && targetPos[1] < r.position[1] + (r.size?.[1] ?? 1),
          );

          const movePath = this.pathSystem.getPath(unit, targetPos[0], targetPos[1], this.board);
          return {
            type: 'interact',
            unit,
            targetPosition: targetPos,
            movePath: movePath ?? (unit.position ? [unit.position, targetPos] : [targetPos]),
            regionNid: region?.nid,
            regionSubNid: region?.sub_nid ?? targetSpec,
          };
        }
      }

      // Can't reach target this turn — move toward it
      return this.moveTowardPosition(unit, validMoves, targetPositions);
    }

    if (action === 'Move_to' || action === 'move_to') {
      const targets = this.getMoveTargets(unit, behaviour);
      if (targets.length === 0) return null;

      // Secondary AI: move toward targets
      const secondaryAction = this.secondaryAI(unit, validMoves, targets, behaviour.view_range);
      return secondaryAction;
    }

    if (action === 'Move_away_from' || action === 'move_away_from') {
      return this.smartRetreat(unit, validMoves, behaviour);
    }

    if (action === 'Wait' || action === 'wait') {
      return { type: 'wait', unit };
    }

    return null;
  }

  // ====================================================================
  // Target resolution
  // ====================================================================

  /**
   * Get target units based on behaviour's target type and spec.
   */
  private getTargets(unit: UnitObject, behaviour: AiBehavior): UnitObject[] {
    const targetType = behaviour.target;

    let candidates: UnitObject[];

    if (targetType === 'Enemy') {
      candidates = this.getEnemies(unit);
    } else if (targetType === 'Ally') {
      candidates = this.getAllies(unit);
    } else if (targetType === 'Unit') {
      candidates = this.board.getAllUnits().filter(u => u !== unit && !u.isDead() && u.position);
    } else {
      // None or unsupported -- no targets
      return [];
    }

    return this.filterByTargetSpec(candidates, behaviour);
  }

  /**
   * Get move-to target units/positions.
   * Handles Position/Starting, Ally, Enemy, Terrain, Event targets.
   */
  private getMoveTargets(unit: UnitObject, behaviour: AiBehavior): UnitObject[] {
    const targetType = behaviour.target;

    if (targetType === 'Position') {
      // Target spec determines the position
      if (behaviour.target_spec === 'Starting') {
        // Return to starting position -- create a virtual target
        if (unit.startingPosition) {
          // Check if already at starting position
          if (unit.position &&
              unit.position[0] === unit.startingPosition[0] &&
              unit.position[1] === unit.startingPosition[1]) {
            return []; // Already home
          }
          // Create a virtual "target" at the starting position
          // We'll handle this in secondaryAI by checking position directly
          return this.createPositionTargets([unit.startingPosition]);
        }
        return [];
      }

      // Literal position from target_spec
      if (Array.isArray(behaviour.target_spec) && behaviour.target_spec.length === 2) {
        const pos: [number, number] = [
          Number(behaviour.target_spec[0]),
          Number(behaviour.target_spec[1]),
        ];
        if (!isNaN(pos[0]) && !isNaN(pos[1])) {
          return this.createPositionTargets([pos]);
        }
      }
      return [];
    }

    // For Ally, Enemy, Unit targets -- reuse getTargets
    return this.getTargets(unit, behaviour);
  }

  /**
   * Create virtual "target" objects at positions for move-to AI.
   * Returns units at those positions if occupied, or creates temporary targets.
   */
  private createPositionTargets(positions: [number, number][]): UnitObject[] {
    const targets: UnitObject[] = [];
    for (const pos of positions) {
      const occupant = this.board.getUnit(pos[0], pos[1]);
      if (occupant && !occupant.isDead()) {
        targets.push(occupant);
      } else {
        // No unit at position -- we need to handle this in secondaryAI
        // by passing positions directly. For now, return empty and handle
        // position-based movement separately.
      }
    }
    return targets;
  }

  /**
   * Get target positions for Interact (Event regions) and Terrain targets.
   */
  private getTargetPositions(unit: UnitObject, behaviour: AiBehavior): [number, number][] {
    if (behaviour.target === 'Event') {
      // Find Event regions matching target_spec sub_nid
      const targetSpec = typeof behaviour.target_spec === 'string' ? behaviour.target_spec : '';
      const regions = this.gameRef?.currentLevel?.regions ?? [];
      const positions: [number, number][] = [];
      for (const region of regions) {
        if (region.region_type !== 'event') continue;
        if (targetSpec && region.sub_nid !== targetSpec) continue;
        // Evaluate region condition against this unit
        if (region.condition) {
          const condCtx: ConditionContext = {
            game: this.gameRef,
            unit1: unit,
            region,
            gameVars: this.gameRef?.gameVars,
            levelVars: this.gameRef?.levelVars,
          };
          try {
            if (!evaluateCondition(region.condition, condCtx)) continue;
          } catch {
            continue;
          }
        }
        // Add all positions in the region
        const [rx, ry] = region.position;
        const [rw, rh] = region.size ?? [1, 1];
        for (let x = rx; x < rx + rw; x++) {
          for (let y = ry; y < ry + rh; y++) {
            positions.push([x, y]);
          }
        }
      }
      // Deduplicate
      const seen = new Set<string>();
      return positions.filter(([x, y]) => {
        const key = `${x},${y}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    if (behaviour.target === 'Terrain') {
      // Find all tiles of matching terrain type
      // TODO: implement terrain position lookup
      return [];
    }

    if (behaviour.target === 'Position') {
      if (behaviour.target_spec === 'Starting' && unit.startingPosition) {
        return [unit.startingPosition];
      }
      if (Array.isArray(behaviour.target_spec) && behaviour.target_spec.length === 2) {
        const pos: [number, number] = [
          Number(behaviour.target_spec[0]),
          Number(behaviour.target_spec[1]),
        ];
        if (!isNaN(pos[0]) && !isNaN(pos[1])) return [pos];
      }
    }

    return [];
  }

  /**
   * Filter units by target_spec and invert_targeting.
   */
  private filterByTargetSpec(units: UnitObject[], behaviour: AiBehavior): UnitObject[] {
    const spec = behaviour.target_spec;
    if (!spec) return units;

    // target_spec can be:
    // - null (no filter)
    // - "Starting" (for Position target)
    // - [specType, specValue] for unit filtering
    if (typeof spec === 'string') return units; // "Starting" etc handled elsewhere

    if (!Array.isArray(spec) || spec.length < 2) return units;

    const specType = spec[0];
    const specValue = spec[1];
    const invert = behaviour.invert_targeting;

    return units.filter(u => {
      let matches = false;

      switch (specType) {
        case 'Tag':
          matches = u.tags.includes(specValue);
          break;
        case 'Class':
          matches = u.klass === specValue;
          break;
        case 'Name':
          matches = u.name === specValue;
          break;
        case 'ID':
          matches = u.nid === specValue;
          break;
        case 'Team':
          matches = u.team === specValue;
          break;
        case 'Faction':
          // Faction is stored on generic units; check via prefab data
          // For simplicity, compare team or a faction field if available
          matches = false; // TODO: implement faction matching
          break;
        case 'Party':
          matches = false; // TODO: implement party matching
          break;
        case 'All':
          matches = true;
          break;
        default:
          matches = true;
          break;
      }

      return invert ? !matches : matches;
    });
  }

  // ====================================================================
  // View range filtering
  // ====================================================================

  /**
   * Filter targets by view range.
   *
   * View range semantics:
   *   -1: Guard mode -- only targets reachable from current position (weapon range only)
   *   -2: Single move -- targets within (max_item_range + MOV)
   *   -3: Double move -- targets within (max_item_range + 2*MOV)
   *   -4: Entire map -- all targets
   *    0: Disabled -- no targets
   *   >0: Custom range -- targets within that many tiles
   */
  private filterByViewRange(
    unit: UnitObject,
    targets: UnitObject[],
    viewRange: number,
  ): UnitObject[] {
    if (viewRange === -4) return targets; // All targets
    if (viewRange === 0) return []; // Disabled

    const unitPos = unit.position;
    if (!unitPos) return [];

    const maxItemRange = this.getMaxItemRange(unit);
    const mov = unit.getStatValue('MOV');

    let limit: number;

    switch (viewRange) {
      case -1:
        // Guard: only targets within weapon range from current position
        limit = maxItemRange;
        break;
      case -2:
        // Single move range
        limit = maxItemRange + mov;
        break;
      case -3:
        // Double move range
        limit = maxItemRange + mov * 2;
        break;
      default:
        // Positive: literal tile range
        limit = viewRange > 0 ? viewRange : 99;
        break;
    }

    return targets.filter(t => {
      if (!t.position) return false;
      return this.distance(unitPos, t.position) <= limit;
    });
  }

  /**
   * Get the maximum range of any weapon or usable item the unit has.
   * Includes staves and spells for proper view range calculations.
   */
  private getMaxItemRange(unit: UnitObject): number {
    let maxRange = 0;
    for (const item of unit.items) {
      if (item.isWeapon() || item.isSpell()) {
        maxRange = Math.max(maxRange, item.getMaxRange());
      }
    }
    return maxRange;
  }

  // ====================================================================
  // Primary AI: Find best attack target + position
  // ====================================================================

  /**
   * Primary AI: Find best attack target + position.
   * For each weapon, for each enemy in the target list, evaluate utility.
   */
  private primaryAI(
    unit: UnitObject,
    validMoves: [number, number][],
    enemies: UnitObject[],
    offenseBias: number,
  ): AIAction | null {
    if (validMoves.length === 0) return null;
    if (enemies.length === 0) return null;

    // Gather all weapons the unit can use
    const weapons: ItemObject[] = [];
    for (const item of unit.items) {
      if (item.isWeapon()) {
        weapons.push(item);
      }
    }

    if (weapons.length === 0) return null;

    let bestUtility = -Infinity;
    let bestAction: AIAction | null = null;

    for (const weapon of weapons) {
      for (const enemy of enemies) {
        if (enemy.isDead()) continue;

        const attackPositions = this.getAttackPositions(validMoves, enemy, weapon);

        for (const pos of attackPositions) {
          const utility = this.evaluateAttackUtility(
            unit,
            weapon,
            enemy,
            pos,
            offenseBias,
          );

          if (utility > bestUtility) {
            bestUtility = utility;

            // Compute the path to the attack position
            const path = unit.position
              ? this.pathSystem.getPath(unit, pos[0], pos[1], this.board)
              : null;

            bestAction = {
              type: 'attack',
              unit,
              targetPosition: pos,
              targetUnit: enemy,
              item: weapon,
              movePath: path ?? [pos],
            };
          }
        }
      }
    }

    return bestAction;
  }

  // ====================================================================
  // Secondary AI: Move toward nearest target
  // ====================================================================

  /**
   * Secondary AI: Move toward nearest target if can't attack.
   * Uses pathfinding to find the closest reachable position.
   * For view_range -4, widens search to full map if initial search fails.
   */
  private secondaryAI(
    unit: UnitObject,
    validMoves: [number, number][],
    targets: UnitObject[],
    viewRange: number,
  ): AIAction | null {
    if (validMoves.length === 0) return null;
    if (!unit.position) return null;
    if (targets.length === 0) return null;

    // Find the nearest target by path distance
    let bestMove: [number, number] | null = null;
    let bestDist = Infinity;
    let nearestTarget: UnitObject | null = null;

    for (const target of targets) {
      if (target.isDead() || !target.position) continue;

      const path = this.pathSystem.getPath(
        unit,
        target.position[0],
        target.position[1],
        this.board,
      );

      if (path && path.length > 0) {
        const dist = path.length;
        if (dist < bestDist) {
          bestDist = dist;

          // Use travelAlgorithm to find the best reachable position along the path
          const moveTarget = this.pathSystem.travelAlgorithm(path, unit, this.board);
          bestMove = moveTarget;
          nearestTarget = target;
        }
      } else {
        // Fallback: use Manhattan distance if no path found
        const manhattanDist = this.distance(unit.position, target.position);
        if (manhattanDist < bestDist) {
          bestDist = manhattanDist;
          nearestTarget = target;

          // Can't path -- find closest valid move toward the target
          bestMove = this.findClosestMoveToward(unit.position, target.position, validMoves);
        }
      }
    }

    if (!bestMove || !nearestTarget) return null;

    // Only move if the target is different from current position
    if (
      bestMove[0] === unit.position[0] &&
      bestMove[1] === unit.position[1]
    ) {
      return null; // Already as close as possible
    }

    // Get the sub-path to the move target
    const movePath = this.pathSystem.getPath(
      unit,
      bestMove[0],
      bestMove[1],
      this.board,
    );

    return {
      type: 'move',
      unit,
      targetPosition: bestMove,
      targetUnit: nearestTarget,
      movePath: movePath ?? [unit.position, bestMove],
    };
  }

  // ====================================================================
  // Support AI: Healing items and staves
  // ====================================================================

  /**
   * Gather all items the AI can use for healing/support:
   * - Staves (spell + target_ally + has uses)
   * - Consumable healing items (usable/heal + has uses)
   * Excludes items with the no_ai component.
   */
  private getSupportItems(unit: UnitObject): ItemObject[] {
    const items: ItemObject[] = [];
    for (const item of unit.items) {
      if (item.hasNoAI()) continue;
      if (!item.hasUsesRemaining()) continue;

      // Staves: spell/magic items that target allies and can heal
      if ((item.isSpell() || item.hasComponent('weapon_type')) && item.targetsAllies() && item.canHeal()) {
        items.push(item);
        continue;
      }

      // Consumable healing items (Vulnerary, Elixir, etc.)
      if (item.isHealing() && !item.isWeapon()) {
        items.push(item);
        continue;
      }
    }
    return items;
  }

  /**
   * Primary AI for Support behavior: evaluate healing item use.
   * For each healing item × target × valid move position, compute heal priority.
   * Handles both staves (ranged, targets allies) and consumables (self-heal).
   *
   * Matches Python's PrimaryAI logic: items with target_ally use
   * item_system.ai_priority() which dispatches to Heal.ai_priority().
   */
  private supportPrimaryAI(
    unit: UnitObject,
    validMoves: [number, number][],
    targets: UnitObject[],
    selfDamaged: boolean,
  ): AIAction | null {
    if (validMoves.length === 0) return null;

    const items = this.getSupportItems(unit);
    if (items.length === 0) return null;

    let bestPriority = 0; // Must exceed 0 to be worth doing
    let bestAction: AIAction | null = null;

    for (const item of items) {
      const isStaff = item.isSpell() || (item.targetsAllies() && item.getMaxRange() > 0);
      const isSelfHeal = !isStaff && item.isHealing();

      if (isStaff) {
        // Staff: evaluate against each ally target from each valid position
        for (const target of targets) {
          if (target.isDead() || !target.position) continue;
          // Skip fully healed allies
          if (target.currentHp >= target.maxHp) continue;

          const attackPositions = this.getAttackPositions(validMoves, target, item);

          for (const pos of attackPositions) {
            const priority = this.computeHealPriority(unit, item, target);
            if (priority > bestPriority) {
              bestPriority = priority;
              const path = unit.position
                ? this.pathSystem.getPath(unit, pos[0], pos[1], this.board)
                : null;

              bestAction = {
                type: 'attack', // Staves go through combat system
                unit,
                targetPosition: pos,
                targetUnit: target,
                item,
                movePath: path ?? [pos],
              };
            }
          }
        }
      } else if (isSelfHeal && selfDamaged) {
        // Consumable self-heal: can use from any valid move position
        // Python's range-0 hack: items with range 0 add all valid moves as
        // potential target positions, allowing self-heal from any reachable spot.
        // Pick the safest position (farthest from enemies).
        const enemies = this.getEnemies(unit);
        const priority = this.computeHealPriority(unit, item, unit);

        if (priority > bestPriority) {
          // Find the safest position to use the item from
          let safestPos = validMoves[0];
          let bestMinDist = -1;

          for (const pos of validMoves) {
            let minDistToEnemy = Infinity;
            for (const enemy of enemies) {
              if (!enemy.position) continue;
              minDistToEnemy = Math.min(minDistToEnemy, this.distance(pos, enemy.position));
            }
            if (minDistToEnemy > bestMinDist) {
              bestMinDist = minDistToEnemy;
              safestPos = pos;
            }
          }

          bestPriority = priority;
          const path = unit.position
            ? this.pathSystem.getPath(unit, safestPos[0], safestPos[1], this.board)
            : null;

          bestAction = {
            type: 'use_item', // Consumables bypass combat system
            unit,
            targetPosition: safestPos,
            targetUnit: unit, // Self-target
            item,
            movePath: path ?? [safestPos],
          };
        }
      }
    }

    return bestAction;
  }

  /**
   * Compute heal priority for an AI unit using a healing item on a target.
   * Matches Python's Heal.ai_priority():
   *   help_term = clamp(missing_health / max_hp, 0, 1)
   *   heal_term = clamp(min(heal_amount, missing_health) / max_hp, 0, 1)
   *   priority = help_term * heal_term
   *
   * Higher priority = ally is more injured AND the heal covers more of the gap.
   */
  private computeHealPriority(
    unit: UnitObject,
    item: ItemObject,
    target: UnitObject,
  ): number {
    const maxHp = target.maxHp;
    if (maxHp <= 0) return 0;

    const missingHealth = maxHp - target.currentHp;
    if (missingHealth <= 0) return 0;

    const helpTerm = Math.min(1, Math.max(0, missingHealth / maxHp));

    // Get heal amount — for staves, pass the caster's MAG stat
    const mag = unit.getStatValue('MAG') ?? unit.getStatValue('STR') ?? 0;
    const healAmount = item.getHealAmount(mag);
    const effectiveHeal = Math.min(healAmount, missingHealth);
    const healTerm = Math.min(1, Math.max(0, effectiveHeal / maxHp));

    return helpTerm * healTerm;
  }

  /**
   * Enhanced secondary AI for Support: move toward the most injured ally.
   * Weights strongly by injury severity (help_term weight 100 vs distance weight 60),
   * matching the Python SecondaryAI's Support priority weighting.
   */
  private supportSecondaryAI(
    unit: UnitObject,
    validMoves: [number, number][],
    targets: UnitObject[],
    viewRange: number,
  ): AIAction | null {
    if (validMoves.length === 0 || !unit.position || targets.length === 0) return null;

    // Score each target by injury severity weighted against distance
    let bestMove: [number, number] | null = null;
    let bestScore = -Infinity;
    let nearestTarget: UnitObject | null = null;

    for (const target of targets) {
      if (target.isDead() || !target.position) continue;

      const maxHp = target.maxHp;
      const missingHealth = maxHp - target.currentHp;
      if (missingHealth <= 0) continue;

      const helpTerm = Math.min(1, Math.max(0, missingHealth / maxHp));
      const dist = this.distance(unit.position, target.position);
      const distTerm = 1 / (1 + dist);

      // Python weights: help_term * 100, dist_term * 60
      const score = helpTerm * 100 + distTerm * 60;

      if (score > bestScore) {
        bestScore = score;
        nearestTarget = target;
      }
    }

    if (!nearestTarget) return null;

    // Use the standard secondary AI movement toward the best target
    return this.secondaryAI(unit, validMoves, [nearestTarget], viewRange);
  }

  /**
   * Move toward a specific set of positions (for Interact, Position targets).
   */
  private moveTowardPosition(
    unit: UnitObject,
    validMoves: [number, number][],
    targetPositions: [number, number][],
  ): AIAction | null {
    if (!unit.position || validMoves.length === 0) return null;

    let bestMove: [number, number] | null = null;
    let bestDist = Infinity;

    for (const targetPos of targetPositions) {
      // Check if we're already at or adjacent to the target
      const dist = this.distance(unit.position, targetPos);
      if (dist === 0) return null; // Already there

      const path = this.pathSystem.getPath(unit, targetPos[0], targetPos[1], this.board);
      if (path && path.length > 0) {
        if (path.length < bestDist) {
          bestDist = path.length;
          bestMove = this.pathSystem.travelAlgorithm(path, unit, this.board);
        }
      } else {
        // Fallback: find closest valid move toward target
        if (dist < bestDist) {
          bestDist = dist;
          bestMove = this.findClosestMoveToward(unit.position, targetPos, validMoves);
        }
      }
    }

    if (!bestMove) return null;

    if (bestMove[0] === unit.position[0] && bestMove[1] === unit.position[1]) {
      return null;
    }

    const movePath = this.pathSystem.getPath(unit, bestMove[0], bestMove[1], this.board);

    return {
      type: 'move',
      unit,
      targetPosition: bestMove,
      movePath: movePath ?? [unit.position, bestMove],
    };
  }

  // ====================================================================
  // Smart retreat (Move_away_from)
  // ====================================================================

  /**
   * Smart retreat: find the position in valid moves that is farthest from threats.
   */
  private smartRetreat(
    unit: UnitObject,
    validMoves: [number, number][],
    behaviour: AiBehavior,
  ): AIAction | null {
    if (!unit.position || validMoves.length === 0) return null;

    // Get the threats to move away from
    const threats = this.getTargets(unit, behaviour);
    const filteredThreats = this.filterByViewRange(unit, threats, behaviour.view_range);

    if (filteredThreats.length === 0) return null;

    // Find the valid move position that maximizes minimum distance from all threats
    let bestMove: [number, number] | null = null;
    let bestMinDist = -Infinity;

    for (const move of validMoves) {
      let minDistToAnyThreat = Infinity;
      for (const threat of filteredThreats) {
        if (!threat.position) continue;
        const dist = this.distance(move, threat.position);
        minDistToAnyThreat = Math.min(minDistToAnyThreat, dist);
      }

      if (minDistToAnyThreat > bestMinDist) {
        bestMinDist = minDistToAnyThreat;
        bestMove = move;
      }
    }

    if (!bestMove) return null;

    // Don't move if already at the best spot
    if (bestMove[0] === unit.position[0] && bestMove[1] === unit.position[1]) {
      return null;
    }

    const movePath = this.pathSystem.getPath(unit, bestMove[0], bestMove[1], this.board);

    return {
      type: 'move',
      unit,
      targetPosition: bestMove,
      movePath: movePath ?? [unit.position, bestMove],
    };
  }

  // ====================================================================
  // Utility evaluation
  // ====================================================================

  /**
   * Evaluate attack utility for choosing best target.
   * Higher utility = better attack choice.
   * Factors: lethality, accuracy, damage dealt, risk taken.
   */
  private evaluateAttackUtility(
    unit: UnitObject,
    item: ItemObject,
    target: UnitObject,
    attackPosition: [number, number],
    offenseBias: number,
  ): number {
    // --- Offense ---
    const expectedDamage = computeDamage(unit, item, target, this.db, this.board);
    const targetHP = Math.max(1, target.currentHp);
    const lethality = Math.min(1.0, expectedDamage / targetHP);

    const hitChance = computeHit(unit, item, target, this.db, this.board);
    const accuracy = hitChance / 100;

    const defenderWeapon = getEquippedWeapon(target);
    const doubles = canDouble(unit, item, target, defenderWeapon, this.db);
    const numAttacks = 1 + (doubles ? 1 : 0);

    const critChance = computeCrit(unit, item, target, this.db);
    const critBonus = (critChance / 100) * 0.5;

    // Kill bonus: strongly prefer targets we can kill
    const killBonus = (expectedDamage * numAttacks >= targetHP) ? 2.0 : 0;

    const offense = lethality * accuracy * numAttacks + critBonus + killBonus;

    // --- Defense ---
    // Determine distance from attack position to target
    const targetPos = target.position;
    const dist = targetPos
      ? this.distance(attackPosition, targetPos)
      : 1;

    // Check if target has a weapon that can counter at this distance
    const counterWeapon = this.findCounterWeapon(target, dist);
    let defense: number;

    if (counterWeapon) {
      const targetDamage = computeDamage(target, counterWeapon, unit, this.db, this.board);
      const targetAccuracy = computeHit(target, counterWeapon, unit, this.db, this.board);
      const rawThreat = (targetDamage * targetAccuracy) / 100;
      const unitHP = Math.max(1, unit.currentHp);
      defense = 1 - Math.min(1.0, rawThreat / unitHP);
    } else {
      // Target can't counter -- defense factor is high (safe attack)
      defense = 1.0;
    }

    // --- Distance factor ---
    // Slight preference for closer attack positions (less movement = less risk)
    const unitPos = unit.position ?? attackPosition;
    const movementDistance = this.distance(unitPos, attackPosition);
    const distanceFactor = 1 / (1 + movementDistance * 0.1);

    // --- Final utility ---
    // Normalize offense_bias: bias ranges 0-4, with 2.0 = balanced
    const offenseWeight = offenseBias / (offenseBias + 1);
    const defenseWeight = 1 - offenseWeight;

    const utility =
      offense * offenseWeight +
      defense * defenseWeight +
      distanceFactor * 0.1;

    return utility;
  }

  // ====================================================================
  // Helpers
  // ====================================================================

  /**
   * Get all valid attack positions for a unit against a specific target.
   * Returns positions in validMoves that are within the weapon's range of the target.
   */
  private getAttackPositions(
    validMoves: [number, number][],
    target: UnitObject,
    item: ItemObject,
  ): [number, number][] {
    const targetPos = target.position;
    if (!targetPos) return [];

    const minRange = item.getMinRange();
    const maxRange = item.getMaxRange();
    const positions: [number, number][] = [];

    for (const move of validMoves) {
      const dist = this.distance(move, targetPos);
      if (dist >= minRange && dist <= maxRange) {
        positions.push(move);
      }
    }

    return positions;
  }

  /**
   * Get all enemies of this unit.
   */
  private getEnemies(unit: UnitObject): UnitObject[] {
    return this.board.getAllUnits().filter((other) => {
      if (other === unit) return false;
      if (other.isDead()) return false;
      if (!other.position) return false;
      return !this.db.areAllied(unit.team, other.team);
    });
  }

  private distanceToClosestEnemy(unit: UnitObject): number {
    if (!unit.position) return -1;
    const enemies = this.getEnemies(unit);
    if (enemies.length === 0) return -1;
    return Math.min(...enemies.map((enemy) => this.distance(unit.position!, enemy.position!)));
  }

  /**
   * Get all allies of this unit (same team / allied teams).
   */
  private getAllies(unit: UnitObject): UnitObject[] {
    return this.board.getAllUnits().filter((other) => {
      if (other === unit) return false;
      if (other.isDead()) return false;
      if (!other.position) return false;
      return this.db.areAllied(unit.team, other.team);
    });
  }

  /**
   * Find the valid move position closest to a target position (Manhattan distance).
   */
  private findClosestMoveToward(
    _unitPos: [number, number],
    targetPos: [number, number],
    validMoves: [number, number][],
  ): [number, number] | null {
    let best: [number, number] | null = null;
    let bestDist = Infinity;

    for (const move of validMoves) {
      const dist = this.distance(move, targetPos);
      if (dist < bestDist) {
        bestDist = dist;
        best = move;
      }
    }

    return best;
  }

  /**
   * Find a weapon on the defender that can counter at the given distance.
   * Returns the first matching weapon, or null.
   */
  private findCounterWeapon(defender: UnitObject, dist: number): ItemObject | null {
    for (const item of defender.items) {
      if (!item.isWeapon()) continue;
      if (dist >= item.getMinRange() && dist <= item.getMaxRange()) {
        return item;
      }
    }
    return null;
  }

  /**
   * Manhattan distance between two positions.
   */
  private distance(a: [number, number], b: [number, number]): number {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  }

  // =========================================================================
  // AI Group Activation
  // =========================================================================

  /**
   * Check if a player unit at the given position triggers activation of any
   * AI group. A group activates when a player unit is within the detection
   * range (move + max weapon range) of any inactive group member.
   */
  checkGroupActivation(
    playerPos: [number, number],
    game: { isAiGroupActive(g: string): boolean; activateAiGroup(g: string): void },
  ): void {
    const allUnits = this.board.getAllUnits();
    for (const enemy of allUnits) {
      if (enemy.isDead() || !enemy.position) continue;
      if (!enemy.aiGroup || enemy.aiGroup === '') continue;
      if (enemy.team === 'player') continue;
      if (game.isAiGroupActive(enemy.aiGroup)) continue;

      // Detection range: movement + max weapon range
      const mov = enemy.getStatValue('MOV');
      const maxRange = this.getMaxItemRange(enemy);
      const detectionRange = mov + maxRange;

      if (this.distance(enemy.position, playerPos) <= detectionRange) {
        game.activateAiGroup(enemy.aiGroup);
      }
    }
  }

  /**
   * Activate the group of a unit that was involved in combat.
   */
  activateGroupOnCombat(
    unit: UnitObject,
    game: { activateAiGroup(g: string): void },
  ): void {
    if (unit.aiGroup && unit.aiGroup !== '') {
      game.activateAiGroup(unit.aiGroup);
    }
  }

}
