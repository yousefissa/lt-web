/**
 * harness.ts -- Deterministic test harness for the Lex Talionis web engine.
 *
 * When activated via ?harness=true, this module:
 *   - Replaces the requestAnimationFrame game loop with manual frame stepping
 *   - Exposes window.__harness with APIs for:
 *     - stepFrames(n, input?) -- advance N frames with optional input
 *     - screenshot() -- capture the current canvas as a PNG data URL
 *     - getState() -- snapshot of current game state (units, cursor, etc.)
 *     - injectInput(button) -- queue an input for the next frame
 *     - loadLevel(nid) -- load a specific level
 *     - waitForReady() -- wait until the game is fully loaded and stable
 *
 * Playwright tests drive the game through this API.
 */

import type { GameState } from './engine/game-state';
import type { Surface } from './engine/surface';
import type { InputEvent, GameButton } from './engine/input';
import { FRAMETIME, updateAnimationCounters } from './engine/constants';
import { ItemObject } from './objects/item';
import { SkillObject } from './objects/skill';
import { clearRandomSeed, getRandomState, setRandomSeed } from './engine/random';
import type { EngineParityState } from './engine/parity';

export interface HarnessCheckpointItem {
  nid: string;
  uses: number;
  droppable: boolean;
}

export interface HarnessCheckpointSkill {
  nid: string;
  data: [string, unknown][];
}

export interface HarnessCheckpointUnit {
  nid: string;
  name: string;
  team: string;
  klass: string;
  level: number;
  exp: number;
  position: [number, number] | null;
  startingPosition: [number, number] | null;
  currentHp: number;
  dead: boolean;
  stats: Record<string, number>;
  growths: Record<string, number>;
  maxStats: Record<string, number>;
  wexp: Record<string, number>;
  tags: string[];
  ai: string;
  aiGroup: string;
  items: HarnessCheckpointItem[];
  skills: HarnessCheckpointSkill[];
  equippedItemIndex: number | null;
  hasAttacked: boolean;
  hasMoved: boolean;
  hasTraded: boolean;
  finished: boolean;
  hasCanto: boolean;
  party: string;
  persistent: boolean;
  statusEffects: unknown[];
}

export interface HarnessTacticalCheckpoint {
  version: 2;
  currentTurn: number;
  currentPhase: string;
  rngState: number;
  activeRegions: string[];
  visibleLayers: string[];
  units: HarnessCheckpointUnit[];
}

export interface HarnessPlannerAction {
  type: 'attack' | 'heal' | 'move' | 'wait' | 'seize' | 'visit' | 'talk' | 'chest' | 'door';
  turn: number;
  actor: string;
  position: [number, number];
  target?: string;
  item?: string;
  itemIndex?: number;
  region?: string;
}

export interface HarnessPlannerActionResult {
  frames: number;
  state: EngineParityState;
  terminal: boolean;
  trace: HarnessPlannerTraceEntry[];
  aiActions: HarnessPlannerAiAction[];
}

export interface HarnessPlannerAiAction {
  actor: string;
  type: string;
  destination: [number, number] | null;
  target: string | null;
  item: string | null;
  path: [number, number][];
}

export interface HarnessPlannerTraceEntry {
  frame: number;
  state: string | null;
  rngState: number | null;
  actor: string | null;
  target: string | null;
  actorHp: number | null;
  targetHp: number | null;
  item: string | null;
  itemUses: number | null;
  aiUnits?: string[];
  aiIndex?: number;
}

export interface HarnessAPI {
  /** Step the game forward by N frames. Optionally inject an input on the first frame. */
  stepFrames: (count: number, input?: GameButton | null) => void;
  /** Capture a screenshot as a PNG data URL. */
  screenshot: () => Promise<string>;
  /** Get a snapshot of current game state. */
  getState: () => HarnessState;
  /** Get a renderer-independent snapshot for solver/engine differential checks. */
  getParityState: () => EngineParityState;
  /** Queue an input for the next stepFrames call. */
  injectInput: (button: GameButton) => void;
  /** Load a level by NID and transition to the free state. */
  loadLevel: (levelNid: string) => Promise<void>;
  /** Load a level, skip all level_start events, go directly to free state. */
  loadLevelClean: (levelNid: string) => Promise<void>;
  /** Wait until the game has finished loading and is ready. */
  waitForReady: () => Promise<boolean>;
  /** Whether the harness is ready (game loaded). */
  ready: boolean;
  /** Run N frames, allowing events/transitions to settle (auto-skips event text). */
  settle: (maxFrames: number) => void;
  /** Give an item (by DB NID) to a unit (by NID). Returns true if successful. */
  giveItem: (unitNid: string, itemNid: string) => boolean;
  /** Kill a unit by NID (set HP to 0, mark dead). For testing win conditions. */
  killUnit: (unitNid: string) => boolean;
  /** Trigger a game event by firing a trigger. Returns true if events were queued. */
  triggerEvent: (triggerType: string) => boolean;
  /** Install a deterministic gameplay RNG seed. */
  setSeed: (seed: number) => void;
  /** Restore normal Math.random-backed gameplay randomness. */
  clearSeed: () => void;
  /** Current deterministic RNG state, or null when unseeded. */
  getSeedState: () => number | null;
  /** Restore an exact solver checkpoint into the loaded live level. */
  restoreTacticalCheckpoint: (checkpoint: HarnessTacticalCheckpoint) => void;
  /** Execute one validated planner action through live combat/phase states. */
  executePlannerAction: (action: HarnessPlannerAction, maxFrames?: number) => Promise<HarnessPlannerActionResult>;
}

export interface HarnessState {
  currentStateName: string | undefined;
  stateStack: string[];
  turnCount: number;
  cursorPos: [number, number];
  units: Array<{
    nid: string;
    name: string;
    team: string;
    position: [number, number] | null;
    hp: number;
    maxHp: number;
    isDead: boolean;
  }>;
  levelNid: string | null;
}

/**
 * Create and install the test harness on window.__harness.
 * Call this instead of starting the rAF game loop.
 */
export function installHarness(
  game: GameState,
  gameSurface: Surface,
  displayCanvas: HTMLCanvasElement,
  displayCtx: CanvasRenderingContext2D,
): void {
  let pendingInput: GameButton | null = null;
  let isReady = false;

  function stepOneFrame(input: InputEvent): void {
    game.frameDeltaMs = FRAMETIME;
    gameSurface.clear();

    let repeat = true;
    let iterations = 0;
    const maxIterations = 10;

    while (repeat && iterations < maxIterations) {
      const inputForThisIteration = iterations === 0 ? input : null;
      const [, shouldRepeat] = game.state.update(inputForThisIteration, gameSurface);
      repeat = shouldRepeat;
      iterations++;
    }

    updateAnimationCounters();
    game.movementSystem.update(FRAMETIME);

    // Blit to display canvas
    displayCtx.imageSmoothingEnabled = false;
    displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
    displayCtx.drawImage(gameSurface.canvas, 0, 0);
  }

  function parityState(): EngineParityState {
    return {
      turn: game.turnCount,
      phase: game.phase?.getCurrent() ?? null,
      rngState: getRandomState(),
      units: Array.from(game.units.values()).map((unit) => ({
        nid: unit.nid,
        team: unit.team,
        klass: unit.klass,
        level: unit.level,
        exp: unit.exp,
        hp: unit.currentHp,
        maxHp: unit.maxHp,
        position: unit.position ? [unit.position[0], unit.position[1]] as [number, number] : null,
        dead: unit.isDead(),
        hasAttacked: unit.hasAttacked,
        hasMoved: unit.hasMoved,
        hasTraded: unit.hasTraded,
        finished: unit.finished,
        items: unit.items.map((item) => ({ nid: item.nid, uses: item.uses })),
        equippedItemIndex: unit.equippedWeapon ? unit.items.indexOf(unit.equippedWeapon) : null,
      })).sort((a, b) => a.nid.localeCompare(b.nid)),
      activeRegions: (game.currentLevel?.regions ?? []).map((region) => region.nid).sort(),
      visibleLayers: (game.tilemap?.layers ?? [])
        .filter((layer) => layer.visible)
        .map((layer) => layer.nid)
        .sort(),
    };
  }

  async function settlePlannerBoundary(
    maxFrames: number,
    trace?: HarnessPlannerTraceEntry[],
    explicitTerminal: boolean = false,
  ): Promise<number> {
    let previousState: string | null = null;
    let previousActor: string | null = null;
    let previousTarget: string | null = null;
    for (let frame = 0; frame < maxFrames; frame++) {
      const current = game.state.getCurrentState()?.name ?? null;
      const actor = game.selectedUnit;
      const target = game.combatTarget;
      const actorNid = actor?.nid ?? null;
      const targetNid = target?.nid ?? null;
      if (trace && (current !== previousState || actorNid !== previousActor || targetNid !== previousTarget)) {
        const item = actor?.getEquippedWeapon() ?? null;
        const stateObject = game.state.getCurrentState() as any;
        trace.push({
          frame,
          state: current,
          rngState: getRandomState(),
          actor: actor?.nid ?? null,
          target: target?.nid ?? null,
          actorHp: actor?.currentHp ?? null,
          targetHp: target?.currentHp ?? null,
          item: item?.nid ?? null,
          itemUses: item?.uses ?? null,
          ...(current === 'ai' ? {
            aiUnits: (stateObject.aiUnits ?? []).map((unit: any) => unit.nid),
            aiIndex: stateObject.currentAiIndex ?? 0,
          } : {}),
        });
        previousState = current;
        previousActor = actorNid;
        previousTarget = targetNid;
      }
      const moving = game.movementSystem.isMoving();
      const events = game.eventManager?.hasActiveEvents() ?? false;
      const players = game.board?.getTeamUnits('player') ?? [];
      const allFinished = players.length > 0 && players.every((unit) => unit.finished || unit.isDead());
      const terminal = explicitTerminal || game.checkWinCondition() || game.checkLossCondition();
      // Capture the completed tactical boundary before victory/loss events
      // advance into the next chapter or game-over UI.
      if (terminal && current !== 'combat' && !moving) return frame;
      if (current === 'free' && !moving && !events && (!allFinished || terminal)) return frame;

      // BACK puts EventState into its explicit skip mode, preserving command
      // effects while bypassing all remaining dialogue and waits. Phase/level
      // screens use SELECT for their normal fast-forward path.
      const input = current === 'event'
        ? 'BACK'
        : current === 'phase_change' || current === 'level_screen'
          ? 'SELECT'
          : null;
      stepOneFrame(input);
      // Manual frame stepping normally runs inside one JS task. Yield often
      // enough for portrait/background promises and image decode callbacks to
      // resolve without coupling tactical state to wall-clock timing.
      if (frame > 0 && frame % 50 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    const currentState = game.state.getCurrentState();
    const current = currentState?.name ?? null;
    const players = game.board?.getTeamUnits('player') ?? [];
    const activeEvent = game.eventManager?.getCurrentEvent() ?? null;
    throw new Error(`Planner action did not settle within ${maxFrames} frames: ${JSON.stringify({
      current,
      turn: game.turnCount,
      phase: game.phase?.getCurrent() ?? null,
      moving: game.movementSystem.isMoving(),
      events: game.eventManager?.hasActiveEvents() ?? false,
      terminal: game.checkWinCondition() || game.checkLossCondition(),
      unfinishedPlayers: players.filter((unit) => !unit.finished && !unit.isDead()).map((unit) => unit.nid),
      event: activeEvent ? {
        nid: activeEvent.nid,
        commandPointer: activeEvent.commandPointer,
        command: activeEvent.commands[activeEvent.commandPointer] ?? null,
      } : null,
      eventState: current === 'event' ? {
        skipMode: (currentState as any).skipMode,
        hasDialog: !!(currentState as any).dialog,
        waiting: (currentState as any).waiting,
        waitTimer: (currentState as any).waitTimer,
      } : null,
    })}`);
  }

  const harness: HarnessAPI = {
    ready: false,

    stepFrames(count: number, input?: GameButton | null): void {
      const firstInput = input ?? pendingInput;
      pendingInput = null;

      for (let i = 0; i < count; i++) {
        const frameInput = i === 0 ? firstInput : null;
        stepOneFrame(frameInput);
      }
    },

    async screenshot(): Promise<string> {
      return displayCanvas.toDataURL('image/png');
    },

    getState(): HarnessState {
      const current = game.state.getCurrentState();
      const units: HarnessState['units'] = [];
      for (const unit of game.units.values()) {
        units.push({
          nid: unit.nid,
          name: unit.name,
          team: unit.team,
          position: unit.position ? [unit.position[0], unit.position[1]] as [number, number] : null,
          hp: unit.currentHp,
          maxHp: unit.stats['HP'] ?? 0,
          isDead: unit.isDead(),
        });
      }

      // Access state stack via getCurrentState -- we need to peek at the full stack
      // The state machine doesn't expose the stack directly, so we get what we can
      const stateStack: string[] = [];
      if (current) {
        stateStack.push(current.name);
      }

      return {
        currentStateName: current?.name,
        stateStack,
        turnCount: game.turnCount,
        cursorPos: game.cursor.getPosition(),
        units,
        levelNid: game.currentLevel?.nid ?? null,
      };
    },

    getParityState(): EngineParityState {
      return parityState();
    },

    injectInput(button: GameButton): void {
      pendingInput = button;
    },

    async loadLevel(levelNid: string): Promise<void> {
      await game.loadLevel(levelNid);
      game.state.clear();
      game.state.change('free');

      // Process deferred transitions. FreeState itself will push EventState
      // when level_start events are queued; avoid manually pushing 'event' here
      // to prevent duplicate stacked EventState instances.
      for (let i = 0; i < 3; i++) {
        stepOneFrame(null);
      }

      isReady = true;
      harness.ready = true;
    },

    async loadLevelClean(levelNid: string): Promise<void> {
      // Load level but DON'T trigger level_start events -- for pure map rendering tests
      await game.loadLevel(levelNid);
      // Clear any queued events from level_start by draining the queue
      if (game.eventManager) {
        while (game.eventManager.hasActiveEvents()) {
          game.eventManager.dequeueCurrentEvent();
        }
      }
      game.state.clear();
      game.state.change('free');

      // Step frames to process the state transition and render
      for (let i = 0; i < 3; i++) {
        stepOneFrame(null);
      }

      isReady = true;
      harness.ready = true;
    },

    async waitForReady(): Promise<boolean> {
      // Poll until ready (used by Playwright's waitForFunction)
      return isReady;
    },

    giveItem(unitNid: string, itemNid: string): boolean {
      const itemPrefab = game.db.items.get(itemNid);
      if (!itemPrefab) {
        console.warn(`[Harness] Item "${itemNid}" not found in DB`);
        return false;
      }
      const unit = game.units.get(unitNid);
      if (!unit) {
        console.warn(`[Harness] Unit "${unitNid}" not found`);
        return false;
      }
      const item = new ItemObject(itemPrefab);
      item.owner = unit;
      unit.items.push(item);
      unit.getEquippedWeapon();
      game.items.set(`${unit.nid}_${item.nid}_${unit.items.length}`, item);
      return true;
    },

    settle(maxFrames: number): void {
      for (let i = 0; i < maxFrames; i++) {
        stepOneFrame(null);
        const current = game.state.getCurrentState();
        // If we're in the 'free' state, we've settled
        if (current?.name === 'free') {
          break;
        }
        // Press SELECT to advance through dialog, menus, events, base screens, etc.
        if (current?.name === 'event' || current?.name === 'base_main' ||
            current?.name === 'base_convos' || current?.name === 'title' ||
            current?.name === 'title_main' || current?.name === 'phase_change' ||
            current?.name === 'turn_change') {
          stepOneFrame('SELECT');
        }
      }
    },

    killUnit(unitNid: string): boolean {
      const unit = game.units.get(unitNid);
      if (!unit) {
        console.warn(`[Harness] Unit "${unitNid}" not found`);
        return false;
      }
      unit.currentHp = 0;
      unit.dead = true;
      // Remove from board if present
      if (unit.position && game.board) {
        game.board.removeUnit(unit);
      }
      return true;
    },

    triggerEvent(triggerType: string): boolean {
      if (!game.eventManager) return false;
      const levelNid = game.currentLevel?.nid ?? '';
      return game.eventManager.trigger(
        { type: triggerType, levelNid },
        { game, gameVars: game.gameVars, levelVars: game.levelVars },
      );
    },

    setSeed(seed: number): void {
      setRandomSeed(seed);
    },

    clearSeed(): void {
      clearRandomSeed();
    },

    getSeedState(): number | null {
      return getRandomState();
    },

    restoreTacticalCheckpoint(checkpoint: HarnessTacticalCheckpoint): void {
      if (checkpoint.version !== 2) throw new Error(`Unsupported checkpoint version: ${checkpoint.version}`);
      if (!game.board || !game.currentLevel || !game.tilemap || !game.phase) {
        throw new Error('A live level must be loaded before restoring a tactical checkpoint');
      }

      for (const unit of game.units.values()) game.board.removeUnit(unit);
      const checkpointNids = new Set(checkpoint.units.map((unit) => unit.nid));
      for (const nid of Array.from(game.units.keys())) {
        if (!checkpointNids.has(nid)) game.units.delete(nid);
      }
      game.items.clear();

      for (const saved of checkpoint.units) {
        let unit = game.units.get(saved.nid);
        if (!unit) {
          const levelUnit = game.currentLevel.units.find((candidate) => candidate.nid === saved.nid);
          if (levelUnit?.generic) {
            game.spawnGenericUnit({ ...levelUnit, team: saved.team, starting_position: null });
            unit = game.units.get(saved.nid);
          }
        }
        if (!unit) {
          const prefab = game.db.units.get(saved.nid);
          if (prefab) unit = game.spawnUnit(prefab, saved.team, null, saved.ai);
        }
        if (!unit) throw new Error(`Cannot materialize checkpoint unit: ${saved.nid}`);
        unit.name = saved.name;
        unit.team = saved.team;
        unit.klass = saved.klass;
        unit.level = saved.level;
        unit.exp = saved.exp;
        unit.position = null;
        unit.startingPosition = saved.startingPosition
          ? [saved.startingPosition[0], saved.startingPosition[1]]
          : null;
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
          const prefab = game.db.items.get(savedItem.nid);
          if (!prefab) throw new Error(`Unknown checkpoint item: ${savedItem.nid}`);
          const item = new ItemObject(prefab);
          item.owner = unit;
          item.uses = savedItem.uses;
          item.droppable = savedItem.droppable;
          return item;
        });
        unit.skills = saved.skills.map((savedSkill) => {
          const prefab = game.db.skills.get(savedSkill.nid);
          if (!prefab) throw new Error(`Unknown checkpoint skill: ${savedSkill.nid}`);
          const skill = new SkillObject(prefab);
          skill.data = new Map(structuredClone(savedSkill.data));
          return skill;
        });
        unit.equippedWeapon = saved.equippedItemIndex === null
          ? null
          : unit.items[saved.equippedItemIndex] ?? null;
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

      game.items.clear();
      for (const unit of game.units.values()) {
        unit.items.forEach((item, index) => {
          game.items.set(`${unit.nid}_${item.nid}_${index}`, item);
        });
      }

      for (const saved of checkpoint.units) {
        const unit = game.units.get(saved.nid)!;
        if (saved.position && !saved.dead) game.board.setUnit(saved.position[0], saved.position[1], unit);
      }

      const activeRegions = new Set(checkpoint.activeRegions);
      game.currentLevel.regions = game.currentLevel.regions.filter((region) => activeRegions.has(region.nid));
      const visibleLayers = new Set(checkpoint.visibleLayers);
      for (const layer of game.tilemap.layers) layer.visible = visibleLayers.has(layer.nid);
      game.board.initFromTilemap(game.tilemap);
      game.turnCount = checkpoint.currentTurn;
      game.phase.setCurrentTeam(checkpoint.currentPhase);
      game.phase.turnCount = checkpoint.currentTurn;
      game.activeAiGroups.clear();
      game.selectedUnit = null;
      game.combatTarget = null;
      game._moveOrigin = null;
      game._pendingAfterMovement = null;
      setRandomSeed(checkpoint.rngState);
      game.recalculateAllFow();
      game.state.clear();
      game.state.change('free');
      stepOneFrame(null);
    },

    async executePlannerAction(
      action: HarnessPlannerAction,
      maxFrames: number = 20_000,
    ): Promise<HarnessPlannerActionResult> {
      const aiController = game.aiController;
      const currentLevel = game.currentLevel;
      if (!game.board || !game.pathSystem || !game.phase || !aiController || !currentLevel) {
        throw new Error('No live tactical level is loaded');
      }
      if (game.state.getCurrentState()?.name !== 'free') throw new Error('Planner actions require a stable free state');
      if (game.turnCount !== action.turn || game.phase.getCurrent() !== 'player') {
        throw new Error(`Planner action expected player turn ${action.turn}, got ${game.phase.getCurrent()} ${game.turnCount}`);
      }
      const unit = game.units.get(action.actor);
      if (!unit?.position || unit.team !== 'player' || unit.isDead() || unit.finished) {
        throw new Error(`Inactive planner unit: ${action.actor}`);
      }
      const origin: [number, number] = [unit.position[0], unit.position[1]];
      const validMoves = unit.hasMoved || unit.hasTraded
        ? [origin]
        : game.pathSystem.getValidMoves(unit, game.board);
      if (!validMoves.some(([x, y]) => x === action.position[0] && y === action.position[1])) {
        const destinationOccupant = game.board.getUnit(action.position[0], action.position[1]);
        const movementGroup = game.db.classes.get(unit.klass)?.movement_group ?? 'Infantry';
        throw new Error(`Illegal live destination ${action.position.join(',')} for ${action.actor}: ${JSON.stringify({
          origin,
          movement: unit.getStatValue('MOV'),
          movementGroup,
          destinationCost: game.board.getMovementCost(
            action.position[0],
            action.position[1],
            movementGroup,
            game.db,
          ),
          destinationOccupant: destinationOccupant?.nid ?? null,
          hasMoved: unit.hasMoved,
          hasTraded: unit.hasTraded,
          validMoves,
        })}`);
      }

      if (action.type === 'wait' && (origin[0] !== action.position[0] || origin[1] !== action.position[1])) {
        throw new Error('Wait must use the current live position');
      }
      if (action.type !== 'wait') {
        game.board.moveUnit(unit, action.position[0], action.position[1]);
        unit.hasMoved = origin[0] !== action.position[0] || origin[1] !== action.position[1];
      }

      if (action.type === 'attack') {
        const indexed = action.itemIndex === undefined ? undefined : unit.items[action.itemIndex];
        const item = indexed?.nid === action.item ? indexed : unit.items.find((candidate) => candidate.nid === action.item);
        const target = action.target ? game.units.get(action.target) : undefined;
        if (!item || !item.isWeapon() || !item.hasUsesRemaining() || !target?.position || target.isDead()) {
          throw new Error(`Invalid live attack target/item for ${action.actor}`);
        }
        const distance = Math.abs(unit.position![0] - target.position[0]) + Math.abs(unit.position![1] - target.position[1]);
        if (game.db.areAllied(unit.team, target.team)
          || distance < item.getMinRange() || distance > item.getMaxRange()) {
          throw new Error(`Illegal live attack by ${action.actor}`);
        }
        unit.equipWeapon(item);
        game.selectedUnit = unit;
        game.combatTarget = target;
        game.state.change('combat');
      } else if (action.type === 'heal') {
        const indexed = action.itemIndex === undefined ? undefined : unit.items[action.itemIndex];
        const item = indexed?.nid === action.item ? indexed : unit.items.find((candidate) => candidate.nid === action.item);
        const target = action.target ? game.units.get(action.target) : undefined;
        if (!item?.canHeal() || !item.hasUsesRemaining() || !target?.position || target.isDead()
          || !game.db.areAllied(unit.team, target.team)) {
          throw new Error(`Invalid live heal target/item for ${action.actor}`);
        }
        const distance = Math.abs(unit.position![0] - target.position[0]) + Math.abs(unit.position![1] - target.position[1]);
        if (item.isSpell() && (distance < item.getMinRange() || distance > item.getMaxRange())) {
          throw new Error(`Illegal live heal range for ${action.actor}`);
        }
        target.currentHp = Math.min(
          target.maxHp,
          target.currentHp + item.getHealAmount(unit.getStatValue('MAG')),
        );
        const broken = item.decrementUses();
        if (broken) {
          const index = unit.items.indexOf(item);
          if (index >= 0) unit.items.splice(index, 1);
          unit.unequipWeapon(item);
        }
        unit.finished = true;
      } else if (action.type === 'visit' || action.type === 'chest' || action.type === 'door') {
        const region = currentLevel.regions.find((candidate) => candidate.nid === action.region);
        if (!region) throw new Error(`Missing live ${action.type} region: ${action.region}`);
        const [rx, ry] = region.position;
        const [rw, rh] = region.size;
        if (unit.position[0] < rx || unit.position[0] >= rx + rw
          || unit.position[1] < ry || unit.position[1] >= ry + rh) {
          throw new Error(`${action.actor} is not inside live region ${region.nid}`);
        }
        const levelNid = currentLevel.nid;
        const context = {
          game,
          unit1: unit,
          position: unit.position,
          region,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
        };
        const didTrigger = game.eventManager?.trigger({
          type: region.sub_nid || action.type,
          levelNid,
          regionNid: region.nid,
          unitNid: unit.nid,
          unit1: unit,
          region,
        }, context) ?? false;
        if (!didTrigger) throw new Error(`No live event accepted ${action.type} at ${region.nid}`);
        if (region.only_once) {
          currentLevel.regions = currentLevel.regions.filter((candidate) =>
            candidate.nid !== region.nid,
          );
        }
        unit.finished = true;
      } else if (action.type === 'talk') {
        const target = action.target ? game.units.get(action.target) : undefined;
        if (!target?.position || target.isDead()
          || Math.abs(unit.position[0] - target.position[0]) + Math.abs(unit.position[1] - target.position[1]) !== 1) {
          throw new Error(`Invalid live talk target for ${action.actor}`);
        }
        const didTrigger = game.eventManager?.trigger({
          type: 'on_talk',
          levelNid: currentLevel.nid,
          unitA: unit.nid,
          unitB: target.nid,
          unit1: unit,
          unit2: target,
        }, {
          game,
          unit1: unit,
          unit2: target,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
        }) ?? false;
        if (!didTrigger) throw new Error(`No live talk event accepted ${action.actor} -> ${target.nid}`);
        unit.hasTraded = true;
      } else {
        unit.finished = true;
      }

      const trace: HarnessPlannerTraceEntry[] = [];
      const aiActions: HarnessPlannerAiAction[] = [];
      const originalGetAction = aiController.getAction.bind(aiController);
      aiController.getAction = ((aiUnit: any) => {
        const resolved = originalGetAction(aiUnit);
        aiActions.push({
          actor: aiUnit.nid,
          type: resolved.type,
          destination: resolved.targetPosition
            ? [resolved.targetPosition[0], resolved.targetPosition[1]]
            : null,
          target: resolved.targetUnit?.nid ?? null,
          item: resolved.item?.nid ?? null,
          path: (resolved.movePath ?? []).map((position: [number, number]) => [position[0], position[1]]),
        });
        return resolved;
      }) as typeof aiController.getAction;
      let frames: number;
      try {
        // Flush the queued CombatState or let FreeState observe a completed unit.
        stepOneFrame(null);
        frames = 1 + await settlePlannerBoundary(maxFrames, trace, action.type === 'seize');
      } finally {
        aiController.getAction = originalGetAction;
      }
      return {
        frames,
        state: parityState(),
        terminal: action.type === 'seize' || game.checkWinCondition() || game.checkLossCondition(),
        trace,
        aiActions,
      };
    },
  };

  // Expose on window for Playwright access
  (window as any).__harness = harness;
}
