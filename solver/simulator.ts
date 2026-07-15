import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { AIController, type AIAction } from '../src/ai/ai-controller';
import {
  canDouble,
  computeDamage,
  computeHit,
  weaponTriangle,
} from '../src/combat/combat-calcs';
import {
  CombatPhaseSolver,
  type CombatStrike,
  type RngMode,
} from '../src/combat/combat-solver';
import type { Database } from '../src/data/database';
import type {
  GenericUnitData,
  KlassDef,
  LevelPrefab,
  TilemapData,
  UniqueUnitData,
  UnitPrefab,
} from '../src/data/types';
import { SeededRandom } from '../src/engine/random';
import { GameBoard } from '../src/objects/game-board';
import { ItemObject } from '../src/objects/item';
import { SkillObject } from '../src/objects/skill';
import { UnitObject } from '../src/objects/unit';
import { PathSystem } from '../src/pathfinding/path-system';
import {
  buildStandardEventPlan,
  findRegion,
  getGroup,
  inferObjectiveType,
  parsePosition,
  resolveGroupPosition,
  type EventGroupSpawnRule,
  type ParsedEventCommand,
} from './event-adapter';
import type {
  MapSnapshot,
  LegalActionOptions,
  PlannerAction,
  PolicyWeights,
  Position,
  ReplayStep,
  SolverActionType,
  SolverMetrics,
  SolverObjectiveType,
  SolverPhase,
  SolverResult,
  SolverScenario,
  StrikeRecord,
  TacticalCheckpoint,
  TacticalUnitCheckpoint,
  TeamUnitConfig,
  UnitSnapshot,
} from './types';

interface AttackCandidate {
  unit: UnitObject;
  target: UnitObject;
  item: ItemObject;
  position: Position;
  score: number;
}

interface MoveCandidate {
  unit: UnitObject;
  position: Position;
  score: number;
}

interface HealCandidate extends MoveCandidate {
  target: UnitObject;
  item: ItemObject;
  amount: number;
}

export const DEFAULT_POLICY: PolicyWeights = {
  kill: 90,
  bossKill: 180,
  damage: 3.5,
  counterDamage: 5,
  lethalRisk: 1500,
  progress: 12,
  danger: 3.5,
  wall: 120,
  heal: 4,
  stayHealthy: 2,
  unitBias: {
    Seth: 18,
    Eirika: 8,
    Franz: 6,
    Gilliam: 4,
    Garcia: 3,
    Vanessa: 2,
    Ross: -2,
    Neimi: -1,
    Moulder: -8,
  },
  unitRisk: {},
};

function isGenericUnit(data: UniqueUnitData | GenericUnitData): data is GenericUnitData {
  return data.generic === true;
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function clonePosition(position: Position | null): Position | null {
  return position ? [position[0], position[1]] : null;
}

function fixedLevelGains(
  unit: UnitObject,
  klass: KlassDef,
  baseLevel: number,
  levels: number,
): void {
  const gains: Record<string, number> = {};
  for (const stat of Object.keys(unit.stats)) gains[stat] = 0;

  for (let index = 0; index < levels; index++) {
    const pseudoLevel = baseLevel + index;
    for (const stat of Object.keys(unit.growths)) {
      let growth = (unit.growths[stat] ?? 0) + (klass.growth_bonus?.[stat] ?? 0);
      let gained = Math.floor(growth / 100);
      growth %= 100;
      if (growth > 0 && (50 + growth * pseudoLevel) % 100 < growth) gained++;
      gains[stat] = (gains[stat] ?? 0) + gained;
    }
  }

  for (const [stat, gain] of Object.entries(gains)) {
    const cap = klass.max_stats?.[stat] ?? 99;
    unit.stats[stat] = Math.min(cap, (unit.stats[stat] ?? 0) + gain);
  }
  unit.currentHp = unit.maxHp;
}

function copyPolicy(policy: PolicyWeights): PolicyWeights {
  return {
    ...policy,
    unitBias: { ...policy.unitBias },
    unitRisk: { ...(policy.unitRisk ?? {}) },
  };
}

export class TacticalSimulator {
  readonly db: Database;
  readonly scenario: SolverScenario;
  readonly policy: PolicyWeights;
  readonly level: LevelPrefab;
  readonly tilemap: TilemapData;
  readonly board: GameBoard;
  readonly pathSystem: PathSystem;
  readonly rng: SeededRandom;
  readonly rngMode: RngMode;
  readonly objectiveType: Exclude<SolverObjectiveType, 'auto'>;

  private aiController: AIController;
  private combatSolver: CombatPhaseSolver;
  private units: Map<string, UnitObject>;
  private replay: ReplayStep[];
  private metrics: SolverMetrics;
  private initialPlayerHp: number;
  private seizePosition: Position | null;
  private currentTurn: number;
  private currentPhase: SolverPhase;
  private cleared: boolean;
  private lost: boolean;
  private dangerMoveCache: Map<string, Position[]>;
  private eventSpawnRules: EventGroupSpawnRule[];
  private firedEventRules: Set<string>;
  private playerPhasePrepared: boolean;

  constructor(db: Database, scenario: SolverScenario, policy: PolicyWeights = DEFAULT_POLICY) {
    this.db = db;
    this.scenario = structuredClone(scenario);
    this.policy = copyPolicy(policy);
    for (const nid of Object.keys(scenario.team)) {
      if (this.policy.unitBias[nid] === undefined) this.policy.unitBias[nid] = 0;
      if (this.policy.unitRisk![nid] === undefined) this.policy.unitRisk![nid] = 1;
    }

    const level = db.levels.get(scenario.levelNid);
    if (!level) throw new Error(`Unknown level NID: ${scenario.levelNid}`);
    const tilemap = db.tilemaps.get(level.tilemap);
    if (!tilemap) throw new Error(`Missing tilemap "${level.tilemap}" for level ${level.nid}`);
    this.level = level;
    this.tilemap = tilemap;

    this.board = new GameBoard(tilemap.size[0], tilemap.size[1]);
    this.initializeTerrain();
    this.pathSystem = new PathSystem(db);
    this.rng = new SeededRandom(scenario.seed);
    this.rngMode = scenario.rngMode ?? 'true_hit';
    this.combatSolver = new CombatPhaseSolver(() => this.rng.next());
    const eventPlan = buildStandardEventPlan(db, level);
    this.objectiveType = inferObjectiveType(level, eventPlan.events, scenario.objective);
    this.units = new Map();
    this.replay = [];
    this.currentTurn = 1;
    this.currentPhase = 'player';
    this.cleared = false;
    this.lost = false;
    this.dangerMoveCache = new Map();
    this.eventSpawnRules = scenario.eventAdapter === 'standard' ? eventPlan.spawnRules : [];
    this.firedEventRules = new Set();
    this.playerPhasePrepared = false;

    this.seizePosition = this.findSeizePosition();
    this.spawnInitialUnits();
    if (scenario.eventAdapter === 'standard') this.applyInitialEventCommands(eventPlan.initialCommands);

    this.aiController = new AIController(db, this.board, this.pathSystem);
    this.aiController.gameRef = {
      board: this.board,
      db: this.db,
      currentLevel: this.level,
      gameVars: new Map<string, unknown>(),
      levelVars: new Map<string, unknown>(),
      supports: null,
    };

    this.initialPlayerHp = this.playerUnits().reduce((sum, unit) => sum + unit.maxHp, 0);
    this.metrics = {
      cleared: false,
      lost: false,
      turns: 0,
      actions: 0,
      combats: 0,
      damageTaken: 0,
      healingReceived: 0,
      playerDeaths: 0,
      enemiesDefeated: 0,
      wallsBroken: 0,
      remainingPlayerHp: this.initialPlayerHp,
      remainingEnemyHp: 0,
    };
    this.recordStep('wait', 'Initial state');
  }

  run(): SolverResult {
    const started = performance.now();

    for (let turn = 1; turn <= this.scenario.maxTurns; turn++) {
      this.currentTurn = turn;
      this.metrics.turns = turn;

      this.currentPhase = 'player';
      this.runEventSpawns();
      this.runScriptedSpawns('player');
      this.runPlayerPhase();
      if (this.cleared || this.lost) break;

      this.runScriptedSpawns('enemy');
      this.runAiPhase('enemy');
      if (this.cleared || this.lost) break;

      this.runScriptedSpawns('other');
      this.runAiPhase('other');
      if (this.cleared || this.lost) break;
    }

    return this.getResult(performance.now() - started);
  }

  /** Return the current state in the same format as a completed simulation. */
  getResult(elapsedMs = 0): SolverResult {
    this.updateDerivedMetrics();
    return {
      scenario: this.scenario.name,
      levelNid: this.scenario.levelNid,
      objective: this.objectiveType,
      seed: this.scenario.seed,
      rngState: this.rng.getState(),
      rngMode: this.rngMode,
      policy: copyPolicy(this.policy),
      metrics: { ...this.metrics },
      score: this.buildScore(),
      map: this.mapSnapshot(),
      replay: this.replay,
      finalUnits: this.snapshotUnits(),
      elapsedMs,
    };
  }

  /** Prepare exactly one player turn. Safe to call repeatedly for the same turn. */
  beginPlayerTurn(): void {
    if (this.playerPhasePrepared || this.cleared || this.lost) return;
    if (this.currentTurn > this.scenario.maxTurns) return;
    this.metrics.turns = this.currentTurn;
    this.currentPhase = 'player';
    this.runEventSpawns();
    this.runScriptedSpawns('player');
    for (const unit of this.playerUnits()) unit.resetTurnState();
    this.playerPhasePrepared = true;
    this.refreshOutcome();
  }

  /** Whether every living, deployed player unit has consumed its action. */
  isPlayerTurnComplete(): boolean {
    return this.cleared || this.lost || this.playerUnits().every(
      (unit) => !unit.position || unit.isDead() || unit.finished,
    );
  }

  isTerminal(): boolean {
    return this.cleared || this.lost || this.currentTurn > this.scenario.maxTurns;
  }

  getCurrentTurn(): number {
    return this.currentTurn;
  }

  getEvaluationScore(): number[] {
    this.updateDerivedMetrics();
    return this.buildScore();
  }

  /**
   * Enumerate deterministic legal actions from the current player state.
   * Limits are optional beam-search pruning knobs; without them this returns
   * every legal attack, heal, move destination, seize, and wait action.
   */
  enumerateLegalActions(options: LegalActionOptions = {}): PlannerAction[] {
    if (!this.playerPhasePrepared || this.currentPhase !== 'player' || this.isTerminal()) return [];
    this.dangerMoveCache.clear();
    const actions: PlannerAction[] = [];
    const active = this.playerUnits().filter(
      (unit) => unit.position && !unit.isDead() && !unit.finished,
    );

    for (const unit of active) {
      const original = clonePosition(unit.position)!;
      const validMoves = this.pathSystem.getValidMoves(unit, this.board);
      const unitActions: PlannerAction[] = [];

      if (this.objectiveType === 'seize' && this.seizePosition && unit.tags.includes('Lord')) {
        if (validMoves.some((position) => samePosition(position, this.seizePosition!))) {
          unitActions.push({
            type: 'seize',
            turn: this.currentTurn,
            actor: unit.nid,
            position: clonePosition(this.seizePosition)!,
            heuristic: Number.MAX_SAFE_INTEGER,
          });
        }
      }

      const attacks: PlannerAction[] = [];
      for (let itemIndex = 0; itemIndex < unit.items.length; itemIndex++) {
        const item = unit.items[itemIndex];
        if (!item.isWeapon() || !item.hasUsesRemaining()) continue;
        for (const target of this.hostileUnits(unit)) {
          if (!target.position) continue;
          for (const position of validMoves) {
            const distance = manhattan(position, target.position);
            if (distance < item.getMinRange() || distance > item.getMaxRange()) continue;
            attacks.push({
              type: 'attack',
              turn: this.currentTurn,
              actor: unit.nid,
              target: target.nid,
              item: item.nid,
              itemIndex,
              position: clonePosition(position)!,
              heuristic: this.scoreAttack(unit, target, item, position),
            });
          }
        }
      }
      attacks.sort(comparePlannerActions);
      unitActions.push(...limitActions(attacks, options.maxAttacksPerUnit));

      const heals: PlannerAction[] = [];
      const injured = this.playerUnits().filter(
        (target) => target.position && !target.isDead() && target.currentHp < target.maxHp,
      );
      for (let itemIndex = 0; itemIndex < unit.items.length; itemIndex++) {
        const item = unit.items[itemIndex];
        if (!item.canHeal() || !item.hasUsesRemaining()) continue;
        const targets = item.isSpell() ? injured : injured.filter((target) => target === unit);
        for (const target of targets) {
          if (!target.position) continue;
          for (const position of validMoves) {
            const distance = manhattan(position, target.position);
            if (item.isSpell() && (distance < item.getMinRange() || distance > item.getMaxRange())) continue;
            const amount = Math.min(
              target.maxHp - target.currentHp,
              item.getHealAmount(unit.getStatValue('MAG')),
            );
            if (amount <= 0) continue;
            heals.push({
              type: 'heal',
              turn: this.currentTurn,
              actor: unit.nid,
              target: target.nid,
              item: item.nid,
              itemIndex,
              position: clonePosition(position)!,
              heuristic: amount * this.policy.heal
                + this.objectiveProgress(original, position) * this.policy.progress,
            });
          }
        }
      }
      heals.sort(comparePlannerActions);
      unitActions.push(...limitActions(heals, options.maxHealsPerUnit));

      const moves: PlannerAction[] = [];
      for (const position of validMoves) {
        if (samePosition(position, original)) continue;
        const progress = this.objectiveProgress(original, position);
        this.board.moveUnit(unit, position[0], position[1]);
        const danger = this.expectedDanger(unit);
        this.board.moveUnit(unit, original[0], original[1]);
        let heuristic = progress * this.policy.progress
          - danger * this.policy.danger * (this.policy.unitRisk?.[unit.nid] ?? 1);
        heuristic += this.policy.unitBias[unit.nid] ?? 0;
        heuristic += (unit.currentHp / Math.max(1, unit.maxHp)) * this.policy.stayHealthy;
        moves.push({
          type: 'move',
          turn: this.currentTurn,
          actor: unit.nid,
          position: clonePosition(position)!,
          heuristic,
        });
      }
      moves.sort(comparePlannerActions);
      unitActions.push(...limitActions(moves, options.maxMovesPerUnit));

      if (options.includeWait !== false) {
        unitActions.push({
          type: 'wait',
          turn: this.currentTurn,
          actor: unit.nid,
          position: original,
          heuristic: -1,
        });
      }
      actions.push(...unitActions);
    }

    return actions.sort(comparePlannerActions);
  }

  /** Return the legacy policy's next action as an explicit planner action. */
  getGreedyPlayerAction(): PlannerAction | null {
    if (!this.playerPhasePrepared || this.currentPhase !== 'player' || this.isTerminal()) return null;
    const active = this.playerUnits().filter(
      (unit) => unit.position && !unit.isDead() && !unit.finished,
    );
    if (active.length === 0) return null;

    const seize = this.findSeizeCandidate(active);
    if (seize) {
      return {
        type: 'seize',
        turn: this.currentTurn,
        actor: seize.unit.nid,
        position: clonePosition(seize.position)!,
        heuristic: seize.score,
      };
    }
    const attack = this.findBestAttack(active);
    if (attack) {
      return {
        type: 'attack',
        turn: this.currentTurn,
        actor: attack.unit.nid,
        target: attack.target.nid,
        item: attack.item.nid,
        itemIndex: attack.unit.items.indexOf(attack.item),
        position: clonePosition(attack.position)!,
        heuristic: attack.score,
      };
    }
    const heal = this.findBestHeal(active);
    if (heal && heal.score > 0) {
      return {
        type: 'heal',
        turn: this.currentTurn,
        actor: heal.unit.nid,
        target: heal.target.nid,
        item: heal.item.nid,
        itemIndex: heal.unit.items.indexOf(heal.item),
        position: clonePosition(heal.position)!,
        heuristic: heal.score,
      };
    }
    const move = this.findBestMove(active);
    if (move) {
      return {
        type: 'move',
        turn: this.currentTurn,
        actor: move.unit.nid,
        position: clonePosition(move.position)!,
        heuristic: move.score,
      };
    }
    const unit = active[0];
    return {
      type: 'wait',
      turn: this.currentTurn,
      actor: unit.nid,
      position: clonePosition(unit.position)!,
      heuristic: -1,
    };
  }

  /** Apply one action previously returned by enumerateLegalActions. */
  applyPlayerAction(action: PlannerAction): void {
    if (!this.playerPhasePrepared || this.currentPhase !== 'player') {
      throw new Error('Player turn has not been prepared');
    }
    if (action.turn !== this.currentTurn) {
      throw new Error(`Action turn ${action.turn} does not match simulator turn ${this.currentTurn}`);
    }
    const unit = this.units.get(action.actor);
    if (!unit?.position || unit.isDead() || unit.finished || unit.team !== 'player') {
      throw new Error(`Inactive player unit: ${action.actor}`);
    }
    const validMoves = this.pathSystem.getValidMoves(unit, this.board);
    if (!validMoves.some((position) => samePosition(position, action.position))) {
      throw new Error(`Illegal destination ${action.position.join(',')} for ${action.actor}`);
    }

    if (action.type === 'wait') {
      if (!samePosition(unit.position, action.position)) throw new Error('Wait must use the current position');
      unit.finished = true;
      this.metrics.actions++;
      this.recordStep('wait', `${unit.name} waits`, unit, unit.position);
    } else if (action.type === 'move') {
      this.moveAndFinish(unit, action.position, 'move');
    } else if (action.type === 'seize') {
      if (this.objectiveType !== 'seize' || !unit.tags.includes('Lord')
        || !this.seizePosition || !samePosition(action.position, this.seizePosition)) {
        throw new Error(`Illegal seize by ${action.actor}`);
      }
      this.moveAndFinish(unit, action.position, 'seize');
      this.cleared = true;
      this.recordStep('seize', `${unit.name} seizes the throne`, unit, unit.position);
    } else {
      const item = action.itemIndex === undefined ? undefined : unit.items[action.itemIndex];
      const target = action.target ? this.units.get(action.target) : undefined;
      if (!item || item.nid !== action.item || !item.hasUsesRemaining() || !target?.position || target.isDead()) {
        throw new Error(`Invalid ${action.type} target or item for ${action.actor}`);
      }
      const distance = manhattan(action.position, target.position);
      if (action.type === 'attack') {
        if (!item.isWeapon() || this.db.areAllied(unit.team, target.team)
          || distance < item.getMinRange() || distance > item.getMaxRange()) {
          throw new Error(`Illegal attack by ${action.actor}`);
        }
        this.executeAttack(unit, target, item, action.position);
      } else {
        const selfConsumable = !item.isSpell() && target === unit;
        if (!item.canHeal() || !this.db.areAllied(unit.team, target.team)
          || (!selfConsumable && (distance < item.getMinRange() || distance > item.getMaxRange()))) {
          throw new Error(`Illegal heal by ${action.actor}`);
        }
        const amount = Math.min(
          target.maxHp - target.currentHp,
          item.getHealAmount(unit.getStatValue('MAG')),
        );
        this.executeHeal({ unit, target, item, position: action.position, amount, score: action.heuristic });
      }
    }
    this.refreshOutcome();
  }

  /** Resolve deterministic enemy/other phases and advance to the next turn. */
  finishTurn(): void {
    if (!this.playerPhasePrepared) throw new Error('Player turn has not been prepared');
    if (!this.isPlayerTurnComplete()) throw new Error('Player units still have legal actions');
    if (!this.cleared && !this.lost) {
      this.runScriptedSpawns('enemy');
      this.runAiPhase('enemy');
    }
    if (!this.cleared && !this.lost) {
      this.runScriptedSpawns('other');
      this.runAiPhase('other');
    }
    this.playerPhasePrepared = false;
    this.refreshOutcome();
    this.updateDerivedMetrics();
    this.currentTurn++;
  }

  createCheckpoint(includeReplay = true): TacticalCheckpoint {
    return {
      version: 1,
      currentTurn: this.currentTurn,
      currentPhase: this.currentPhase,
      playerPhasePrepared: this.playerPhasePrepared,
      cleared: this.cleared,
      lost: this.lost,
      rngState: this.rng.getState(),
      initialPlayerHp: this.initialPlayerHp,
      metrics: { ...this.metrics },
      firedEventRules: Array.from(this.firedEventRules).sort(),
      units: Array.from(this.units.values()).map((unit) => this.checkpointUnit(unit))
        .sort((a, b) => a.nid.localeCompare(b.nid)),
      replay: includeReplay ? structuredClone(this.replay) : undefined,
    };
  }

  restoreCheckpoint(checkpoint: TacticalCheckpoint): void {
    if (checkpoint.version !== 1) throw new Error(`Unsupported checkpoint version: ${checkpoint.version}`);
    for (const unit of this.units.values()) this.board.removeUnit(unit);

    const checkpointNids = new Set(checkpoint.units.map((unit) => unit.nid));
    for (const nid of Array.from(this.units.keys())) {
      if (!checkpointNids.has(nid)) this.units.delete(nid);
    }

    for (const saved of checkpoint.units) {
      let unit = this.units.get(saved.nid);
      if (!unit) {
        const data = this.level.units.find((candidate) => candidate.nid === saved.nid);
        if (data) unit = this.spawnLevelUnit(data, saved.team, null) ?? undefined;
        if (!unit) {
          const prefab = this.db.units.get(saved.nid);
          if (prefab) unit = this.spawnFromPrefab(prefab, saved.team, null, saved.ai) ?? undefined;
        }
      }
      if (!unit) throw new Error(`Cannot restore unknown unit: ${saved.nid}`);
      this.restoreUnit(unit, saved);
    }

    for (const saved of checkpoint.units) {
      const unit = this.units.get(saved.nid)!;
      unit.rescuing = saved.rescuing ? this.units.get(saved.rescuing) ?? null : null;
      unit.rescuedBy = saved.rescuedBy ? this.units.get(saved.rescuedBy) ?? null : null;
      if (saved.position && !saved.dead) this.board.setUnit(saved.position[0], saved.position[1], unit);
    }

    this.currentTurn = checkpoint.currentTurn;
    this.currentPhase = checkpoint.currentPhase;
    this.playerPhasePrepared = checkpoint.playerPhasePrepared;
    this.cleared = checkpoint.cleared;
    this.lost = checkpoint.lost;
    this.initialPlayerHp = checkpoint.initialPlayerHp;
    this.metrics = { ...checkpoint.metrics };
    this.firedEventRules = new Set(checkpoint.firedEventRules);
    this.replay = checkpoint.replay ? structuredClone(checkpoint.replay) : [];
    this.rng.setState(checkpoint.rngState);
    this.dangerMoveCache.clear();
  }

  clone(includeReplay = true): TacticalSimulator {
    const clone = new TacticalSimulator(this.db, this.scenario, this.policy);
    clone.restoreCheckpoint(this.createCheckpoint(includeReplay));
    return clone;
  }

  /** Canonical cache key including the RNG stream and cumulative objective cost. */
  getTranspositionKey(): string {
    const checkpoint = this.createCheckpoint(false);
    return createHash('sha256').update(JSON.stringify(checkpoint)).digest('base64url');
  }

  getAsciiMap(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.board.height; y++) {
      let row = '';
      for (let x = 0; x < this.board.width; x++) {
        const unit = this.board.getUnit(x, y);
        if (unit) {
          row += unit.team === 'player' ? 'P' : unit.team === 'enemy' ? 'E' : 'O';
          continue;
        }
        if (this.seizePosition?.[0] === x && this.seizePosition[1] === y) {
          row += 'S';
          continue;
        }
        const terrain = this.db.terrain.get(this.board.getTerrain(x, y) ?? '');
        row += terrain?.mtype === 'Wall' ? '#' : terrain?.mtype === 'Throne' ? 'T' : '.';
      }
      rows.push(row);
    }
    return rows.join('\n');
  }

  getInitialUnits(): UnitSnapshot[] {
    return this.snapshotUnits();
  }

  getMapSnapshot(): MapSnapshot {
    return this.mapSnapshot();
  }

  private initializeTerrain(): void {
    for (const layer of this.tilemap.layers) {
      if (!layer.visible) continue;
      for (const [key, terrainNid] of Object.entries(layer.terrain_grid)) {
        const [x, y] = key.split(',').map(Number);
        this.board.setTerrain(x, y, terrainNid);
      }
    }
  }

  private findSeizePosition(): Position | null {
    const region = this.level.regions?.find((entry) => entry.sub_nid === 'Seize');
    return region ? [region.position[0], region.position[1]] : null;
  }

  private spawnInitialUnits(): void {
    const scripted = new Set((this.scenario.scriptedSpawns ?? []).map((spawn) => spawn.unitNid));
    for (const data of this.level.units) {
      if (!data.starting_position && scripted.has(data.nid)) continue;
      if (data.team === 'player' && this.scenario.team[data.nid]?.enabled === false) continue;
      if (!data.starting_position) continue;
      this.spawnLevelUnit(data, data.team, data.starting_position);
    }
  }

  private applyInitialEventCommands(commands: ParsedEventCommand[]): void {
    for (const command of commands) {
      const [first, second, third] = command.args;
      if (command.nid === 'remove_unit') this.removeInitialUnit(first);
      else if (command.nid === 'kill_unit') this.removeInitialUnit(first, true);
      else if (command.nid === 'add_unit') this.placeUnit(first, parsePosition(second), true);
      else if (command.nid === 'move_unit') this.placeUnit(first, parsePosition(second), false);
      else if (command.nid === 'remove_group') this.removeGroup(first);
      else if (command.nid === 'add_group') this.placeGroup(first, second, true, false);
      else if (command.nid === 'spawn_group') this.placeGroup(first, third, true, false);
      else if (command.nid === 'move_group') this.placeGroup(first, second, false, false);
      else if (command.nid === 'set_stats') this.setInitialStats(first, second);
      else if (command.nid === 'add_tag') this.addInitialTag(first, second);
      else if (command.nid === 'interact_unit') this.applyInitialScriptedCombat(first, second, third);
    }
  }

  private removeInitialUnit(nid: string, dead = false): void {
    const unit = this.units.get(nid);
    if (!unit) return;
    this.board.removeUnit(unit);
    if (dead) {
      unit.dead = true;
      unit.currentHp = 0;
    }
  }

  private removeGroup(groupNid: string): void {
    const group = getGroup(this.level, groupNid);
    if (!group) return;
    for (const nid of group.units) this.removeInitialUnit(nid);
  }

  private placeUnit(nid: string, requested: Position | null, allowSpawn: boolean): UnitObject | null {
    const data = this.level.units.find((candidate) => candidate.nid === nid);
    if (!data) return null;
    if (data.team === 'player' && this.scenario.team[nid]?.enabled === false) return null;
    const position = requested ?? clonePosition(data.starting_position);
    if (!position) return null;

    let unit = this.units.get(nid) ?? null;
    if (!unit && allowSpawn) unit = this.spawnLevelUnit(data, data.team, null);
    if (!unit || unit.isDead()) return null;
    const occupant = this.board.getUnit(position[0], position[1]);
    if (occupant && occupant !== unit) return null;
    if (unit.position) this.board.moveUnit(unit, position[0], position[1]);
    else this.board.setUnit(position[0], position[1], unit);
    return unit;
  }

  private placeGroup(
    groupNid: string,
    startingGroup: string | undefined,
    allowSpawn: boolean,
    recordSpawn: boolean,
  ): void {
    const group = getGroup(this.level, groupNid);
    if (!group) return;
    for (const nid of group.units) {
      const position = resolveGroupPosition(this.level, group, nid, startingGroup);
      if (!position) continue;
      const wasOnMap = !!this.units.get(nid)?.position;
      const unit = this.placeUnit(nid, position, allowSpawn);
      if (recordSpawn && unit && !wasOnMap) {
        this.recordStep('spawn', `${unit.name} enters the map`, unit, unit.position);
      }
    }
  }

  private setInitialStats(nid: string, encoded: string): void {
    const unit = this.units.get(nid);
    if (!unit) return;
    const values = encoded.split(',').map((value) => value.trim());
    for (let index = 0; index + 1 < values.length; index += 2) {
      const value = Number(values[index + 1]);
      if (values[index] && Number.isFinite(value)) unit.stats[values[index]] = value;
    }
    unit.currentHp = unit.maxHp;
  }

  private addInitialTag(nid: string, tag: string): void {
    const unit = this.units.get(nid);
    if (unit && tag && !unit.tags.includes(tag)) unit.tags.push(tag);
  }

  private applyInitialScriptedCombat(attackerNid: string, targetValue: string, encodedScript: string): void {
    const attacker = this.units.get(attackerNid);
    const targetPosition = parsePosition(targetValue);
    const defender = targetPosition
      ? this.board.getUnit(targetPosition[0], targetPosition[1])
      : this.units.get(targetValue);
    const attackItem = attacker?.items.find((item) => item.isWeapon() && item.hasUsesRemaining());
    if (!attacker || !defender || !attackItem || !encodedScript) return;
    const defenseItem = defender.items.find((item) => item.isWeapon() && item.hasUsesRemaining()) ?? null;
    const strikes = this.combatSolver.resolve(
      attacker,
      attackItem,
      defender,
      defenseItem,
      this.db,
      this.rngMode,
      this.board,
      encodedScript.split(',').map((token) => token.trim()),
    );
    for (const strike of strikes) {
      strike.item.decrementUses();
      if (!strike.hit || strike.defender.isDead()) continue;
      strike.defender.currentHp = Math.max(0, strike.defender.currentHp - strike.damage);
      if (strike.defender.currentHp <= 0) this.removeInitialUnit(strike.defender.nid, true);
    }
  }

  private spawnLevelUnit(
    data: UniqueUnitData | GenericUnitData,
    team: string,
    position: Position | null,
  ): UnitObject | null {
    if (isGenericUnit(data)) return this.spawnGeneric(data, team, position);
    const prefab = this.db.units.get(data.nid);
    if (!prefab) return null;
    return this.spawnFromPrefab(prefab, team, position, data.ai, this.scenario.team[data.nid]);
  }

  private spawnGeneric(data: GenericUnitData, team: string, position: Position | null): UnitObject | null {
    const klass = this.db.classes.get(data.klass);
    if (!klass) return null;
    const factionName = this.db.factions.get(data.faction)?.name ?? data.nid;
    const prefab: UnitPrefab = {
      nid: data.nid,
      name: data.variant || factionName,
      desc: '',
      level: data.level,
      klass: data.klass,
      tags: [...klass.tags],
      bases: { ...klass.bases },
      growths: { ...klass.growths },
      starting_items: data.starting_items,
      learned_skills: (data.starting_skills ?? []).map((nid) => [1, nid]),
      wexp_gain: klass.wexp_gain,
      portrait_nid: '',
      affinity: '',
    };
    const unit = this.spawnFromPrefab(prefab, team, position, data.ai);
    if (!unit) return null;
    fixedLevelGains(unit, klass, 1, Math.max(0, data.level - 1));
    unit.level = data.level;
    return unit;
  }

  private spawnFromPrefab(
    prefab: UnitPrefab,
    team: string,
    position: Position | null,
    ai: string,
    config?: TeamUnitConfig,
  ): UnitObject | null {
    const klass = this.db.classes.get(prefab.klass);
    if (!klass) return null;
    const unit = new UnitObject(prefab, klass);
    unit.team = team;
    unit.ai = ai;
    unit.tags = Array.from(new Set([...unit.tags, ...klass.tags]));
    unit.startingPosition = clonePosition(position);

    const targetLevel = config?.level ?? unit.level;
    if (targetLevel > unit.level) {
      fixedLevelGains(unit, klass, unit.level, targetLevel - unit.level);
      unit.level = targetLevel;
    } else if (targetLevel < unit.level) {
      unit.level = Math.max(1, targetLevel);
    }
    unit.exp = Math.max(0, Math.min(99, config?.exp ?? 0));
    if (config?.stats) {
      for (const [stat, value] of Object.entries(config.stats)) unit.stats[stat] = value;
      unit.currentHp = unit.maxHp;
    }

    const itemNids = config?.items ?? prefab.starting_items.map(([nid]) => nid);
    for (const nid of itemNids) {
      const itemPrefab = this.db.items.get(nid);
      if (!itemPrefab) throw new Error(`Unknown item "${nid}" for ${unit.nid}`);
      const item = new ItemObject(itemPrefab);
      item.owner = unit;
      unit.items.push(item);
    }

    const learned = [...(prefab.learned_skills ?? []), ...(klass.learned_skills ?? [])];
    for (const [requiredLevel, nid] of learned) {
      if (unit.level < requiredLevel || unit.skills.some((skill) => skill.nid === nid)) continue;
      const skillPrefab = this.db.skills.get(nid);
      if (skillPrefab) unit.skills.push(new SkillObject(skillPrefab));
    }

    this.units.set(unit.nid, unit);
    if (position) this.board.setUnit(position[0], position[1], unit);
    return unit;
  }

  private runPlayerPhase(): void {
    this.currentPhase = 'player';
    for (const unit of this.playerUnits()) unit.resetTurnState();

    let guard = 0;
    while (!this.cleared && !this.lost && guard++ < this.playerUnits().length * 3) {
      const active = this.playerUnits().filter((unit) => unit.position && !unit.isDead() && !unit.finished);
      if (active.length === 0) break;

      const seize = this.findSeizeCandidate(active);
      if (seize) {
        this.moveAndFinish(seize.unit, seize.position, 'seize');
        this.cleared = true;
        this.recordStep('seize', `${seize.unit.name} seizes the throne`, seize.unit, seize.unit.position);
        break;
      }

      const attack = this.findBestAttack(active);
      if (attack) {
        this.executeAttack(attack.unit, attack.target, attack.item, attack.position);
        continue;
      }

      const heal = this.findBestHeal(active);
      if (heal && heal.score > 0) {
        this.executeHeal(heal);
        continue;
      }

      const move = this.findBestMove(active);
      if (move) {
        this.moveAndFinish(move.unit, move.position, 'move');
        continue;
      }

      for (const unit of active) {
        unit.finished = true;
        this.metrics.actions++;
        this.recordStep('wait', `${unit.name} waits`, unit, unit.position);
      }
    }
    this.refreshOutcome();
  }

  private runAiPhase(phase: 'enemy' | 'other'): void {
    this.currentPhase = phase;
    const units = this.unitsByTeam(phase)
      .filter((unit) => unit.position && !unit.isDead())
      .sort((a, b) => (this.db.ai.get(b.ai)?.priority ?? 0) - (this.db.ai.get(a.ai)?.priority ?? 0));
    for (const unit of units) unit.resetTurnState();

    for (const unit of units) {
      if (!unit.position || unit.isDead() || this.cleared || this.lost) continue;
      const action = this.aiController.getAction(unit);
      this.executeAiAction(action);
      unit.finished = true;
      this.refreshOutcome();
    }
  }

  private runEventSpawns(): void {
    for (const rule of this.eventSpawnRules) {
      if (this.firedEventRules.has(rule.id) || !this.eventSpawnRuleMatches(rule)) continue;
      this.firedEventRules.add(rule.id);
      this.placeGroup(rule.groupNid, rule.startingGroup, true, true);
    }
  }

  private eventSpawnRuleMatches(rule: EventGroupSpawnRule): boolean {
    if (rule.trigger.type === 'turn') return this.currentTurn === rule.trigger.turn;
    const region = findRegion(this.level, rule.trigger.regionNid);
    if (!region) return false;
    return this.playerUnits().some((unit) => {
      if (!unit.position || unit.isDead()) return false;
      const [x, y] = unit.position;
      return x >= region.position[0]
        && y >= region.position[1]
        && x < region.position[0] + region.size[0]
        && y < region.position[1] + region.size[1];
    });
  }

  private runScriptedSpawns(phase: SolverPhase): void {
    const spawns = (this.scenario.scriptedSpawns ?? []).filter(
      (spawn) => spawn.turn === this.currentTurn && spawn.phase === phase && !this.units.has(spawn.unitNid),
    );
    for (const spawn of spawns) {
      const levelData = this.level.units.find((unit) => unit.nid === spawn.unitNid);
      if (!levelData) continue;
      const unit = this.spawnLevelUnit(levelData, spawn.team, spawn.position);
      if (!unit) continue;
      if (spawn.moveTo && !this.board.isOccupied(spawn.moveTo[0], spawn.moveTo[1])) {
        this.board.moveUnit(unit, spawn.moveTo[0], spawn.moveTo[1]);
      }
      this.recordStep('spawn', `${unit.name} enters the map`, unit, unit.position);
    }
  }

  private executeAiAction(action: AIAction): void {
    const unit = action.unit;
    const destination = action.targetPosition ?? unit.position;
    if (destination && (!this.board.isOccupied(destination[0], destination[1]) || unit.position?.toString() === destination.toString())) {
      this.board.moveUnit(unit, destination[0], destination[1]);
    }

    if (action.type === 'attack' && action.targetUnit && action.item) {
      if (action.item.canHeal() && this.db.areAllied(unit.team, action.targetUnit.team)) {
        const amount = Math.min(
          action.targetUnit.maxHp - action.targetUnit.currentHp,
          action.item.getHealAmount(unit.getStatValue('MAG')),
        );
        action.targetUnit.currentHp += amount;
        action.item.decrementUses();
        this.metrics.actions++;
        this.recordStep('heal', `${unit.name} heals ${action.targetUnit.name} for ${amount}`, unit, unit.position, action.targetUnit, action.item);
      } else {
        this.executeCombat(unit, action.targetUnit, action.item);
      }
      return;
    }

    this.metrics.actions++;
    const description = destination
      ? `${unit.name} ${action.type === 'move' ? 'moves' : 'waits'} at ${destination[0]},${destination[1]}`
      : `${unit.name} waits`;
    this.recordStep(action.type === 'move' ? 'move' : 'wait', description, unit, destination);
  }

  private findSeizeCandidate(active: UnitObject[]): MoveCandidate | null {
    if (this.objectiveType !== 'seize' || !this.seizePosition || this.board.isOccupied(this.seizePosition[0], this.seizePosition[1])) return null;
    for (const unit of active) {
      if (!unit.tags.includes('Lord')) continue;
      const valid = this.pathSystem.getValidMoves(unit, this.board);
      if (valid.some((position) => position[0] === this.seizePosition![0] && position[1] === this.seizePosition![1])) {
        return { unit, position: this.seizePosition, score: Infinity };
      }
    }
    return null;
  }

  private findBestAttack(active: UnitObject[]): AttackCandidate | null {
    this.dangerMoveCache.clear();
    let best: AttackCandidate | null = null;
    for (const unit of active) {
      const validMoves = this.pathSystem.getValidMoves(unit, this.board);
      for (const item of unit.items.filter((candidate) => candidate.isWeapon() && candidate.hasUsesRemaining())) {
        for (const target of this.hostileUnits(unit)) {
          if (!target.position) continue;
          for (const position of validMoves) {
            const distance = manhattan(position, target.position);
            if (distance < item.getMinRange() || distance > item.getMaxRange()) continue;
            const score = this.scoreAttack(unit, target, item, position);
            if (!best || score > best.score) best = { unit, target, item, position, score };
          }
        }
      }
    }
    return best && best.score > -this.policy.lethalRisk ? best : null;
  }

  private scoreAttack(unit: UnitObject, target: UnitObject, item: ItemObject, position: Position): number {
    const original = clonePosition(unit.position);
    if (!original) return -Infinity;
    this.board.moveUnit(unit, position[0], position[1]);

    const defenderWeapon = target.items.find((candidate) => candidate.isWeapon()) ?? null;
    const triangle = weaponTriangle(item, defenderWeapon, this.db, unit);
    const hit = Math.max(0, Math.min(100, computeHit(unit, item, target, this.db, this.board) + triangle.hitBonus));
    const perHit = Math.max(0, computeDamage(unit, item, target, this.db, this.board) + triangle.damageBonus);
    const attacks = canDouble(unit, item, target, defenderWeapon, this.db) ? 2 : 1;
    const expected = (hit / 100) * perHit * attacks;
    const canKill = perHit * attacks >= target.currentHp;
    const counter = this.expectedCounterDamage(target, unit, distanceBetween(target, unit));
    const danger = this.expectedDanger(unit);
    const progress = this.objectiveProgress(original, position);

    let score = expected * this.policy.damage + progress * this.policy.progress;
    score -= counter * this.policy.counterDamage;
    score -= danger * this.policy.danger * (this.policy.unitRisk?.[unit.nid] ?? 1);
    score += this.policy.unitBias[unit.nid] ?? 0;
    score += (unit.currentHp / Math.max(1, unit.maxHp)) * this.policy.stayHealthy;
    if (canKill) score += this.policy.kill;
    if (target.tags.includes('Boss')) score += canKill ? this.policy.bossKill : this.policy.bossKill * 0.2;
    if (this.isWall(target)) score += this.policy.wall;
    if (counter >= unit.currentHp) score -= this.policy.lethalRisk;

    this.board.moveUnit(unit, original[0], original[1]);
    return score;
  }

  private findBestHeal(active: UnitObject[]): HealCandidate | null {
    let best: HealCandidate | null = null;
    const injured = this.playerUnits().filter((unit) => unit.position && !unit.isDead() && unit.currentHp < unit.maxHp);
    for (const unit of active) {
      const validMoves = this.pathSystem.getValidMoves(unit, this.board);
      for (const item of unit.items.filter((candidate) => candidate.canHeal() && candidate.hasUsesRemaining())) {
        const targets = item.isSpell() ? injured : injured.filter((target) => target === unit);
        for (const target of targets) {
          if (!target.position) continue;
          for (const position of validMoves) {
            const distance = manhattan(position, target.position);
            if (item.isSpell() && (distance < item.getMinRange() || distance > item.getMaxRange())) continue;
            const amount = Math.min(target.maxHp - target.currentHp, item.getHealAmount(unit.getStatValue('MAG')));
            if (amount <= 0) continue;
            const score = amount * this.policy.heal + this.objectiveProgress(unit.position!, position) * this.policy.progress;
            if (!best || score > best.score) best = { unit, target, item, position, amount, score };
          }
        }
      }
    }
    return best;
  }

  private findBestMove(active: UnitObject[]): MoveCandidate | null {
    this.dangerMoveCache.clear();
    let best: MoveCandidate | null = null;
    for (const unit of active) {
      if (!unit.position) continue;
      const original = clonePosition(unit.position)!;
      for (const position of this.pathSystem.getValidMoves(unit, this.board)) {
        const progress = this.objectiveProgress(original, position);
        this.board.moveUnit(unit, position[0], position[1]);
        const danger = this.expectedDanger(unit);
        this.board.moveUnit(unit, original[0], original[1]);
        let score = progress * this.policy.progress
          - danger * this.policy.danger * (this.policy.unitRisk?.[unit.nid] ?? 1);
        score += this.policy.unitBias[unit.nid] ?? 0;
        score += (unit.currentHp / Math.max(1, unit.maxHp)) * this.policy.stayHealthy;
        if (this.seizePosition && !unit.tags.includes('Lord')) {
          const startsOnSeize = original[0] === this.seizePosition[0] && original[1] === this.seizePosition[1];
          const endsOnSeize = position[0] === this.seizePosition[0] && position[1] === this.seizePosition[1];
          if (startsOnSeize && !endsOnSeize) score += this.policy.bossKill * 10;
          if (endsOnSeize) score -= this.policy.bossKill * 10;
        }
        if (position[0] === original[0] && position[1] === original[1]) score -= 1;
        if (!best || score > best.score) best = { unit, position, score };
      }
    }
    return best;
  }

  private executeAttack(unit: UnitObject, target: UnitObject, item: ItemObject, position: Position): void {
    const from = clonePosition(unit.position);
    this.board.moveUnit(unit, position[0], position[1]);
    unit.hasMoved = from?.[0] !== position[0] || from?.[1] !== position[1];
    this.executeCombat(unit, target, item, from);
    unit.hasAttacked = true;
    unit.finished = true;
  }

  private executeCombat(unit: UnitObject, target: UnitObject, item: ItemObject, from?: Position | null): void {
    const defenseItem = target.items.find((candidate) => candidate.isWeapon() && candidate.hasUsesRemaining()) ?? null;
    const strikes = this.combatSolver.resolve(unit, item, target, defenseItem, this.db, this.rngMode, this.board);
    const records: StrikeRecord[] = [];
    for (const strike of strikes) {
      records.push(this.applyStrike(strike));
      strike.item.decrementUses();
    }
    this.metrics.actions++;
    this.metrics.combats++;
    const summary = records.map((strike) => `${strike.attacker}${strike.hit ? ` ${strike.damage}` : ' miss'}${strike.crit ? ' crit' : ''}`).join(', ');
    this.recordStep(
      'attack',
      `${unit.name} attacks ${target.name} with ${item.name}: ${summary}`,
      unit,
      unit.position,
      target,
      item,
      records,
      from,
    );
    this.refreshOutcome();
  }

  private applyStrike(strike: CombatStrike): StrikeRecord {
    if (strike.hit && !strike.defender.isDead()) {
      const before = strike.defender.currentHp;
      strike.defender.currentHp = Math.max(0, before - strike.damage);
      const actualDamage = before - strike.defender.currentHp;
      if (strike.defender.team === 'player') this.metrics.damageTaken += actualDamage;
      if (strike.defender.currentHp <= 0) this.killUnit(strike.defender);
    }
    return {
      attacker: strike.attacker.nid,
      defender: strike.defender.nid,
      item: strike.item.nid,
      hit: strike.hit,
      crit: strike.crit,
      damage: strike.damage,
      counter: strike.isCounter,
    };
  }

  private executeHeal(candidate: HealCandidate): void {
    const from = clonePosition(candidate.unit.position);
    this.board.moveUnit(candidate.unit, candidate.position[0], candidate.position[1]);
    const before = candidate.target.currentHp;
    candidate.target.currentHp = Math.min(candidate.target.maxHp, before + candidate.amount);
    const healed = candidate.target.currentHp - before;
    candidate.item.decrementUses();
    candidate.unit.finished = true;
    this.metrics.actions++;
    this.metrics.healingReceived += healed;
    this.recordStep(
      'heal',
      `${candidate.unit.name} heals ${candidate.target.name} for ${healed}`,
      candidate.unit,
      candidate.position,
      candidate.target,
      candidate.item,
      undefined,
      from,
    );
  }

  private moveAndFinish(unit: UnitObject, position: Position, type: 'move' | 'seize'): void {
    const from = clonePosition(unit.position);
    this.board.moveUnit(unit, position[0], position[1]);
    unit.hasMoved = true;
    unit.finished = true;
    this.metrics.actions++;
    if (type === 'move') this.recordStep('move', `${unit.name} moves to ${position[0]},${position[1]}`, unit, position, undefined, undefined, undefined, from);
  }

  private expectedCounterDamage(attacker: UnitObject, defender: UnitObject, distance: number): number {
    const item = attacker.items.find(
      (candidate) => candidate.isWeapon() && distance >= candidate.getMinRange() && distance <= candidate.getMaxRange(),
    );
    if (!item) return 0;
    const triangle = weaponTriangle(item, defender.items.find((candidate) => candidate.isWeapon()) ?? null, this.db, attacker);
    const hit = Math.max(0, Math.min(100, computeHit(attacker, item, defender, this.db, this.board) + triangle.hitBonus));
    const damage = Math.max(0, computeDamage(attacker, item, defender, this.db, this.board) + triangle.damageBonus);
    const doubles = canDouble(attacker, item, defender, defender.items.find((candidate) => candidate.isWeapon()) ?? null, this.db) ? 2 : 1;
    return (hit / 100) * damage * doubles;
  }

  private expectedDanger(unit: UnitObject): number {
    if (!unit.position) return 0;
    let danger = 0;
    for (const enemy of this.hostileUnits(unit)) {
      if (!enemy.position || enemy.isDead() || this.isWall(enemy)) continue;
      let moves = this.dangerMoveCache.get(enemy.nid);
      if (!moves) {
        moves = enemy.ai === 'Guard' ? [enemy.position] : this.pathSystem.getValidMoves(enemy, this.board);
        this.dangerMoveCache.set(enemy.nid, moves);
      }
      let best = 0;
      for (const item of enemy.items.filter((candidate) => candidate.isWeapon())) {
        if (!moves.some((position) => {
          const distance = manhattan(position, unit.position!);
          return distance >= item.getMinRange() && distance <= item.getMaxRange();
        })) continue;
        const triangle = weaponTriangle(item, unit.items.find((candidate) => candidate.isWeapon()) ?? null, this.db, enemy);
        const hit = Math.max(0, Math.min(100, computeHit(enemy, item, unit, this.db, this.board) + triangle.hitBonus));
        const damage = Math.max(0, computeDamage(enemy, item, unit, this.db, this.board) + triangle.damageBonus);
        const doubles = canDouble(enemy, item, unit, unit.items.find((candidate) => candidate.isWeapon()) ?? null, this.db) ? 2 : 1;
        best = Math.max(best, (hit / 100) * damage * doubles);
      }
      danger += best;
    }
    return danger;
  }

  private objectiveProgress(from: Position, to: Position): number {
    if (this.objectiveType === 'seize') {
      if (!this.seizePosition) return 0;
      return manhattan(from, this.seizePosition) - manhattan(to, this.seizePosition);
    }
    const targets = this.objectiveType === 'defeat_boss'
      ? this.enemyUnits().filter((unit) => unit.position && !unit.isDead() && this.isBoss(unit))
      : this.enemyUnits().filter((unit) => unit.position && !unit.isDead());
    if (targets.length === 0) return 0;
    const distanceFrom = Math.min(...targets.map((unit) => manhattan(from, unit.position!)));
    const distanceTo = Math.min(...targets.map((unit) => manhattan(to, unit.position!)));
    return distanceFrom - distanceTo;
  }

  private killUnit(unit: UnitObject): void {
    if (unit.dead) return;
    unit.dead = true;
    unit.currentHp = 0;
    this.board.removeUnit(unit);
    if (unit.team === 'player') this.metrics.playerDeaths++;
    if (unit.team === 'enemy') {
      if (this.isWall(unit)) this.metrics.wallsBroken++;
      else this.metrics.enemiesDefeated++;
    }
  }

  private refreshOutcome(): void {
    const lord = this.units.get('Eirika') ?? this.playerUnits().find((unit) => unit.tags.includes('Lord'));
    this.lost = !lord || lord.isDead();
    if (this.objectiveType === 'seize' && this.seizePosition) {
      const occupant = this.board.getUnit(this.seizePosition[0], this.seizePosition[1]);
      this.cleared = !!occupant && occupant.team === 'player' && occupant.tags.includes('Lord');
    } else if (this.objectiveType === 'rout') {
      this.cleared = this.enemyUnits().every((unit) => !unit.position || unit.isDead());
    } else if (this.objectiveType === 'defeat_boss') {
      const boss = this.scenario.bossNid
        ? this.units.get(this.scenario.bossNid)
        : this.enemyUnits().find((unit) => this.isBoss(unit));
      this.cleared = !!boss && boss.isDead();
    }
  }

  private buildScore(): number[] {
    const lord = this.units.get('Eirika') ?? this.playerUnits().find((unit) => unit.tags.includes('Lord'));
    if (this.cleared) {
      return [0, this.metrics.playerDeaths, this.metrics.damageTaken, this.metrics.turns, this.metrics.actions];
    }
    let objectiveRemaining = 999;
    if (this.objectiveType === 'seize' && lord?.position && this.seizePosition) {
      objectiveRemaining = manhattan(lord.position, this.seizePosition);
    } else if (this.objectiveType === 'rout') {
      objectiveRemaining = this.enemyUnits().filter((unit) => unit.position && !unit.isDead()).length;
    } else if (this.objectiveType === 'defeat_boss') {
      const boss = this.scenario.bossNid
        ? this.units.get(this.scenario.bossNid)
        : this.enemyUnits().find((unit) => this.isBoss(unit));
      objectiveRemaining = boss?.currentHp ?? 999;
    }
    return [1, this.lost ? 1 : 0, this.metrics.playerDeaths, objectiveRemaining, this.metrics.remainingEnemyHp, this.metrics.damageTaken];
  }

  private isWall(unit: UnitObject): boolean {
    return unit.tags.includes('Tile') || unit.klass.toLowerCase().startsWith('wall');
  }

  private isBoss(unit: UnitObject): boolean {
    return unit.nid === this.scenario.bossNid || unit.tags.includes('Boss');
  }

  private playerUnits(): UnitObject[] {
    return this.unitsByTeam('player');
  }

  private enemyUnits(): UnitObject[] {
    return this.unitsByTeam('enemy');
  }

  private unitsByTeam(team: string): UnitObject[] {
    return Array.from(this.units.values()).filter((unit) => unit.team === team);
  }

  private hostileUnits(unit: UnitObject): UnitObject[] {
    return Array.from(this.units.values()).filter(
      (other) => other !== unit && other.position && !other.isDead() && !this.db.areAllied(unit.team, other.team),
    );
  }

  private updateDerivedMetrics(): void {
    this.refreshOutcome();
    this.metrics.cleared = this.cleared;
    this.metrics.lost = this.lost;
    this.metrics.remainingPlayerHp = this.playerUnits()
      .filter((unit) => !unit.isDead())
      .reduce((sum, unit) => sum + unit.currentHp, 0);
    this.metrics.remainingEnemyHp = this.enemyUnits()
      .filter((unit) => unit.position && !unit.isDead())
      .reduce((sum, unit) => sum + unit.currentHp, 0);
  }

  private checkpointUnit(unit: UnitObject): TacticalUnitCheckpoint {
    return {
      nid: unit.nid,
      name: unit.name,
      team: unit.team,
      klass: unit.klass,
      level: unit.level,
      exp: unit.exp,
      position: clonePosition(unit.position),
      startingPosition: clonePosition(unit.startingPosition),
      currentHp: unit.currentHp,
      dead: unit.dead,
      stats: { ...unit.stats },
      growths: { ...unit.growths },
      maxStats: { ...unit.maxStats },
      wexp: { ...unit.wexp },
      tags: [...unit.tags],
      ai: unit.ai,
      aiGroup: unit.aiGroup,
      items: unit.items.map((item) => ({
        nid: item.nid,
        uses: item.uses,
        droppable: item.droppable,
      })),
      hasAttacked: unit.hasAttacked,
      hasMoved: unit.hasMoved,
      hasTraded: unit.hasTraded,
      finished: unit.finished,
      hasCanto: unit.hasCanto,
      party: unit.party,
      persistent: unit.persistent,
      statusEffects: structuredClone(unit.statusEffects),
      rescuing: unit.rescuing?.nid,
      rescuedBy: unit.rescuedBy?.nid,
    };
  }

  private restoreUnit(unit: UnitObject, saved: TacticalUnitCheckpoint): void {
    unit.name = saved.name;
    unit.team = saved.team;
    unit.klass = saved.klass;
    unit.level = saved.level;
    unit.exp = saved.exp;
    unit.position = null;
    unit.startingPosition = clonePosition(saved.startingPosition);
    unit.currentHp = saved.currentHp;
    unit.dead = saved.dead;
    unit.stats = { ...saved.stats };
    unit.growths = { ...saved.growths };
    unit.maxStats = { ...saved.maxStats };
    unit.wexp = { ...saved.wexp };
    unit.tags = [...saved.tags];
    unit.ai = saved.ai;
    unit.aiGroup = saved.aiGroup;
    unit.items = saved.items.map((savedItem) => {
      const prefab = this.db.items.get(savedItem.nid);
      if (!prefab) throw new Error(`Cannot restore unknown item: ${savedItem.nid}`);
      const item = new ItemObject(prefab);
      item.owner = unit;
      item.uses = savedItem.uses;
      item.droppable = savedItem.droppable;
      return item;
    });
    unit.hasAttacked = saved.hasAttacked;
    unit.hasMoved = saved.hasMoved;
    unit.hasTraded = saved.hasTraded;
    unit.finished = saved.finished;
    unit.hasCanto = saved.hasCanto;
    unit.party = saved.party;
    unit.persistent = saved.persistent;
    unit.statusEffects = structuredClone(saved.statusEffects) as typeof unit.statusEffects;
    unit.rescuing = null;
    unit.rescuedBy = null;
  }

  private snapshotUnits(): UnitSnapshot[] {
    return Array.from(this.units.values())
      .map((unit) => ({
        nid: unit.nid,
        name: unit.name,
        team: unit.team,
        klass: unit.klass,
        level: unit.level,
        exp: unit.exp,
        hp: unit.currentHp,
        maxHp: unit.maxHp,
        position: clonePosition(unit.position),
        dead: unit.isDead(),
        items: unit.items.map((item) => ({ nid: item.nid, uses: item.uses })),
      }))
      .sort((a, b) => a.team.localeCompare(b.team) || a.nid.localeCompare(b.nid));
  }

  private mapSnapshot(): MapSnapshot {
    const terrain: string[][] = [];
    const terrainNames: Record<string, string> = {};
    for (let y = 0; y < this.board.height; y++) {
      const row: string[] = [];
      for (let x = 0; x < this.board.width; x++) {
        const nid = this.board.getTerrain(x, y) ?? '0';
        row.push(nid);
        const def = this.db.terrain.get(nid);
        terrainNames[nid] = def?.name ?? nid;
      }
      terrain.push(row);
    }
    return { width: this.board.width, height: this.board.height, terrain, terrainNames, seize: clonePosition(this.seizePosition) };
  }

  private recordStep(
    type: SolverActionType,
    description: string,
    actor?: UnitObject,
    to?: Position | null,
    target?: UnitObject,
    item?: ItemObject,
    strikes?: StrikeRecord[],
    from?: Position | null,
  ): void {
    this.replay.push({
      index: this.replay.length,
      turn: this.currentTurn,
      phase: this.currentPhase,
      type,
      actor: actor?.nid,
      from: from === undefined ? clonePosition(actor?.position ?? null) : clonePosition(from),
      to: clonePosition(to ?? actor?.position ?? null),
      target: target?.nid,
      item: item?.nid,
      description,
      strikes,
      units: this.snapshotUnits(),
    });
  }
}

function distanceBetween(a: UnitObject, b: UnitObject): number {
  if (!a.position || !b.position) return 99;
  return manhattan(a.position, b.position);
}

function samePosition(a: Position | null, b: Position | null): boolean {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}

function comparePlannerActions(a: PlannerAction, b: PlannerAction): number {
  return b.heuristic - a.heuristic
    || a.actor.localeCompare(b.actor)
    || a.type.localeCompare(b.type)
    || (a.target ?? '').localeCompare(b.target ?? '')
    || (a.itemIndex ?? -1) - (b.itemIndex ?? -1)
    || a.position[1] - b.position[1]
    || a.position[0] - b.position[0];
}

function limitActions(actions: PlannerAction[], limit: number | undefined): PlannerAction[] {
  if (limit === undefined) return actions;
  return actions.slice(0, Math.max(0, limit));
}
