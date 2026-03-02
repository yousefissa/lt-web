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

export interface HarnessAPI {
  /** Step the game forward by N frames. Optionally inject an input on the first frame. */
  stepFrames: (count: number, input?: GameButton | null) => void;
  /** Capture a screenshot as a PNG data URL. */
  screenshot: () => Promise<string>;
  /** Get a snapshot of current game state. */
  getState: () => HarnessState;
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
          position: unit.position ? [unit.position[0], unit.position[1]] : null,
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
      unit.items.unshift(item); // put at front so it's auto-equipped
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
  };

  // Expose on window for Playwright access
  (window as any).__harness = harness;
}
