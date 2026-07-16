/**
 * game-states.ts - All game states for the Lex Talionis web engine.
 *
 * Each state class extends State or MapState and plugs into the
 * stack-based StateMachine.  A lazily-resolved `game` reference
 * provides access to the shared game context (camera, cursor, board,
 * units, tilemap, mapView, etc.) without creating circular imports.
 */

import { State, MapState, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import {
  WINWIDTH,
  WINHEIGHT,
  TILEWIDTH,
  TILEHEIGHT,
  FRAMETIME,
} from '../constants';
import { viewport, isSmallScreen } from '../viewport';

import type { UnitObject } from '../../objects/unit';
import type { ItemObject } from '../../objects/item';
import type { RegionData } from '../../data/types';
import { ItemObject as ItemObjectClass } from '../../objects/item';
import { SkillObject } from '../../objects/skill';
import { evaluateCondition, type ConditionContext, type GameEvent, type EventCommand } from '../../events/event-manager';
import { MapSprite as MapSpriteClass } from '../../rendering/map-sprite';
import {
  MarkActionGroupStart,
  MarkActionGroupEnd,
  MarkPhase,
  LockTurnwheel,
  MessageAction,
  PromoteAction,
  ClassChangeAction,
} from '../action';

import { ChoiceMenu, type MenuOption } from '../../ui/menu';
export { InfoMenuState, setInfoMenuGameRef } from './info-menu-state';
import { Banner } from '../../ui/banner';
import { Dialog } from '../../ui/dialog';
import { ExpBar as ExpBarClass, LevelUpScreen as LevelUpScreenClass } from '../../ui/exp-display';
import { EventPortrait } from '../../events/event-portrait';
import { parseScreenPosition } from '../../events/screen-positions';
import { MapCombat, type CombatResults } from '../../combat/map-combat';
import { MapAnimation } from '../../rendering/map-animation';
import type { FogRenderConfig } from '../../rendering/map-view';
import { drawItemIcon } from '../../ui/icons';
import { AnimationCombat, type AnimationCombatRenderState, type AnimationCombatOwner } from '../../combat/animation-combat';
import { BattleAnimation as RealBattleAnimation, type BattleAnimDrawData } from '../../combat/battle-animation';
import { getEquippedWeapon, isMagic } from '../../combat/combat-calcs';
import { loadBattlePlatforms, loadAndConvertWeaponAnim, selectPalette, selectWeaponAnim } from '../../combat/sprite-loader';
import { handleBaseEventCommand } from './base-state';
import { RECORDS, ACHIEVEMENTS } from '../records';
import { saveGame as doSaveGame, suspendGame as doSuspendGame, hasSuspend, loadSaveSlots } from '../save';

// ---------------------------------------------------------------------------
// Lazy game reference — set once at bootstrap to break circular deps.
// The `any` type is intentional: game-states.ts and game-state.ts would
// form a circular import if we typed this as GameState. The property names
// are validated at build time via the integration in main.ts.
// ---------------------------------------------------------------------------

let _game: any = null;
export function setGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set. Call setGameRef() first.');
  return _game;
}

/** Get the board, throwing a clear error if no level is loaded. */
function getBoard(): any {
  const game = getGame();
  if (!game.board) {
    throw new Error('No level loaded — game.board is null. Ensure loadLevel() completes before entering gameplay states.');
  }
  return game.board;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract terrain defense and avoid bonuses from a terrain's status skill.
 * The terrain's `status` field references a skill NID. That skill's
 * components contain `stat_change` (for DEF) and `avoid` (for AVO).
 */
// Terrain bonuses imported from shared utility
import { getTerrainBonuses } from '../../combat/terrain-bonuses';

/**
 * Active combat animation offsets, set by CombatState so that
 * collectVisibleUnits can apply lunge/shake to the fighting sprites.
 */
let _activeCombatOffsets: {
  attacker: UnitObject;
  defender: UnitObject;
  attackerOffset: [number, number]; // pixel offsets
  defenderOffset: [number, number];
} | null = null;

export function setActiveCombatOffsets(
  offsets: typeof _activeCombatOffsets,
): void {
  _activeCombatOffsets = offsets;
}

/** Collect units for map-view rendering from the game board. */
function collectVisibleUnits(): {
  x: number;
  y: number;
  /** Sub-tile visual offset in tile units for movement interpolation. */
  visualOffsetX: number;
  visualOffsetY: number;
  sprite: any;
  team: string;
  finished: boolean;
  currentHp: number;
  maxHp: number;
}[] {
  const game = getGame();
  if (!game.board) return [];
  const allUnits: UnitObject[] = game.board.getAllUnits();
  const currentTeam = game.phase.getCurrent();
  const result: {
    x: number;
    y: number;
    visualOffsetX: number;
    visualOffsetY: number;
    sprite: any;
    team: string;
    finished: boolean;
    currentHp: number;
    maxHp: number;
  }[] = [];

  for (const u of allUnits) {
    if (u.isDead() || !u.position) continue;

    // Update sprite state: gray for finished units on the active team only.
    // Units from other teams should never appear greyed out.
    // In initiative mode, non-current-initiative units appear greyed.
    // (moving state is set by the movement system)
    if (u.sprite && typeof u.sprite === 'object' && 'state' in u.sprite) {
      const spr = u.sprite as { state: string };
      if (spr.state !== 'moving') {
        let showGray = u.finished && u.team === currentTeam;
        // Initiative mode: grey out units that aren't the current initiative unit
        if (game.initiative) {
          const initNid = game.initiative.getCurrentUnitNid();
          if (initNid && u.nid !== initNid && u.team === currentTeam) {
            showGray = true;
          }
        }
        spr.state = showGray ? 'gray' : 'standing';
      }
    }

    // Get smooth movement interpolation offset (in tile units)
    const moveOffset = game.movementSystem.getVisualOffset(u);
    let visualOffsetX = moveOffset ? moveOffset[0] : 0;
    let visualOffsetY = moveOffset ? moveOffset[1] : 0;

    // Apply combat lunge/shake offsets (in pixels, convert to tile units)
    if (_activeCombatOffsets) {
      if (u === _activeCombatOffsets.attacker) {
        visualOffsetX += _activeCombatOffsets.attackerOffset[0] / TILEWIDTH;
        visualOffsetY += _activeCombatOffsets.attackerOffset[1] / TILEHEIGHT;
      } else if (u === _activeCombatOffsets.defender) {
        visualOffsetX += _activeCombatOffsets.defenderOffset[0] / TILEWIDTH;
        visualOffsetY += _activeCombatOffsets.defenderOffset[1] / TILEHEIGHT;
      }
    }

    // Only report finished=true for units on the active team so that
    // downstream renderers (placeholder overlays, etc.) don't grey out
    // units from other teams.
    result.push({
      x: u.position[0],
      y: u.position[1],
      visualOffsetX,
      visualOffsetY,
      sprite: u.sprite,
      team: u.team,
      finished: u.finished && u.team === currentTeam,
      currentHp: u.currentHp,
      maxHp: u.maxHp,
    });
  }
  return result;
}

/** Render the map through MapView and blit onto `surf`. */
function drawMap(surf: Surface, showHighlights: boolean = true): Surface {
  const game = getGame();
  if (!game.board || !game.tilemap) return surf; // No level loaded
  game.camera.update();
  game.cursor.update();

  const cullRect = game.camera.getCullRect();
  const units = collectVisibleUnits();
  const highlights: Map<string, string> | null = showHighlights
    ? game.highlight.getHighlights()
    : null;

  const cursorInfo = {
    x: game.cursor.getHover().x,
    y: game.cursor.getHover().y,
    visible: game.cursor.visible,
    draw: (s: Surface, ox: number, oy: number) => {
      game.cursor.draw(s, [ox, oy] as [number, number]);
    },
  };

  // Build fog of war config if fog is active
  let fogConfig: FogRenderConfig | null = null;
  const fogInfo = game.getCurrentFogInfo?.();
  if (fogInfo && game.board && (fogInfo.isActive || game.board.fogRegionSet?.size > 0)) {
    fogConfig = {
      fogInfo,
      board: game.board,
      db: game.db,
      allUnits: game.getAllUnits(),
    };
  }

  const mapSurf = game.mapView.draw(
    game.tilemap,
    cullRect,
    units,
    highlights,
    cursorInfo,
    false, // showGrid
    surf.scale,
    fogConfig,
  );

  surf.blit(mapSurf);
  return surf;
}

/** Move cursor and camera together. */
function moveCursor(dx: number, dy: number): void {
  const game = getGame();
  game.cursor.move(dx, dy);
  const pos = game.cursor.getHover();
  game.camera.focusTile(pos.x, pos.y);
  // Cursor movement sound (matching Python's 'Select 5')
  game.audioManager?.playSfx?.('Select 5');
}

/** Get the unit under the cursor, or null. */
function getUnitUnderCursor(): UnitObject | null {
  const game = getGame();
  const pos = game.cursor.getHover();
  return getBoard().getUnit(pos.x, pos.y);
}

/** Get all enemies of a unit within weapon range from a specific position. */
function getTargetsInRange(
  unit: UnitObject,
  fromX: number,
  fromY: number,
): UnitObject[] {
  const game = getGame();
  const weapon = getEquippedWeapon(unit);
  if (!weapon) return [];
  const minRange = weapon.getMinRange();
  const maxRange = weapon.getMaxRange();
  const allUnits: UnitObject[] = getBoard().getAllUnits();
  const targets: UnitObject[] = [];

  for (const other of allUnits) {
    if (other === unit) continue;
    if (other.isDead() || !other.position) continue;
    if (game.db.areAllied(unit.team, other.team)) continue;
    const dist =
      Math.abs(other.position[0] - fromX) +
      Math.abs(other.position[1] - fromY);
    if (dist >= minRange && dist <= maxRange) {
      targets.push(other);
    }
  }
  return targets;
}

/** Get all adjacent allied units to a unit at a specific position. */
function getAdjacentAllies(unit: UnitObject, x: number, y: number): UnitObject[] {
  const game = getGame();
  const board = getBoard();
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const allies: UnitObject[] = [];
  for (const [dx, dy] of dirs) {
    const other = board.getUnit(x + dx, y + dy);
    if (other && other !== unit && !other.isDead() && game.db.areAllied(unit.team, other.team)) {
      allies.push(other);
    }
  }
  return allies;
}

/** Get all adjacent units (any team) at a specific position. */
function getAdjacentUnits(x: number, y: number): UnitObject[] {
  const board = getBoard();
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const units: UnitObject[] = [];
  for (const [dx, dy] of dirs) {
    const other = board.getUnit(x + dx, y + dy);
    if (other && !other.isDead()) {
      units.push(other);
    }
  }
  return units;
}

/** Get all adjacent empty tiles that are in bounds. */
function getAdjacentEmptyTiles(x: number, y: number): [number, number][] {
  const board = getBoard();
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const tiles: [number, number][] = [];
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (board.inBounds(nx, ny) && !board.isOccupied(nx, ny)) {
      tiles.push([nx, ny]);
    }
  }
  return tiles;
}

// ---------------------------------------------------------------------------
// Mouse helpers
// ---------------------------------------------------------------------------

/**
 * Get the tile coordinates under the mouse cursor, or null if the mouse
 * is outside the game area or no InputManager is available.
 */
function getMouseTile(): [number, number] | null {
  const game = getGame();
  if (!game.input) return null;
  const cam = game.camera.getOffset();
  return game.input.getMouseTile(cam[0], cam[1]);
}

/**
 * If the mouse was clicked this frame (LMB), move the cursor to the
 * clicked tile and return 'SELECT'. If RMB, return 'BACK'.
 * If the mouse moved (no click), move the cursor to the hovered tile
 * and return null (no action, just hover tracking).
 *
 * Returns the effective InputEvent to process, or undefined to indicate
 * "mouse didn't do anything interesting — fall through to keyboard".
 */
function processMouseForMap(event: InputEvent): InputEvent | undefined {
  const game = getGame();
  if (!game.input) return undefined;

  const input = game.input;
  const tile = getMouseTile();

  // Handle mouse click: move cursor to tile, then return the action
  if (input.mouseClick) {
    if (input.mouseClick === 'SELECT' && tile) {
      const curPos = game.cursor.getHover();
      if (tile[0] !== curPos.x || tile[1] !== curPos.y) {
        game.audioManager?.playSfx?.('Select 5');
      }
      game.cursor.setPos(tile[0], tile[1]);
      // Only auto-center camera on tap for small/mobile screens
      if (isSmallScreen()) {
        game.camera.focusTile(tile[0], tile[1]);
      }
      return 'SELECT';
    }
    if (input.mouseClick === 'BACK') {
      return 'BACK';
    }
    if (input.mouseClick === 'INFO' && tile) {
      const curPos = game.cursor.getHover();
      if (tile[0] !== curPos.x || tile[1] !== curPos.y) {
        game.audioManager?.playSfx?.('Select 5');
      }
      game.cursor.setPos(tile[0], tile[1]);
      if (isSmallScreen()) {
        game.camera.focusTile(tile[0], tile[1]);
      }
      return 'INFO';
    }
  }

  // Handle mouse hover: move cursor to hovered tile (no action)
  if (input.mouseMoved && tile) {
    const curPos = game.cursor.getHover();
    if (tile[0] !== curPos.x || tile[1] !== curPos.y) {
      game.cursor.setPos(tile[0], tile[1]);
      // Play cursor movement sound on hover too (matches keyboard behavior)
      game.audioManager?.playSfx?.('Select 5');
    }
  }

  return undefined; // No mouse action to process
}

// ============================================================================
// 1. TitleStartState — "Press Start" splash screen
// ============================================================================

export class TitleState extends State {
  readonly name = 'title';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bgImage: HTMLImageElement | null = null;
  private pulseTimer: number = 0;

  override start(): StateResult {
    const game = getGame();
    // Load the title background panorama (try single file, then frame 0 for animated panoramas)
    game.resources.tryLoadImage('resources/panoramas/title_background.png').then((img: HTMLImageElement | null) => {
      if (img) {
        this.bgImage = img;
      } else {
        // Animated panorama fallback: try title_background0.png
        game.resources.tryLoadImage('resources/panoramas/title_background0.png').then((img0: HTMLImageElement | null) => {
          this.bgImage = img0;
        });
      }
    });

    // Play title music if configured
    const titleMusic = game.db.getConstant('music_main', null) as string | null;
    if (titleMusic) {
      void game.audioManager.playMusic(titleMusic);
    }
  }

  override update(): StateResult {
    this.pulseTimer += getGame().frameDeltaMs ?? 16;
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;

    // Background — scale panorama to fill viewport
    if (this.bgImage) {
      const s = surf.scale;
      const imgW = this.bgImage.naturalWidth || vw;
      const imgH = this.bgImage.naturalHeight || vh;
      surf.ctx.imageSmoothingEnabled = false;
      surf.ctx.drawImage(
        this.bgImage,
        0, 0, imgW, imgH,
        0, 0, Math.round(vw * s), Math.round(vh * s),
      );
    } else {
      surf.fill(16, 16, 32);
    }

    // Title text — centered, upper third
    const title = 'Lex Talionis';
    const titleW = title.length * 8;
    surf.drawText(
      title,
      Math.floor((vw - titleW) / 2),
      Math.floor(vh / 3),
      'white',
      '14px monospace',
    );

    // "Press Start" — pulsing alpha
    const alpha = 0.5 + 0.5 * Math.sin(this.pulseTimer / 500 * Math.PI);
    const prompt = 'Press Start';
    const promptW = prompt.length * 5;
    surf.drawText(
      prompt,
      Math.floor((vw - promptW) / 2),
      Math.floor(vh * 4 / 5),
      `rgba(200,200,220,${alpha.toFixed(2)})`,
      '8px monospace',
    );

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (event === 'START' || event === 'SELECT' || game.input?.mouseClick === 'SELECT') {
      game.state.change('title_main');
    }
  }
}

// ============================================================================
// 1a. TitleMainState — Main title menu (New Game / Extras)
// ============================================================================

export class TitleMainState extends State {
  readonly name = 'title_main';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bgImage: HTMLImageElement | null = null;
  private options: string[] = ['New Game', 'Extras'];
  private cursor: number = 0;
  private slideX: number = -120;
  private targetX: number = 0;
  private slideTimer: number = 0;
  private hasSaveData: boolean = false;

  override start(): StateResult {
    const game = getGame();
    game.resources.tryLoadImage('resources/panoramas/title_background.png').then((img: HTMLImageElement | null) => {
      if (img) {
        this.bgImage = img;
      } else {
        // Animated panorama fallback: try title_background0.png
        game.resources.tryLoadImage('resources/panoramas/title_background0.png').then((img0: HTMLImageElement | null) => {
          this.bgImage = img0;
        });
      }
    });
    this.slideX = -120;
    this.targetX = 24;
    this.cursor = 0;

    // Check if any save data exists to show Load Game / Continue options
    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const numSlots = game.db?.getConstant?.('num_save_slots', 3) ?? 3;
    Promise.all([
      loadSaveSlots(gameNid as string, numSlots as number),
      hasSuspend(gameNid as string),
    ]).then(([slots, hasSusp]) => {
      const hasAnySave = hasSusp || slots.some(s => s.name !== '--NO DATA--');
      this.hasSaveData = hasAnySave;
      this.rebuildOptions();
    }).catch(() => {
      // Ignore errors — just show default options
    });
  }

  override begin(): StateResult {
    this.slideX = -120;
    this.cursor = 0;
    this.slideTimer = 0;
    this.rebuildOptions();
  }

  private rebuildOptions(): void {
    const opts: string[] = [];
    if (this.hasSaveData) {
      opts.push('Continue');
    }
    opts.push('New Game');
    if (this.hasSaveData) {
      opts.push('Load Game');
    }
    opts.push('Extras');
    this.options = opts;
    // Keep cursor in bounds
    if (this.cursor >= this.options.length) {
      this.cursor = 0;
    }
  }

  override update(): StateResult {
    // Slide menu in
    if (this.slideX < this.targetX) {
      this.slideX = Math.min(this.targetX, this.slideX + 12);
    }
    this.slideTimer += getGame().frameDeltaMs ?? 16;
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;

    // Background — scale panorama to fill viewport
    if (this.bgImage) {
      const s = surf.scale;
      const imgW = this.bgImage.naturalWidth || vw;
      const imgH = this.bgImage.naturalHeight || vh;
      surf.ctx.imageSmoothingEnabled = false;
      surf.ctx.drawImage(
        this.bgImage,
        0, 0, imgW, imgH,
        0, 0, Math.round(vw * s), Math.round(vh * s),
      );
    } else {
      surf.fill(16, 16, 32);
    }

    // Semi-transparent panel behind menu
    const panelX = Math.floor(this.slideX - 8);
    const panelY = Math.floor(vh / 2 - 10);
    const panelW = 90;
    const panelH = this.options.length * 16 + 8;
    surf.fillRect(panelX, panelY, panelW, panelH, 'rgba(16,16,48,0.85)');
    surf.drawRect(panelX, panelY, panelW, panelH, 'rgba(100,100,180,0.7)');

    // Menu options
    for (let i = 0; i < this.options.length; i++) {
      const optY = Math.floor(vh / 2 + i * 16 - 4);
      const optX = Math.floor(this.slideX);

      if (i === this.cursor) {
        // Highlight bar
        surf.fillRect(panelX + 2, optY - 2, panelW - 4, 14, 'rgba(64,64,160,0.6)');
        // Animated cursor arrow with bobbing
        const bobOffset = Math.sin(this.slideTimer / 300 * Math.PI) * 1.5;
        surf.drawText('>', optX - 8, optY + bobOffset, 'rgba(255,255,128,1)', '8px monospace');
      }

      const color = i === this.cursor ? 'white' : 'rgba(180,180,200,1)';
      surf.drawText(this.options[i], optX, optY, color, '8px monospace');
    }

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    if (event === 'UP') {
      this.cursor = (this.cursor - 1 + this.options.length) % this.options.length;
    } else if (event === 'DOWN') {
      this.cursor = (this.cursor + 1) % this.options.length;
    } else if (event === 'SELECT' || game.input?.mouseClick === 'SELECT') {
      const selected = this.options[this.cursor];
      if (selected === 'New Game') {
        game.state.change('level_select');
      } else if (selected === 'Continue') {
        // Load the most recent save (highest realtime)
        game.state.change('load_menu');
      } else if (selected === 'Load Game') {
        game.state.change('load_menu');
      } else if (selected === 'Extras') {
        // Placeholder — not yet implemented
      }
    } else if (event === 'BACK') {
      game.state.back(); // Return to press-start screen
    }
  }
}

// ============================================================================
// 1a2. LevelSelectState (chapter / scenario picker)
// ============================================================================

export class LevelSelectState extends State {
  readonly name = 'level_select';
  override readonly showMap = false;
  override readonly inLevel = false;

  private levels: { nid: string; name: string }[] = [];
  private cursor: number = 0;
  private scrollOffset: number = 0;
  private loading: boolean = false;

  // Layout constants
  private readonly VISIBLE_ROWS = 7;
  private readonly ROW_HEIGHT = 16;
  private readonly LIST_Y = 30;
  private readonly LIST_X = 20;

  override begin(): StateResult {
    const game = getGame();
    this.levels = [];
    this.cursor = 0;
    this.scrollOffset = 0;
    this.loading = false;

    // Collect all levels from the database
    for (const [nid, prefab] of game.db.levels) {
      this.levels.push({ nid, name: prefab.name });
    }
  }

  override draw(surf: Surface): Surface {
    // Dark background
    surf.fill(16, 16, 32);

    // Title
    const vw = viewport.width;
    const vh = viewport.height;
    const title = 'Select Chapter';
    const titleW = title.length * 7;
    surf.drawText(
      title,
      Math.floor((vw - titleW) / 2),
      10,
      'white',
      '12px monospace',
    );

    // Level list
    const visibleStart = this.scrollOffset;
    const visibleEnd = Math.min(this.levels.length, visibleStart + this.VISIBLE_ROWS);

    for (let i = visibleStart; i < visibleEnd; i++) {
      const level = this.levels[i];
      const y = this.LIST_Y + (i - visibleStart) * this.ROW_HEIGHT;
      const isSelected = i === this.cursor;

      // Selection highlight
      if (isSelected) {
        surf.fillRect(this.LIST_X - 4, y - 1, vw - (this.LIST_X - 4) * 2, this.ROW_HEIGHT, 'rgba(60,80,160,0.6)');
      }

      // Cursor arrow
      if (isSelected) {
        surf.drawText('>', this.LIST_X - 2, y, 'rgb(220,200,80)', '10px monospace');
      }

      // Level name
      const color = isSelected ? 'rgb(255,255,220)' : 'rgb(180,180,200)';
      surf.drawText(level.name, this.LIST_X + 8, y, color, '10px monospace');
    }

    // Scroll indicators
    if (this.scrollOffset > 0) {
      surf.drawText('^', Math.floor(vw / 2), this.LIST_Y - 10, 'rgba(200,200,220,0.6)', '8px monospace');
    }
    if (visibleEnd < this.levels.length) {
      const bottomY = this.LIST_Y + this.VISIBLE_ROWS * this.ROW_HEIGHT;
      surf.drawText('v', Math.floor(vw / 2), bottomY, 'rgba(200,200,220,0.6)', '8px monospace');
    }

    // Loading indicator
    if (this.loading) {
      surf.fillRect(0, 0, vw, vh, 'rgba(0,0,0,0.5)');
      const loadText = 'Loading...';
      const loadW = loadText.length * 5;
      surf.drawText(
        loadText,
        Math.floor((vw - loadW) / 2),
        Math.floor(vh / 2),
        'white',
        '10px monospace',
      );
    }

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    if (this.loading) return;
    const game = getGame();

    // Mouse hover to highlight
    if (game.input?.mouseMoved) {
      const [, gy] = game.input.getGameMousePos();
      const hoverIndex = this.getIndexAtY(gy);
      if (hoverIndex !== null) {
        this.cursor = hoverIndex;
      }
    }

    // Mouse click to select
    if (game.input?.mouseClick === 'SELECT') {
      const [, gy] = game.input.getGameMousePos();
      const clickIndex = this.getIndexAtY(gy);
      if (clickIndex !== null) {
        this.cursor = clickIndex;
        this.selectLevel();
        return;
      }
    }

    // Mouse right-click to go back
    if (game.input?.mouseClick === 'BACK') {
      game.state.back();
      return;
    }

    if (event === 'UP') {
      if (this.cursor > 0) {
        this.cursor--;
        // Scroll up if cursor is above visible area
        if (this.cursor < this.scrollOffset) {
          this.scrollOffset = this.cursor;
        }
      }
    } else if (event === 'DOWN') {
      if (this.cursor < this.levels.length - 1) {
        this.cursor++;
        // Scroll down if cursor is below visible area
        if (this.cursor >= this.scrollOffset + this.VISIBLE_ROWS) {
          this.scrollOffset = this.cursor - this.VISIBLE_ROWS + 1;
        }
      }
    } else if (event === 'SELECT' || event === 'START') {
      this.selectLevel();
    } else if (event === 'BACK') {
      game.state.back();
    }
  }

  private getIndexAtY(gy: number): number | null {
    const relY = gy - this.LIST_Y;
    if (relY < 0) return null;
    const row = Math.floor(relY / this.ROW_HEIGHT);
    if (row >= this.VISIBLE_ROWS) return null;
    const index = this.scrollOffset + row;
    if (index >= this.levels.length) return null;
    return index;
  }

  private selectLevel(): void {
    if (this.levels.length === 0) return;
    const selected = this.levels[this.cursor];
    const game = getGame();

    this.loading = true;

    // Load the level, then clear the stack and start gameplay.
    // Keep LevelSelectState on the stack during loading so the
    // loading overlay remains visible.
    game.loadLevel(selected.nid).then(() => {
      this.loading = false;
      game.state.clear();
      game.state.change('free');
      // If level_start triggered events, push EventState on top of FreeState
      if (game.eventManager?.hasActiveEvents()) {
        game.state.change('event');
      }
    }).catch((err: unknown) => {
      this.loading = false;
      console.error('Failed to load level:', err);
      // Go back to title on failure
      game.state.change('title');
    });
  }
}

// ============================================================================
// 1b. OptionMenuState (map option menu: End Turn, etc.)
// ============================================================================

export class OptionMenuState extends State {
  readonly name = 'option_menu';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;

  override begin(): StateResult {
    const game = getGame();
    const hasMinimap = !!(game.board && game.tilemap);

    // Check if turnwheel is enabled (constant + game var)
    const turnwheelConstant = game.db?.getConstant?.('turnwheel', null) ?? null;
    const turnwheelEnabled = !!turnwheelConstant && !!game.gameVars.get('_turnwheel');

    const options: MenuOption[] = [];
    options.push({ label: 'End Turn', value: 'end_turn', enabled: true });
    if (turnwheelEnabled) {
      options.push({ label: 'Turnwheel', value: 'turnwheel', enabled: true });
    }
    options.push({ label: 'Minimap', value: 'minimap', enabled: hasMinimap });
    options.push({ label: 'Save', value: 'save', enabled: true });
    options.push({ label: 'Suspend', value: 'suspend', enabled: true });
    options.push({ label: 'Options', value: 'options', enabled: true });

    // Centre the menu on screen
    const menuX = Math.floor(viewport.width / 2) - 30;
    const menuY = Math.floor(viewport.height / 2) - (options.length * 8 + 4);
    this.menu = new ChoiceMenu(options, menuX, menuY);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    // Handle mouse click on menu options
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    // Handle mouse hover to highlight menu options
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    // Fall through to keyboard input if mouse didn't produce a result
    if (!result && event !== null) {
      result = this.menu.handleInput(event);
    }
    if (!result) return;

    if ('back' in result) {
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      switch (result.selected) {
        case 'end_turn': {
          // Mark all player units as finished and trigger turn change
          const playerUnits: UnitObject[] = game.board?.getTeamUnits('player') ?? [];
          for (const unit of playerUnits) {
            unit.finished = true;
          }
          this.menu = null;
          game.state.back();
          game.state.change('turn_change');
          break;
        }
        case 'turnwheel': {
          // Check if the player has uses remaining (or unlimited = -1)
          const currentUses = game.gameVars.get('_current_turnwheel_uses') ?? -1;
          if (currentUses > 0 || currentUses === -1) {
            this.menu = null;
            game.state.change('turnwheel');
          } else {
            // No uses remaining
            game.audioManager?.playSfx?.('Error');
          }
          break;
        }
        case 'minimap': {
          this.menu = null;
          game.state.back();
          game.state.change('minimap');
          break;
        }
        case 'save': {
          this.menu = null;
          game.state.back();
          game.state.change('save_menu');
          break;
        }
        case 'suspend': {
          this.menu = null;
          game.state.back();
          doSuspendGame(game).then(() => {
            game.state.clear();
            game.state.change('title');
          }).catch(() => {
            game.state.clear();
            game.state.change('title');
          });
          break;
        }
        case 'options': {
          this.menu = null;
          game.state.back();
          game.state.change('settings_menu');
          break;
        }
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 2. FreeState
// ============================================================================

export class FreeState extends MapState {
  readonly name = 'free';

  override begin(): StateResult {
    const game = getGame();
    const board = getBoard();

    // Clear any stale highlights from previous states (matching Python's FreeState.begin)
    game.highlight.clear();

    // Check for free roam mode
    const roamInfo = game.roamInfo;
    if (roamInfo && roamInfo.roam && roamInfo.roamUnitNid) {
      const roamUnit = game.getUnit(roamInfo.roamUnitNid);
      if (roamUnit && roamUnit.position) {
        game.state.change('free_roam');
        return 'repeat';
      }
    }

    game.cursor.visible = true;

    // Mark end of previous action group (turnwheel marker)
    game.actionLog.doAction(new MarkActionGroupEnd('free'));

    // Initiative mode: auto-cursor to the initiative unit
    if (game.initiative) {
      const unitNid = game.initiative.getCurrentUnitNid();
      if (unitNid) {
        const unit = game.getUnit(unitNid);
        if (unit && unit.position) {
          game.cursor.setPos(unit.position[0], unit.position[1]);
          game.camera.focusTile(unit.position[0], unit.position[1]);
        }
      }
    } else {
      // Standard mode: auto-cursor to first available player unit
      const playerUnits: UnitObject[] = board.getTeamUnits('player');
      const available = playerUnits.find((u) => u.canStillAct() && u.position);
      if (available && available.position) {
        game.cursor.setPos(available.position[0], available.position[1]);
        game.camera.focusTile(available.position[0], available.position[1]);
      }
    }
  }

  override end(): StateResult {
    // Clear highlights when leaving FreeState (matching Python's FreeState.end)
    const game = getGame();
    game.highlight.clear();
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Process mouse: click moves cursor to tile + fires action,
    // hover tracks cursor position silently.
    const mouseAction = processMouseForMap(event);
    const effective = mouseAction ?? event;

    if (effective === null) return;

    switch (effective) {
      case 'UP':
        moveCursor(0, -1);
        break;
      case 'DOWN':
        moveCursor(0, 1);
        break;
      case 'LEFT':
        moveCursor(-1, 0);
        break;
      case 'RIGHT':
        moveCursor(1, 0);
        break;

      case 'SELECT': {
        const unit = getUnitUnderCursor();
        if (unit && unit.team === 'player' && unit.canStillAct()) {
          // In initiative mode, only allow selecting the current initiative unit
          if (game.initiative) {
            const initUnitNid = game.initiative.getCurrentUnitNid();
            if (initUnitNid && unit.nid !== initUnitNid) {
              // Not the initiative unit — treat as enemy click (show range) or error
              break;
            }
          }
          // Mark start of this unit's action group (turnwheel marker)
          game.actionLog.doAction(new MarkActionGroupStart(unit, 'free'));
          game.selectedUnit = unit;
          game.state.change('move');
        } else if (unit && unit.team !== 'player' && unit.position) {
          // SELECT on enemy: toggle individual enemy range display
          const key = `${unit.position[0]},${unit.position[1]}`;
          const existing = game.highlight.getHighlights().get(key);
          if (existing === 'selected') {
            game.highlight.clearType('selected');
            game.highlight.clearType('move');
            game.highlight.clearType('attack');
          } else {
            game.highlight.clearType('selected');
            game.highlight.clearType('move');
            game.highlight.clearType('attack');
            const validMoves = game.pathSystem!.getValidMoves(unit, game.board);
            const attackPos = game.pathSystem!.getAttackPositions(unit, game.board, validMoves);
            game.highlight.setMoveHighlights(validMoves);
            game.highlight.setAttackHighlights(attackPos);
            game.highlight.addHighlight(unit.position[0], unit.position[1], 'selected');
          }
        } else {
          // No actionable unit — open option menu
          game.state.change('option_menu');
        }
        break;
      }

      case 'BACK': {
        // Right-click on map: open option menu (same as START)
        game.state.change('option_menu');
        break;
      }

      case 'INFO': {
        const unit = getUnitUnderCursor();
        if (!unit) {
          // Empty tile: toggle ALL enemy threat zone overlay
          if (game.highlight.hasType('threat')) {
            game.highlight.clearType('threat');
          } else {
            this.showAllEnemyThreat(game);
          }
        } else {
          // Any unit: open info menu
          game.infoMenuUnit = unit;
          game.state.change('info_menu');
        }
        break;
      }

      case 'AUX': {
        // Cycle cursor through available player units
        const playerUnits: UnitObject[] = game.board.getTeamUnits('player');
        const available = playerUnits.filter(
          (u) => u.canStillAct() && u.position,
        );
        if (available.length === 0) break;

        const cursorPos = game.cursor.getPosition();
        // Find next unit after the one at cursor (or wrap)
        let nextIdx = 0;
        for (let i = 0; i < available.length; i++) {
          const p = available[i].position!;
          if (p[0] === cursorPos[0] && p[1] === cursorPos[1]) {
            nextIdx = (i + 1) % available.length;
            break;
          }
        }
        const next = available[nextIdx];
        if (next && next.position) {
          game.cursor.setPos(next.position[0], next.position[1]);
          game.camera.focusTile(next.position[0], next.position[1]);
        }
        break;
      }

      case 'START':
        // In initiative mode, START toggles the initiative bar display
        if (game.initiative) {
          game.initiative.toggleDraw();
        } else {
          game.state.change('option_menu');
        }
        break;
    }
  }

  override update(): StateResult {
    const game = getGame();

    // Check for pending events (might have been queued by another state)
    if (game.eventManager?.hasActiveEvents()) {
      game.state.change('event');
      return;
    }

    // Update HUD hover info
    const pos = game.cursor.getHover();
    const unit = game.board.getUnit(pos.x, pos.y);
    const terrainNid = game.board.getTerrain(pos.x, pos.y);
    const terrainDef = terrainNid ? game.db.terrain.get(terrainNid) : null;
    const [tDef, tAvo] = getTerrainBonuses(terrainDef, game.db);
    game.hud.setHover(unit, terrainDef?.name ?? '', tDef, tAvo);

    // Auto end-turn logic
    if (game.initiative) {
      // Initiative mode: auto-end when the current initiative unit is finished
      const initUnitNid = game.initiative.getCurrentUnitNid();
      if (initUnitNid) {
        const initUnit = game.getUnit(initUnitNid);
        if (initUnit && initUnit.finished) {
          game.state.change('turn_change');
          return;
        }
      }
    } else {
      // Standard mode: if all player units are finished, advance
      const playerUnits: UnitObject[] = game.board.getTeamUnits('player');
      if (playerUnits.length > 0) {
        const allFinished = playerUnits.every((u) => u.finished || u.isDead());
        if (allFinished) {
          game.state.change('turn_change');
          return;
        }
      }
    }
  }

  override draw(surf: Surface): Surface {
    surf = drawMap(surf);
    // HUD is drawn in screen-space by main.ts after the game surface blit.
    return surf;
  }

  /**
   * Compute and display the union of all enemy units' attack ranges.
   * This iterates every enemy unit, computes their valid moves and
   * attack positions, and combines them into a single 'threat' overlay.
   */
  private showAllEnemyThreat(game: any): void {
    const board = game.board;
    const pathSystem = game.pathSystem;
    if (!board || !pathSystem) return;

    const allThreatPositions = new Set<string>();

    // Gather all teams that are hostile to the player
    const enemyTeams = ['enemy', 'enemy2'];
    for (const team of enemyTeams) {
      const enemies: UnitObject[] = board.getTeamUnits(team);
      for (const enemy of enemies) {
        if (!enemy.position || enemy.isDead()) continue;

        try {
          const validMoves = pathSystem.getValidMoves(enemy, board);
          const attackPos = pathSystem.getAttackPositions(enemy, board, validMoves);

          // Both move positions (they can attack from there) and attack positions are threats
          for (const [x, y] of validMoves) {
            allThreatPositions.add(`${x},${y}`);
          }
          for (const [x, y] of attackPos) {
            allThreatPositions.add(`${x},${y}`);
          }
        } catch (e) {
          // Skip units that fail (e.g. missing movement group data)
          continue;
        }
      }
    }

    // Convert to position array
    const positions: [number, number][] = [];
    for (const key of allThreatPositions) {
      const [x, y] = key.split(',').map(Number);
      positions.push([x, y]);
    }

    game.highlight.setThreatHighlights(positions);
  }
}

// ============================================================================
// 3. MoveState
// ============================================================================

export class MoveState extends MapState {
  readonly name = 'move';

  private validMoves: [number, number][] = [];
  private attackPositions: [number, number][] = [];
  private previousPosition: [number, number] | null = null;

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return 'repeat';
    }

    // If the unit already finished (e.g. returned from menu after Wait/Attack),
    // pop back to FreeState by clearing the selection and returning.
    if (unit.finished || !unit.canStillAct()) {
      game.selectedUnit = null;
      game._moveOrigin = null;
      game.highlight.clear();
      game.state.back();
      return 'repeat';
    }

    this.previousPosition = [unit.position[0], unit.position[1]];
    // Save origin so MenuState can undo the move
    game._moveOrigin = [unit.position[0], unit.position[1]];

    // Compute valid moves + attack positions
    this.validMoves = game.pathSystem.getValidMoves(unit, game.board);
    this.attackPositions = game.pathSystem.getAttackPositions(
      unit,
      game.board,
      this.validMoves,
    );

    // Show highlights
    game.highlight.clear();
    game.highlight.setMoveHighlights(this.validMoves);
    game.highlight.setAttackHighlights(this.attackPositions);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Process mouse input for map interaction
    const mouseAction = processMouseForMap(event);
    const effective = mouseAction ?? event;

    if (effective === null) return;

    switch (effective) {
      case 'UP':
        moveCursor(0, -1);
        break;
      case 'DOWN':
        moveCursor(0, 1);
        break;
      case 'LEFT':
        moveCursor(-1, 0);
        break;
      case 'RIGHT':
        moveCursor(1, 0);
        break;

      case 'SELECT': {
        const pos = game.cursor.getHover();
        const isValid = this.validMoves.some(
          ([x, y]) => x === pos.x && y === pos.y,
        );
        if (isValid) {
          const unit: UnitObject = game.selectedUnit;

          // Compute path from the unit's current position (before moving on the board)
          const path = game.pathSystem.getPath(
            unit,
            pos.x,
            pos.y,
            game.board,
          );

          // Move unit on the board
          game.board.moveUnit(unit, pos.x, pos.y);
          unit.hasMoved = true;

          // Check if this movement triggers AI group activation
          if (game.aiController && unit.team === 'player') {
            game.aiController.checkGroupActivation([pos.x, pos.y], game);
          }

          // If we have a path with length > 1, animate movement
          if (path && path.length > 1) {
            game.movementSystem.beginMove(unit, path, undefined, () => {
              // After movement animation completes, push menu
            });
            game.state.change('movement');
            // After movement, push menu
            game._pendingAfterMovement = 'menu';
          } else {
            // Already at destination or single tile, push menu directly
            game.state.change('menu');
          }
        }
        break;
      }

      case 'BACK':
        game.highlight.clear();
        game._moveOrigin = null;
        game.state.back();
        break;
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    surf = drawMap(surf, true);

    // Draw path preview from unit to cursor
    const unit: UnitObject = game.selectedUnit;
    if (unit && unit.position) {
      const cursorPos = game.cursor.getHover();
      const isValid = this.validMoves.some(
        ([x, y]) => x === cursorPos.x && y === cursorPos.y,
      );
      if (isValid) {
        const cameraOffset = game.camera.getOffset();
        const path = game.pathSystem.getPath(
          unit,
          cursorPos.x,
          cursorPos.y,
          game.board,
        );
        if (path && path.length > 1) {
          for (const [px, py] of path) {
            const screenX = px * TILEWIDTH - cameraOffset[0];
            const screenY = py * TILEHEIGHT - cameraOffset[1];
            surf.fillRect(
              screenX + 4,
              screenY + 4,
              TILEWIDTH - 8,
              TILEHEIGHT - 8,
              'rgba(255,255,255,0.35)',
            );
          }
        }
      }
    }
    return surf;
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
  }
}

// ============================================================================
// 4. MenuState
// ============================================================================

export class MenuState extends State {
  readonly name = 'menu';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private previousPosition: [number, number] | null = null;
  private validRegions: RegionData[] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return 'repeat';
    }

    // If the unit already finished (returned from a sub-state like ItemUse/Trade),
    // pop back so MoveState can clean up and return to FreeState.
    if (unit.finished || !unit.canStillAct()) {
      this.menu = null;
      game.state.back();
      return 'repeat';
    }

    this.previousPosition = game._moveOrigin ?? null;

    const options: MenuOption[] = [];
    const ux = unit.position[0];
    const uy = unit.position[1];

    // Attack option — only if enemies are in weapon range from current position
    const targets = getTargetsInRange(unit, ux, uy);
    if (targets.length > 0) {
      options.push({ label: 'Attack', value: 'attack', enabled: true });
    }

    // Item option — if unit has usable healing/consumable items
    if (unit.hasUsableItems()) {
      options.push({ label: 'Item', value: 'item', enabled: true });
    }

    // Trade option — if adjacent allied unit exists and unit hasn't traded/attacked
    if (unit.canTrade()) {
      const adjacentAllies = getAdjacentAllies(unit, ux, uy);
      if (adjacentAllies.length > 0) {
        options.push({ label: 'Trade', value: 'trade', enabled: true });
      }
    }

    // Rescue option — if adjacent allied unit that can be rescued
    const rescuableUnits = getAdjacentAllies(unit, ux, uy).filter(
      (ally) => !ally.isRescued() && !ally.isRescuing(),
    );
    if (rescuableUnits.length > 0 && !unit.isRescuing()) {
      options.push({ label: 'Rescue', value: 'rescue', enabled: true });
    }

    // Drop option — if unit is carrying a rescued unit
    if (unit.isRescuing()) {
      const dropTiles = getAdjacentEmptyTiles(ux, uy);
      if (dropTiles.length > 0) {
        options.push({ label: 'Drop', value: 'drop', enabled: true });
      }
    }

    // Region interactions (Visit, Seize, Shop, Armory, Chest, etc.)
    // Regions with region_type === 'event' show their sub_nid as the menu label.
    this.validRegions = [];
    if (game.currentLevel?.regions) {
      for (const region of game.currentLevel.regions) {
        if (region.region_type.toLowerCase() !== 'event') continue;
        const [rx, ry] = region.position;
        const [rw, rh] = region.size;
        if (ux >= rx && ux < rx + rw && uy >= ry && uy < ry + rh) {
          // Evaluate region condition
          const condCtx: ConditionContext = {
            game, unit1: unit, region,
            gameVars: game.gameVars, levelVars: game.levelVars,
          };
          const conditionStr = region.condition ?? 'True';
          const conditionMet = evaluateCondition(conditionStr, condCtx);
          if (!conditionMet) continue;
          // No duplicate sub_nid labels
          const subNid = region.sub_nid || 'Visit';
          if (options.some(o => o.label === subNid)) continue;
          options.push({ label: subNid, value: `region_${region.nid}`, enabled: true });
          this.validRegions.push(region);
        }
      }
    }

    // Talk option — check if adjacent unit has a talk event
    const adjacentTalkTargets = getAdjacentUnits(ux, uy).filter((other) => {
      if (other === unit) return false;
      // Check if there's a talk event between these two units
      if (game.eventManager) {
        const ctx = { game, unit1: unit, unit2: other, gameVars: game.gameVars, levelVars: game.levelVars };
        const levelNid = game.currentLevel?.nid ?? '';
        const events = game.eventManager.getEventsForTrigger({
          type: 'on_talk',
          levelNid,
          unitA: unit.nid,
          unitB: other.nid,
          unit1: unit,
          unit2: other,
        }, ctx);
        return events.length > 0;
      }
      return false;
    });
    if (adjacentTalkTargets.length > 0) {
      options.push({ label: 'Talk', value: 'talk', enabled: true });
    }

    // Wait is always available
    options.push({ label: 'Wait', value: 'wait', enabled: true });

    // Position the menu near the unit
    const cameraOffset = game.camera.getOffset();
    const menuX = ux * TILEWIDTH - cameraOffset[0] + TILEWIDTH + 4;
    const menuY = uy * TILEHEIGHT - cameraOffset[1];

    // Clamp menu to screen
    const clampedX = Math.min(menuX, viewport.width - 60);
    const clampedY = Math.min(menuY, viewport.height - options.length * 16 - 8);

    this.menu = new ChoiceMenu(options, clampedX, Math.max(0, clampedY));
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    // Handle mouse click on menu options
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    // Handle mouse hover to highlight menu options
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    // Fall through to keyboard input if mouse didn't produce a result
    if (!result && event !== null) {
      result = this.menu.handleInput(event);
    }
    if (!result) return;

    if ('back' in result) {
      // Undo move — put unit back at original position
      const unit: UnitObject = game.selectedUnit;
      if (unit && game._moveOrigin) {
        game.board.moveUnit(
          unit,
          game._moveOrigin[0],
          game._moveOrigin[1],
        );
        unit.hasMoved = false;
      }
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const value = result.selected;
      const unit: UnitObject = game.selectedUnit;

      if (value === 'attack') {
        this.menu = null;
        game.state.change('weapon_choice');
      } else if (value === 'item') {
        this.menu = null;
        game.state.change('item_use');
      } else if (value === 'trade') {
        this.menu = null;
        game.state.change('trade');
      } else if (value === 'rescue') {
        this.menu = null;
        game.state.change('rescue');
      } else if (value === 'drop') {
        this.menu = null;
        game.state.change('drop');
      } else if (value.startsWith('region_')) {
        // Region interaction — triggered by sub_nid (Visit, Seize, Shop, Armory, Chest, etc.)
        const regionNid = value.slice('region_'.length);
        const region = this.validRegions.find((r) => r.nid === regionNid);
        const subNid = region?.sub_nid || '';
        const levelNid = game.currentLevel?.nid ?? '';
        const ctx = { game, unit1: unit, position: unit.position, region, gameVars: game.gameVars, levelVars: game.levelVars };
        let didTrigger = false;
        if (game.eventManager) {
          // Try region sub_nid as trigger type first (e.g., 'Visit', 'Seize', 'Armory')
          if (subNid) {
            didTrigger = game.eventManager.trigger(
              { type: subNid, levelNid, regionNid, unitNid: unit.nid, unit1: unit, region },
              ctx,
            );
          }

          // Compatibility fallback for destructible village events where LT data
          // conditions target the sibling "VillageX" region while interaction
          // originates from "DestroyVillageX".
          if (!didTrigger && subNid === 'Destructible' && region?.nid?.startsWith('Destroy') && game.currentLevel?.regions) {
            const aliasNid = region.nid.replace(/^Destroy/, '');
            const aliasRegion = game.currentLevel.regions.find(
              (r: RegionData) => r.nid === aliasNid,
            );
            if (aliasRegion) {
              const aliasCtx = {
                game,
                unit1: unit,
                position: unit.position,
                region: aliasRegion,
                gameVars: game.gameVars,
                levelVars: game.levelVars,
              };
              didTrigger = game.eventManager.trigger(
                { type: subNid, levelNid, regionNid: aliasRegion.nid, unitNid: unit.nid, unit1: unit, region: aliasRegion },
                aliasCtx,
              );
            }
          }

          // Fallback to generic on_region_interact
          if (!didTrigger) {
            didTrigger = game.eventManager.trigger(
              { type: 'on_region_interact', levelNid, regionNid, unitNid: unit.nid, unit1: unit, region },
              ctx,
            );
          }
        }
        // Python LT removes only the selected one-shot region. Co-located
        // regions remain active unless the event script removes them.
        if (didTrigger && region?.only_once && game.currentLevel?.regions) {
          game.currentLevel.regions = game.currentLevel.regions.filter(
            (candidate: RegionData) => candidate.nid !== regionNid,
          );
        }
        if (unit) unit.finished = true;
        this.menu = null;
        // Seize also checks win condition immediately
        if (subNid === 'Seize') {
          if (game.checkWinCondition()) {
            console.warn('VICTORY — seize condition met');
          }
        }
        if (game.eventManager?.hasActiveEvents()) {
          game.state.change('event');
        } else {
          game.state.back();
        }
      } else if (value === 'talk') {
        // Trigger talk event using 'on_talk' trigger type (matches LT Python)
        const adjacentTalkTargets = getAdjacentUnits(
          unit.position![0],
          unit.position![1],
        ).filter((other) => {
          if (other === unit) return false;
          if (game.eventManager) {
            const ctx = { game, unit1: unit, unit2: other, gameVars: game.gameVars, levelVars: game.levelVars };
            const levelNid = game.currentLevel?.nid ?? '';
            const events = game.eventManager.getEventsForTrigger({
              type: 'on_talk',
              levelNid,
              unitA: unit.nid,
              unitB: other.nid,
              unit1: unit,
              unit2: other,
            }, ctx);
            return events.length > 0;
          }
          return false;
        });
        if (adjacentTalkTargets.length > 0 && game.eventManager) {
          const target = adjacentTalkTargets[0];
          const talkLevelNid = game.currentLevel?.nid ?? '';
          const ctx = { game, unit1: unit, unit2: target, gameVars: game.gameVars, levelVars: game.levelVars };
          game.eventManager.trigger(
            {
              type: 'on_talk',
              levelNid: talkLevelNid,
              unitA: unit.nid,
              unitB: target.nid,
              unit1: unit,
              unit2: target,
            },
            ctx,
          );
        }
        // Python LT's TalkAbility applies HasTraded, preserving canto/post-action
        // movement while preventing another full action.
        if (unit) unit.hasTraded = true;
        this.menu = null;
        if (game.eventManager?.hasActiveEvents()) {
          game.state.change('event');
        } else {
          game.state.back();
        }
      } else if (value === 'wait') {
        // Record end of action group (turnwheel marker)
        game.actionLog.doAction(new MarkActionGroupEnd('menu'));
        if (unit) unit.finished = true;
        this.menu = null;
        game.state.back();
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 4b. ItemUseState - Select and use a consumable item
// ============================================================================

export class ItemUseState extends State {
  readonly name = 'item_use';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private usableItems: ItemObject[] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit) {
      game.state.back();
      return;
    }

    this.usableItems = unit.getUsableItems();
    if (this.usableItems.length === 0) {
      game.state.back();
      return;
    }

    const options: MenuOption[] = this.usableItems.map((item, i) => ({
      label: item.name,
      value: `item_${i}`,
      enabled: true,
    }));

    // Position near the unit
    const cameraOffset = game.camera.getOffset();
    const menuX = unit.position
      ? unit.position[0] * TILEWIDTH - cameraOffset[0] + TILEWIDTH + 4
      : viewport.width / 2;
    const menuY = unit.position
      ? unit.position[1] * TILEHEIGHT - cameraOffset[1]
      : viewport.height / 2;

    const clampedX = Math.min(menuX, viewport.width - 70);
    const clampedY = Math.min(menuY, viewport.height - options.length * 16 - 8);

    this.menu = new ChoiceMenu(options, clampedX, Math.max(0, clampedY));
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu || event === null) return;
    const game = getGame();

    const result = this.menu.handleInput(event);
    if (!result) return;

    if ('back' in result) {
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const idx = parseInt(result.selected.replace('item_', ''), 10);
      const item = this.usableItems[idx];
      const unit: UnitObject = game.selectedUnit;

      if (item && unit) {
        // Apply item effect
        if (item.isHealing()) {
          const healAmount = item.getHealAmount();
          unit.currentHp = Math.min(unit.maxHp, unit.currentHp + healAmount);
        }
        if (item.isStatBooster()) {
          const changes = item.getStatChanges();
          for (const [stat, amount] of Object.entries(changes)) {
            if (unit.stats[stat] !== undefined) {
              unit.stats[stat] += amount;
            }
          }
        }

        // Decrement uses
        const broken = item.decrementUses();
        if (broken) {
          const itemIdx = unit.items.indexOf(item);
          if (itemIdx !== -1) unit.items.splice(itemIdx, 1);
        }

        // Using an item finishes the unit's turn
        unit.finished = true;
      }

      this.menu = null;
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 4c. TradeState - Trade items between adjacent allied units
// ============================================================================

export class TradeState extends State {
  readonly name = 'trade';
  override readonly transparent = true;

  private targetMenu: ChoiceMenu | null = null;
  private adjacentAllies: UnitObject[] = [];
  private tradePartner: UnitObject | null = null;

  // Item selection phase
  private itemMenuA: ChoiceMenu | null = null;
  private itemMenuB: ChoiceMenu | null = null;
  private selectedIndexA: number = -1;
  private phase: 'select_partner' | 'select_items' = 'select_partner';

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return;
    }

    this.adjacentAllies = getAdjacentAllies(unit, unit.position[0], unit.position[1]);
    if (this.adjacentAllies.length === 0) {
      game.state.back();
      return;
    }

    if (this.adjacentAllies.length === 1) {
      // Only one partner, skip selection
      this.tradePartner = this.adjacentAllies[0];
      this.buildItemMenus(unit);
      this.phase = 'select_items';
    } else {
      const options: MenuOption[] = this.adjacentAllies.map((ally) => ({
        label: ally.name,
        value: ally.nid,
        enabled: true,
      }));

      this.targetMenu = new ChoiceMenu(options, viewport.width / 2 - 30, viewport.height / 2 - 16);
      this.phase = 'select_partner';
    }
  }

  private buildItemMenus(unit: UnitObject): void {
    const partner = this.tradePartner!;

    // Build items list for unit A (current unit)
    const optionsA: MenuOption[] = unit.items.map((item, i) => ({
      label: item.name,
      value: `a_${i}`,
      enabled: true,
    }));
    // Add empty slot
    optionsA.push({ label: '---', value: 'a_empty', enabled: false });

    this.itemMenuA = new ChoiceMenu(optionsA, 4, 20);

    // Build items list for unit B (trade partner)
    const optionsB: MenuOption[] = partner.items.map((item, i) => ({
      label: item.name,
      value: `b_${i}`,
      enabled: true,
    }));
    optionsB.push({ label: '---', value: 'b_empty', enabled: false });

    this.itemMenuB = new ChoiceMenu(optionsB, viewport.width / 2 + 4, 20);
    this.selectedIndexA = -1;
  }

  override takeInput(event: InputEvent): StateResult {
    if (event === null) return;
    const game = getGame();

    if (this.phase === 'select_partner' && this.targetMenu) {
      const result = this.targetMenu.handleInput(event);
      if (!result) return;

      if ('back' in result) {
        this.targetMenu = null;
        game.state.back();
        return;
      }

      if ('selected' in result) {
        this.tradePartner = this.adjacentAllies.find((a) => a.nid === result.selected) ?? null;
        if (this.tradePartner) {
          this.buildItemMenus(game.selectedUnit);
          this.phase = 'select_items';
          this.targetMenu = null;
        }
      }
      return;
    }

    if (this.phase === 'select_items') {
      // Simplified trade: BACK exits, otherwise just swap first items
      if (event === 'BACK') {
        const unit: UnitObject = game.selectedUnit;
        if (unit) {
          unit.hasTraded = true;
          unit.finished = true;
        }
        game.state.back();
        return;
      }

      // For now, a simple swap of the first items from each unit
      if (event === 'SELECT') {
        const unit: UnitObject = game.selectedUnit;
        const partner = this.tradePartner;
        if (unit && partner && unit.items.length > 0 && partner.items.length > 0) {
          const itemA = unit.items[0];
          const itemB = partner.items[0];
          unit.items[0] = itemB;
          partner.items[0] = itemA;
          itemA.owner = partner;
          itemB.owner = unit;
        }
        if (unit) {
          unit.hasTraded = true;
          unit.finished = true;
        }
        game.state.back();
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.phase === 'select_partner' && this.targetMenu) {
      this.targetMenu.draw(surf);
    }

    if (this.phase === 'select_items') {
      // Draw a simplified trade UI
      surf.fillRect(0, 0, viewport.width, viewport.height, 'rgba(0,0,32,0.7)');

      const game = getGame();
      const unit: UnitObject = game.selectedUnit;
      const partner = this.tradePartner;

      // Unit A items
      surf.drawText(unit?.name ?? '', 4, 4, 'white', '8px monospace');
      if (unit) {
        unit.items.forEach((item, i) => {
          surf.drawText(item.name, 8, 16 + i * 12, 'rgba(200,200,255,1)', '7px monospace');
        });
      }

      // Unit B items
      const bx = viewport.width / 2 + 4;
      surf.drawText(partner?.name ?? '', bx, 4, 'white', '8px monospace');
      if (partner) {
        partner.items.forEach((item, i) => {
          surf.drawText(item.name, bx + 4, 16 + i * 12, 'rgba(200,200,255,1)', '7px monospace');
        });
      }

      surf.drawText('SELECT to swap, BACK to finish', 4, viewport.height - 12, 'rgba(160,160,200,1)', '7px monospace');
    }

    return surf;
  }
}

// ============================================================================
// 4d. RescueState - Select an adjacent ally to rescue
// ============================================================================

export class RescueState extends State {
  readonly name = 'rescue';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private rescuableUnits: UnitObject[] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return;
    }

    this.rescuableUnits = getAdjacentAllies(unit, unit.position[0], unit.position[1])
      .filter((ally) => !ally.isRescued() && !ally.isRescuing());

    if (this.rescuableUnits.length === 0) {
      game.state.back();
      return;
    }

    const options: MenuOption[] = this.rescuableUnits.map((ally) => ({
      label: ally.name,
      value: ally.nid,
      enabled: true,
    }));

    this.menu = new ChoiceMenu(options, viewport.width / 2 - 30, viewport.height / 2 - 16);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu || event === null) return;
    const game = getGame();

    const result = this.menu.handleInput(event);
    if (!result) return;

    if ('back' in result) {
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const target = this.rescuableUnits.find((u) => u.nid === result.selected);
      const unit: UnitObject = game.selectedUnit;

      if (target && unit) {
        // Remove target from board
        game.board.removeUnit(target);
        // Set rescue references
        unit.rescuing = target;
        target.rescuedBy = unit;
        // Finish the unit's turn
        unit.finished = true;
      }

      this.menu = null;
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 4e. DropState - Select a tile to drop a rescued unit
// ============================================================================

export class DropState extends MapState {
  readonly name = 'drop';

  private dropTiles: [number, number][] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position || !unit.rescuing) {
      game.state.back();
      return;
    }

    this.dropTiles = getAdjacentEmptyTiles(unit.position[0], unit.position[1]);

    if (this.dropTiles.length === 0) {
      game.state.back();
      return;
    }

    // Highlight drop tiles
    game.highlight.clear();
    for (const [tx, ty] of this.dropTiles) {
      game.highlight.addHighlight(tx, ty, 'move');
    }

    // Position cursor on first drop tile
    game.cursor.setPos(this.dropTiles[0][0], this.dropTiles[0][1]);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Process mouse input for map interaction
    const mouseAction = processMouseForMap(event);
    const effective = mouseAction ?? event;

    if (effective === null) return;

    switch (effective) {
      case 'UP':
        moveCursor(0, -1);
        break;
      case 'DOWN':
        moveCursor(0, 1);
        break;
      case 'LEFT':
        moveCursor(-1, 0);
        break;
      case 'RIGHT':
        moveCursor(1, 0);
        break;

      case 'SELECT': {
        const pos = game.cursor.getHover();
        const isValid = this.dropTiles.some(([x, y]) => x === pos.x && y === pos.y);
        if (isValid) {
          const unit: UnitObject = game.selectedUnit;
          const target = unit?.rescuing;
          if (unit && target) {
            // Drop the rescued unit
            unit.rescuing = null;
            target.rescuedBy = null;
            game.board.setUnit(pos.x, pos.y, target);
            // Finish unit's turn
            unit.finished = true;
          }
          game.highlight.clear();
          game.state.back();
        }
        break;
      }

      case 'BACK':
        game.highlight.clear();
        game.state.back();
        break;
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    return drawMap(surf, true);
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
  }
}

// ============================================================================
// 5a. WeaponChoiceState — Select which weapon to use before attacking
// ============================================================================

export class WeaponChoiceState extends State {
  readonly name = 'weapon_choice';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private weapons: ItemObject[] = [];
  private previousEquipped: ItemObject | null = null;

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return 'repeat';
    }

    // If the unit already finished (returned from combat), pop back.
    if (unit.finished || !unit.canStillAct()) {
      this.menu = null;
      game.state.back();
      return 'repeat';
    }

    // Gather all usable weapons (has uses remaining, is a weapon)
    this.weapons = unit.items.filter(
      (item) => item.isWeapon() && item.hasUsesRemaining(),
    );

    // Also include spells
    const spells = unit.items.filter(
      (item) => item.isSpell() && item.hasUsesRemaining() && !item.isWeapon(),
    );
    this.weapons.push(...spells);

    if (this.weapons.length === 0) {
      game.state.back();
      return;
    }

    // If only one weapon, auto-select it
    if (this.weapons.length === 1) {
      this.equipWeapon(unit, this.weapons[0]);
      game.state.change('targeting');
      return;
    }

    // Remember current equipped weapon for undo
    this.previousEquipped = getEquippedWeapon(unit);

    // Build menu options
    const options: MenuOption[] = this.weapons.map((w) => ({
      label: w.name,
      value: w.nid,
      enabled: true,
    }));

    // Position menu near unit
    const cameraOffset = game.camera.getOffset();
    const menuX = unit.position[0] * TILEWIDTH - cameraOffset[0] + TILEWIDTH + 4;
    const menuY = unit.position[1] * TILEHEIGHT - cameraOffset[1];
    const clampedX = Math.min(menuX, viewport.width - 80);
    const clampedY = Math.min(menuY, viewport.height - options.length * 16 - 8);

    this.menu = new ChoiceMenu(options, clampedX, Math.max(0, clampedY));

    // Equip the first weapon and show its attack range
    this.equipWeapon(unit, this.weapons[0]);
    this.showWeaponRange(unit, this.weapons[0]);
  }

  private equipWeapon(unit: UnitObject, weapon: ItemObject): void {
    unit.equipWeapon(weapon);
  }

  private showWeaponRange(unit: UnitObject, weapon: ItemObject): void {
    const game = getGame();
    game.highlight.clear();
    const minRange = weapon.getMinRange();
    const maxRange = weapon.getMaxRange();
    const ux = unit.position![0];
    const uy = unit.position![1];
    const attackTiles: [number, number][] = [];
    for (let dx = -maxRange; dx <= maxRange; dx++) {
      for (let dy = -maxRange; dy <= maxRange; dy++) {
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist >= minRange && dist <= maxRange) {
          const tx = ux + dx;
          const ty = uy + dy;
          if (game.board.inBounds(tx, ty)) {
            attackTiles.push([tx, ty]);
          }
        }
      }
    }
    game.highlight.setAttackHighlights(attackTiles);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    // Handle mouse
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    if (!result && event !== null) {
      result = this.menu.handleInput(event);
    }
    if (!result) {
      // On UP/DOWN, update weapon range display
      if (event === 'UP' || event === 'DOWN') {
        const idx = this.menu.selectedIndex;
        if (idx >= 0 && idx < this.weapons.length) {
          const unit: UnitObject = game.selectedUnit;
          this.equipWeapon(unit, this.weapons[idx]);
          this.showWeaponRange(unit, this.weapons[idx]);
        }
      }
      return;
    }

    if ('back' in result) {
      // Restore previous equipped weapon
      const unit: UnitObject = game.selectedUnit;
      if (this.previousEquipped) {
        this.equipWeapon(unit, this.previousEquipped);
      }
      game.highlight.clear();
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const weapon = this.weapons.find((w) => w.nid === result.selected);
      if (weapon) {
        const unit: UnitObject = game.selectedUnit;
        this.equipWeapon(unit, weapon);
      }
      game.highlight.clear();
      this.menu = null;
      game.state.change('targeting');
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    surf = drawMap(surf, true);
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
  }
}

// ============================================================================
// 5b. TargetingState
// ============================================================================

export class TargetingState extends MapState {
  readonly name = 'targeting';

  private targets: UnitObject[] = [];
  private targetIndex: number = 0;

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return 'repeat';
    }

    // If the unit already finished (returned from combat), pop back.
    if (unit.finished || !unit.canStillAct()) {
      game.highlight.clear();
      game.state.back();
      return 'repeat';
    }

    // Get valid targets
    this.targets = getTargetsInRange(
      unit,
      unit.position[0],
      unit.position[1],
    );
    this.targetIndex = 0;

    if (this.targets.length === 0) {
      game.state.back();
      return;
    }

    // Show attack range highlights
    game.highlight.clear();
    const weapon = getEquippedWeapon(unit);
    if (weapon) {
      const minRange = weapon.getMinRange();
      const maxRange = weapon.getMaxRange();
      const attackTiles: [number, number][] = [];
      const ux = unit.position[0];
      const uy = unit.position[1];
      for (let dx = -maxRange; dx <= maxRange; dx++) {
        for (let dy = -maxRange; dy <= maxRange; dy++) {
          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist >= minRange && dist <= maxRange) {
            const tx = ux + dx;
            const ty = uy + dy;
            if (game.board.inBounds(tx, ty)) {
              attackTiles.push([tx, ty]);
            }
          }
        }
      }
      game.highlight.setAttackHighlights(attackTiles);
    }

    // Position cursor on first target
    this.focusTarget();
  }

  private focusTarget(): void {
    const game = getGame();
    const target = this.targets[this.targetIndex];
    if (target && target.position) {
      game.cursor.setPos(target.position[0], target.position[1]);
      // Only pan camera to target on mobile; desktop users can pan manually
      if (isSmallScreen()) {
        game.camera.focusTile(target.position[0], target.position[1]);
      }
    }
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Mouse: clicking directly on a valid target selects it
    if (game.input?.mouseClick === 'SELECT') {
      const tile = getMouseTile();
      if (tile) {
        const clickedTargetIdx = this.targets.findIndex(
          (t) => t.position && t.position[0] === tile[0] && t.position[1] === tile[1],
        );
        if (clickedTargetIdx >= 0) {
          this.targetIndex = clickedTargetIdx;
          const target = this.targets[this.targetIndex];
          game.combatTarget = target;
          game.highlight.clear();
          game.state.change('combat');
          return;
        }
      }
    }
    if (game.input?.mouseClick === 'BACK') {
      game.highlight.clear();
      game.state.back();
      return;
    }

    if (event === null) return;

    switch (event) {
      case 'UP':
      case 'LEFT':
        // Cycle to previous target
        if (this.targets.length > 0) {
          this.targetIndex =
            (this.targetIndex - 1 + this.targets.length) % this.targets.length;
          this.focusTarget();
        }
        break;

      case 'DOWN':
      case 'RIGHT':
        // Cycle to next target
        if (this.targets.length > 0) {
          this.targetIndex =
            (this.targetIndex + 1) % this.targets.length;
          this.focusTarget();
        }
        break;

      case 'SELECT': {
        const target = this.targets[this.targetIndex];
        if (target) {
          game.combatTarget = target;
          game.highlight.clear();
          game.state.change('combat');
        }
        break;
      }

      case 'BACK':
        game.highlight.clear();
        game.state.back();
        break;
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    surf = drawMap(surf, true);

    // Draw target info overlay
    const target = this.targets[this.targetIndex];
    if (target) {
      const unit: UnitObject = game.selectedUnit;
      const weapon = getEquippedWeapon(unit);
      if (weapon && target.position) {
        const cameraOffset = game.camera.getOffset();
        const tx = target.position[0] * TILEWIDTH - cameraOffset[0];
        const ty = target.position[1] * TILEHEIGHT - cameraOffset[1];

        // Highlight target tile
        surf.fillRect(tx, ty, TILEWIDTH, TILEHEIGHT, 'rgba(255,0,0,0.3)');

        // Show target name/HP at top of screen
        surf.fillRect(0, 0, viewport.width, 16, 'rgba(0,0,0,0.7)');
        surf.drawText(
          `${target.name}  HP: ${target.currentHp}/${target.maxHp}`,
          4,
          4,
          'white',
          '8px monospace',
        );
      }
    }
    return surf;
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
    // Clear targets to prevent stale draw (red rectangle) when CombatState
    // draws on top of this transparent state
    this.targets = [];
  }
}

// ============================================================================
// 6. CombatState
// ============================================================================

/**
 * CombatState phases:
 * 1. 'combat' - Running the MapCombat animation (strikes, HP drain)
 * 2. 'death' - Death animation timer (fade-out)
 * 3. 'exp' - EXP bar animation
 * 4. 'levelup' - Level-up stat display
 * 5. 'cleanup' - Check win/loss, transition out
 */
type CombatPhase = 'combat' | 'death' | 'exp_init' | 'exp_wait' | 'exp0' | 'exp100' | 'exp_leave' | 'level_up' | 'level_screen' | 'cleanup';

export class CombatState extends State {
  readonly name = 'combat';
  override readonly transparent = true;

  private combat: MapCombat | null = null;
  private animCombat: AnimationCombat | null = null;
  private isAnimationCombat: boolean = false;
  private results: CombatResults | null = null;
  private phase: CombatPhase = 'combat';
  private phaseTimer: number = 0;

  /**
   * Whether this combat was triggered from an event (interact_unit).
   * When true, CombatState should NOT push EventState on cleanup —
   * the calling EventState is already on the stack and will resume
   * processing when CombatState pops via back().
   * Matches Python's `event_combat` flag in `simple_combat.py`.
   */
  private eventCombat: boolean = false;

  /** Whether we successfully pushed battle music (guards popMusic). */
  private didPushBattleMusic: boolean = false;

  // EXP state machine (faithful port of Python ExpState)
  private expBar: ExpBarClass | null = null;
  private expOldExp: number = 0;
  private expGainAmount: number = 0;
  private expTotalTime: number = 0;    // ms to fill bar (1 frame per EXP point at 60fps)
  private expStartTime: number = 0;    // timestamp when current sub-phase started
  private expNeedLevelUp: boolean = false;

  // Level-up display
  private levelUpGains: Record<string, number> | null = null;
  private levelUpScreen: LevelUpScreenClass | null = null;
  private levelUpSoundPlayed: boolean = false;
  private darkFuzzAlpha: number = 0.34; // 66% translucent = 34% opaque black overlay
  private portraitImg: HTMLImageElement | null = null;

  // Death fade
  private deathFadeProgress: number = 0;

  // Platform images for animation combat
  private leftPlatformImg: HTMLImageElement | null = null;
  private rightPlatformImg: HTMLImageElement | null = null;

  // Battle background panorama image
  private battleBackgroundImg: HTMLImageElement | null = null;

  /** Get whichever combat controller is active (AnimationCombat or MapCombat). */
  private getActiveCombat(): MapCombat | AnimationCombat | null {
    return this.isAnimationCombat ? this.animCombat : this.combat;
  }

  override begin(): StateResult {
    const game = getGame();
    const attacker: UnitObject = game.selectedUnit;
    const defender: UnitObject = game.combatTarget;

    if (!attacker || !defender) {
      game.state.back();
      return;
    }

    const attackItem = getEquippedWeapon(attacker);
    if (!attackItem) {
      game.state.back();
      return;
    }

    const defenseItem = getEquippedWeapon(defender);
    const rngMode = game.db.getConstant('rng_mode', 'true_hit') as any;

    // Read and consume the combat script (set by interact_unit)
    const script = game.combatScript;
    game.combatScript = null;

    // Check if both units have battle animations available
    const canAnimate = this.tryCreateAnimationCombat(
      attacker, attackItem, defender, defenseItem, rngMode, game, script,
    );

    if (canAnimate) {
      this.isAnimationCombat = true;
      this.combat = null;
      console.log(`CombatState: using AnimationCombat (${attacker.name} vs ${defender.name})`);
    } else {
      // Fallback to map combat
      this.isAnimationCombat = false;
      this.animCombat = null;
      this.combat = new MapCombat(
        attacker,
        attackItem,
        defender,
        defenseItem,
        game.db,
        rngMode,
        game.board,
        script,
      );
      // Wire audio manager for combat sound effects
      if (game.audioManager) {
        this.combat.audioManager = game.audioManager;
      }
      console.log(`CombatState: using MapCombat (${attacker.name} vs ${defender.name})`);
    }

    this.results = null;
    this.phase = 'combat';
    this.phaseTimer = 0;
    this.deathFadeProgress = 0;
    this.levelUpGains = null;
    this.levelUpScreen = null;
    this.levelUpSoundPlayed = false;
    this.expBar = null;
    this.portraitImg = null;

    // Clear all highlights and hide cursor/HUD before combat starts
    // (Python does this in interaction.py and the red_cursor state)
    game.highlight.clear();
    game.cursor.visible = false;
    game.hud.visible = false;

    // Play battle music (push current phase music onto the stack)
    this.didPushBattleMusic = false;
    const levelMusic = game.currentLevel?.music;
    if (levelMusic) {
      const battleTrack = attacker.team === 'player'
        ? levelMusic.player_battle
        : levelMusic.enemy_battle;
      if (battleTrack) {
        this.didPushBattleMusic = true;
        void game.audioManager.pushMusic(battleTrack);
      }
    }
  }

  /**
   * Try to create an AnimationCombat. Returns true if successful.
   * Requires both units to have combat animations defined in their classes,
   * and those animations must be loaded in the database.
   */
  private tryCreateAnimationCombat(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    rngMode: string,
    game: any,
    script?: string[] | null,
  ): boolean {
    try {
      const db = game.db;
      if (!db.combatAnims || db.combatAnims.size === 0) return false;

      // Look up combat anim NIDs from unit classes.
      // Fallback chain: combat_anim_nid -> class nid (handles projects
      // where combat_anim_nid is null or references a missing animation).
      const atkKlass = db.classes.get(attacker.klass);
      const defKlass = db.classes.get(defender.klass);
      if (!atkKlass || !defKlass) return false;

      const atkAnimData = db.combatAnims.get(atkKlass.combat_anim_nid ?? '')
        ?? db.combatAnims.get(atkKlass.nid);
      const defAnimData = db.combatAnims.get(defKlass.combat_anim_nid ?? '')
        ?? db.combatAnims.get(defKlass.nid);
      if (!atkAnimData || !defAnimData) return false;

      // Determine weapon type for selecting the weapon animation.
      // Python's get_battle_anim() prepends "Magic" to the weapon type when
      // the item has the 'magic' or 'magic_at_range' component, and prepends
      // "Ranged" for ranged weapons at distance > 1.
      let atkWeaponType = attackItem.getWeaponType() ?? null;
      if (atkWeaponType && isMagic(attackItem)) {
        atkWeaponType = 'Magic' + atkWeaponType;
      }
      let defWeaponType = defenseItem?.getWeaponType() ?? null;
      if (defWeaponType && defenseItem && isMagic(defenseItem)) {
        defWeaponType = 'Magic' + defWeaponType;
      }

      // Select weapon animations
      const atkWeaponAnim = selectWeaponAnim(atkAnimData, atkWeaponType ?? null);
      const defWeaponAnim = selectWeaponAnim(defAnimData, defWeaponType ?? null);
      if (!atkWeaponAnim || !defWeaponAnim) return false;

      // Create BattleAnimation instances with real pose data but empty frames
      // (sprites will hot-swap in once async loading completes)
      const atkAnim = new RealBattleAnimation(atkWeaponAnim, new Map());
      const defAnim = new RealBattleAnimation(defWeaponAnim, new Map());

      // Determine left/right assignment (player on right)
      let leftIsAttacker = true;
      if (defender.team === 'player' && attacker.team !== 'player') {
        leftIsAttacker = true; // attacker (enemy) on left, defender (player) on right
      } else if (attacker.team === 'player') {
        leftIsAttacker = false; // attacker (player) on right, defender on left
      }

      const leftAnim = leftIsAttacker ? atkAnim : defAnim;
      const rightAnim = leftIsAttacker ? defAnim : atkAnim;

      // Store resources on globalThis so effect loaders can access them
      (globalThis as any).__ltResources = game.resources;

      this.animCombat = new AnimationCombat(
        attacker,
        attackItem,
        defender,
        defenseItem,
        db,
        rngMode,
        leftAnim,
        rightAnim,
        leftIsAttacker,
        game.board,
        script,
      );

      // Wire audio manager for combat sound effects
      if (game.audioManager) {
        this.animCombat.audioManager = game.audioManager;
      }

      // Load platform images asynchronously (they'll appear once loaded)
      const isMelee = this.animCombat.combatRange <= 1;
      const leftUnit = leftIsAttacker ? attacker : defender;
      const rightUnit = leftIsAttacker ? defender : attacker;
      const leftPlatformType = this.getUnitPlatformType(leftUnit, db) ?? 'Plains';
      const rightPlatformType = this.getUnitPlatformType(rightUnit, db) ?? 'Plains';
      loadBattlePlatforms(leftPlatformType, rightPlatformType, isMelee).then(([left, right]) => {
        this.leftPlatformImg = left;
        this.rightPlatformImg = right;
      });

      // Load battle background panorama based on attacker's terrain
      const bgNid = this.getUnitBackgroundNid(attacker, db);
      if (bgNid) {
        const resources = getGame().resources;
        resources.loadPanorama(bgNid).then((img: HTMLImageElement) => {
          this.battleBackgroundImg = img;
        }).catch(() => {
          // Panorama not found — fall back to solid color background
        });
      }

      // Load and apply spritesheets asynchronously (sprites hot-swap in once ready)
      this.loadCombatSprites(
        atkAnimData.nid, atkWeaponAnim, attacker, atkAnimData, atkAnim,
        defAnimData.nid, defWeaponAnim, defender, defAnimData, defAnim,
        db,
      );

      return true;
    } catch (e) {
      console.warn('Failed to create AnimationCombat, falling back to MapCombat:', e);
      return false;
    }
  }

  /** Look up the terrain definition for a unit's map position. */
  private getUnitTerrain(unit: UnitObject, db: any): any | null {
    if (!unit.position) return null;
    const game = getGame();
    if (!game.tilemap) return null;

    // TileMapObject.getTerrain walks layers top-to-bottom
    const terrainNid = game.tilemap.getTerrain(unit.position[0], unit.position[1]);
    if (!terrainNid) return null;

    return db.terrain?.get(terrainNid) ?? null;
  }

  /** Look up the platform type for a unit's terrain tile. */
  private getUnitPlatformType(unit: UnitObject, db: any): string | null {
    const terrain = this.getUnitTerrain(unit, db);
    if (!terrain?.platform) return 'Plains';
    return terrain.platform;
  }

  /** Look up the panorama background NID for a unit's terrain tile. */
  private getUnitBackgroundNid(unit: UnitObject, db: any): string | null {
    const terrain = this.getUnitTerrain(unit, db);
    return terrain?.background ?? null;
  }

  /**
   * Asynchronously load and palette-convert combat animation spritesheets.
   * Once loaded, the frame images are hot-swapped into the BattleAnimation
   * instances so sprites appear mid-scene if loading takes time.
   */
  private async loadCombatSprites(
    atkAnimNid: string,
    atkWeaponAnim: import('../../combat/battle-anim-types').WeaponAnimData,
    attacker: UnitObject,
    atkCombatAnimData: import('../../combat/battle-anim-types').CombatAnimData,
    atkBattleAnim: RealBattleAnimation,
    defAnimNid: string,
    defWeaponAnim: import('../../combat/battle-anim-types').WeaponAnimData,
    defender: UnitObject,
    defCombatAnimData: import('../../combat/battle-anim-types').CombatAnimData,
    defBattleAnim: RealBattleAnimation,
    db: any,
  ): Promise<void> {
    try {
      const resources = getGame().resources;
      const palettes = db.combatPalettes as Map<string, import('../../combat/battle-anim-types').PaletteData>;

      // Select palettes for each unit
      const atkPalette = selectPalette(atkCombatAnimData, attacker, palettes);
      const defPalette = selectPalette(defCombatAnimData, defender, palettes);

      // Load both spritesheets in parallel
      const [atkFrames, defFrames] = await Promise.all([
        atkPalette
          ? loadAndConvertWeaponAnim(resources, atkAnimNid, atkWeaponAnim, atkPalette)
          : null,
        defPalette
          ? loadAndConvertWeaponAnim(resources, defAnimNid, defWeaponAnim, defPalette)
          : null,
      ]);

      // Hot-swap frame images into the running BattleAnimation instances
      if (atkFrames && atkFrames.size > 0) {
        for (const [nid, canvas] of atkFrames) {
          atkBattleAnim.frameImages.set(nid, canvas);
        }
      }
      if (defFrames && defFrames.size > 0) {
        for (const [nid, canvas] of defFrames) {
          defBattleAnim.frameImages.set(nid, canvas);
        }
      }
    } catch (e) {
      console.warn('Failed to load combat animation sprites:', e);
    }
  }

  override takeInput(): StateResult {
    const game = getGame();
    if (!game.input) return;

    // BACK (Escape/X) instantly skips combat (both animation and map combat).
    // START (S) toggles 4x speed for animation combat.
    if (game.input.justPressed('BACK')) {
      if (this.phase === 'combat') {
        // Skip the combat animation entirely — results will be applied
        // by the normal 'done' handling in update()
        const activeCombat = this.isAnimationCombat ? this.animCombat : this.combat;
        if (activeCombat) {
          activeCombat.skipToEnd();
        }
      } else if (this.phase === 'death' || this.phase === 'exp_init' || this.phase === 'exp_wait' ||
                 this.phase === 'exp0' || this.phase === 'exp100' || this.phase === 'exp_leave' ||
                 this.phase === 'level_up' || this.phase === 'level_screen') {
        // Skip post-combat phases — stop looping SFX and jump straight to cleanup
        game.audioManager?.stopSfx?.('Experience Gain');
        this.phase = 'cleanup';
        this.phaseTimer = 0;
      }
    }
    if (game.input.justPressed('START')) {
      if (this.animCombat) {
        this.animCombat.skipMode = !this.animCombat.skipMode;
      }
    }
  }

  override update(): StateResult {
    const activeCombat = this.isAnimationCombat ? this.animCombat : this.combat;
    if (!activeCombat) return;
    const game = getGame();

    // Use real frame delta for consistent timing across refresh rates
    const realDelta = game.frameDeltaMs ?? FRAMETIME;

    switch (this.phase) {
      case 'combat': {
        // Pass real delta to combat (skip mode is handled inside AnimationCombat)
        const done = activeCombat.update(realDelta);
        if (done) {
          this.results = activeCombat.applyResults();
          // Record combat message for turnwheel
          const atkName = activeCombat.attacker.name;
          const defName = activeCombat.defender.name;
          const isSpell = activeCombat.attackItem?.isSpell?.();
          const isHeal = activeCombat.attackItem?.targetsAllies?.();
          if (isHeal) {
            game.actionLog.doAction(new MessageAction(`${atkName} helped ${defName}`));
          } else if (isSpell) {
            game.actionLog.doAction(new MessageAction(`${atkName} used ${activeCombat.attackItem?.name ?? 'spell'}`));
          } else {
            game.actionLog.doAction(new MessageAction(`${atkName} attacked ${defName}`));
          }
          if (this.results.attackerDead || this.results.defenderDead) {
            this.phase = 'death';
            this.phaseTimer = 0;
            this.deathFadeProgress = 0;
          } else if (this.results.expGained > 0 && activeCombat.attacker.team === 'player') {
            this.startExpPhase();
          } else {
            this.phase = 'cleanup';
            this.phaseTimer = 0;
          }
        }
        break;
      }

      case 'death': {
        // Death animation: 350ms fade-out
        this.phaseTimer += realDelta;
        this.deathFadeProgress = Math.min(1, this.phaseTimer / 350);
        if (this.phaseTimer >= 350) {
          // Remove dead units from board and initiative tracker
          if (this.results!.defenderDead) {
            if (game.initiative) game.initiative.removeUnit(activeCombat!.defender);
            game.board.removeUnit(activeCombat!.defender);
          }
          if (this.results!.attackerDead) {
            if (game.initiative) game.initiative.removeUnit(activeCombat!.attacker);
            game.board.removeUnit(activeCombat!.attacker);
          }

          // Check if attacker earned EXP
          if (
            !this.results!.attackerDead &&
            this.results!.expGained > 0 &&
            activeCombat!.attacker.team === 'player'
          ) {
            this.startExpPhase();
          } else {
            this.phase = 'cleanup';
            this.phaseTimer = 0;
          }
        }
        break;
      }

      // ---------------------------------------------------------------
      // EXP state machine — faithful port of Python ExpState
      // Phases: exp_init → exp_wait → exp0 → [exp100 →] exp_leave → [level_up → level_screen →] cleanup
      // ---------------------------------------------------------------

      case 'exp_init': {
        // Create the ExpBar, start fade-in
        const isCombatContext = !!this.getActiveCombat();
        this.expBar = new ExpBarClass(this.expOldExp, !isCombatContext);
        this.expStartTime = this.phaseTimer; // Use phaseTimer as accumulated time
        this.phase = 'exp_wait';
        this.phaseTimer = 0;
        break;
      }

      case 'exp_wait': {
        // 466ms pause before bar starts filling. Bar fades in during this time.
        this.phaseTimer += realDelta;
        if (this.expBar) this.expBar.update(this.expOldExp);
        if (this.phaseTimer > 466) {
          this.phase = 'exp0';
          this.phaseTimer = 0;
          // Start looping "Experience Gain" SFX
          game.audioManager?.playSfxLoop?.('Experience Gain');
        }
        break;
      }

      case 'exp0': {
        // Fill bar at 1 frame per EXP point. Linear interpolation.
        this.phaseTimer += realDelta;
        const progress = Math.min(1, this.phaseTimer / this.expTotalTime);
        const expSet = this.expOldExp + progress * this.expGainAmount;
        if (this.expBar) this.expBar.update(expSet);

        // Stop SFX when fill reaches target
        if (Math.floor(expSet) >= this.expOldExp + this.expGainAmount) {
          game.audioManager?.stopSfx?.('Experience Gain');
        }

        // Check if bar reaches 100 (level-up threshold)
        if (Math.floor(expSet) >= 100 && this.expNeedLevelUp) {
          this.phase = 'exp100';
          // Don't reset phaseTimer — continue from current time for smooth animation
          break;
        }

        // Wait extra 500ms after fill completes, then fade out
        if (this.phaseTimer >= this.expTotalTime + 500) {
          game.audioManager?.stopSfx?.('Experience Gain');
          if (this.expBar) this.expBar.fadeOut();
          this.phase = 'exp_leave';
          this.phaseTimer = 0;
        }
        break;
      }

      case 'exp100': {
        // Bar wraps past 100, continues filling from 0 with remaining EXP
        this.phaseTimer += realDelta;
        const progress100 = Math.min(1, this.phaseTimer / this.expTotalTime);
        // Wrap: subtract 100 from the running total
        const expSet100 = this.expOldExp + (this.expGainAmount * progress100) - 100;
        const clampedExp = Math.min(this.expOldExp + this.expGainAmount - 100, expSet100);
        if (this.expBar) this.expBar.update(clampedExp);

        // Stop SFX when fill reaches wrapped target
        if (Math.floor(clampedExp) >= this.expOldExp + this.expGainAmount - 100) {
          game.audioManager?.stopSfx?.('Experience Gain');
        }

        // Wait extra 333ms after fill, then trigger level-up
        if (this.phaseTimer >= this.expTotalTime + 333) {
          // Level-up gains were already computed by applyResults
          if (this.results!.levelUps.length > 0) {
            this.levelUpGains = this.results!.levelUps[0];
          }
          // Fade out the EXP bar
          if (this.expBar) this.expBar.fadeOut();
          // Chain: exp_leave → level_up → level_screen
          this.expNeedLevelUp = true;
          this.phase = 'exp_leave';
          this.phaseTimer = 0;
        }
        break;
      }

      case 'exp_leave': {
        // Fade out the EXP bar (iris close animation)
        if (this.expBar) {
          const fadeDone = this.expBar.update();
          if (fadeDone) {
            // If level-up pending, continue to level_up phase
            if (this.levelUpGains && Object.values(this.levelUpGains).some(v => v !== 0)) {
              this.phase = 'level_up';
              this.phaseTimer = 0;
              this.levelUpSoundPlayed = false;
            } else {
              this.phase = 'cleanup';
              this.phaseTimer = 0;
            }
          }
        } else {
          // No bar — skip directly
          if (this.levelUpGains) {
            this.phase = 'level_up';
            this.phaseTimer = 0;
          } else {
            this.phase = 'cleanup';
            this.phaseTimer = 0;
          }
        }
        break;
      }

      case 'level_up': {
        // Play level-up SFX once, then show dark overlay briefly before going to stat screen
        if (!this.levelUpSoundPlayed) {
          game.audioManager?.playSfx?.('Level Up');
          this.levelUpSoundPlayed = true;
          this.phaseTimer = 0;
        }
        this.phaseTimer += realDelta;
        // Brief pause (500ms) to show the "Level Up" moment with dark overlay,
        // then transition to level_screen
        if (this.phaseTimer >= 500) {
          this.phase = 'level_screen';
          this.phaseTimer = 0;
          // Create the LevelUpScreen
          const activeCombat = this.getActiveCombat();
          const unit = activeCombat?.attacker;
          if (unit && this.levelUpGains) {
            const statDefs = game.db?.stats ?? [];
            this.levelUpScreen = new LevelUpScreenClass(
              unit,
              this.levelUpGains,
              (unit.level - 1), // old level (before the level-up that already happened)
              unit.level,       // new level
              statDefs,
              game.audioManager,
              this.portraitImg,
            );
          }
        }
        break;
      }

      case 'level_screen': {
        // Update the LevelUpScreen animation
        const now = performance.now();
        if (this.levelUpScreen) {
          const done = this.levelUpScreen.update(now);
          if (done) {
            this.phase = 'cleanup';
            this.phaseTimer = 0;
          }
        } else {
          // No screen object — skip
          this.phase = 'cleanup';
          this.phaseTimer = 0;
        }
        break;
      }

      case 'cleanup': {
        const attacker = activeCombat!.attacker;
        const defender = activeCombat!.defender;
        const hasCanto = attacker.hasCanto && attacker.team === 'player' && !attacker.isDead();

        if (!attacker.isDead()) {
          attacker.hasAttacked = true;

          // Check for Canto: if the unit has canto, don't mark as finished
          if (hasCanto) {
            attacker.finished = false;
          } else {
            attacker.finished = true;
          }
        }

        // Fire combat event triggers
        if (game.eventManager) {
          const levelNid = game.currentLevel?.nid;
          const ctx = { game, unit1: attacker, unit2: defender, gameVars: game.gameVars, levelVars: game.levelVars };

          // combat_death for each dead unit
          if (this.results?.defenderDead) {
            game.eventManager.trigger(
              { type: 'combat_death', unit1: defender, unit2: attacker, unitNid: defender.nid, position: defender.position, levelNid },
              { ...ctx, unit1: defender, unit2: attacker },
            );
          }
          if (this.results?.attackerDead) {
            game.eventManager.trigger(
              { type: 'combat_death', unit1: attacker, unit2: defender, unitNid: attacker.nid, position: attacker.position, levelNid },
              { ...ctx, unit1: attacker, unit2: defender },
            );
          }

          // combat_end fires after every combat
          game.eventManager.trigger(
            { type: 'combat_end', unit1: attacker, unit2: defender, levelNid },
            ctx,
          );
        }

        // Activate AI groups if an enemy was involved in combat
        if (game.aiController) {
          game.aiController.activateGroupOnCombat(activeCombat!.attacker, game);
          game.aiController.activateGroupOnCombat(activeCombat!.defender, game);
        }

        // Check win/loss conditions
        // Note: In the original Python engine, loss conditions are handled
        // through the event system (combat_death triggers → lose_game command).
        // This auto-detect is a fallback for cases where events don't fire.
        if (game.checkLossCondition()) {
          console.warn('GAME OVER — loss condition met');
          game.state.clear();
          game.state.change('game_over');
        } else if (game.checkWinCondition()) {
          console.warn('VICTORY — win condition met');
          // TODO: push a VictoryState / trigger level_end event
        }

        // Restore phase music (pop battle music from the stack)
        if (this.didPushBattleMusic) {
          void game.audioManager.popMusic();
          this.didPushBattleMusic = false;
        }

        // Restore cursor and HUD visibility (hidden at combat start)
        game.cursor.visible = true;
        game.hud.visible = true;

        // Clear combat animation offsets
        setActiveCombatOffsets(null);

        this.combat = null;
        this.animCombat = null;
        this.isAnimationCombat = false;
        this.results = null;
        this.leftPlatformImg = null;
        this.rightPlatformImg = null;
        this.battleBackgroundImg = null;

        // Clear eventCombat flag
        const wasEventCombat = game.eventCombat;
        game.eventCombat = false;

        // Pop combat state
        game.state.back();

        // If events were triggered by combat (combat_end, combat_death), push EventState.
        // BUT skip this when combat was triggered from an event (interact_unit) —
        // EventState is already on the stack below and will resume processing.
        // Matches Python's handle_state_stack which does `pass` for event_combat.
        if (!wasEventCombat && game.eventManager?.hasActiveEvents()) {
          game.state.change('event');
        }
        // If Canto, re-enter move state for remaining movement
        else if (!wasEventCombat && hasCanto) {
          game.selectedUnit = attacker;
          game.state.change('move');
        }
        break;
      }
    }
  }

  private startExpPhase(): void {
    const game = getGame();
    // Calculate EXP bar parameters (faithful to Python ExpState.start)
    const totalExp = this.results!.expGained;
    const activeCombat = this.getActiveCombat();
    const currentExp = activeCombat!.attacker.exp;
    const hasLevelUp = this.results!.levelUps.length > 0;

    // Calculate old EXP (before gain was applied by applyResults)
    if (hasLevelUp) {
      // Bar wraps around 100: old_exp = currentExp + 100 - totalExp
      // e.g. had 70 EXP, gained 50 → leveled → now has 20, old was 70
      this.expOldExp = currentExp + 100 - totalExp;
    } else {
      this.expOldExp = currentExp - totalExp;
    }
    this.expGainAmount = totalExp;
    this.expNeedLevelUp = hasLevelUp;

    // 1 frame per EXP point at 60fps = ~16.67ms per point
    this.expTotalTime = Math.max(1, Math.abs(totalExp) * FRAMETIME);

    this.levelUpGains = null;
    this.levelUpScreen = null;
    this.levelUpSoundPlayed = false;
    this.expBar = null;

    // Start loading portrait for potential level-up screen
    if (hasLevelUp && activeCombat?.attacker) {
      const unit = activeCombat.attacker;
      const portraitNid = (unit as any).portraitNid ?? unit.nid;
      game.resources?.loadPortrait?.(portraitNid)?.then?.((img: HTMLImageElement) => {
        this.portraitImg = img;
      })?.catch?.(() => {});
    }

    this.phase = 'exp_init';
    this.phaseTimer = 0;
  }

  override end(): StateResult {
    // Always clear combat animation offsets when this state exits
    setActiveCombatOffsets(null);
    // Stop looping EXP SFX if still playing
    const game = getGame();
    game.audioManager?.stopSfx?.('Experience Gain');
  }

  override draw(surf: Surface): Surface {
    // Route to the appropriate renderer
    if (this.isAnimationCombat && this.animCombat) {
      return this.drawAnimationCombat(surf);
    }
    if (!this.combat) return surf;
    return this.drawMapCombat(surf);
  }

  /** Render map combat: overlays on top of the map (lunge, flash, HP bars, etc.) */
  private drawMapCombat(surf: Surface): Surface {
    const rs = this.combat!.getRenderState();
    const game = getGame();
    const cameraOffset = game.camera.getOffset();

    const atkPos = this.combat!.attacker.position;
    const defPos = this.combat!.defender.position;

    // Push combat animation offsets so collectVisibleUnits applies them
    // to the underlying map render (lunge + shake on the actual sprites)
    const atkLunge = rs.attackerAnim.lungeOffset;
    const atkShake = rs.attackerAnim.shakeOffset;
    const defLunge = rs.defenderAnim.lungeOffset;
    const defShake = rs.defenderAnim.shakeOffset;
    setActiveCombatOffsets({
      attacker: this.combat!.attacker,
      defender: this.combat!.defender,
      attackerOffset: [atkLunge[0] + atkShake[0], atkLunge[1] + atkShake[1]],
      defenderOffset: [defLunge[0] + defShake[0], defLunge[1] + defShake[1]],
    });

    // White flash overlay on hit targets
    if (rs.attackerAnim.flashAlpha > 0 && atkPos) {
      const fx = atkPos[0] * TILEWIDTH - cameraOffset[0];
      const fy = atkPos[1] * TILEHEIGHT - cameraOffset[1];
      surf.fillRect(
        fx - 4, fy - 4,
        TILEWIDTH + 8, TILEHEIGHT + 8,
        `rgba(255,255,255,${rs.attackerAnim.flashAlpha.toFixed(2)})`,
      );
    }
    if (rs.defenderAnim.flashAlpha > 0 && defPos) {
      const fx = defPos[0] * TILEWIDTH - cameraOffset[0];
      const fy = defPos[1] * TILEHEIGHT - cameraOffset[1];
      surf.fillRect(
        fx - 4, fy - 4,
        TILEWIDTH + 8, TILEHEIGHT + 8,
        `rgba(255,255,255,${rs.defenderAnim.flashAlpha.toFixed(2)})`,
      );
    }

    // HP bars (positioned above the unit, accounting for shake/lunge)
    if (atkPos) {
      const atkShakeX = rs.attackerAnim.shakeOffset[0] + rs.attackerAnim.lungeOffset[0];
      const ax = atkPos[0] * TILEWIDTH - cameraOffset[0] + atkShakeX;
      const ay = atkPos[1] * TILEHEIGHT - cameraOffset[1] - 6;
      this.drawHpBar(surf, ax, ay, rs.attackerHp, rs.attackerMaxHp);
    }
    if (defPos) {
      const defShakeX = rs.defenderAnim.shakeOffset[0] + rs.defenderAnim.lungeOffset[0];
      const dx = defPos[0] * TILEWIDTH - cameraOffset[0] + defShakeX;
      const dy = defPos[1] * TILEHEIGHT - cameraOffset[1] - 6;
      this.drawHpBar(surf, dx, dy, rs.defenderHp, rs.defenderMaxHp);
    }

    // Floating damage numbers
    this.drawDamagePopupsMap(surf, rs.damagePopups, cameraOffset);

    // Death fade-out: dim the dying unit's tile with white overlay
    if (this.phase === 'death') {
      const alpha = this.deathFadeProgress * 0.85;
      if (this.results?.defenderDead && defPos) {
        const dx = defPos[0] * TILEWIDTH - cameraOffset[0];
        const dy = defPos[1] * TILEHEIGHT - cameraOffset[1];
        surf.fillRect(dx - 24, dy - 32, 64, 48, `rgba(255,255,255,${alpha.toFixed(2)})`);
      }
      if (this.results?.attackerDead && atkPos) {
        const ax = atkPos[0] * TILEWIDTH - cameraOffset[0];
        const ay = atkPos[1] * TILEHEIGHT - cameraOffset[1];
        surf.fillRect(ax - 24, ay - 32, 64, 48, `rgba(255,255,255,${alpha.toFixed(2)})`);
      }
    }

    // EXP / Level-up overlays (shared with animation combat)
    this.drawExpAndLevelUp(surf);

    return surf;
  }

  // ================================================================
  // Animation Combat Renderer — GBA-style full-screen battle scene
  // ================================================================

  /** Render the GBA-style animation combat scene. */
  private drawAnimationCombat(surf: Surface): Surface {
    // Pass camera offset so the viewbox iris can compute tile-relative positions
    const game = getGame();
    const cameraOffset = game.camera.getOffset();
    this.animCombat!.setCameraOffset(cameraOffset[0], cameraOffset[1]);

    const rs = this.animCombat!.getRenderState();

    // Screen shake (used for background/platforms)
    const shakeX = rs.screenShake[0];
    const shakeY = rs.screenShake[1];

    // Python-faithful sprite shake: sprites get negated total_shake_x (so they
    // move opposite to platforms, creating a ground-rumbling visual effect).
    // Python: shake = (-total_shake_x, total_shake_y)
    const spriteShakeX = -rs.totalShakeX;
    const spriteShakeY = rs.totalShakeY;

    // --- Viewbox iris during fade_in/fade_out ---
    // During transitions, the map is visible and we darken around a shrinking/growing iris.
    if (rs.viewbox) {
      const vb = rs.viewbox;
      // Darken everything outside the viewbox iris
      // Top bar
      if (vb.y > 0) {
        surf.fillRect(0, 0, WINWIDTH, Math.max(0, vb.y), 'rgba(0,0,0,0.75)');
      }
      // Bottom bar
      const botY = vb.y + vb.height;
      if (botY < WINHEIGHT) {
        surf.fillRect(0, botY, WINWIDTH, WINHEIGHT - botY, 'rgba(0,0,0,0.75)');
      }
      // Left bar (between top and bottom bars)
      if (vb.x > 0) {
        surf.fillRect(0, Math.max(0, vb.y), vb.x, Math.max(0, vb.height), 'rgba(0,0,0,0.75)');
      }
      // Right bar
      const rightX = vb.x + vb.width;
      if (rightX < WINWIDTH) {
        surf.fillRect(rightX, Math.max(0, vb.y), WINWIDTH - rightX, Math.max(0, vb.height), 'rgba(0,0,0,0.75)');
      }

      // If still fading in, don't draw the battle scene yet
      if (rs.state === 'fade_in') {
        return surf;
      }
    }

    // --- Full battle scene background ---
    // Once past fade_in, fill the screen with the battle background
    if (rs.state !== 'fade_in') {
      // Dark fallback fill (in case panorama hasn't loaded or is missing)
      surf.fillRect(shakeX, shakeY, WINWIDTH, WINHEIGHT, 'rgb(16,20,32)');
      // Draw the panorama background image if available
      if (this.battleBackgroundImg) {
        const bgW = this.battleBackgroundImg.naturalWidth || WINWIDTH;
        const bgH = this.battleBackgroundImg.naturalHeight || WINHEIGHT;
        surf.drawImageFull(this.battleBackgroundImg, shakeX, shakeY, bgW, bgH);
      }
    }

    // --- Platforms ---
    // GBA-style: left platform on the left, right platform on the right.
    // Melee platforms: 87x40, Ranged: 100x40. Positioned at WINHEIGHT - 72 = 88.
    const isMelee = this.animCombat!.combatRange <= 1;
    const PLAT_W = isMelee ? 87 : 100;
    const PLAT_H = 40;
    const SCENE_FLOOR_Y = WINHEIGHT - 72; // 88

    // Melee: platforms touch at center. Ranged: gap with pan offset.
    // Python formula (mock_combat.py:406-417):
    //   total_shake_x = shake_offset[0] + platform_shake_offset[0]
    //   total_shake_y = shake_offset[1] + platform_shake_offset[1]
    //   if at_range:
    //     left = W/2 - width - 11 - pan_max + total_shake_x + pan_offset
    //     right = W/2 + 11 + pan_max + total_shake_x + pan_offset
    //   else:
    //     left = W/2 - width + total_shake_x
    //     right = W/2 + total_shake_x
    let leftPlatX: number;
    let rightPlatX: number;
    const panMax = this.animCombat!.panConfig?.max ?? 0;
    const platShakeX = rs.totalShakeX;
    const platShakeY = rs.totalShakeY;
    if (isMelee) {
      leftPlatX = Math.floor(WINWIDTH / 2) - PLAT_W + platShakeX;
      rightPlatX = Math.floor(WINWIDTH / 2) + platShakeX;
    } else {
      leftPlatX = Math.floor(WINWIDTH / 2) - PLAT_W - 11 - panMax + platShakeX + rs.panOffset;
      rightPlatX = Math.floor(WINWIDTH / 2) + 11 + panMax + platShakeX + rs.panOffset;
    }
    // Python: top = platform_top + (platform_trans - platform_offset * platform_trans) + total_shake_y
    const leftPlatY = SCENE_FLOOR_Y + rs.leftPlatformY + platShakeY;
    const rightPlatY = SCENE_FLOOR_Y + rs.rightPlatformY + platShakeY;

    // Draw platforms (real images or fallback rectangles)
    if (this.leftPlatformImg) {
      const pw = this.leftPlatformImg.naturalWidth || PLAT_W;
      const ph = this.leftPlatformImg.naturalHeight || PLAT_H;
      surf.drawImageFull(this.leftPlatformImg, leftPlatX, leftPlatY, pw, ph);
    } else {
      surf.fillRect(leftPlatX, leftPlatY, PLAT_W, PLAT_H, 'rgb(60,80,50)');
      surf.fillRect(leftPlatX, leftPlatY, PLAT_W, 2, 'rgb(90,120,70)');
    }
    if (this.rightPlatformImg) {
      // Right platform is drawn horizontally flipped
      const pw = this.rightPlatformImg.naturalWidth || PLAT_W;
      const ph = this.rightPlatformImg.naturalHeight || PLAT_H;
      surf.drawImageFull(this.rightPlatformImg, rightPlatX, rightPlatY, pw, ph, 1, true);
    } else {
      surf.fillRect(rightPlatX, rightPlatY, PLAT_W, PLAT_H, 'rgb(60,80,50)');
      surf.fillRect(rightPlatX, rightPlatY, PLAT_W, 2, 'rgb(90,120,70)');
    }

    // --- Battle sprites ---
    // Draw under-frames, then main frames, then over-frames.
    // Each frame has an offset in 240x160 screen coords + recoil.
    const leftDraw = rs.leftDraw;
    const rightDraw = rs.rightDraw;

    // Helper to draw a single BattleAnimDrawData
    const drawBattleSprite = (
      draw: BattleAnimDrawData,
      fallbackColor: string,
      platformX: number,
      platformY: number,
      rangeOffset: number,
    ) => {
      const alpha = Math.max(0, Math.min(1, draw.opacity / 255));
      if (alpha <= 0) return;

      // Determine canvas composite mode
      const prevComposite = surf.ctx.globalCompositeOperation;
      if (draw.blendMode === 'add') {
        surf.ctx.globalCompositeOperation = 'lighter';
      }

       // Left-side sprites (right=false) need horizontal flip since
      // animation frames are authored facing left (for right-side position).
      const flipSprite = !draw.right;

      // Python-faithful sprite X offset: get_image applies shake + range_offset
      // + pan_offset into a `left` accumulator, then adds shake[0] again for
      // right-side sprites. We replicate this exactly.
      //
      // Python get_image (battle_animation.py:830-846):
      //   left = 0
      //   if not static: left += shake[0] + range_offset
      //   if at_range and not static: left += pan_offset
      //   if right: offset = (offset[0] + shake[0] + left, offset[1] + shake[1])
      //   else:     offset = (WINWIDTH - offset[0] - width + left, offset[1] + shake[1])
      //
      // where shake = (-total_shake_x, total_shake_y)
      let spriteLeft = spriteShakeX + rangeOffset;
      if (rs.isAtRange) {
        spriteLeft += rs.panOffset;
      }

      // Draw under-frame first (behind platform)
      this.drawAnimFrame(surf, draw.underFrame, alpha, spriteShakeX, spriteShakeY, draw.recoilX, flipSprite, spriteLeft, draw.right);

      // Draw main frame
      if (draw.mainFrame) {
        this.drawAnimFrame(surf, draw.mainFrame, alpha, spriteShakeX, spriteShakeY, draw.recoilX, flipSprite, spriteLeft, draw.right);
      } else {
        // Stub placeholder: colored rectangle on the platform
        const STUB_W = 32;
        const STUB_H = 40;
        const stubX = platformX + (PLAT_W - STUB_W) / 2;
        const stubY = platformY - STUB_H;
        surf.fillRect(stubX, stubY, STUB_W, STUB_H, `rgba(${fallbackColor},${alpha.toFixed(2)})`);
        surf.fillRect(stubX + STUB_W / 2 - 4, stubY + 2, 8, 8, `rgba(200,180,150,${alpha.toFixed(2)})`);
      }

      // Draw over-frame on top
      this.drawAnimFrame(surf, draw.overFrame, alpha, spriteShakeX, spriteShakeY, draw.recoilX, flipSprite, spriteLeft, draw.right);

      // Death flash: white overlay
      if (draw.deathFlash && draw.mainFrame) {
        const f = draw.mainFrame;
        surf.fillRect(
          f.offset[0] + spriteShakeX + draw.recoilX,
          f.offset[1] + spriteShakeY,
          (f.image as HTMLCanvasElement).width ?? 32,
          (f.image as HTMLCanvasElement).height ?? 40,
          'rgba(255,255,255,0.9)',
        );
      }

      // Tints
      for (const tint of draw.tints) {
        if (tint.alpha > 0 && draw.mainFrame) {
          const f = draw.mainFrame;
          const [tr, tg, tb] = tint.color;
          surf.fillRect(
            f.offset[0] + spriteShakeX + draw.recoilX,
            f.offset[1] + spriteShakeY,
            (f.image as HTMLCanvasElement).width ?? 32,
            (f.image as HTMLCanvasElement).height ?? 40,
            `rgba(${tr},${tg},${tb},${(tint.alpha * 0.5).toFixed(2)})`,
          );
        }
      }

      // Draw child effects (under first, then over)
      for (const ue of draw.underEffects) {
        drawBattleSprite(ue, fallbackColor, platformX, platformY, rangeOffset);
      }
      for (const e of draw.effects) {
        drawBattleSprite(e, fallbackColor, platformX, platformY, rangeOffset);
      }

      // Restore composite mode
      surf.ctx.globalCompositeOperation = prevComposite;
    };

    // Draw left combatant (Python: left_range_offset = -24 - pan_max for ranged, 0 for melee)
    drawBattleSprite(leftDraw, '80,120,200', leftPlatX, leftPlatY, rs.leftRangeOffset);
    // Draw right combatant (Python: right_range_offset = 24 + pan_max for ranged, 0 for melee)
    drawBattleSprite(rightDraw, '200,80,80', rightPlatX, rightPlatY, rs.rightRangeOffset);

    // --- Name tags ---
    // --- Name tags (top of screen, matching Python layout) ---
    // Python: name tags slide in from y=-60, visible at y=0.
    // Left name tag at x=-3, right name tag right-aligned.
    // Python sprite is ~66x16 pixels.
    const nameSlide = rs.nameTagProgress;
    if (nameSlide > 0) {
      const NAME_TAG_W = 66;
      const NAME_TAG_H = 16;
      // Slide in from above: Python uses top = -60 + name_offset * 60
      const nameY = -60 + nameSlide * 60 + shakeY;
      const leftNameX = -3 + shakeX;
      const rightNameX = WINWIDTH + 3 - NAME_TAG_W + shakeX;

      // Left name tag background (blue tint for player/left)
      surf.fillRect(leftNameX, nameY, NAME_TAG_W, NAME_TAG_H, 'rgba(32,32,64,0.9)');
      surf.drawRect(leftNameX, nameY, NAME_TAG_W, NAME_TAG_H, 'rgba(100,100,160,0.7)');
      // Center name text within tag (Python: HAlignment.CENTER at (30,8)/(36,8))
      // Use approximate char width for monospace font centering
      const charW = 5; // ~5px per char for 8px monospace
      const leftNameW = rs.leftHp.name.length * charW;
      surf.drawText(rs.leftHp.name, leftNameX + Math.floor((NAME_TAG_W - leftNameW) / 2), nameY + 4, 'white', '8px monospace');

      // Right name tag background (red tint for enemy/right)
      surf.fillRect(rightNameX, nameY, NAME_TAG_W, NAME_TAG_H, 'rgba(64,32,32,0.9)');
      surf.drawRect(rightNameX, nameY, NAME_TAG_W, NAME_TAG_H, 'rgba(160,100,100,0.7)');
      const rightNameW = rs.rightHp.name.length * charW;
      surf.drawText(rs.rightHp.name, rightNameX + Math.floor((NAME_TAG_W - rightNameW) / 2), nameY + 4, 'white', '8px monospace');
    }

    // --- HP bars (bottom of screen, matching Python layout) ---
    // Python: bars slide up from 52px below, visible at y=WINHEIGHT-barH.
    // Left bar at x=-3, right bar at x=WINWIDTH/2.
    // Python bar is 40px tall (no crit) or 48px (with crit), positioned at WINHEIGHT - barH.
    const hpSlide = rs.hpBarProgress;
    if (hpSlide > 0) {
      const HP_BAR_W = WINWIDTH / 2 + 3; // Each bar covers half the screen
      const HP_BAR_H = 40; // Matching Python's combat_main sprite height (no crit)
      // Bottom anchor: slide up from below screen
      const hpY = WINHEIGHT + (1 - hpSlide) * 52 - HP_BAR_H + shakeY;
      const leftHpX = -3 + shakeX;
      const rightHpX = WINWIDTH / 2 + shakeX;

      // Left HP bar
      this.drawBattleHpBar(surf, leftHpX, hpY, HP_BAR_W, HP_BAR_H, rs.leftHp);
      // Right HP bar
      this.drawBattleHpBar(surf, rightHpX, hpY, HP_BAR_W, HP_BAR_H, rs.rightHp);
    }

    // --- Spark effects ---
    for (const spark of rs.sparks) {
      const t = spark.elapsed / spark.duration;

      // Position spark at the defender's platform center
      const sparkBaseX = spark.isLeft
        ? leftPlatX + PLAT_W / 2
        : rightPlatX + PLAT_W / 2;
      const sparkBaseY = spark.isLeft ? leftPlatY - 16 : rightPlatY - 16;

      if (spark.type === 'hit') {
        // Burst of radiating particles
        const numParticles = 8;
        const alpha = Math.max(0, 1 - t * 1.5);
        for (let i = 0; i < numParticles; i++) {
          const angle = (i / numParticles) * Math.PI * 2;
          const dist = t * 20;
          const px = sparkBaseX + Math.cos(angle) * dist;
          const py = sparkBaseY + Math.sin(angle) * dist;
          const size = Math.max(1, 3 * (1 - t));
          surf.fillRect(px - size / 2, py - size / 2, size, size, `rgba(255,255,200,${alpha.toFixed(2)})`);
        }
      } else if (spark.type === 'crit') {
        // Dramatic crit flash + large particle burst
        const alpha = Math.max(0, 1 - t);
        if (t < 0.15) {
          // Initial flash
          const flashAlpha = (1 - t / 0.15) * 0.6;
          surf.fillRect(0, 0, WINWIDTH, WINHEIGHT, `rgba(255,255,255,${flashAlpha.toFixed(2)})`);
        }
        const numParticles = 16;
        for (let i = 0; i < numParticles; i++) {
          const angle = (i / numParticles) * Math.PI * 2 + t * 2;
          const dist = t * 35;
          const px = sparkBaseX + Math.cos(angle) * dist;
          const py = sparkBaseY + Math.sin(angle) * dist;
          const size = Math.max(1, 4 * (1 - t));
          surf.fillRect(px - size / 2, py - size / 2, size, size, `rgba(255,255,128,${alpha.toFixed(2)})`);
        }
      } else if (spark.type === 'noDamage') {
        // Small blue "ping"
        const alpha = Math.max(0, 1 - t * 2);
        const radius = t * 10 + 2;
        // Draw as a small ring approximation
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2;
          const px = sparkBaseX + Math.cos(angle) * radius;
          const py = sparkBaseY + Math.sin(angle) * radius;
          surf.fillRect(px, py, 2, 2, `rgba(100,160,255,${alpha.toFixed(2)})`);
        }
      }
      // 'miss' is handled by damage popups already
    }

    // --- Damage popups (in battle scene space) with bounce physics ---
    for (const popup of rs.damagePopups) {
      const t = popup.elapsed; // time in ms

      // Position popups centered above the platform the hit landed on
      const isLeftSide = popup.x < WINWIDTH / (2 * TILEWIDTH);
      const popupBaseX = isLeftSide ? leftPlatX + PLAT_W / 2 : rightPlatX + PLAT_W / 2;
      const popupBaseY = isLeftSide ? leftPlatY - 24 : rightPlatY - 24;

      // Bounce physics: damped sine wave (3-phase animation)
      let floatY = 0;
      let alpha = 1;

      if (t < 400) {
        // Phase 0: Bounce (damped sine wave)
        floatY = -10 * Math.exp(-t / 250) * Math.sin(t / 25);
        alpha = Math.min(1, t / 100); // Fade in over first 100ms
      } else if (t < 1000) {
        // Phase 1: Pause (sit still)
        floatY = 0;
        alpha = 1;
      } else {
        // Phase 2: Fade out (drift upward)
        const fadeT = t - 1000;
        floatY = -fadeT / 15;
        alpha = Math.max(0, 1 - fadeT / 200);
      }

      if (popup.value === 0) {
        surf.drawText(
          'Miss', popupBaseX - 8, popupBaseY + floatY,
          `rgba(200,200,255,${alpha.toFixed(2)})`, '7px monospace',
        );
      } else {
        const text = popup.isCrit ? `${popup.value}!` : `${popup.value}`;
        const color = popup.isCrit
          ? `rgba(255,255,64,${alpha.toFixed(2)})`
          : `rgba(255,64,64,${alpha.toFixed(2)})`;
        const font = popup.isCrit ? '9px monospace' : '8px monospace';
        surf.drawText(text, popupBaseX - 4, popupBaseY + floatY, color, font);
      }
    }

    // --- Screen blend overlay ---
    if (rs.screenBlend) {
      const [r, g, b] = rs.screenBlend.color;
      surf.fillRect(
        0, 0, WINWIDTH, WINHEIGHT,
        `rgba(${r},${g},${b},${rs.screenBlend.alpha.toFixed(2)})`,
      );
    }

    // --- Fade-out iris ---
    if (rs.state === 'fade_out' && rs.viewbox) {
      const vb = rs.viewbox;
      // Draw black bars closing in
      if (vb.y > 0) surf.fillRect(0, 0, WINWIDTH, vb.y, 'rgb(0,0,0)');
      const botY = vb.y + vb.height;
      if (botY < WINHEIGHT) surf.fillRect(0, botY, WINWIDTH, WINHEIGHT - botY, 'rgb(0,0,0)');
      if (vb.x > 0) surf.fillRect(0, vb.y, vb.x, vb.height, 'rgb(0,0,0)');
      const rightX = vb.x + vb.width;
      if (rightX < WINWIDTH) surf.fillRect(rightX, vb.y, WINWIDTH - rightX, vb.height, 'rgb(0,0,0)');
    }

    // EXP / Level-up overlays (shared)
    this.drawExpAndLevelUp(surf);

    return surf;
  }

  /** Draw a battle-scene HP bar (used in animation combat).
   *  Compact layout matching GBA Python reference (40px height):
   *  Row 0: Weapon name (centered, y+2)
   *  Row 1-2: HIT / DMG labels + values (y+12, y+19)
   *  Row 3: HP number (left) + HP bar (right, y+28) */
  private drawBattleHpBar(
    surf: Surface,
    x: number,
    y: number,
    width: number,
    height: number,
    hp: { current: number; max: number; name: string; weapon: string; hit: number | null; damage: number | null; crit: number | null },
  ): void {
    // Background
    surf.fillRect(x, y, width, height, 'rgba(16,16,40,0.9)');
    surf.drawRect(x, y, width, height, 'rgba(100,100,160,0.8)');

    // Inset the content area to avoid drawing at the panel edges
    const pad = 3;
    const innerX = x + pad;
    const innerW = width - pad * 2;
    const valueRightX = x + width - pad;

    // --- Row 0: Weapon name (top, centered) ---
    const weaponFont = '7px monospace';
    const weaponCharW = 4; // approximate char width for 7px monospace
    const weaponW = hp.weapon.length * weaponCharW;
    surf.drawText(hp.weapon, innerX + Math.floor((innerW - weaponW) / 2), y + 2, 'rgba(220,220,255,1)', weaponFont);

    // --- Rows 1-2: Combat stats (HIT / DMG) ---
    const statFont = '6px monospace';
    const statLabelColor = 'rgba(140,140,180,1)';
    const statValueColor = 'rgba(255,255,255,1)';
    let statY = y + 11;

    // HIT
    surf.drawText('HIT', innerX, statY, statLabelColor, statFont);
    const hitStr = hp.hit !== null ? `${hp.hit}` : '--';
    surf.drawTextRight(hitStr, valueRightX, statY, statValueColor, statFont);
    statY += 7;

    // DMG
    surf.drawText('DMG', innerX, statY, statLabelColor, statFont);
    const dmgStr = hp.damage !== null ? `${hp.damage}` : '--';
    surf.drawTextRight(dmgStr, valueRightX, statY, statValueColor, statFont);

    // --- Row 3: HP number (left) + HP bar (right) ---
    const barX = innerX + 16;
    const barY = y + height - 9;
    const barW = innerW - 16;
    const barH = 5; // Matching Python's blip height
    const ratio = hp.max > 0 ? Math.max(0, Math.min(1, hp.current / hp.max)) : 0;

    // HP number to the left of the bar
    surf.drawTextRight(`${hp.current}`, barX - 2, barY - 1, 'white', '6px monospace');

    surf.fillRect(barX, barY, barW, barH, 'rgba(32,32,32,1)');
    let color: string;
    if (ratio > 0.5) color = 'rgba(64,200,64,1)';
    else if (ratio > 0.25) color = 'rgba(220,200,32,1)';
    else color = 'rgba(220,48,48,1)';
    const filled = Math.round(barW * ratio);
    if (filled > 0) surf.fillRect(barX, barY, filled, barH, color);
    surf.drawRect(barX, barY, barW, barH, 'rgba(120,120,140,0.8)');
  }

  /** Draw damage popups for map combat (tile-space positions). */
  private drawDamagePopupsMap(
    surf: Surface,
    popups: Array<{ x: number; y: number; value: number; isCrit: boolean; elapsed: number; duration: number }>,
    cameraOffset: [number, number],
  ): void {
    for (const popup of popups) {
      const t = popup.elapsed / popup.duration;
      const floatY = -12 * t;
      const alpha = Math.max(0, 1 - t * 1.2);
      const px = popup.x * TILEWIDTH - cameraOffset[0] + TILEWIDTH / 2;
      const py = popup.y * TILEHEIGHT - cameraOffset[1] + floatY - 4;

      if (popup.value === 0) {
        surf.drawText('Miss', px - 8, py, `rgba(200,200,255,${alpha.toFixed(2)})`, '7px monospace');
      } else {
        const text = popup.isCrit ? `${popup.value}!` : `${popup.value}`;
        const color = popup.isCrit
          ? `rgba(255,255,64,${alpha.toFixed(2)})`
          : `rgba(255,255,255,${alpha.toFixed(2)})`;
        const font = popup.isCrit ? '9px monospace' : '8px monospace';
        surf.drawText(text, px - 4, py, color, font);
      }
    }
  }

  /** Draw EXP bar and level-up stats (shared between map and animation combat). */
  private drawExpAndLevelUp(surf: Surface): void {
    // Draw EXP bar during all exp sub-phases
    const expPhases = ['exp_init', 'exp_wait', 'exp0', 'exp100', 'exp_leave'];
    if (expPhases.includes(this.phase)) {
      if (this.expBar) {
        this.expBar.draw(surf);
      }
    }

    // Dark overlay during level_up phase (before stat screen)
    if (this.phase === 'level_up') {
      surf.fillRect(0, 0, WINWIDTH, WINHEIGHT, `rgba(0,0,0,${this.darkFuzzAlpha.toFixed(2)})`);
    }

    // Level-up stat screen
    if (this.phase === 'level_screen' && this.levelUpScreen) {
      this.levelUpScreen.draw(surf, performance.now());
    }
  }

  /**
   * Draw a single animation frame (mainFrame/underFrame/overFrame) from
   * BattleAnimDrawData onto the battle scene surface.
   *
   * Frame offsets are in 240x160 screen space. The image is an
   * HTMLCanvasElement (palette-converted frame) or ImageBitmap.
   *
   * Python-faithful positioning (battle_animation.py:830-846):
   *   For right-side: final_x = offset[0] + shake[0] + left
   *   For left-side:  final_x = WINWIDTH - offset[0] - width + left
   *   where left = shake[0] + range_offset + pan_offset (the `spriteLeft` param)
   *
   * Note: resolveFrame already handles the left-side mirroring
   * (WINWIDTH - ox - frameWidth), so for left-side sprites the offset is
   * already mirrored. We just need to add spriteLeft (which includes
   * shake + range + pan) and for right-side sprites, also add shake[0].
   */
  private drawAnimFrame(
    surf: Surface,
    frame: { image: ImageBitmap | HTMLCanvasElement; offset: [number, number] } | null,
    alpha: number,
    spriteShakeX: number,
    spriteShakeY: number,
    recoilX: number,
    flipH: boolean = false,
    spriteLeft: number = 0,
    isRight: boolean = true,
  ): void {
    if (!frame) return;

    const img = frame.image;
    // Python: right side gets shake[0] + left; left side gets just left
    // (because left-side mirroring in resolveFrame already handles the base offset)
    const ox = isRight
      ? frame.offset[0] + spriteShakeX + spriteLeft + recoilX
      : frame.offset[0] + spriteLeft + recoilX;
    const oy = frame.offset[1] + spriteShakeY;

    const srcW = (img as HTMLCanvasElement).width ?? 32;
    const srcH = (img as HTMLCanvasElement).height ?? 40;
    surf.drawImageFull(img, ox, oy, srcW, srcH, alpha, flipH);
  }

  private drawHpBar(
    surf: Surface,
    x: number,
    y: number,
    current: number,
    max: number,
  ): void {
    const width = TILEWIDTH;
    const height = 4;
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;

    // Background
    surf.fillRect(x, y, width, height, 'rgba(32,32,32,0.8)');
    // Filled portion
    let color: string;
    if (ratio > 0.5) {
      color = 'rgba(64,200,64,1)';
    } else if (ratio > 0.25) {
      color = 'rgba(220,200,32,1)';
    } else {
      color = 'rgba(220,48,48,1)';
    }
    const filled = Math.round(width * ratio);
    if (filled > 0) {
      surf.fillRect(x, y, filled, height, color);
    }
    // Border
    surf.drawRect(x, y, width, height, 'rgba(120,120,120,0.8)');
  }

}

// ============================================================================
// 7. AIState
// ============================================================================

export class AIState extends MapState {
  readonly name = 'ai';

  private aiUnits: UnitObject[] = [];
  private currentAiIndex: number = 0;
  private frameCounter: number = 0;
  private processing: boolean = false;
  private waitingForCombat: boolean = false;
  private waitingForMovement: boolean = false;
  private waitingForEvent: boolean = false;
  private pendingCombatTarget: UnitObject | null = null;
  private pendingCombatWeapon: ItemObject | null = null;

  override begin(): StateResult {
    const game = getGame();

    // Initiative mode: only process the single current initiative unit
    if (game.initiative) {
      const unitNid = game.initiative.getCurrentUnitNid();
      if (unitNid) {
        const unit = game.getUnit(unitNid);
        if (unit && unit.position && !unit.finished && !unit.isDead()) {
          this.aiUnits = [unit];
        } else {
          this.aiUnits = [];
        }
      } else {
        this.aiUnits = [];
      }
    } else {
      // Standard mode: gather all units for the current team
      const currentTeam = game.phase.getCurrent();
      const candidates = (Array.from(game.units.values()) as UnitObject[])
        .filter((u) => u.team === currentTeam && !!u.position
          && !u.isDead() && u.canStillAct() && game.isAiGroupActive(u.aiGroup));
      this.aiUnits = game.aiController.orderUnitsForTurn(candidates);
    }

    this.currentAiIndex = 0;
    this.frameCounter = 0;
    this.processing = false;
    this.waitingForCombat = false;
    this.waitingForMovement = false;
    this.waitingForEvent = false;
    this.pendingCombatTarget = null;
    this.pendingCombatWeapon = null;

    game.cursor.visible = false;
  }

  override update(): StateResult {
    const game = getGame();

    // Wait for combat animation (CombatState) to finish.
    // CombatState pops itself via back(), which returns control here.
    if (this.waitingForCombat) {
      // CombatState is transparent and sits on top of us. If it has
      // popped, we are now the top state and can advance.
      // We detect this by checking if we're still waiting — CombatState
      // sets attacker.hasAttacked and attacker.finished in its cleanup.
      // Also check hasAttacked to handle canto units (finished=false but
      // hasAttacked=true).
      const unit = this.aiUnits[this.currentAiIndex];
      if (unit && (unit.finished || unit.isDead() || unit.hasAttacked)) {
        this.waitingForCombat = false;
        // AI units with canto should still be marked finished
        if (unit.hasAttacked && !unit.finished && !unit.isDead()) {
          unit.finished = true;
        }
        this.advanceToNextUnit();
      }
      return;
    }

    // Wait for movement animations to finish
    if (this.waitingForMovement) {
      if (!game.movementSystem.isMoving()) {
        this.waitingForMovement = false;
      }
      return;
    }

    // Wait for event (from interact action) to finish
    if (this.waitingForEvent) {
      if (!game.eventManager?.hasActiveEvents()) {
        this.waitingForEvent = false;
        this.advanceToNextUnit();
      }
      return;
    }

    if (this.currentAiIndex >= this.aiUnits.length) {
      // All AI units processed — advance to turn change
      game.state.change('turn_change');
      return;
    }

    // Process one AI unit with a short delay between each.
    // SELECT (Enter/Z) fast-forwards by reducing the delay to 1 frame.
    const fastForward = game.input?.isPressed('SELECT') ?? false;
    const aiDelay = fastForward ? 1 : 6; // ~100ms normal, ~16ms when holding SELECT
    this.frameCounter++;
    if (this.frameCounter < aiDelay) return;
    this.frameCounter = 0;

    const unit = this.aiUnits[this.currentAiIndex];
    if (!unit || unit.isDead() || !unit.canStillAct()) {
      this.advanceToNextUnit();
      return;
    }

    // Mark start of AI unit's action group (turnwheel marker)
    game.actionLog.doAction(new MarkActionGroupStart(unit, 'ai'));

    // Get AI decision
    const action = game.aiController.getAction(unit);

    switch (action.type) {
      case 'attack': {
        if (action.targetPosition && action.targetUnit) {
          // Move unit to attack position
          const prevPos: [number, number] | null = unit.position
            ? [unit.position[0], unit.position[1]]
            : null;

          if (
            action.movePath &&
            action.movePath.length > 1 &&
            prevPos &&
            (action.targetPosition[0] !== prevPos[0] ||
              action.targetPosition[1] !== prevPos[1])
          ) {
            // Animate movement
            game.board.moveUnit(
              unit,
              action.targetPosition[0],
              action.targetPosition[1],
            );
            game.camera.focusTile(
              action.targetPosition[0],
              action.targetPosition[1],
            );

            this.waitingForMovement = true;
            this.pendingCombatTarget = action.targetUnit!;
            this.pendingCombatWeapon = action.item!;
            game.movementSystem.beginMove(
              unit,
              action.movePath,
              undefined,
              () => {
                // Movement done — now push CombatState for animated combat
                this.beginAICombat(unit, this.pendingCombatTarget!, this.pendingCombatWeapon!);
              },
            );
          } else {
            // Already at position, attack directly
            if (action.targetPosition) {
              game.board.moveUnit(
                unit,
                action.targetPosition[0],
                action.targetPosition[1],
              );
            }
            this.beginAICombat(
              unit,
              action.targetUnit!,
              action.item!,
            );
          }
        } else {
          unit.finished = true;
          this.advanceToNextUnit();
        }
        break;
      }

      case 'move': {
        if (action.targetPosition) {
          const prevPos: [number, number] | null = unit.position
            ? [unit.position[0], unit.position[1]]
            : null;

          game.board.moveUnit(
            unit,
            action.targetPosition[0],
            action.targetPosition[1],
          );
          game.camera.focusTile(
            action.targetPosition[0],
            action.targetPosition[1],
          );

          if (action.movePath && action.movePath.length > 1 && prevPos) {
            this.waitingForMovement = true;
            game.movementSystem.beginMove(unit, action.movePath, undefined, () => {
              unit.finished = true;
              this.waitingForMovement = false;
              this.advanceToNextUnit();
            });
          } else {
            unit.hasMoved = true;
            unit.finished = true;
            this.advanceToNextUnit();
          }
        } else {
          unit.finished = true;
          this.advanceToNextUnit();
        }
        break;
      }

      case 'use_item': {
        // AI uses a consumable item (Vulnerary, Elixir, etc.)
        // Move to position first, then apply item effect
        if (action.targetPosition && action.item) {
          const prevPos: [number, number] | null = unit.position
            ? [unit.position[0], unit.position[1]]
            : null;

          const applyItem = () => {
            const item = action.item!;
            // Apply healing
            if (item.isHealing()) {
              const healAmount = item.getHealAmount();
              unit.currentHp = Math.min(unit.maxHp, unit.currentHp + healAmount);
            }
            // Decrement uses
            const broken = item.decrementUses();
            if (broken) {
              const itemIdx = unit.items.indexOf(item);
              if (itemIdx !== -1) unit.items.splice(itemIdx, 1);
            }
            unit.finished = true;
            this.advanceToNextUnit();
          };

          if (
            action.movePath &&
            action.movePath.length > 1 &&
            prevPos &&
            (action.targetPosition[0] !== prevPos[0] ||
              action.targetPosition[1] !== prevPos[1])
          ) {
            game.board.moveUnit(
              unit,
              action.targetPosition[0],
              action.targetPosition[1],
            );
            game.camera.focusTile(
              action.targetPosition[0],
              action.targetPosition[1],
            );
            this.waitingForMovement = true;
            game.movementSystem.beginMove(unit, action.movePath, undefined, () => {
              this.waitingForMovement = false;
              applyItem();
            });
          } else {
            if (action.targetPosition) {
              game.board.moveUnit(
                unit,
                action.targetPosition[0],
                action.targetPosition[1],
              );
            }
            applyItem();
          }
        } else {
          unit.finished = true;
          this.advanceToNextUnit();
        }
        break;
      }

      case 'interact': {
        // AI interacting with a region (e.g., destroying a village)
        if (action.targetPosition) {
          const prevPos: [number, number] | null = unit.position
            ? [unit.position[0], unit.position[1]]
            : null;

          const triggerInteract = () => {
            // Find the region at the target position
            const regionNid = action.regionNid;
            const regionSubNid = action.regionSubNid ?? '';
            const regions = game.currentLevel?.regions ?? [];
            const region = regionNid
              ? regions.find((r: any) => r.nid === regionNid)
              : regions.find((r: any) =>
                  r.region_type === 'event' &&
                  r.sub_nid === regionSubNid &&
                  action.targetPosition![0] >= r.position[0] &&
                  action.targetPosition![0] < r.position[0] + (r.size?.[0] ?? 1) &&
                  action.targetPosition![1] >= r.position[1] &&
                  action.targetPosition![1] < r.position[1] + (r.size?.[1] ?? 1),
                );

            if (region && game.eventManager) {
              // Build context for event trigger
              const ctx = {
                game,
                unit1: unit,
                position: action.targetPosition,
                region,
                gameVars: game.gameVars,
                levelVars: game.levelVars,
              };

              // Try RegionTrigger (uses sub_nid as trigger type, e.g., 'Destructible')
              let triggered = game.eventManager.trigger(
                { type: region.sub_nid, unit1: unit, position: action.targetPosition, region, levelNid: game.currentLevel?.nid },
                ctx,
              );

              // Compatibility fallback for destructible village events that
              // reference sibling "VillageX" region NIDs.
              if (!triggered && region.sub_nid === 'Destructible' && region.nid?.startsWith('Destroy')) {
                const aliasNid = region.nid.replace(/^Destroy/, '');
                const aliasRegion = regions.find((r: any) => r.nid === aliasNid);
                if (aliasRegion) {
                  const aliasCtx = {
                    game,
                    unit1: unit,
                    position: action.targetPosition,
                    region: aliasRegion,
                    gameVars: game.gameVars,
                    levelVars: game.levelVars,
                  };
                  triggered = game.eventManager.trigger(
                    { type: aliasRegion.sub_nid ?? region.sub_nid, unit1: unit, position: action.targetPosition, region: aliasRegion, levelNid: game.currentLevel?.nid },
                    aliasCtx,
                  );
                }
              }

              // Fallback to generic on_region_interact
              if (!triggered) {
                triggered = game.eventManager.trigger(
                  { type: 'on_region_interact', unit1: unit, position: action.targetPosition, region, levelNid: game.currentLevel?.nid },
                  ctx,
                );
              }

              // Match Python LT: consume the selected one-shot region only.
              // Event commands decide whether a co-located sibling is removed.
              if (triggered && region.only_once) {
                for (let i = regions.length - 1; i >= 0; i--) {
                  const candidate = regions[i];
                  if (candidate === region) regions.splice(i, 1);
                }
              }

              // Push EventState if events were triggered
              if (triggered && game.eventManager.hasActiveEvents()) {
                this.waitingForEvent = true;
                game.state.change('event');
              }
            }

            unit.hasAttacked = true;
            unit.finished = true;
            if (!this.waitingForEvent) {
              this.advanceToNextUnit();
            }
          };

          if (
            action.movePath &&
            action.movePath.length > 1 &&
            prevPos &&
            (action.targetPosition[0] !== prevPos[0] ||
              action.targetPosition[1] !== prevPos[1])
          ) {
            // Move first, then interact
            game.board.moveUnit(
              unit,
              action.targetPosition[0],
              action.targetPosition[1],
            );
            game.camera.focusTile(
              action.targetPosition[0],
              action.targetPosition[1],
            );
            this.waitingForMovement = true;
            game.movementSystem.beginMove(unit, action.movePath, undefined, () => {
              this.waitingForMovement = false;
              triggerInteract();
            });
          } else {
            if (action.targetPosition) {
              game.board.moveUnit(
                unit,
                action.targetPosition[0],
                action.targetPosition[1],
              );
            }
            triggerInteract();
          }
        } else {
          unit.finished = true;
          this.advanceToNextUnit();
        }
        break;
      }

      case 'wait':
      default:
        unit.finished = true;
        this.advanceToNextUnit();
        break;
    }
  }

  /**
   * Push CombatState onto the state machine so the AI combat plays
   * with the same animations (lunge, shake, HP drain, death fade, EXP)
   * that the player sees. CombatState reads game.selectedUnit and
   * game.combatTarget, then pops itself when done. AIState.update()
   * detects the pop via waitingForCombat and advances to the next unit.
   */
  private beginAICombat(
    attacker: UnitObject,
    defender: UnitObject,
    weapon: ItemObject,
  ): void {
    const game = getGame();

    // Persist the AI's selected weapon without reordering inventory, matching
    // Python LT's EquipItem action.
    attacker.equipWeapon(weapon);

    // CombatState.begin() reads these to set up the MapCombat instance
    game.selectedUnit = attacker;
    game.combatTarget = defender;

    this.waitingForCombat = true;
    this.waitingForMovement = false;

    // Push CombatState on top of AIState (CombatState is transparent,
    // so AIState.draw() still runs underneath).
    game.state.change('combat');
  }

  private advanceToNextUnit(): void {
    const game = getGame();
    // Mark end of AI unit's action group (turnwheel marker)
    game.actionLog.doAction(new MarkActionGroupEnd('ai'));
    this.currentAiIndex++;
    this.frameCounter = 0;
    this.waitingForCombat = false;
  }

  override draw(surf: Surface): Surface {
    surf = drawMap(surf, false);

    // Show current AI unit indicator — but NOT when combat is in progress
    // (CombatState is transparent and draws on top, so the red rect would
    // bleed through the viewbox iris during animation combat)
    if (!this.waitingForCombat) {
      const game = getGame();
      if (this.currentAiIndex < this.aiUnits.length) {
        const unit = this.aiUnits[this.currentAiIndex];
        if (unit && unit.position) {
          const cameraOffset = game.camera.getOffset();
          const ux = unit.position[0] * TILEWIDTH - cameraOffset[0];
          const uy = unit.position[1] * TILEHEIGHT - cameraOffset[1];
          surf.drawRect(ux, uy, TILEWIDTH, TILEHEIGHT, 'rgba(255,80,80,0.8)', 2);
        }
      }
    }
    return surf;
  }
}

// ============================================================================
// 8. TurnChangeState
// ============================================================================

export class TurnChangeState extends State {
  readonly name = 'turn_change';

  override begin(): StateResult {
    const game = getGame();

    // --- Initiative mode ---
    // Python: TurnChangeState.begin() calls refresh() + back() -> 'repeat'
    // Then TurnChangeState.end() does the real work. We do both in begin()
    // since our state machine doesn't call end() on back().
    if (game.initiative) {
      // Handle end-turn supports for initiative (player unit ending turn)
      const curUnitNid = game.initiative.getCurrentUnitNid();
      if (curUnitNid) {
        const curUnit = game.getUnit(curUnitNid);
        if (curUnit && curUnit.team === 'player' && game.supports) {
          game.supports.incrementEndTurnSupports?.(curUnit);
        }
      }

      // Save cursor position to memory
      game.memory.set('previous_cursor_position', game.cursor.getPosition());

      // Advance initiative to next unit
      game.initiative.next();

      // If we wrapped back to the start, increment the turn counter
      if (game.initiative.atStart()) {
        game.turnCount++;
        if (game.phase) {
          game.phase.turnCount = game.turnCount;
        }
        // Fire turn_change event
        if (game.eventManager) {
          const ctx = { game, gameVars: game.gameVars, levelVars: game.levelVars };
          game.eventManager.trigger(
            { type: 'turn_change', turnCount: game.turnCount, levelNid: game.currentLevel?.nid },
            ctx,
          );
        }
      }

      // Clear the state stack and push initiative_upkeep
      game.state.clear();
      game.state.change('initiative_upkeep');

      return 'repeat';
    }

    // --- Standard phase mode ---

    // Handle end-turn supports for standard mode
    if (game.phase?.getCurrent() === 'player' && game.supports) {
      game.supports.incrementEndTurnSupportsForTeam?.('player');
    }
    game.memory.set('previous_cursor_position', game.cursor.getPosition());

    // Advance to next phase
    game.phase.next((team: string) => game.board.getTeamUnits(team));

    // Sync turnCount to GameState so event conditions like
    // "game.turncount == 2" resolve correctly
    game.turnCount = game.phase.turnCount;

    const currentTeam = game.phase.getCurrent();
    const turnCount = game.phase.turnCount;
    const levelNid = game.currentLevel?.nid;

    // Clear highlights before clearing the state stack (the clear() calls
    // finish() not end(), so FreeState.end() won't run to clean up highlights)
    game.highlight.clear();

    // Clear the entire state stack to prevent unbounded growth,
    // then push the appropriate states fresh.
    game.state.clear();

    if (currentTeam === 'player') {
      // Player phase: push free, then phase banner on top
      game.state.change('free');
      game.state.change('phase_change');
    } else {
      // AI phase: push ai, then phase banner on top
      game.state.change('ai');
      game.state.change('phase_change');
    }

    // Fire event triggers — they'll queue events for the EventState
    // to process after the phase banner dismisses
    if (game.eventManager) {
      const ctx = { game, gameVars: game.gameVars, levelVars: game.levelVars };

      // phase_change fires for every phase
      game.eventManager.trigger(
        { type: 'phase_change', team: currentTeam, levelNid },
        ctx,
      );

      if (currentTeam === 'player') {
        // turn_change fires on player phase
        game.eventManager.trigger(
          { type: 'turn_change', turnCount, levelNid },
          ctx,
        );
        // level_start fires on the first player turn (turnCount === 1)
        // Note: loadLevel already triggers level_start, but only on initial load.
        // Subsequent level_start events from turn_change are NOT standard — 
        // the Python engine fires level_start separately. We skip it here.
      } else if (currentTeam === 'enemy') {
        game.eventManager.trigger(
          { type: 'enemy_turn_change', turnCount, levelNid },
          ctx,
        );
      } else if (currentTeam === 'enemy2') {
        game.eventManager.trigger(
          { type: 'enemy2_turn_change', turnCount, levelNid },
          ctx,
        );
      } else {
        game.eventManager.trigger(
          { type: 'other_turn_change', turnCount, levelNid, team: currentTeam },
          ctx,
        );
      }

      // If events were triggered, push EventState on top of everything
      if (game.eventManager.hasActiveEvents()) {
        game.state.change('event');
      }
    }

    return 'repeat';
  }
}

// ============================================================================
// 8b. InitiativeUpkeepState
// ============================================================================

/**
 * InitiativeUpkeepState — Transition state for the initiative system.
 *
 * Port of Python's InitiativeUpkeep (general_states.py).
 *
 * When initiative mode is active, this state is pushed after advancing
 * to the next unit in the initiative line. It determines which team the
 * current unit belongs to, updates the phase controller, and pushes the
 * appropriate gameplay state (free for player, ai for enemies), with a
 * phase_change banner on top.
 *
 * Design: The Python version uses begin() -> back() -> end(), where
 * end() does the real work. But in our TS state machine, back() calls
 * finish() not end(). So instead we do the work directly in begin(),
 * then pop self. The states we push via change() are deferred, so they
 * won't fire until after we're popped.
 */
export class InitiativeUpkeepState extends State {
  readonly name = 'initiative_upkeep';
  override readonly transparent = false;

  override begin(): StateResult {
    const game = getGame();
    if (!game.initiative) {
      game.state.back();
      return 'repeat';
    }

    const unitNid = game.initiative.getCurrentUnitNid();
    if (!unitNid) {
      game.state.back();
      return 'repeat';
    }

    const unit = game.getUnit(unitNid);
    if (!unit || unit.isDead() || !unit.position) {
      // Unit was removed/dead/off-map — skip to next via turn_change
      game.state.back();
      game.state.change('turn_change');
      return 'repeat';
    }

    // Matches Python: phase.next() in initiative mode sets current
    // to the initiative unit's team index
    if (game.phase) {
      game.phase.setCurrentTeam(unit.team);
    }

    // Pop self
    game.state.back();

    // Push the appropriate state
    if (unit.team === 'player') {
      game.state.change('free');
    } else {
      game.state.change('ai');
    }

    // Push phase_change banner on top for visual feedback
    // (Python pushes status_upkeep too, but we don't have that yet)
    game.state.change('phase_change');

    return 'repeat';
  }

  override takeInput(_event: InputEvent): StateResult {
    return 'repeat';
  }
}

// ============================================================================
// 9. PhaseChangeState
// ============================================================================

export class PhaseChangeState extends State {
  readonly name = 'phase_change';
  override readonly transparent = true;

  private banner: Banner | null = null;

  override begin(): StateResult {
    const game = getGame();
    const currentTeam = game.phase.getCurrent();
    const turnCount = game.phase.turnCount;

    // Turnwheel markers: lock during non-player phases, mark phase change
    game.actionLog.doAction(new LockTurnwheel(currentTeam !== 'player'));
    game.actionLog.doAction(new MarkPhase(currentTeam));

    let bannerText: string;
    let subText: string;

    switch (currentTeam) {
      case 'player':
        bannerText = 'Player Phase';
        subText = `Turn ${turnCount}`;
        break;
      case 'enemy':
        bannerText = 'Enemy Phase';
        subText = `Turn ${turnCount}`;
        break;
      default:
        bannerText = `${currentTeam} Phase`;
        subText = `Turn ${turnCount}`;
        break;
    }

    this.banner = new Banner(bannerText, subText);

    // Reset units for the new phase and process status effects
    if (game.initiative) {
      // Initiative mode: only reset the current initiative unit
      const unitNid = game.initiative.getCurrentUnitNid();
      if (unitNid) {
        const unit = game.getUnit(unitNid);
        if (unit && !unit.isDead()) {
          unit.resetTurnState();
          const dotDamage = unit.processStatusEffects();
          if (dotDamage > 0 && unit.currentHp <= 0) {
            unit.dead = true;
            game.board.removeUnit(unit);
          }
        }
      }
      // Move cursor to initiative unit's position
      if (unitNid) {
        const unit = game.getUnit(unitNid);
        if (unit && unit.position) {
          game.cursor.setPos(unit.position[0], unit.position[1]);
        }
      }
    } else {
      // Standard mode: reset all units of the team
      const teamUnits: UnitObject[] = game.board.getTeamUnits(currentTeam);
      for (const unit of teamUnits) {
        unit.resetTurnState();
        // Process status effects (DOT damage, duration tick-down)
        const dotDamage = unit.processStatusEffects();
        if (dotDamage > 0) {
          // Unit took status damage — check if they died from it
          if (unit.currentHp <= 0) {
            unit.dead = true;
            game.board.removeUnit(unit);
          }
        }
      }
    }
  }

  /**
   * Called when this state is popped off the stack.
   * Sets the first free action on the first player turn so the
   * turnwheel cannot rewind before this point.
   */
  override finish(): void {
    const game = getGame();
    if (game.turnCount === 1 && game.phase?.getCurrent() === 'player') {
      game.actionLog.setFirstFreeAction();
    }
  }

  override update(): StateResult {
    if (!this.banner) return;
    const game = getGame();

    const done = this.banner.update(FRAMETIME);
    if (done) {
      this.banner = null;
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    if (this.banner) {
      this.banner.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 10. MovementState
// ============================================================================

export class MovementState extends State {
  readonly name = 'movement';
  override readonly transparent = true;

  override update(): StateResult {
    const game = getGame();
    // movementSystem.update() is called by the main loop;
    // we only check completion status here.
    const stillMoving = game.movementSystem.isMoving();
    if (!stillMoving) {
      game.state.back();
      // If there is a pending state after movement, push it
      if (game._pendingAfterMovement) {
        const nextState = game._pendingAfterMovement;
        game._pendingAfterMovement = null;
        game.state.change(nextState);
      }
    }
  }

  override draw(surf: Surface): Surface {
    // Transparent — underlying MapState draws the map
    return surf;
  }
}

// ============================================================================
// 11. EventState
// ============================================================================

// ===================================================================
// ShopState — Buy/sell items at a shop
// ===================================================================

type ShopPhase = 'choice' | 'buy' | 'sell' | 'done';

export class ShopState extends State {
  readonly name = 'shop';
  override readonly transparent = false;

  private phase: ShopPhase = 'choice';
  private unit: UnitObject | null = null;
  private shopItems: ItemObject[] = [];
  private shopStock: number[] = []; // -1 = unlimited
  private money: number = 0;

  // Buy/sell menu selection
  private menuIndex: number = 0;
  private sellIndex: number = 0;

  // Choice menu (Buy/Sell)
  private choiceIndex: number = 0; // 0=Buy, 1=Sell

  // Message display
  private message: string = '';
  private messageTimer: number = 0;

  override begin(): StateResult {
    const game = getGame();
    this.unit = game.shopUnit ?? game.selectedUnit;
    this.shopItems = game.shopItems ?? [];
    this.shopStock = game.shopStock ?? this.shopItems.map(() => -1);
    this.money = Number(game.gameVars.get('money') ?? 0);
    this.phase = 'choice';
    this.menuIndex = 0;
    this.sellIndex = 0;
    this.choiceIndex = 0;
    this.message = '';
    this.messageTimer = 0;

    // Clear transient shop data
    game.shopUnit = null;
    game.shopItems = null;
    game.shopStock = null;
  }

  override takeInput(event: InputEvent): StateResult {
    if (!event) return;
    const game = getGame();

    // Dismiss message
    if (this.messageTimer > 0) {
      if (event === 'SELECT' || event === 'BACK') {
        this.messageTimer = 0;
        this.message = '';
      }
      return;
    }

    switch (this.phase) {
      case 'choice': {
        if (event === 'LEFT') this.choiceIndex = 0;
        if (event === 'RIGHT') this.choiceIndex = 1;
        if (event === 'SELECT') {
          if (this.choiceIndex === 0) {
            this.phase = 'buy';
            this.menuIndex = 0;
          } else {
            this.phase = 'sell';
            this.sellIndex = 0;
          }
        }
        if (event === 'BACK') {
          game.state.back();
        }
        return;
      }

      case 'buy': {
        if (event === 'UP') {
          this.menuIndex = (this.menuIndex - 1 + this.shopItems.length) % this.shopItems.length;
        }
        if (event === 'DOWN') {
          this.menuIndex = (this.menuIndex + 1) % this.shopItems.length;
        }
        if (event === 'SELECT') {
          this.tryBuyItem(game);
        }
        if (event === 'BACK') {
          this.phase = 'choice';
        }
        return;
      }

      case 'sell': {
        if (!this.unit || this.unit.items.length === 0) {
          this.phase = 'choice';
          return;
        }
        const sellableItems = this.unit.items.filter(i => i.getValue() > 0);
        if (sellableItems.length === 0) {
          this.showMessage('Nothing to sell.');
          this.phase = 'choice';
          return;
        }
        if (event === 'UP') {
          this.sellIndex = (this.sellIndex - 1 + sellableItems.length) % sellableItems.length;
        }
        if (event === 'DOWN') {
          this.sellIndex = (this.sellIndex + 1) % sellableItems.length;
        }
        if (event === 'SELECT') {
          this.trySellItem(game, sellableItems);
        }
        if (event === 'BACK') {
          this.phase = 'choice';
        }
        return;
      }
    }
  }

  override update(): StateResult {
    if (this.messageTimer > 0) {
      this.messageTimer -= FRAMETIME;
      if (this.messageTimer <= 0) {
        this.message = '';
        this.messageTimer = 0;
      }
    }
  }

  override draw(surf: Surface): Surface {
    // Dark background
    surf.fillRect(0, 0, surf.width, surf.height, 'rgba(8, 8, 24, 0.95)');

    const FONT = '8px monospace';
    const SMALL = '7px monospace';
    const W = surf.width;

    // Title
    surf.drawText('SHOP', 4, 4, '#FFD700', FONT);

    // Money display
    const moneyStr = `Gold: ${this.money}`;
    surf.drawText(moneyStr, W - 4 - moneyStr.length * 5, 4, '#FFD700', FONT);

    // Unit name
    if (this.unit) {
      surf.drawText(this.unit.name, 4, 16, 'white', FONT);
    }

    if (this.message) {
      // Show message centered
      const mx = Math.floor((W - this.message.length * 5) / 2);
      surf.fillRect(mx - 4, 70, this.message.length * 5 + 8, 16, 'rgba(40, 40, 80, 0.95)');
      surf.drawText(this.message, mx, 74, '#FFD700', FONT);
      return surf;
    }

    switch (this.phase) {
      case 'choice': {
        // Buy/Sell choice
        const cx = Math.floor(W / 2);
        const cy = 50;
        surf.fillRect(cx - 50, cy, 100, 20, 'rgba(32, 32, 64, 0.9)');
        surf.drawRect(cx - 50, cy, 100, 20, 'rgba(180, 180, 220, 0.6)');
        const buyColor = this.choiceIndex === 0 ? '#FFD700' : 'rgba(160,160,160,1)';
        const sellColor = this.choiceIndex === 1 ? '#FFD700' : 'rgba(160,160,160,1)';
        surf.drawText('Buy', cx - 40, cy + 6, buyColor, FONT);
        surf.drawText('Sell', cx + 15, cy + 6, sellColor, FONT);
        break;
      }

      case 'buy': {
        this.drawBuyMenu(surf, FONT, SMALL);
        break;
      }

      case 'sell': {
        this.drawSellMenu(surf, FONT, SMALL);
        break;
      }
    }

    return surf;
  }

  private drawBuyMenu(surf: Surface, FONT: string, SMALL: string): void {
    const startY = 28;
    const rowH = 14;
    const W = surf.width;

    // Column headers
    surf.drawText('Item', 20, startY, 'rgba(180,180,220,1)', SMALL);
    surf.drawText('Price', W - 35, startY, 'rgba(180,180,220,1)', SMALL);

    for (let i = 0; i < this.shopItems.length; i++) {
      const item = this.shopItems[i] as ItemObject;
      const y = startY + 10 + i * rowH;
      const stock = this.shopStock[i] ?? -1;
      const price = this.getBuyPrice(item);
      const canAfford = this.money >= price && stock !== 0;

      // Highlight selected row
      if (i === this.menuIndex) {
        surf.fillRect(2, y - 2, W - 4, rowH, 'rgba(80, 80, 140, 0.7)');
      }

      // Draw item icon (16x16)
      drawItemIcon(surf, item, 2, y - 2);

      const textColor = canAfford ? 'white' : 'rgba(128,128,128,1)';
      surf.drawText(item.name, 20, y + 1, textColor, SMALL);

      // Price
      const priceStr = String(price);
      surf.drawText(priceStr, W - 6 - priceStr.length * 4, y + 1,
        canAfford ? '#90D0FF' : 'rgba(128,128,128,1)', SMALL);

      // Stock (if limited)
      if (stock >= 0) {
        const stockStr = `x${stock}`;
        surf.drawText(stockStr, W - 50 - stockStr.length * 4, y + 1,
          stock > 0 ? 'rgba(200,200,200,1)' : 'rgba(128,128,128,1)', SMALL);
      }
    }

    // Item description at bottom
    if (this.shopItems[this.menuIndex]) {
      const desc = this.shopItems[this.menuIndex].desc || '';
      if (desc) {
        surf.fillRect(0, surf.height - 14, W, 14, 'rgba(16,16,32,0.9)');
        surf.drawText(desc.slice(0, Math.floor(W / 4)), 4, surf.height - 11, 'rgba(200,200,200,1)', SMALL);
      }
    }
  }

  private drawSellMenu(surf: Surface, FONT: string, SMALL: string): void {
    const startY = 28;
    const rowH = 14;
    const W = surf.width;
    const sellableItems = this.unit?.items.filter(i => i.getValue() > 0) ?? [];

    surf.drawText('Item', 20, startY, 'rgba(180,180,220,1)', SMALL);
    surf.drawText('Value', W - 35, startY, 'rgba(180,180,220,1)', SMALL);

    for (let i = 0; i < sellableItems.length; i++) {
      const item = sellableItems[i];
      const y = startY + 10 + i * rowH;
      const price = this.getSellPrice(item);

      if (i === this.sellIndex) {
        surf.fillRect(2, y - 2, W - 4, rowH, 'rgba(80, 80, 140, 0.7)');
      }

      // Draw item icon (16x16)
      drawItemIcon(surf, item, 2, y - 2);

      surf.drawText(item.name, 20, y + 1, 'white', SMALL);
      const priceStr = String(price);
      surf.drawText(priceStr, W - 6 - priceStr.length * 4, y + 1, '#90D0FF', SMALL);
    }

    if (sellableItems.length === 0) {
      surf.drawText('No items to sell', 20, startY + 12, 'rgba(160,160,160,1)', SMALL);
    }
  }

  private tryBuyItem(game: any): void {
    const item = this.shopItems[this.menuIndex];
    if (!item || !this.unit) return;
    const price = this.getBuyPrice(item);
    const stock = this.shopStock[this.menuIndex] ?? -1;

    if (stock === 0) {
      this.showMessage('Out of stock!');
      return;
    }
    if (this.money < price) {
      this.showMessage('Not enough gold!');
      return;
    }
    if (this.unit.items.length >= 5) {
      this.showMessage('Inventory full!');
      return;
    }

    // Deduct money
    this.money -= price;
    game.gameVars.set('money', this.money);

    // Decrement stock
    if (stock > 0) {
      this.shopStock[this.menuIndex] = stock - 1;
    }

    // Create new item and give to unit
    const prefab = game.db?.items?.get(item.nid);
    if (prefab) {
      const newItem = new ItemObjectClass(prefab);
      newItem.owner = this.unit;
      this.unit.items.push(newItem);
      this.showMessage(`Bought ${item.name}!`);
    }
  }

  private trySellItem(game: any, sellableItems: ItemObject[]): void {
    const item = sellableItems[this.sellIndex];
    if (!item || !this.unit) return;
    const price = this.getSellPrice(item);

    // Gain money
    this.money += price;
    game.gameVars.set('money', this.money);

    // Remove item from unit
    const idx = this.unit.items.indexOf(item);
    if (idx >= 0) {
      this.unit.items.splice(idx, 1);
    }

    this.showMessage(`Sold ${item.name}!`);

    // Adjust sell index
    const remaining = this.unit.items.filter(i => i.getValue() > 0);
    if (this.sellIndex >= remaining.length) {
      this.sellIndex = Math.max(0, remaining.length - 1);
    }
    if (remaining.length === 0) {
      this.phase = 'choice';
    }
  }

  private getBuyPrice(item: ItemObject): number {
    return item.getValue();
  }

  private getSellPrice(item: ItemObject): number {
    // Sell price = half of buy price, adjusted for remaining uses
    const base = item.getValue();
    if (item.maxUses > 0 && item.uses > 0) {
      return Math.floor((base * item.uses) / (item.maxUses * 2));
    }
    return Math.floor(base / 2);
  }

  private showMessage(msg: string): void {
    this.message = msg;
    this.messageTimer = 1500;
  }
}

/**
 * Set of commands that block execution until they complete.
 * All other commands are "instant" and processed in burst within a single frame.
 */
const BLOCKING_COMMANDS: Set<string> = new Set([
  'speak', 'wait', 'transition', 'alert',
  'add_portrait', 'remove_portrait', 'music', 'change_music',
]);

/** Maximum instant commands processed per frame to prevent infinite loops. */
const MAX_BURST = 100;

export class EventState extends State {
  readonly name = 'event';
  override readonly transparent = true;

  // Active event pulled from the EventManager queue
  private currentEvent: GameEvent | null = null;

  // Level transition lock: set when levelEnd() kicks off an async loadLevel.
  // Prevents update() from processing commands while the load is in progress.
  private levelTransitionInProgress: boolean = false;

  // When true, begin() starts with a black screen (transitionAlpha = 1)
  // instead of clearing it. Set by levelEnd() so that chapter_title +
  // transition;Open work correctly after level transitions.
  private startWithBlackScreen: boolean = false;

  // Blocking-command state
  private dialog: Dialog | null = null;
  private banner: Banner | null = null;
  private bannerIsAlert: boolean = false;  // true if banner is from 'alert' command (allows early dismiss)
  private waitTimer: number = 0;
  private waiting: boolean = false;

  // Transition fade state
  private transitionAlpha: number = 0;
  private transitionFadingIn: boolean = false;  // true = fading to black
  private transitionFadingOut: boolean = false; // true = fading from black
  private transitionHoldBlack: boolean = false; // true = holding black between open/close
  private transitionDurationMs: number = 500;   // fade duration in ms
  private transitionColor: string = '0,0,0';    // fade color as "r,g,b"

  // Choice menu state
  private choiceMenu: ChoiceMenu | null = null;
  private choiceResult: string | null = null;

  // For-loop state: stack of { varName, values[], currentIndex, loopStartPointer }
  private forLoopStack: { varName: string; values: string[]; currentIndex: number; startPointer: number }[] = [];

  // Skip mode: when true, all speak/narrate commands are auto-advanced
  private skipMode: boolean = false;

  // Portrait state
  private portraits: Map<string, EventPortrait> = new Map();
  private portraitPriorityCounter: number = 1;
  /** Count of portrait image loads in flight — blocks command processing until 0. */
  private pendingPortraitLoads: number = 0;

  // Currently speaking portrait (for talk animation)
  private speakingPortrait: EventPortrait | null = null;
  private wasDialogTyping: boolean = false;

  // Background panorama image (drawn behind portraits, on top of map)
  private background: HTMLImageElement | null = null;
  private pendingBackgroundLoad: boolean = false;
  private backgroundLoadDone: boolean = false;
  private backgroundLoadToken: number = 0;

  // Chapter title overlay state
  private chapterTitlePhase: 'none' | 'fade_in' | 'hold' | 'fade_out' = 'none';
  private chapterTitleTimer: number = 0;
  private chapterTitleText: string = '';

  // Location card state
  private locationCard: { text: string; timer: number; phase: 'fade_in' | 'hold' | 'fade_out'; alpha: number } | null = null;

  /** Effective dialog text speed in milliseconds per character. */
  private getDialogTextSpeedMs(): number {
    const game = getGame();
    const raw = game.gameVars?.get('_setting_text_speed');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      return raw;
    }
    if (typeof raw === 'string') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return 32;
  }

  /** Optional per-dialog speed multiplier from command args (LT `text_speed`). */
  private getDialogSpeedMultiplier(args: string[]): number {
    const parseNumeric = (value: string): number | null => {
      const parsed = Number(value.trim());
      if (!Number.isFinite(parsed) || parsed < 0) return null;
      return parsed;
    };

    // PYEV1/keyword-style args: text_speed=5 or speed=5
    for (const arg of args) {
      const trimmed = arg.trim();
      const match = trimmed.match(/^(?:text_speed|speed)\s*=\s*(\d+(?:\.\d+)?)$/i);
      if (match) {
        const parsed = parseNumeric(match[1]);
        if (parsed !== null) return parsed;
      }
    }

    // Semicolon-format positional arg order:
    // speak;speaker;text;position;width;style_nid;text_speed;...
    const positional = args[5];
    if (typeof positional === 'string' && positional.trim() !== '') {
      const parsed = parseNumeric(positional);
      if (parsed !== null) return parsed;
    }

    return 1;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override begin(): StateResult {
    const game = getGame();
    const nextEvent = game.eventManager?.getCurrentEvent() ?? null;
    if (!nextEvent) {
      // Nothing to process — pop back immediately.
      // Return 'repeat' so the state machine flushes this back() before
      // running update() on us (which would queue a second back()).
      game.state.back();
      return 'repeat';
    }
    // Only do a full reset when starting a genuinely NEW event.
    // When EventState is re-activated after another state pops (e.g.,
    // movement, shop, combat), we keep skipMode and other state intact.
    const isNewEvent = nextEvent !== this.currentEvent;
    this.currentEvent = nextEvent;
    if (isNewEvent) {
      // Full reset for a new event
      this.dialog = null;
      this.banner = null;
      this.bannerIsAlert = false;
      this.waitTimer = 0;
      this.waiting = false;
      // If starting from a level transition, keep the screen black so
      // chapter_title + transition;Open work as expected. Otherwise reset.
      if (!this.startWithBlackScreen) {
        this.transitionAlpha = 0;
      } else {
        this.transitionAlpha = 1;
        this.startWithBlackScreen = false;
      }
      this.transitionFadingIn = false;
      this.transitionFadingOut = false;
      this.transitionHoldBlack = false;
      this.choiceMenu = null;
      this.choiceResult = null;
      this.forLoopStack = [];
      this.skipMode = false;
      this.portraits.clear();
      this.portraitPriorityCounter = 1;
      this.pendingPortraitLoads = 0;
      this.speakingPortrait = null;
      this.wasDialogTyping = false;
      this.background = null;
      this.pendingBackgroundLoad = false;
      this.backgroundLoadDone = false;
      this.backgroundLoadToken++;
      this.chapterTitlePhase = 'none';
      this.chapterTitleTimer = 0;
      this.chapterTitleText = '';
      this.locationCard = null;
      this.isHandlingLevelEnd = false;
      this.levelTransitionInProgress = false;
    }
  }

  // -----------------------------------------------------------------------
  // Input
  // -----------------------------------------------------------------------

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    let effective = event;
    if (game.input?.mouseClick === 'SELECT' && !effective) {
      effective = 'SELECT';
    } else if (game.input?.mouseClick === 'BACK' && !effective) {
      effective = 'BACK';
    }

    // Forward input to dialog if active
    if (this.dialog) {
      if (effective === 'BACK') {
        // Enable skip mode — dismiss this dialog and auto-skip all
        // remaining speak/narrate commands in the current event
        this.skipMode = true;
        this.dialog = null;
        if (this.speakingPortrait) {
          this.speakingPortrait.stopTalking();
          this.speakingPortrait = null;
        }
        this.wasDialogTyping = false;
        this.advancePointer();
        return;
      }
      const done = this.dialog.handleInput(effective);
      if (done) {
        this.dialog = null;
        if (this.speakingPortrait) {
          this.speakingPortrait.stopTalking();
          this.speakingPortrait = null;
        }
        this.wasDialogTyping = false;
        this.advancePointer();
      }
      return;
    }

    // Allow skipping chapter title
    if (this.chapterTitlePhase !== 'none') {
      if (effective === 'SELECT' || effective === 'BACK') {
        this.chapterTitlePhase = 'none';
        this.chapterTitleTimer = 0;
        this.advancePointer();
      }
      return;
    }

    // Allow early dismiss of alert banners after 300ms
    if (this.banner && this.bannerIsAlert) {
      if (effective && this.banner.getElapsed() > 300) {
        this.banner = null;
        this.bannerIsAlert = false;
        this.advancePointer();
      }
      return;
    }

    // Forward input to choice menu if active
    if (this.choiceMenu) {
      const result = this.choiceMenu.handleInput(effective);
      if (result !== null) {
        if ('selected' in result) {
          this.choiceResult = result.selected;
        } else {
          // BACK — pick first option as default
          this.choiceResult = this.choiceMenu.options[0]?.value ?? '';
        }
        this.choiceMenu = null;
        this.advancePointer();
      }
      return;
    }

    // Enable skip mode when BACK is pressed outside of any blocking UI.
    // This handles the case where the user presses Escape during wait,
    // transition, screen_shake, or between instant commands.
    if (effective === 'BACK') {
      this.skipMode = true;
      // If we're in a wait, transition, or other blockable state, resolve it
      if (this.waiting) {
        this.waiting = false;
        this.waitTimer = 0;
        this.advancePointer();
      }
      if (this.banner) {
        this.banner = null;
        this.bannerIsAlert = false;
        this.advancePointer();
      }
      if (this.locationCard) {
        this.locationCard = null;
        this.advancePointer();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Update — burst-processes instant commands each frame
  // -----------------------------------------------------------------------

  override update(): StateResult {
    const game = getGame();

    // Block while a level transition is loading asynchronously
    if (this.levelTransitionInProgress) {
      return;
    }

    // --- Handle active blocking UI elements first ---

    // Dialog typewriter
    if (this.dialog) {
      if (this.skipMode) {
        // Skip mode: instantly dismiss dialog
        this.dialog = null;
        if (this.speakingPortrait) {
          this.speakingPortrait.stopTalking();
          this.speakingPortrait = null;
        }
        this.wasDialogTyping = false;
        this.advancePointer();
      } else {
        this.dialog.update(FRAMETIME);
        const isTyping = this.dialog.isTyping();
        if (this.speakingPortrait) {
          if (isTyping && !this.wasDialogTyping) {
            this.speakingPortrait.startTalking();
          } else if (!isTyping && this.wasDialogTyping) {
            this.speakingPortrait.stopTalking();
          }
        }
        this.wasDialogTyping = isTyping;
        return;
      }
    }

    // Banner timer
    if (this.banner) {
      if (this.skipMode) {
        this.banner = null;
        this.bannerIsAlert = false;
        this.advancePointer();
      } else {
        const done = this.banner.update(FRAMETIME);
        if (done) {
          this.banner = null;
          this.bannerIsAlert = false;
          this.advancePointer();
        } else {
          return; // still showing banner
        }
      }
    }

    // Wait timer
    if (this.waiting) {
      if (this.skipMode) {
        this.waiting = false;
        this.waitTimer = 0;
        this.advancePointer();
      } else {
        this.waitTimer -= FRAMETIME;
        if (this.waitTimer <= 0) {
          this.waiting = false;
          this.advancePointer();
        }
        return;
      }
    }

    // Transition fade animation
    if (this.transitionFadingIn) {
      if (this.skipMode) {
        this.transitionAlpha = 1;
        this.transitionFadingIn = false;
        this.transitionHoldBlack = true;
        this.advancePointer();
      } else {
        this.transitionAlpha = Math.min(1, this.transitionAlpha + FRAMETIME / this.transitionDurationMs);
        if (this.transitionAlpha >= 1) {
          this.transitionFadingIn = false;
          this.transitionHoldBlack = true;
          this.advancePointer();
          // Don't return — allow burst to continue while holding black
        } else {
          return;
        }
      }
    }
    if (this.transitionFadingOut) {
      if (this.skipMode) {
        this.transitionAlpha = 0;
        this.transitionFadingOut = false;
        this.transitionHoldBlack = false;
        this.advancePointer();
      } else {
        this.transitionAlpha = Math.max(0, this.transitionAlpha - FRAMETIME / this.transitionDurationMs);
        if (this.transitionAlpha <= 0) {
          this.transitionFadingOut = false;
          this.transitionHoldBlack = false;
          this.advancePointer();
        }
        return;
      }
    }

    // Choice menu — block while active
    if (this.choiceMenu) {
      return;
    }

    // Overworld movement — block while an entity is moving along a road
    if (game.overworldMovement && game.overworldMovement.isMoving()) {
      game.overworldMovement.update(FRAMETIME);
      return;
    }

    // Chapter title overlay animation
    if (this.chapterTitlePhase !== 'none') {
      if (this.skipMode) {
        this.chapterTitlePhase = 'none';
        this.chapterTitleTimer = 0;
        this.advancePointer();
      } else {
        this.chapterTitleTimer += FRAMETIME;
        switch (this.chapterTitlePhase) {
          case 'fade_in':
            if (this.chapterTitleTimer >= 1000) {
              this.chapterTitlePhase = 'hold';
              this.chapterTitleTimer = 0;
            }
            break;
          case 'hold':
            if (this.chapterTitleTimer >= 3000) {
              this.chapterTitlePhase = 'fade_out';
              this.chapterTitleTimer = 0;
            }
            break;
          case 'fade_out':
            if (this.chapterTitleTimer >= 1000) {
              this.chapterTitlePhase = 'none';
              this.chapterTitleTimer = 0;
              this.advancePointer();
            }
            break;
        }
        return;
      }
    }

    // Location card timer (non-blocking: just updates alpha, doesn't stop command processing)
    if (this.locationCard) {
      this.locationCard.timer += FRAMETIME;
      switch (this.locationCard.phase) {
        case 'fade_in':
          this.locationCard.alpha = Math.min(0.9, this.locationCard.timer / 200);
          if (this.locationCard.timer >= 200) {
            this.locationCard.phase = 'hold';
            this.locationCard.timer = 0;
          }
          break;
        case 'hold':
          this.locationCard.alpha = 0.9;
          if (this.locationCard.timer >= 2000) {
            this.locationCard.phase = 'fade_out';
            this.locationCard.timer = 0;
          }
          break;
        case 'fade_out':
          this.locationCard.alpha = Math.max(0, 0.9 - (this.locationCard.timer / 200) * 0.9);
          if (this.locationCard.timer >= 200) {
            this.locationCard = null;
          }
          break;
      }
      // Location card does NOT block command processing — fall through
    }

    // Block while portrait images are still loading (async).
    // In the original Python engine, image loads are synchronous, so portraits
    // are always available when the next command (e.g. speak) executes.
    // In skip mode, we still need to wait — the portrait must exist in the
    // portraits map for subsequent commands that reference it by name.
    if (this.pendingPortraitLoads > 0) {
      return;
    }

    // Block while a panorama from change_background is loading.
    if (this.pendingBackgroundLoad) {
      if (this.backgroundLoadDone) {
        this.pendingBackgroundLoad = false;
        this.backgroundLoadDone = false;
        this.advancePointer();
      } else {
        return;
      }
    }

    // --- Burst-process commands ---
    let burst = 0;
    while (burst < MAX_BURST) {
      burst++;

      // Ensure we have an event to process
      if (!this.currentEvent) {
        this.finishAndDequeue();
        return;
      }

      const ev = this.currentEvent;
      const commands = ev.commands;

      // Check if event is complete
      if (ev.commandPointer >= commands.length || ev.isDone()) {
        this.finishAndDequeue();
        return;
      }

      const cmd = commands[ev.commandPointer];
      if (!cmd) {
        this.advancePointer();
        continue;
      }

      // Execute the command. Returns true if the command is blocking.
      const blocking = this.executeCommand(cmd, game);
      if (blocking) {
        break; // stop burst — wait for blocking command to finish
      }
      // Instant command: pointer was already advanced inside executeCommand,
      // continue processing next command in the same frame.
    }
  }

  // -----------------------------------------------------------------------
  // Draw
  // -----------------------------------------------------------------------

  override draw(surf: Surface): Surface {
    // Background panorama (drawn on top of map, behind portraits)
    if (this.background) {
      // Center the background image on the 240x160 surface
      const bx = Math.floor((surf.width - this.background.width) / 2);
      const by = Math.floor((surf.height - this.background.height) / 2);
      surf.blitImage(this.background, 0, 0, this.background.width, this.background.height, bx, by);
    }

    // Transition fade overlay
    if (this.transitionAlpha > 0) {
      surf.fillRect(0, 0, surf.width, surf.height, `rgba(${this.transitionColor},${this.transitionAlpha})`);
    }

    // Update and draw portraits (sorted by priority, ascending)
    const dt = FRAMETIME; // ~16.67ms per frame
    const toRemove: string[] = [];
    for (const [name, portrait] of this.portraits) {
      const finished = portrait.update(dt);
      if (finished) {
        toRemove.push(name);
      }
    }
    for (const name of toRemove) {
      this.portraits.delete(name);
    }

    // Draw portraits sorted by priority (lowest first = drawn behind)
    const sortedPortraits = [...this.portraits.values()].sort(
      (a, b) => a.priority - b.priority,
    );
    for (const portrait of sortedPortraits) {
      portrait.draw(surf);
    }

    // UI on top of portraits
    if (this.dialog) {
      this.dialog.draw(surf);
    }
    if (this.banner) {
      this.banner.draw(surf);
    }
    if (this.choiceMenu) {
      this.choiceMenu.draw(surf);
    }

    // Chapter title overlay (drawn on top of everything)
    if (this.chapterTitlePhase !== 'none') {
      let ctAlpha = 1;
      if (this.chapterTitlePhase === 'fade_in') {
        ctAlpha = Math.min(1, this.chapterTitleTimer / 1000);
      } else if (this.chapterTitlePhase === 'fade_out') {
        ctAlpha = Math.max(0, 1 - this.chapterTitleTimer / 1000);
      }

      // Black background
      surf.fillRect(0, 0, surf.width, surf.height, `rgba(0,0,0,${ctAlpha})`);

      if (ctAlpha > 0.1) {
        // Horizontal banner bar across the middle
        const bannerY = Math.floor(surf.height / 2) - 16;
        const bannerH = 32;
        surf.fillRect(0, bannerY, surf.width, bannerH, `rgba(40,20,10,${ctAlpha * 0.9})`);
        // Gold border lines
        surf.fillRect(0, bannerY, surf.width, 1, `rgba(200,170,80,${ctAlpha * 0.8})`);
        surf.fillRect(0, bannerY + bannerH - 1, surf.width, 1, `rgba(200,170,80,${ctAlpha * 0.8})`);

        // Chapter title text (centered)
        const titleColor = `rgba(255,230,120,${ctAlpha})`;
        const titleFont = '10px monospace';
        // Approximate centering
        const textW = this.chapterTitleText.length * 6; // ~6px per char at 10px mono
        const tx = Math.floor((surf.width - textW) / 2);
        const ty = bannerY + Math.floor((bannerH - 10) / 2);
        surf.drawText(this.chapterTitleText, tx, ty, titleColor, titleFont);
      }
    }

    // Location card overlay (upper-left corner)
    if (this.locationCard && this.locationCard.alpha > 0) {
      const lc = this.locationCard;
      const lcPad = 8;
      const lcFont = '8px monospace';
      const lcTextW = lc.text.length * 5; // ~5px per char at 8px mono
      const lcW = lcTextW + lcPad * 2;
      const lcH = 16 + lcPad;
      const lcX = 10;
      const lcY = 4;

      // Brown card background
      surf.fillRect(lcX, lcY, lcW, lcH, `rgba(60,40,20,${lc.alpha})`);
      surf.drawRect(lcX, lcY, lcW, lcH, `rgba(140,110,60,${lc.alpha * 0.8})`);

      // Text
      surf.drawText(lc.text, lcX + lcPad, lcY + Math.floor(lcPad / 2), `rgba(255,240,200,${lc.alpha})`, lcFont);
    }

    return surf;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Advance the command pointer of the current event by 1. */
  private advancePointer(): void {
    if (this.currentEvent) {
      this.currentEvent.commandPointer++;
    }
  }

  /** Track whether we are in the middle of handling a level end sequence. */
  private isHandlingLevelEnd: boolean = false;

  /**
   * Finish the current event, dequeue it, and either load the next queued
   * event or pop the state.
   *
   * Matches Python EventState.end_event(): after dequeuing, checks _win_game
   * and _lose_game level variables to trigger level transitions.
   */
  private finishAndDequeue(): void {
    const game = getGame();
    if (this.currentEvent) {
      this.currentEvent.finish();
    }
    game.eventManager?.dequeueCurrentEvent();

    // Clean up portraits and talking state
    if (this.speakingPortrait) {
      this.speakingPortrait.stopTalking();
      this.speakingPortrait = null;
    }
    this.wasDialogTyping = false;

    // --- Check win/lose flags (matches Python end_event logic) ---

    if (game.levelVars.get('_win_game') || this.isHandlingLevelEnd) {
      game.levelVars.set('_win_game', false);
      this.isHandlingLevelEnd = true;

      // Check if LevelEnd event was already triggered
      if (game.levelVars.get('_level_end_triggered')) {
        // LevelEnd event has run — proceed with actual level transition
        this.levelEnd(game);
        return;
      }

      // Try to trigger a LevelEnd event for outro cutscenes
      const levelNid = game.currentLevel?.nid ?? '';
      const didTrigger = game.eventManager?.trigger(
        { type: 'level_end', levelNid },
        { game, gameVars: game.gameVars, levelVars: game.levelVars },
      ) ?? false;

      if (didTrigger) {
        // Mark so we know to call levelEnd() after it finishes
        game.levelVars.set('_level_end_triggered', true);
        // The next event in the queue is the LevelEnd event — load it
        this.loadNextEvent(game);
        return;
      }

      // No LevelEnd event exists — proceed directly
      this.levelEnd(game);
      return;
    }

    if (game.levelVars.get('_lose_game')) {
      game.levelVars.set('_lose_game', false);
      console.warn('GAME OVER — loss condition met via lose_game flag');
      game.state.clear();
      game.state.change('game_over');
      return;
    }

    // --- Normal event completion (no win/lose) ---
    this.loadNextEvent(game);
  }

  /**
   * Try to load the next queued event, or pop the state if none remain.
   */
  private loadNextEvent(game: any): void {
    const next = game.eventManager?.getCurrentEvent() ?? null;
    if (next) {
      this.currentEvent = next;
      this.dialog = null;
      this.banner = null;
      this.waitTimer = 0;
      this.waiting = false;
      this.portraits.clear();
      this.portraitPriorityCounter = 1;
      this.pendingPortraitLoads = 0;
      this.background = null;
      this.pendingBackgroundLoad = false;
      this.backgroundLoadDone = false;
      this.backgroundLoadToken++;
      this.chapterTitleTimer = 0;
      this.chapterTitlePhase = 'none';
      this.locationCard = null;
    } else {
      this.currentEvent = null;
      this.portraits.clear();
      this.pendingPortraitLoads = 0;
      this.background = null;
      this.pendingBackgroundLoad = false;
      this.backgroundLoadDone = false;
      this.backgroundLoadToken++;
      this.chapterTitleTimer = 0;
      this.chapterTitlePhase = 'none';
      this.locationCard = null;
      game.state.back();
    }
  }

  /**
   * Handle level transition after win_game.
   * Matches Python EventState.level_end():
   *   1. Clean up the current level (persist player units, heal, etc.)
   *   2. Determine the next level (via _goto_level override or sequential)
   *   3. Load the next level and transition to free state
   */
  private levelEnd(game: any): void {
    const currentLevelNid = game.currentLevel?.nid ?? '';
    game.gameVars.set('_prev_level_nid', currentLevelNid);

    // Find current level index in the ordered db.levels map
    const levelNids = Array.from(game.db.levels.keys()) as string[];
    const currentIndex = levelNids.indexOf(currentLevelNid);

    // Clean up current level state (persist player units)
    game.cleanUpLevel();

    // Determine the next level
    let nextLevelNid: string | null = null;
    const gotoLevel = game.gameVars.get('_goto_level') ?? null;

    if (gotoLevel !== null) {
      if (gotoLevel === '_force_quit') {
        // Force quit to title
        game.state.clear();
        game.state.change('title');
        this.isHandlingLevelEnd = false;
        return;
      }
      nextLevelNid = gotoLevel as string;
      game.gameVars.delete('_goto_level');
    } else if (currentIndex >= 0 && currentIndex < levelNids.length - 1) {
      // Sequential: next level in order
      const candidateNid = levelNids[currentIndex + 1];
      // Skip debug levels (matching Python: 'debug' in next_level.nid.lower())
      if (candidateNid.toLowerCase().includes('debug')) {
        console.log('No more levels (next is debug). Returning to title.');
        game.state.clear();
        game.state.change('title');
        this.isHandlingLevelEnd = false;
        return;
      }
      nextLevelNid = candidateNid;
    }

    if (!nextLevelNid) {
      console.log('No more levels! Returning to title.');
      game.state.clear();
      game.state.change('title');
      this.isHandlingLevelEnd = false;
      return;
    }

    // Store next level NID for reference
    game.gameVars.set('_next_level_nid', nextLevelNid);
    this.isHandlingLevelEnd = false;

    console.log(`Level transition: ${currentLevelNid} -> ${nextLevelNid}`);

    // Lock event processing while the async load is in progress.
    // Also null out currentEvent so the burst loop doesn't try to
    // finishAndDequeue the old event (which would dequeue the new
    // level's events from the new EventManager's queue).
    this.levelTransitionInProgress = true;
    this.currentEvent = null;

    // Load the next level and transition to gameplay
    game.loadLevel(nextLevelNid).then(() => {
      // DON'T clear levelTransitionInProgress here — it will be reset
      // in begin() when EventState is re-pushed after the deferred ops.
      // If we clear it now, update() would run the burst loop with stale
      // state before processTempState flushes the clear/change ops.
      game.state.clear();
      game.state.change('free');
      // If level_start triggered events, push EventState
      if (game.eventManager?.hasActiveEvents()) {
        // Start the new level's events with a black screen so that
        // chapter_title + transition;Open work as expected
        this.startWithBlackScreen = true;
        game.state.change('event');
      }
    }).catch((err: unknown) => {
      this.levelTransitionInProgress = false;
      console.error('Failed to load next level:', err);
      game.state.clear();
      game.state.change('title');
    });
  }

  /**
   * Find the unit by NID — first try the game unit registry, then the board.
   */
  private findUnit(nid: string): UnitObject | undefined {
    const game = getGame();
    const fromRegistry = game.units.get(nid);
    if (fromRegistry) return fromRegistry;
    return game.board?.getAllUnits().find((u: UnitObject) => u.nid === nid);
  }

  /**
   * Resolve a position argument that could be either "x,y" coordinates
   * or a unit NID (resolves to the unit's current position).
   */
  private resolvePosition(posOrUnit: string, game: any): [number, number] | null {
    if (!posOrUnit) return null;
    // Try parsing as x,y coordinates first
    const parts = posOrUnit.split(',');
    if (parts.length >= 2) {
      const x = parseInt(parts[0].trim(), 10);
      const y = parseInt(parts[1].trim(), 10);
      if (!isNaN(x) && !isNaN(y)) return [x, y];
    }
    // Try resolving as a unit NID
    const unit = this.findUnit(posOrUnit);
    if (unit?.position) return [unit.position[0], unit.position[1]];
    return null;
  }

  /**
   * Build a ConditionContext from the current game state and event trigger.
   */
  private buildConditionContext(): ConditionContext {
    const game = getGame();
    const trigger = this.currentEvent?.trigger;
    return {
      game,
      unit1: trigger?.unit1,
      unit2: trigger?.unit2,
      position: trigger?.position,
      region: trigger?.region,
      item: trigger?.item,
      gameVars: game.gameVars,
      levelVars: game.levelVars,
    };
  }

  // -----------------------------------------------------------------------
  // if / elif / else / end  flow-control
  // -----------------------------------------------------------------------

  /**
   * Jump forward from a false if/elif to the matching elif/else/end,
   * respecting nested if blocks.
   * Returns the index to jump to (the elif/else/end command itself).
   */
  private jumpToNextBranch(fromIndex: number): number {
    const commands = this.currentEvent!.commands;
    let depth = 0;
    for (let i = fromIndex + 1; i < commands.length; i++) {
      const t = commands[i].type;
      if (t === 'if') {
        depth++;
      } else if (t === 'end') {
        if (depth === 0) return i;
        depth--;
      } else if (depth === 0 && (t === 'elif' || t === 'else')) {
        return i;
      }
    }
    // Couldn't find matching end — jump past end of commands
    return commands.length;
  }

  /**
   * Jump forward from a true elif/else branch that was reached by
   * fall-through to the matching `end`, skipping nested if blocks.
   */
  private jumpToEnd(fromIndex: number): number {
    const commands = this.currentEvent!.commands;
    let depth = 0;
    for (let i = fromIndex + 1; i < commands.length; i++) {
      const t = commands[i].type;
      if (t === 'if') {
        depth++;
      } else if (t === 'end') {
        if (depth === 0) return i;
        depth--;
      }
    }
    return commands.length;
  }

  // -----------------------------------------------------------------------
  // Command execution — returns true if command is blocking
  // -----------------------------------------------------------------------

  private executeCommand(cmd: EventCommand, game: any): boolean {
    const rawArgs = cmd.args ?? [];

    // Substitute template variables in all args:
    // {unit} -> the unit that triggered this event (from trigger.unitNid or unit1.nid)
    // {unit2} -> the secondary unit (from trigger.unit2.nid)
    const trigger = this.currentEvent?.trigger;
    const unitNid = trigger?.unitNid ?? trigger?.unit1?.nid ?? '';
    const unit2Nid = trigger?.unitB ?? trigger?.unit2?.nid ?? '';
    const args = rawArgs.map(a =>
      a.replace(/\{unit\}/g, unitNid).replace(/\{unit2\}/g, unit2Nid)
    );

    switch (cmd.type) {
      // ----- Flow control -----
      case 'if': {
        const condition = args[0] ?? 'True';
        const ctx = this.buildConditionContext();
        if (evaluateCondition(condition, ctx)) {
          // Condition true — advance into the if body
          this._jumpedToBranch = false;
          this.advancePointer();
        } else {
          // Condition false — jump to matching elif/else/end
          const target = this.jumpToNextBranch(this.currentEvent!.commandPointer);
          this.currentEvent!.commandPointer = target;
          this._jumpedToBranch = true;
          // Don't advance — we land ON the elif/else/end and it will be
          // processed next iteration.
        }
        return false;
      }

      case 'elif': {
        // If reached naturally (fall-through from a true if/elif body),
        // the previous branch was true — skip to end.
        // If jumped to from a false branch, the pointer lands here and
        // we evaluate the condition.
        //
        // We distinguish by checking: did we arrive here by advancing
        // (commandPointer was just set to this index by jumpToNextBranch)?
        // We use a simple heuristic: the previous command in the stream
        // will NOT be 'end' if we jumped here from a false branch — it
        // could be anything. But if we fell through, the previous executed
        // command was the last in the true block.
        //
        // Instead, use the fact that jumpToNextBranch lands ON this command
        // without advancing. So if we're processing it, there are two cases:
        // 1. We were jumped here (false branch) — evaluate condition.
        // 2. We fell through (true branch) — skip to end.
        //
        // The way to disambiguate: check if the command immediately before
        // this one is an `end` or some other command. But this is fragile.
        // Instead, use a simpler approach: we check if the condition that
        // brought us here by looking at whether the PREVIOUS if/elif at the
        // same nesting level was true. But tracking that is complex.
        //
        // Simplest correct approach: treat `elif` like Python's `elif`.
        // If we reach it by sequential execution (fall-through from true
        // block), jump to end. We know we fell through if the previous
        // instruction that was executed was NOT a jump (i.e., the pointer
        // was sequentially incremented to reach here).
        //
        // Actually the cleanest way: when a true if/elif body completes
        // and reaches an elif/else by fall-through, we must jump to end.
        // We handle this by checking if the previous command (pointer - 1)
        // is NOT 'if' and NOT 'elif' — if so, we fell through.
        //
        // But the pointer was advanced past all the body commands. The
        // command at pointer-1 is the last body command, not the if/elif.
        //
        // The correct approach used in LT: when an if/elif condition is
        // TRUE, we execute the body. When execution naturally reaches the
        // next elif/else, we know the previous branch succeeded, so we
        // jump to `end`. When an if/elif condition is FALSE, jumpToNextBranch
        // sets the pointer directly to the elif/else without advancing.
        //
        // So we need a flag. Let's track whether we're in a "jump-to" state.
        // Alternatively, check if the command BEFORE this elif was inside
        // the previous branch body (not another if/elif/else).
        //
        // Simplest: use the fact that jumpToNextBranch does NOT call
        // advancePointer, it sets commandPointer directly. So when we land
        // on elif from a false branch, the pointer equals our index.
        // When we fall through, advancePointer was called, so the pointer
        // also equals our index. Both cases look the same!
        //
        // The real disambiguation is: were we jumped to, or did we arrive
        // sequentially? We can't tell from the pointer alone.
        //
        // The LT engine handles this with a skip-to-end flag. Let's do the
        // same: when a true branch body finishes and we encounter elif/else,
        // we jump to end. We'll handle this by checking if the previous
        // command was NOT 'if' / 'elif' with false condition.
        //
        // Actually let me just implement this properly with a simple rule:
        // We need to know if we jumped here. Let's track `_jumpedToBranch`.
        if (this._jumpedToBranch) {
          this._jumpedToBranch = false;
          // We were jumped here from a false branch — evaluate condition
          const condition = args[0] ?? 'True';
          const ctx = this.buildConditionContext();
          if (evaluateCondition(condition, ctx)) {
            // Condition true — enter this elif body
            this.advancePointer();
          } else {
            // Still false — jump to next elif/else/end
            const target = this.jumpToNextBranch(this.currentEvent!.commandPointer);
            this.currentEvent!.commandPointer = target;
            this._jumpedToBranch = true;
          }
        } else {
          // Fell through from a true branch — skip to matching end
          const target = this.jumpToEnd(this.currentEvent!.commandPointer);
          this.currentEvent!.commandPointer = target;
          // Landing on `end`, which will just advance
        }
        return false;
      }

      case 'else': {
        if (this._jumpedToBranch) {
          this._jumpedToBranch = false;
          // Jumped here from a false branch — enter the else body
          this.advancePointer();
        } else {
          // Fell through from a true branch — skip to end
          const target = this.jumpToEnd(this.currentEvent!.commandPointer);
          this.currentEvent!.commandPointer = target;
        }
        return false;
      }

      case 'end': {
        // End of an if block — just advance
        this._jumpedToBranch = false;
        this.advancePointer();
        return false;
      }

      case 'finish': {
        // Immediately end the event
        this.currentEvent!.finish();
        return false;
      }

      case 'comment':
      case 'end_skip': {
        this.advancePointer();
        return false;
      }

      // ----- Blocking commands -----

      case 's':           // short alias used in support conversations
      case 'speak':
      case 'narrate': {
        // In skip mode, auto-advance past all dialogue without showing it
        if (this.skipMode) {
          this.advancePointer();
          return false;
        }
        const speaker = args[0] ?? '';
        const text = args[1] ?? '';

        // Stop previous speaking portrait
        if (this.speakingPortrait) {
          this.speakingPortrait.stopTalking();
          this.speakingPortrait = null;
        }

        // Look up portrait for the speaker
        const portrait = this.portraits.get(speaker) ?? null;

        // Check flags (flags are extra args like 'no_talk', 'low_priority', 'hold')
        const flagArgs = args.slice(2).map(s => s.toLowerCase());
        const noTalk = flagArgs.includes('no_talk');

        if (portrait && !noTalk && cmd.type !== 'narrate') {
          this.speakingPortrait = portrait;

          // Raise portrait priority (bring to front) unless low_priority
          if (!flagArgs.includes('low_priority')) {
            portrait.priority = this.portraitPriorityCounter++;
          }
        }

        const dialogSpeedMult = this.getDialogSpeedMultiplier(args.slice(2));

        // Create dialog with optional portrait reference for positioning
        this.dialog = new Dialog(
          text,
          speaker || undefined,
          portrait ?? undefined,
          this.getDialogTextSpeedMs(),
          dialogSpeedMult,
        );
        this.wasDialogTyping = false;

        // Don't advance pointer — it's advanced when dialog finishes (in takeInput)
        return true;
      }

      case 'wait': {
        if (this.skipMode) {
          this.advancePointer();
          return false;
        }
        this.waiting = true;
        this.waitTimer = parseInt(args[0], 10) || 1000;
        return true;
      }

      case 'transition': {
        // transition;open[;duration[;r,g,b]] — fade FROM color (reveal)
        // transition;close[;duration[;r,g,b]] — fade TO color (hide)
        // transition (no args) — same as close
        // Parse optional duration (ms) and color
        const durationArg = parseInt(args[1], 10);
        if (!isNaN(durationArg) && durationArg > 0) {
          this.transitionDurationMs = durationArg;
        } else {
          this.transitionDurationMs = 500; // default
        }
        // Parse optional color (r,g,b)
        if (args[2]) {
          const colorParts = args[2].split(',');
          if (colorParts.length >= 3) {
            this.transitionColor = `${colorParts[0].trim()},${colorParts[1].trim()},${colorParts[2].trim()}`;
          }
        } else {
          this.transitionColor = '0,0,0'; // default black
        }

        if (this.skipMode) {
          // In skip mode, apply transitions instantly
          const dir = (args[0] ?? 'close').toLowerCase();
          this.transitionAlpha = dir === 'open' ? 0 : 1;
          this.transitionFadingIn = false;
          this.transitionFadingOut = false;
          this.transitionHoldBlack = dir !== 'open';
          this.advancePointer();
          return false;
        }
        const direction = (args[0] ?? 'close').toLowerCase();
        if (direction === 'open') {
          this.transitionFadingOut = true;
          this.transitionAlpha = 1;
        } else {
          // 'close' — fade to black
          this.transitionFadingIn = true;
          this.transitionAlpha = 0;
        }
        return true;
      }

      case 'alert': {
        if (this.skipMode) {
          this.advancePointer();
          return false;
        }
        const text = args[0] ?? '';
        this.banner = new Banner(text, undefined, 3000);
        this.bannerIsAlert = true;
        // Don't advance — advanced when banner finishes (in update) or early dismissed via input
        return true;
      }

      // ----- Unit commands (instant) -----

      case 'move_unit': {
        // move_unit;UnitNid;x,y  or  move_unit;UnitNid (uses starting_position)
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit && game.board) {
          let targetPos: [number, number] | null = null;
          // Try parsing explicit position
          const posStr = args[1] ?? '';
          if (posStr) {
            const posParts = posStr.split(',').map((s: string) => parseInt(s.trim(), 10));
            if (posParts.length >= 2 && !isNaN(posParts[0]) && !isNaN(posParts[1])) {
              targetPos = [posParts[0], posParts[1]];
            }
          }
          // Fallback to starting position if no explicit position given
          if (!targetPos && unit.startingPosition) {
            targetPos = [unit.startingPosition[0], unit.startingPosition[1]];
          }
          if (targetPos) {
            game.board.moveUnit(unit, targetPos[0], targetPos[1]);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'add_unit': {
        // add_unit;unit_nid;x,y  or  add_unit;unit_nid;starting
        const unitNid = args[0] ?? '';
        const posArg = args[1] ?? 'starting';
        const existingUnit = game.units.get(unitNid) as UnitObject | undefined;
        if (existingUnit?.position || existingUnit?.isDead()) {
          this.advancePointer();
          return false;
        }

        // Look up unit data from the level definition
        const levelUnits = game.currentLevel?.units ?? [];
        const unitData = levelUnits.find((u: any) => u.nid === unitNid);
        if (!unitData) {
          console.warn(`EventState add_unit: unit "${unitNid}" not found in level data`);
          this.advancePointer();
          return false;
        }

        // Determine position override
        let posOverride: [number, number] | null = null;
        if (posArg !== 'starting' && posArg !== '' && posArg !== 'immediate') {
          const cleanPos = posArg.replace(/;.*/, ''); // strip trailing modifiers like ;immediate;stack
          const parts = cleanPos.split(',').map((s: string) => parseInt(s.trim(), 10));
          if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            posOverride = [parts[0], parts[1]];
          }
        }

        const desiredPosition = posOverride
          ?? existingUnit?.startingPosition
          ?? unitData.starting_position
          ?? null;
        const placement = (args[3] ?? 'giveup').toLowerCase().trim();
        const finalPosition = desiredPosition
          ? this._checkPlacement(desiredPosition, placement, game)
          : null;
        if (!finalPosition) {
          console.warn(`EventState add_unit: no valid position for "${unitNid}"`);
          this.advancePointer();
          return false;
        }

        if (existingUnit) {
          game.board?.setUnit(finalPosition[0], finalPosition[1], existingUnit);
          if (game.initiative) game.initiative.insertUnit(existingUnit, game.db);
        } else {
          // Spawn the unit — handle both unique and generic
          this.spawnUnitFromLevelData(unitData, finalPosition, game);
        }

        this.advancePointer();
        return false;
      }

      case 'remove_unit': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit && game.board) {
          // Remove from initiative tracker if active
          if (game.initiative) {
            game.initiative.removeUnit(unit);
          }
          game.board.removeUnit(unit);
          game.units.delete(unitNid);
        }
        this.advancePointer();
        return false;
      }

      case 'kill_unit': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) {
          // Remove from initiative tracker if active
          if (game.initiative) {
            game.initiative.removeUnit(unit);
          }
          unit.dead = true;
          unit.currentHp = 0;
          if (game.board) {
            game.board.removeUnit(unit);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'add_group': {
        // add_group;GroupNid;StartingGroup;EntryType;Placement
        // StartingGroup: empty=group's own positions, 'starting'=unit.startingPosition,
        //   'x,y'=literal coords (all units), or another group NID's positions
        // EntryType: fade (default), immediate, warp, swoosh
        // Placement: giveup (default), stack, closest, push
        const groupNid = args[0] ?? '';
        const startingGroup = args[1] ?? '';
        // args[2] = entry type (ignored for now — all entries are immediate)
        const placement = (args[3] ?? 'giveup').toLowerCase().trim();
        const groups: any[] = game.currentLevel?.unit_groups ?? [];
        const group = groups.find((g: any) => g.nid === groupNid);
        if (!group) {
          console.warn(`EventState add_group: group "${groupNid}" not found`);
          this.advancePointer();
          return false;
        }

        const unitNids: string[] = group.units ?? [];
        const levelUnits = game.currentLevel?.units ?? [];

        for (const uNid of unitNids) {
          // Skip if already on map or dead
          const existing = this.findUnit(uNid);
          if (existing?.position || existing?.isDead()) continue;
          // If not spawned yet, skip units that are already in the registry
          if (existing && existing.position) continue;

          const position = this._getGroupPosition(startingGroup, uNid, group, groups, game);
          if (!position) continue;

          const finalPos = this._checkPlacement(position, placement, game);
          if (!finalPos) continue;

          // Need to spawn the unit first if not yet in registry
          if (!existing) {
            let unitData = levelUnits.find((u: any) => u.nid === uNid);
            if (!unitData) {
              const dbUnit = game.db.units.get(uNid);
              if (dbUnit) {
                unitData = { ...dbUnit, generic: false, team: 'enemy', ai: 'Normal' };
              } else {
                continue;
              }
            }
            this.spawnUnitFromLevelData(unitData, finalPos, game);
          } else {
            // Unit exists but not on map — place them
            if (game.board) {
              game.board.moveUnit(existing, finalPos[0], finalPos[1]);
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'spawn_group': {
        // spawn_group;GroupNid;CardinalDirection;StartingGroup;MovementType;Placement
        // Units appear at map edge, then walk to their destination position.
        const groupNid = args[0] ?? '';
        const direction = (args[1] ?? 'south').toLowerCase().trim();
        const startingGroup = args[2] ?? '';
        // args[3] = movement type (normal/immediate/warp/fade; all treated as immediate for now)
        const placement = (args[4] ?? 'giveup').toLowerCase().trim();
        const groups: any[] = game.currentLevel?.unit_groups ?? [];
        const group = groups.find((g: any) => g.nid === groupNid);
        if (!group) {
          console.warn(`EventState spawn_group: group "${groupNid}" not found`);
          this.advancePointer();
          return false;
        }

        const unitNids: string[] = group.units ?? [];
        const levelUnits = game.currentLevel?.units ?? [];
        const tilemap = game.tilemap;
        const mapW = tilemap?.width ?? 20;
        const mapH = tilemap?.height ?? 20;

        for (const uNid of unitNids) {
          const existing = this.findUnit(uNid);
          if (existing?.position || existing?.isDead()) continue;

          const destPos = this._getGroupPosition(startingGroup, uNid, group, groups, game);
          if (!destPos) continue;

          const finalDest = this._checkPlacement(destPos, placement, game);
          if (!finalDest) continue;

          // Compute edge spawn position
          let edgePos: [number, number];
          if (direction === 'north') {
            edgePos = [finalDest[0], 0];
          } else if (direction === 'south') {
            edgePos = [finalDest[0], mapH - 1];
          } else if (direction === 'west') {
            edgePos = [0, finalDest[1]];
          } else {
            edgePos = [mapW - 1, finalDest[1]]; // east
          }

          // Spawn or place the unit at the edge first
          if (!existing) {
            let unitData = levelUnits.find((u: any) => u.nid === uNid);
            if (!unitData) {
              const dbUnit = game.db.units.get(uNid);
              if (dbUnit) {
                unitData = { ...dbUnit, generic: false, team: 'enemy', ai: 'Normal' };
              } else {
                continue;
              }
            }
            this.spawnUnitFromLevelData(unitData, edgePos, game);
          } else {
            if (game.board) {
              game.board.moveUnit(existing, edgePos[0], edgePos[1]);
            }
          }

          // Now move the unit from edge to destination
          const spawnedUnit = this.findUnit(uNid);
          if (spawnedUnit && game.board) {
            game.board.moveUnit(spawnedUnit, finalDest[0], finalDest[1]);
          }
        }
        // TODO: In Python, spawn_group pauses for movement animation unless no_block.
        // For now, units teleport instantly. Movement animation can be added later.
        this.advancePointer();
        return false;
      }

      case 'remove_group': {
        const groupNid = args[0] ?? '';
        const groups: any[] = game.currentLevel?.unit_groups ?? [];
        const group = groups.find((g: any) => g.nid === groupNid);
        if (group) {
          const unitNids: string[] = group.units ?? [];
          for (const uNid of unitNids) {
            const unit = this.findUnit(uNid);
            if (unit) {
              if (game.board) game.board.removeUnit(unit);
              game.units.delete(uNid);
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'move_group': {
        // move_group;GroupNid;StartingGroup;MovementType;Placement
        const groupNid = args[0] ?? '';
        const startingGroup = args[1] ?? '';
        // args[2] = movement type (ignored — all teleport for now)
        const placement = (args[3] ?? 'giveup').toLowerCase().trim();
        const groups: any[] = game.currentLevel?.unit_groups ?? [];
        const group = groups.find((g: any) => g.nid === groupNid);
        if (group && game.board) {
          const unitNids: string[] = group.units ?? [];
          for (const uNid of unitNids) {
            const unit = this.findUnit(uNid);
            if (!unit?.position) continue; // skip units not on map
            const destPos = this._getGroupPosition(startingGroup, uNid, group, groups, game);
            if (!destPos) continue;
            const finalPos = this._checkPlacement(destPos, placement, game);
            if (!finalPos) continue;
            game.board.moveUnit(unit, finalPos[0], finalPos[1]);
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Item / Skill commands (instant) -----

      case 'give_item': {
        // give_item;unit_nid;item_nid — give an item to a unit
        // If unit_nid is 'convoy', put it directly in the convoy
        const giUnitNid = args[0] ?? '';
        const giItemNid = args[1] ?? '';
        const giItemPrefab = game.db.items.get(giItemNid);
        if (giItemPrefab) {
          const giItem = new ItemObjectClass(giItemPrefab);
          if (giUnitNid.toLowerCase() === 'convoy') {
            // Put directly in convoy
            const giParty = game.getParty();
            if (giParty) {
              giItem.owner = null;
              giParty.convoy.push(giItem);
              game.items.set(`convoy_${giItem.nid}_${giParty.convoy.length}`, giItem);
            }
          } else {
            const giUnit = this.findUnit(giUnitNid);
            if (giUnit) {
              giItem.owner = giUnit;
              giUnit.items.push(giItem);
              game.items.set(`${giUnit.nid}_${giItem.nid}_${giUnit.items.length}`, giItem);
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'remove_item': {
        const unitNid = args[0] ?? '';
        const itemNid = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) {
          const idx = unit.items.findIndex((i: ItemObject) => i.nid === itemNid);
          if (idx !== -1) {
            unit.items.splice(idx, 1);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'give_skill': {
        const unitNid = args[0] ?? '';
        const skillNid = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        const skillPrefab = game.db.skills.get(skillNid);
        if (unit && skillPrefab) {
          // Don't add duplicate skills
          if (!unit.skills.some((s: any) => s.nid === skillNid)) {
            const skill = new SkillObject(skillPrefab);
            unit.skills.push(skill);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'remove_skill': {
        const unitNid = args[0] ?? '';
        const skillNid = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) {
          const idx = unit.skills.findIndex((s: any) => s.nid === skillNid);
          if (idx !== -1) {
            unit.skills.splice(idx, 1);
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Stat / Property commands (instant) -----

      case 'set_current_hp': {
        const unitNid = args[0] ?? '';
        const hpValue = parseInt(args[1], 10);
        const unit = this.findUnit(unitNid);
        if (unit && !isNaN(hpValue)) {
          unit.currentHp = Math.max(0, Math.min(hpValue, unit.maxHp));
        }
        this.advancePointer();
        return false;
      }

      case 'give_exp': {
        const unitNid = args[0] ?? '';
        const amount = parseInt(args[1], 10) || 0;
        const unit = this.findUnit(unitNid);
        if (unit) {
          unit.exp = (unit.exp ?? 0) + amount;
          // Level up if exp >= 100
          while (unit.exp >= 100) {
            unit.exp -= 100;
            unit.levelUp();
          }
        }
        this.advancePointer();
        return false;
      }

      case 'change_ai': {
        const unitNid = args[0] ?? '';
        const aiNid = args[1] ?? 'None';
        const unit = this.findUnit(unitNid);
        if (unit) {
          unit.ai = aiNid;
        }
        this.advancePointer();
        return false;
      }

      case 'change_team': {
        const unitNid = args[0] ?? '';
        const team = args[1] ?? 'player';
        const unit = this.findUnit(unitNid);
        if (unit) {
          unit.team = team;
          // Re-palette the sprite (would need async reload in full implementation)
        }
        this.advancePointer();
        return false;
      }

      case 'change_stats': {
        // change_stats;unit_nid;HP,2,STR,1,DEF,-1
        const unitNid = args[0] ?? '';
        const changes = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit && changes) {
          const parts = changes.split(',');
          for (let i = 0; i < parts.length - 1; i += 2) {
            const stat = parts[i].trim();
            const delta = parseInt(parts[i + 1], 10);
            if (stat && !isNaN(delta) && unit.stats[stat] !== undefined) {
              unit.stats[stat] += delta;
              // If HP stat changed, adjust currentHp
              if (stat === 'HP') {
                unit.currentHp = Math.min(unit.currentHp + Math.max(0, delta), unit.maxHp);
              }
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'add_tag': {
        const unitNid = args[0] ?? '';
        const tag = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit && tag && !unit.tags.includes(tag)) {
          unit.tags.push(tag);
        }
        this.advancePointer();
        return false;
      }

      case 'remove_tag': {
        const unitNid = args[0] ?? '';
        const tag = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit && tag) {
          const idx = unit.tags.indexOf(tag);
          if (idx !== -1) unit.tags.splice(idx, 1);
        }
        this.advancePointer();
        return false;
      }

      // ----- Game variable commands (instant) -----

      case 'game_var':
      case 'set_game_var': {
        const varName = args[0] ?? '';
        const value = args[1] ?? 'true';
        if (varName && game.gameVars) {
          game.gameVars.set(varName, value);
        }
        this.advancePointer();
        return false;
      }

      case 'inc_game_var': {
        const varName = args[0] ?? '';
        if (varName && game.gameVars) {
          const current = Number(game.gameVars.get(varName) ?? 0);
          game.gameVars.set(varName, current + 1);
        }
        this.advancePointer();
        return false;
      }

      case 'set_next_chapter': {
        // Override sequential level progression: set _goto_level to a specific chapter NID.
        // Matches Python: action.do(action.SetGameVar("_goto_level", chapter))
        const chapterNid = args[0] ?? '';
        if (chapterNid) {
          if (!game.db.levels.has(chapterNid)) {
            console.warn(`set_next_chapter: "${chapterNid}" is not a valid chapter nid`);
          } else {
            game.gameVars.set('_goto_level', chapterNid);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'level_var': {
        const varName = args[0] ?? '';
        const value = args[1] ?? 'true';
        if (varName && game.levelVars) {
          game.levelVars.set(varName, value);
        }
        this.advancePointer();
        return false;
      }

      case 'inc_level_var': {
        const varName = args[0] ?? '';
        if (varName && game.levelVars) {
          const current = Number(game.levelVars.get(varName) ?? 0);
          game.levelVars.set(varName, current + 1);
        }
        this.advancePointer();
        return false;
      }

      // ----- Audio commands -----

      case 'music':
      case 'change_music': {
        // change_music can be called two ways:
        // 1. music;musicNid (direct play)
        // 2. change_music;phase_type;musicNid (change phase music)
        // Phase types: player_phase, enemy_phase, other_phase, player_battle, enemy_battle
        const phaseTypes = ['player_phase', 'enemy_phase', 'other_phase', 'player_battle', 'enemy_battle'];
        let musicNid: string;
        if (args.length >= 2 && phaseTypes.includes(args[0])) {
          // Phase variant: args[0] is phase type, args[1] is music NID
          // TODO: actually store the phase music override for the level
          musicNid = args[1];
        } else {
          musicNid = args[0] ?? '';
        }
        if (musicNid && game.audioManager) {
          game.audioManager.playMusic(musicNid);
        }
        this.advancePointer();
        // Music is treated as blocking briefly to let the transition feel natural
        this.waiting = true;
        this.waitTimer = 100;
        return true;
      }

      case 'sound': {
        const soundNid = args[0] ?? '';
        if (soundNid && game.audioManager) {
          game.audioManager.playSfx(soundNid);
        }
        this.advancePointer();
        return false;
      }

      // ----- Win / Lose (instant — they change the state machine) -----

      case 'win_game': {
        // Matches Python: just set the flag — the actual level transition
        // happens in finishAndDequeue() after the event completes, allowing
        // remaining event commands (e.g., dialog, transitions) to run first.
        game.levelVars.set('_win_game', true);
        this.advancePointer();
        return false;
      }

      case 'lose_game': {
        game.levelVars.set('_lose_game', true);
        this.advancePointer();
        return false;
      }

      // ----- Turn management -----

      case 'has_attacked': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) unit.hasAttacked = true;
        this.advancePointer();
        return false;
      }

      case 'has_finished': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) unit.finished = true;
        this.advancePointer();
        return false;
      }

      case 'reset': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) unit.resetTurnState();
        this.advancePointer();
        return false;
      }

      // ----- Audio extended -----

      case 'music_fade_back': {
        // Restore the previous music (pop the stack)
        if (game.audioManager) {
          void game.audioManager.popMusic();
        }
        this.advancePointer();
        return false;
      }

      case 'music_clear': {
        if (game.audioManager) {
          game.audioManager.stopMusic();
        }
        this.advancePointer();
        return false;
      }

      case 'stop_sound': {
        // SFX are fire-and-forget — no way to stop them currently
        this.advancePointer();
        return false;
      }

      // ----- Camera / cursor commands -----

      case 'center_cursor':
      case 'move_cursor': {
        // center_cursor;x,y or center_cursor;UnitNid
        const posOrUnit = args[0] ?? '';
        const resolved = this.resolvePosition(posOrUnit, game);
        if (resolved) {
          game.cursor?.setPos(resolved[0], resolved[1]);
          game.camera?.focusTile(resolved[0], resolved[1]);
        }
        this.advancePointer();
        return false;
      }

      case 'disp_cursor': {
        // disp_cursor;true/false — show or hide cursor
        const show = (args[0] ?? 'true').toLowerCase();
        if (game.cursor) {
          game.cursor.visible = show !== 'false' && show !== '0';
        }
        this.advancePointer();
        return false;
      }

      case 'screen_shake': {
        // screen_shake;duration;shake_type;flags
        // shake_type: default, combat, kill, random, celeste (default: 'default')
        // flags: no_block
        const durationMs = parseInt(args[0], 10) || 500;
        const shakeType = (args[1] ?? 'default').toLowerCase().trim();
        const noBlock = args.some((a: string) => a.toLowerCase().trim() === 'no_block');
        if (game.camera) {
          game.camera.setShake(shakeType, durationMs);
        }
        if (noBlock || this.skipMode) {
          this.advancePointer();
          return false;
        }
        // Block for the shake duration
        this.waitTimer = durationMs;
        this.waiting = true;
        return true;
      }

      case 'screen_shake_end': {
        if (game.camera) {
          game.camera.resetShake();
        }
        this.advancePointer();
        return false;
      }

      case 'flicker_cursor': {
        // Briefly highlight a tile — move camera and cursor there
        const flickerTarget = args[0] ?? '';
        const flickerPos = this.resolvePosition(flickerTarget, game);
        if (flickerPos) {
          game.cursor?.setPos(flickerPos[0], flickerPos[1]);
          game.camera?.focusTile(flickerPos[0], flickerPos[1]);
        }
        this.advancePointer();
        return false;
      }

      // ----- Objective changes -----

      case 'change_objective_simple':
      case 'change_objective': {
        const newObj = args[0] ?? '';
        if (game.currentLevel?.objective) {
          game.currentLevel.objective.simple = newObj;
        }
        this.advancePointer();
        return false;
      }

      case 'change_objective_win': {
        const newWin = args[0] ?? '';
        if (game.currentLevel?.objective) {
          game.currentLevel.objective.win = newWin;
        }
        this.advancePointer();
        return false;
      }

      case 'change_objective_loss': {
        const newLoss = args[0] ?? '';
        if (game.currentLevel?.objective) {
          game.currentLevel.objective.loss = newLoss;
        }
        this.advancePointer();
        return false;
      }

      // ----- Money / BExp -----

      case 'give_money': {
        // give_money;amount[;party_nid]
        const amount = parseInt(args[0], 10) || 0;
        const moneyPartyNid = args[1] || undefined;
        const party = game.getParty(moneyPartyNid);
        if (party) {
          const clampedAmount = party.money + amount < 0 ? -party.money : amount;
          party.money += clampedAmount;
        }
        // Also update legacy gameVars for backward compatibility
        game.gameVars.set('money', game.getMoney());
        this.advancePointer();
        return false;
      }

      case 'give_bexp': {
        // give_bexp;amount[;party_nid]
        const bexpAmount = parseInt(args[0], 10) || 0;
        const bexpPartyNid = args[1] || undefined;
        const bexpParty = game.getParty(bexpPartyNid);
        if (bexpParty) {
          bexpParty.bexp = Math.max(0, bexpParty.bexp + bexpAmount);
        }
        // Also update legacy gameVars for backward compatibility
        game.gameVars.set('bexp', game.getBexp());
        this.advancePointer();
        return false;
      }

      // ----- Convoy / Party commands -----

      case 'enable_convoy': {
        // enable_convoy — enables or disables convoy access
        // Sets the _convoy game variable
        game.gameVars.set('_convoy', true);
        this.advancePointer();
        return false;
      }

      case 'disable_convoy': {
        game.gameVars.set('_convoy', false);
        this.advancePointer();
        return false;
      }

      case 'change_party': {
        // change_party;unit_nid;party_nid — assigns a unit to a different party
        const cpUnitNid = args[0] ?? '';
        const cpPartyNid = args[1] ?? '';
        const cpUnit = this.findUnit(cpUnitNid);
        if (cpUnit && cpPartyNid) {
          cpUnit.party = cpPartyNid;
        }
        this.advancePointer();
        return false;
      }

      case 'open_convoy': {
        // open_convoy — opens the convoy/supply UI (stub for now)
        // This would push a supply_items state; currently just skip
        console.warn('open_convoy: convoy UI not yet implemented');
        this.advancePointer();
        return false;
      }

      // ----- Talk management -----

      case 'add_talk': {
        // add_talk;unit1_nid;unit2_nid
        if (game.eventManager && args.length >= 2) {
          game.eventManager.addTalkPair(args[0], args[1]);
        }
        this.advancePointer();
        return false;
      }

      case 'remove_talk': {
        if (game.eventManager && args.length >= 2) {
          game.eventManager.removeTalkPair(args[0], args[1]);
        }
        this.advancePointer();
        return false;
      }

      case 'hide_talk':
      case 'unhide_talk': {
        // Talk visibility toggling — not yet tracked visually
        this.advancePointer();
        return false;
      }

      // ----- End turn -----

      case 'end_turn': {
        // Finish this event, then trigger a turn change
        if (this.currentEvent) this.currentEvent.finish();
        game.eventManager?.dequeueCurrentEvent();
        this.currentEvent = null;
        game.state.back();
        game.state.change('turn_change');
        return true;
      }

      // ----- Unit property modifications -----

      case 'set_name': {
        const unitNid = args[0] ?? '';
        const newName = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) unit.name = newName;
        this.advancePointer();
        return false;
      }

      case 'equip_item': {
        // equip_item;unit_nid;item_nid — move item to front of inventory
        const unitNid2 = args[0] ?? '';
        const itemNid = args[1] ?? '';
        const unit2 = this.findUnit(unitNid2);
        if (unit2) {
          const idx = unit2.items.findIndex((it: any) => it.nid === itemNid);
          if (idx > 0) {
            const [item] = unit2.items.splice(idx, 1);
            unit2.items.unshift(item);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'set_current_mana': {
        const unitNid3 = args[0] ?? '';
        const mana = parseInt(args[1], 10);
        const unit3 = this.findUnit(unitNid3);
        if (unit3 && !isNaN(mana)) {
          (unit3 as any).currentMana = Math.max(0, mana);
        }
        this.advancePointer();
        return false;
      }

      case 'has_traded': {
        const unitNid4 = args[0] ?? '';
        const unit4 = this.findUnit(unitNid4);
        if (unit4) unit4.hasTraded = true;
        this.advancePointer();
        return false;
      }

      case 'set_exp': {
        const unitNid5 = args[0] ?? '';
        const expVal = parseInt(args[1], 10);
        const unit5 = this.findUnit(unitNid5);
        if (unit5 && !isNaN(expVal)) {
          unit5.exp = Math.max(0, Math.min(99, expVal));
        }
        this.advancePointer();
        return false;
      }

      case 'set_stats': {
        // set_stats;unit_nid;HP,STR,MAG,SKL,SPD,LCK,DEF,RES
        const unitNid6 = args[0] ?? '';
        const statsStr = args[1] ?? '';
        const unit6 = this.findUnit(unitNid6);
        if (unit6 && statsStr) {
          const statNames = ['hp', 'str', 'mag', 'skl', 'spd', 'lck', 'def', 'res'];
          const values = statsStr.split(',').map((v: string) => parseInt(v, 10));
          for (let i = 0; i < Math.min(values.length, statNames.length); i++) {
            if (!isNaN(values[i])) {
              (unit6 as any)[statNames[i]] = values[i];
            }
          }
          // Clamp HP
          if (unit6.currentHp > unit6.maxHp) unit6.currentHp = unit6.maxHp;
        }
        this.advancePointer();
        return false;
      }

      case 'promote': {
        // promote;unit_nid;[class_nid1,class_nid2,...];[silent]
        // If silent + single class: apply immediately with stat changes
        // If not silent or multiple classes: for now, treat as silent with first class
        const promoUnitNid = args[0] ?? '';
        const promoUnit = this.findUnit(promoUnitNid);
        if (promoUnit) {
          const klassListStr = args[1] ?? '';
          const isSilent = args.some((a: string) => a.toLowerCase() === 'silent');
          let klassList = klassListStr
            ? klassListStr.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
            : [];

          // If no class list given, use the class's turns_into
          if (klassList.length === 0) {
            const currentKlass = game.db.classes.get(promoUnit.klass);
            if (currentKlass && currentKlass.turns_into && currentKlass.turns_into.length > 0) {
              klassList = [...currentKlass.turns_into];
            }
          }

          if (klassList.length > 0) {
            // Use the first class (for multi-class, a choice UI would be needed)
            const newKlass = klassList[0];
            const promoAction = new PromoteAction(promoUnit, newKlass);
            game.actionLog.doAction(promoAction);

            // Grant new class skills
            this.grantClassSkills(promoUnit, game);

            // Apply new weapon experience
            const { newWexp } = promoAction.getData();
            if (newWexp) {
              for (const [weaponNid, value] of Object.entries(newWexp)) {
                if (value > 0) {
                  const current = promoUnit.wexp[weaponNid] ?? 0;
                  promoUnit.wexp[weaponNid] = Math.max(current, value);
                }
              }
            }

            // Reload map sprite for new class
            this.loadMapSpriteForUnit(promoUnit, game);
          } else {
            console.warn(`promote: no promotion classes available for unit "${promoUnitNid}"`);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'change_class': {
        // change_class;unit_nid;[class_nid1,class_nid2,...];[silent]
        // If silent + single class: apply immediately with stat changes
        // If not silent or multiple classes: for now, treat as silent with first class
        const ccUnitNid = args[0] ?? '';
        const ccUnit = this.findUnit(ccUnitNid);
        if (ccUnit) {
          const ccKlassListStr = args[1] ?? '';
          const ccIsSilent = args.some((a: string) => a.toLowerCase() === 'silent');
          let ccKlassList = ccKlassListStr
            ? ccKlassListStr.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
            : [];

          // If no class list given, use the class's turns_into as a fallback
          if (ccKlassList.length === 0) {
            const currentKlass = game.db.classes.get(ccUnit.klass);
            if (currentKlass && currentKlass.turns_into && currentKlass.turns_into.length > 0) {
              ccKlassList = [...currentKlass.turns_into];
            }
          }

          if (ccKlassList.length > 0) {
            const newKlass = ccKlassList[0];
            if (newKlass !== ccUnit.klass) {
              const ccAction = new ClassChangeAction(ccUnit, newKlass);
              game.actionLog.doAction(ccAction);

              // Grant new class skills
              this.grantClassSkills(ccUnit, game);

              // Apply new weapon experience
              const { newWexp } = ccAction.getData();
              if (newWexp) {
                for (const [weaponNid, value] of Object.entries(newWexp)) {
                  if (value > 0) {
                    const current = ccUnit.wexp[weaponNid] ?? 0;
                    ccUnit.wexp[weaponNid] = Math.max(current, value);
                  }
                }
              }

              // Reload map sprite for new class
              this.loadMapSpriteForUnit(ccUnit, game);
            }
          } else {
            console.warn(`change_class: no class options available for unit "${ccUnitNid}"`);
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Choice menu -----

      case 'choice': {
        // choice;header;option1,option2,option3
        const _header = args[0] ?? 'Choose';
        const optionStrs = (args[1] ?? '').split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
        if (optionStrs.length > 0) {
          const menuOptions: MenuOption[] = optionStrs.map((s: string) => ({
            label: s,
            value: s,
            enabled: true,
          }));
          // Center the menu on screen
          const menuX = 80;
          const menuY = 40;
          this.choiceMenu = new ChoiceMenu(menuOptions, menuX, menuY);
          return true; // block until user picks
        }
        this.advancePointer();
        return false;
      }

      case 'unchoice': {
        this.choiceResult = null;
        this.advancePointer();
        return false;
      }

      // ----- Remove all units / enemies -----

      case 'remove_all_enemies': {
        const enemies = game.board?.getTeamUnits('enemy') ?? [];
        for (const enemy of enemies) {
          game.board?.removeUnit(enemy);
          game.units.delete(enemy.nid);
        }
        this.advancePointer();
        return false;
      }

      case 'remove_all_units': {
        const allUnits = game.board?.getAllUnits() ?? [];
        for (const u of allUnits) {
          game.board?.removeUnit(u);
          game.units.delete(u.nid);
        }
        this.advancePointer();
        return false;
      }

      // ----- Region management -----

      case 'add_region': {
        // add_region;NID;Position;Size;RegionType;SubNid;TimeLeft;flags
        // Example: add_region;MyRegion;5,6;1,1;event;Visit;only_once
        const regionNid = args[0] ?? '';
        const posStr = args[1] ?? '0,0';
        const sizeStr = args[2] ?? '1,1';
        const regionType = (args[3] ?? 'normal').toLowerCase();
        const subNid = args[4] ?? '';
        // Time left could be in args[5], flags could be scattered in remaining args
        let timeLeft: number | null = null;
        let onlyOnce = false;
        let interruptMove = false;
        let hideTime = false;
        for (let i = 5; i < args.length; i++) {
          const a = args[i].toLowerCase().trim();
          if (a === 'only_once') onlyOnce = true;
          else if (a === 'interrupt_move') interruptMove = true;
          else if (a === 'true' || a === 'false') hideTime = a === 'true';
          else {
            const n = parseInt(a, 10);
            if (!isNaN(n) && timeLeft === null) timeLeft = n;
          }
        }

        // Parse position
        const posParts = posStr.split(',').map((s: string) => parseInt(s.trim(), 10));
        const pos: [number, number] = [posParts[0] || 0, posParts[1] || 0];

        // Parse size
        const sizeParts = sizeStr.split(',').map((s: string) => parseInt(s.trim(), 10));
        const size: [number, number] = [sizeParts[0] || 1, sizeParts[1] || 1];

        // Check for duplicate NID
        if (game.currentLevel?.regions?.some((r: RegionData) => r.nid === regionNid)) {
          console.warn(`add_region: Region "${regionNid}" already exists`);
          this.advancePointer();
          return false;
        }

        const newRegion: RegionData = {
          nid: regionNid,
          region_type: regionType,
          position: pos,
          size: size,
          sub_nid: subNid,
          condition: 'True',
          time_left: timeLeft,
          only_once: onlyOnce,
          interrupt_move: interruptMove,
          hide_time: hideTime,
        };

        if (!game.currentLevel) {
          this.advancePointer();
          return false;
        }
        if (!game.currentLevel.regions) {
          game.currentLevel.regions = [];
        }
        game.currentLevel.regions.push(newRegion);
        this.advancePointer();
        return false;
      }

      case 'remove_region': {
        const regionNid = args[0] ?? '';
        if (game.currentLevel?.regions) {
          game.currentLevel.regions = game.currentLevel.regions.filter(
            (r: RegionData) => r.nid !== regionNid
          );
        }
        this.advancePointer();
        return false;
      }

      case 'region_condition': {
        // region_condition;RegionNID;ConditionExpression
        const rcNid = args[0] ?? '';
        const rcCondition = args[1] ?? 'True';
        if (game.currentLevel?.regions) {
          const reg = game.currentLevel.regions.find((r: RegionData) => r.nid === rcNid);
          if (reg) {
            reg.condition = rcCondition;
          } else {
            console.warn(`region_condition: Region "${rcNid}" not found`);
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Map animations -----

      case 'map_anim': {
        // map_anim;AnimNid;Position;[Speed];[flags]
        // Position: x,y or (x,y) or UnitNid
        // flags: no_block, permanent, overlay
        const maAnimNid = args[0] ?? '';
        const maPosArg = args[1] ?? '';
        const maSpeedArg = args[2] ?? '1';
        const maFlagsStr = args.slice(3).join(';').toLowerCase();
        const maNoBlock = maFlagsStr.includes('no_block');
        const maPermanent = maFlagsStr.includes('permanent');
        const maOverlay = maFlagsStr.includes('overlay');

        const maPrefab = game.db?.mapAnimations?.get(maAnimNid);
        if (!maPrefab) {
          console.warn(`map_anim: animation "${maAnimNid}" not found`);
          this.advancePointer();
          return false;
        }

        // Parse position
        let maX = 0, maY = 0;
        const maPosMatch = maPosArg.match(/\(?(\d+),\s*(\d+)\)?/);
        if (maPosMatch) {
          maX = parseInt(maPosMatch[1], 10);
          maY = parseInt(maPosMatch[2], 10);
        } else {
          // Try as unit NID
          const maUnit = game.units.get(maPosArg);
          if (maUnit?.position) {
            maX = maUnit.position[0];
            maY = maUnit.position[1];
          }
        }

        const maSpeed = parseFloat(maSpeedArg) || 1;

        // Create animation
        const mapAnim = new MapAnimation(maPrefab, maX, maY, {
          loop: maPermanent,
          speedAdj: maSpeed,
        });

        // Load the sprite sheet asynchronously (animation starts once loaded)
        void game.resources.loadImage(`resources/animations/${maAnimNid}.png`).then((maImg: HTMLImageElement) => {
          if (maImg) mapAnim.setImage(maImg);
        }).catch(() => {
          console.warn(`map_anim: failed to load sprite sheet for "${maAnimNid}"`);
        });

        // Add to tilemap
        if (game.tilemap) {
          if (maOverlay) {
            game.tilemap.highAnimations.push(mapAnim);
          } else {
            game.tilemap.animations.push(mapAnim);
          }
        }

        this.advancePointer();
        if (maNoBlock || maPermanent) {
          return false;
        }
        // Block for animation duration
        this.waiting = true;
        this.waitTimer = mapAnim.getDuration();
        return true;
      }

      case 'remove_map_anim': {
        // remove_map_anim;AnimNid
        const rmaAnimNid = args[0] ?? '';
        if (game.tilemap) {
          game.tilemap.animations = game.tilemap.animations.filter((a: MapAnimation) => a.nid !== rmaAnimNid);
          game.tilemap.highAnimations = game.tilemap.highAnimations.filter((a: MapAnimation) => a.nid !== rmaAnimNid);
        }
        this.advancePointer();
        return false;
      }

      // ----- Tilemap commands -----

      case 'change_tilemap': {
        // change_tilemap;TilemapNid[;PositionOffset;reload]
        const tmNid = args[0] ?? '';
        if (tmNid) {
          // Async: block the event until the tilemap is loaded
          this.waiting = true;
          game.changeTilemap(tmNid).then(() => {
            this.waiting = false;
            this.advancePointer();
          });
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'show_layer': {
        const layerNid = args[0] ?? '';
        if (game.tilemap) {
          game.tilemap.showLayer(layerNid);
        }
        this.advancePointer();
        return false;
      }

      case 'hide_layer': {
        const layerNid2 = args[0] ?? '';
        if (game.tilemap) {
          game.tilemap.hideLayer(layerNid2);
        }
        this.advancePointer();
        return false;
      }

      // ----- Weather -----

      case 'add_weather': {
        // add_weather;nid
        const weatherNid = (args[0] ?? '').toLowerCase();
        if (weatherNid && game.tilemap) {
          game.tilemap.addWeather(weatherNid);
        }
        this.advancePointer();
        return false;
      }

      case 'remove_weather': {
        // remove_weather;nid
        const weatherNid2 = (args[0] ?? '').toLowerCase();
        if (weatherNid2 && game.tilemap) {
          game.tilemap.removeWeather(weatherNid2);
        }
        this.advancePointer();
        return false;
      }

      // ----- Modify game var (arithmetic) -----

      case 'modify_game_var': {
        // modify_game_var;name;expression
        const gvarName = args[0] ?? '';
        const gvarExpr = args[1] ?? '0';
        const gvarVal = parseInt(gvarExpr, 10);
        if (!isNaN(gvarVal)) {
          game.gameVars.set(gvarName, gvarVal);
        }
        this.advancePointer();
        return false;
      }

      case 'modify_level_var': {
        const lvarName = args[0] ?? '';
        const lvarExpr = args[1] ?? '0';
        const lvarVal = parseInt(lvarExpr, 10);
        if (!isNaN(lvarVal)) {
          game.levelVars.set(lvarName, lvarVal);
        }
        this.advancePointer();
        return false;
      }

      // ----- For loops -----

      case 'for': {
        // for;varName;value1,value2,value3
        const forVar = args[0] ?? '_i';
        const forValues = (args[1] ?? '').split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
        if (forValues.length === 0) {
          // Empty loop — skip to matching endf
          const commands = this.currentEvent!.commands;
          let depth = 0;
          for (let i = this.currentEvent!.commandPointer + 1; i < commands.length; i++) {
            if (commands[i].type === 'for') depth++;
            if (commands[i].type === 'endf') {
              if (depth === 0) {
                this.currentEvent!.commandPointer = i + 1;
                return false;
              }
              depth--;
            }
          }
          this.currentEvent!.commandPointer = this.currentEvent!.commands.length;
          return false;
        }
        // Push loop context and set first value
        this.forLoopStack.push({
          varName: forVar,
          values: forValues,
          currentIndex: 0,
          startPointer: this.currentEvent!.commandPointer + 1,
        });
        game.gameVars.set(forVar, forValues[0]);
        this.advancePointer();
        return false;
      }

      case 'endf': {
        const loopCtx = this.forLoopStack[this.forLoopStack.length - 1];
        if (loopCtx) {
          loopCtx.currentIndex++;
          if (loopCtx.currentIndex < loopCtx.values.length) {
            // Set next value and jump back to loop start
            game.gameVars.set(loopCtx.varName, loopCtx.values[loopCtx.currentIndex]);
            this.currentEvent!.commandPointer = loopCtx.startPointer;
            return false;
          } else {
            // Loop complete — pop and advance past endf
            this.forLoopStack.pop();
            this.advancePointer();
            return false;
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Portrait commands -----
      case 'add_portrait': {
        // add_portrait;PortraitNid;ScreenPosition;[Slide];[ExpressionList]
        // flags (in args): mirror, immediate, no_block, low_priority, low_saturation
        const portraitNid = args[0] ?? '';
        const positionStr = args[1] ?? 'Left';
        // Remaining args may be slide, expressions, or flags
        const extraArgs = args.slice(2).map(s => s.toLowerCase().trim());
        const knownFlags = new Set(['mirror', 'immediate', 'no_block', 'low_priority', 'low_saturation']);

        // Separate flags from positional args
        const pFlags = extraArgs.filter(a => knownFlags.has(a));
        const pArgs = extraArgs.filter(a => !knownFlags.has(a));

        const slideArg = pArgs[0] ?? '';
        const expressionArg = pArgs[1] ?? '';

        if (!portraitNid) {
          this.advancePointer();
          return false;
        }

        // Resolve portrait NID: try unit portrait_nid first, then direct
        const game = getGame();
        let resolvedNid = portraitNid;
        const unitPrefab = game.db?.units.get(portraitNid);
        if (unitPrefab && unitPrefab.portrait_nid) {
          resolvedNid = unitPrefab.portrait_nid;
        }

        // Get portrait metadata
        const portraitMeta = game.db?.portraits.get(resolvedNid);
        const blinkOffset: [number, number] = portraitMeta?.blinking_offset ?? [24, 32];
        const smileOffset: [number, number] = portraitMeta?.smiling_offset ?? [16, 48];

        // Parse position
        const { position: pos, mirror: autoMirror } = parseScreenPosition(positionStr);

        // Parse slide
        const slide: 'left' | 'right' | null =
          slideArg === 'left' ? 'left' :
          slideArg === 'right' ? 'right' : null;

        // Parse expressions
        const expressions = expressionArg
          ? expressionArg.split(',').map(s => s.trim()).filter(Boolean)
          : [];

        // Check flags
        const isMirror = pFlags.includes('mirror') ? !autoMirror : autoMirror;
        const immediate = pFlags.includes('immediate');
        const lowPriority = pFlags.includes('low_priority');

        const priority = lowPriority ? 0 : this.portraitPriorityCounter++;

        // Load portrait image asynchronously. Block command processing until
        // the image is ready — in the original Python engine, image loads are
        // synchronous, so the portrait is always available when subsequent
        // commands (e.g. speak) execute.
        this.pendingPortraitLoads++;
        game.resources.loadPortrait(resolvedNid).then((image: HTMLImageElement) => {
          const portrait = new EventPortrait(
            image,
            blinkOffset,
            smileOffset,
            pos,
            priority,
            portraitNid, // Use original NID as the name key
            {
              transition: !immediate,
              slide,
              mirror: isMirror,
              expressions,
              speedMult: 1,
            },
          );
          this.portraits.set(portraitNid, portrait);
          this.pendingPortraitLoads--;
        }).catch(() => {
          console.warn(`EventState: failed to load portrait "${resolvedNid}"`);
          this.pendingPortraitLoads--;
        });

        this.advancePointer();
        // Return true to break the burst loop — the pending portrait load
        // check in update() will block until the image is ready.
        return true;
      }

      case 'multi_add_portrait': {
        // multi_add_portrait;P1;Pos1;P2;Pos2;[P3;Pos3;P4;Pos4]
        // Process pairs of (portrait, position)
        for (let i = 0; i + 1 < args.length; i += 2) {
          const pNid = args[i] ?? '';
          const pPos = args[i + 1] ?? 'Left';
          if (!pNid) continue;

          const game = getGame();
          let resolvedNid = pNid;
          const unitPrefab = game.db?.units.get(pNid);
          if (unitPrefab && unitPrefab.portrait_nid) {
            resolvedNid = unitPrefab.portrait_nid;
          }
          const portraitMeta = game.db?.portraits.get(resolvedNid);
          const blinkOffset: [number, number] = portraitMeta?.blinking_offset ?? [24, 32];
          const smileOffset: [number, number] = portraitMeta?.smiling_offset ?? [16, 48];
          const { position: pos, mirror: autoMirror } = parseScreenPosition(pPos);
          const priority = this.portraitPriorityCounter++;

          this.pendingPortraitLoads++;
          game.resources.loadPortrait(resolvedNid).then((image: HTMLImageElement) => {
            const portrait = new EventPortrait(
              image, blinkOffset, smileOffset, pos, priority, pNid,
              { transition: true, mirror: autoMirror },
            );
            this.portraits.set(pNid, portrait);
            this.pendingPortraitLoads--;
          }).catch(() => {
            console.warn(`EventState: failed to load portrait "${resolvedNid}"`);
            this.pendingPortraitLoads--;
          });
        }
        this.advancePointer();
        return true; // Block burst until all portrait images are loaded
      }

      case 'remove_portrait': {
        // remove_portrait;PortraitNid;[SpeedMult];[Slide];[immediate]
        const removeNid = args[0] ?? '';
        const removeExtraArgs = args.slice(1).map(s => s.toLowerCase().trim());
        const removeImmediate = removeExtraArgs.includes('immediate');
        const speedMultStr = removeExtraArgs.find(a => !isNaN(parseFloat(a)) && a !== 'immediate');
        const speedMult = speedMultStr ? parseFloat(speedMultStr) : 1;
        const removeSlide = removeExtraArgs.find(a => a === 'left' || a === 'right') as 'left' | 'right' | undefined;

        const portrait = this.portraits.get(removeNid);
        if (portrait) {
          if (removeImmediate) {
            this.portraits.delete(removeNid);
          } else {
            portrait.end(speedMult, removeSlide);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'multi_remove_portrait': {
        // multi_remove_portrait;P1;P2;...[;immediate]
        const mrExtraArgs = args.map(s => s.toLowerCase().trim());
        const mrImmediate = mrExtraArgs.includes('immediate');
        const mrNids = args.filter(a => a.toLowerCase().trim() !== 'immediate');
        for (const nid of mrNids) {
          const portrait = this.portraits.get(nid);
          if (portrait) {
            if (mrImmediate) {
              this.portraits.delete(nid);
            } else {
              portrait.end();
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'remove_all_portraits': {
        const rapImmediate = args.some(a => a.toLowerCase().trim() === 'immediate');
        if (rapImmediate) {
          this.portraits.clear();
        } else {
          for (const portrait of this.portraits.values()) {
            portrait.end();
          }
        }
        this.advancePointer();
        return false;
      }

      case 'move_portrait': {
        // move_portrait;PortraitNid;ScreenPosition;[SpeedMult];[immediate]
        const moveNid = args[0] ?? '';
        const movePos = args[1] ?? 'Left';
        const moveImmediate = args.slice(2).some(a => a.toLowerCase().trim() === 'immediate');

        const portrait = this.portraits.get(moveNid);
        if (portrait) {
          const { position: newPos } = parseScreenPosition(movePos);
          if (moveImmediate) {
            portrait.quickMove(newPos);
          } else {
            portrait.move(newPos);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'bop':           // short alias
      case 'bop_portrait': {
        // bop_portrait;PortraitNid;[NumBops];[Time]
        const bopNid = args[0] ?? '';
        const numBops = parseInt(args[1], 10) || 2;
        const bopTime = parseInt(args[2], 10) || undefined;

        const portrait = this.portraits.get(bopNid);
        if (portrait) {
          portrait.bop(numBops, 2, bopTime);
        }
        this.advancePointer();
        return false;
      }

      case 'mirror_portrait': {
        // mirror_portrait;PortraitNid
        const mirrorNid = args[0] ?? '';
        const portrait = this.portraits.get(mirrorNid);
        if (portrait) {
          portrait.mirror = !portrait.mirror;
        }
        this.advancePointer();
        return false;
      }

      case 'expression': {
        // expression;PortraitNid;ExpressionList (comma-separated)
        const exprNid = args[0] ?? '';
        const exprList = args[1] ?? '';
        const portrait = this.portraits.get(exprNid);
        if (portrait) {
          const exprs = exprList.split(',').map(s => s.trim()).filter(Boolean);
          portrait.setExpressions(exprs);
        }
        this.advancePointer();
        return false;
      }

      // ----- Background -----
      case 'change_background': {
        // change_background;[PanoramaNid];[keep_portraits];[scroll]
        // No panorama arg = remove background
        const bgKnownFlags = new Set(['keep_portraits', 'scroll']);
        const bgFlagSet = new Set<string>();
        let bgNid: string | null = null;

        for (const a of args) {
          const lower = a.trim().toLowerCase();
          if (bgKnownFlags.has(lower)) {
            bgFlagSet.add(lower);
          } else if (a.trim() && !bgNid) {
            bgNid = a.trim(); // Keep original case for the panorama NID
          }
        }

        if (!bgNid) {
          // Remove background
          this.background = null;
          this.pendingBackgroundLoad = false;
          this.backgroundLoadDone = false;
          this.backgroundLoadToken++;
          if (!bgFlagSet.has('keep_portraits')) {
            this.portraits.clear();
          }
          this.advancePointer();
          return false;
        } else {
          // Load panorama image asynchronously and block command progression
          // until the load resolves to match Python's synchronous semantics.
          const game = getGame();
          const panoramaNid = bgNid;
          const token = ++this.backgroundLoadToken;
          this.pendingBackgroundLoad = true;
          this.backgroundLoadDone = false;

          const resourcePromise = game.resourceManager?.loadPanorama(panoramaNid);
          if (!resourcePromise) {
            this.backgroundLoadDone = true;
          } else {
            resourcePromise.then((img: HTMLImageElement) => {
              if (this.backgroundLoadToken === token) {
                this.background = img;
              }
            }).catch(() => {
              console.warn(`EventState: panorama "${panoramaNid}" not found`);
              if (this.backgroundLoadToken === token) {
                this.background = null;
              }
            }).finally(() => {
              if (this.backgroundLoadToken === token) {
                this.backgroundLoadDone = true;
              }
            });
          }
        }

        // By default, change_background clears all portraits
        if (!bgFlagSet.has('keep_portraits')) {
          this.portraits.clear();
        }

        return true;
      }

      // ----- Chapter Title -----
      case 'chapter_title': {
        // chapter_title;[Music];[CustomTitle]
        const ctMusic = args[0]?.trim() || null;
        const ctTitle = args[1]?.trim() || null;

        // Start music if specified
        if (ctMusic) {
          const game = getGame();
          game.audioManager?.playMusic(ctMusic);
        }

        // Determine title text
        const game2 = getGame();
        this.chapterTitleText = ctTitle || game2.currentLevel?.name || 'Chapter';
        this.chapterTitlePhase = 'fade_in';
        this.chapterTitleTimer = 0;

        // Disable skip mode (player must watch or manually skip)
        this.skipMode = false;

        // Blocking — don't advance pointer; the update loop handles it
        return true;
      }

      // ----- Location Card -----
      case 'location_card': {
        // location_card;Text
        const lcText = args[0]?.trim() || '';
        this.locationCard = {
          text: lcText,
          timer: 0,
          phase: 'fade_in',
          alpha: 0,
        };
        // Block for the fade_in + hold duration. The wait timer mechanism
        // will advance the pointer when done.
        this.waiting = true;
        this.waitTimer = 2200; // 200ms fade in + 2000ms hold
        return true;
      }

      // ----- Has Visited (marks unit as having completed an action) -----
      case 'has_visited': {
        // has_visited;UnitNid;[attacked]
        const hvUnitNid = args[0]?.trim() ?? '';
        const hvFlags = args.slice(1).map(a => a.trim().toLowerCase());
        const hvUnit = this.findUnit(hvUnitNid);
        if (hvUnit) {
          if (hvFlags.includes('attacked')) {
            hvUnit.hasAttacked = true;
          } else {
            hvUnit.hasTraded = true;
          }
          // If the unit doesn't have Canto, mark them as finished
          if (!hvUnit.hasCanto) {
            hvUnit.finished = true;
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Unlock (simplified: consume a key/lockpick use) -----
      case 'unlock':
      case 'find_unlock':
      case 'spend_unlock': {
        // unlock;UnitNid — in the full Python engine, this is a complex macro.
        // Simplified: find the first item with 'unlock' component, decrement its uses.
        const unlockUnitNid = args[0]?.trim() ?? '';
        const unlockUnit = this.findUnit(unlockUnitNid);
        if (unlockUnit) {
          // Find first item that can unlock (has 'unlock' or 'key' component)
          const keyItem = unlockUnit.items.find(item => {
            for (const [compName] of item.components) {
              if (compName === 'unlock' || compName === 'Unlock' ||
                  compName === 'keys' || compName === 'Keys' ||
                  compName === 'can_unlock') return true;
            }
            return false;
          });
          if (keyItem && keyItem.uses !== undefined && keyItem.uses > 0) {
            keyItem.uses--;
            if (keyItem.uses <= 0) {
              // Remove broken item
              const idx = unlockUnit.items.indexOf(keyItem);
              if (idx >= 0) unlockUnit.items.splice(idx, 1);
            }
          }
          // If no key item, check for Locktouch skill (no item consumed)
          // Already handled implicitly — if no key found, nothing happens
        }
        this.advancePointer();
        return false;
      }

      // ----- Interact Unit (scripted combat) -----
      case 'interact_unit': {
        // interact_unit;AttackerNid;TargetNidOrPos;CombatScript;Ability;flags
        // e.g. interact_unit;Eirika;Boss;hit1,crit1,end;Rapier
        // CombatScript: comma-separated tokens (hit1,hit2,crit1,crit2,miss1,miss2,--,end)
        // flags: immediate, force_animation, force_no_animation
        const iuAttackerNid = args[0] ?? '';
        const iuTargetArg = args[1] ?? '';
        const iuScriptStr = args[2] ?? '';
        const iuAbilityNid = args[3] ?? '';
        const iuFlagsStr = args.slice(4).join(';').toLowerCase();
        const iuImmediate = iuFlagsStr.includes('immediate');

        // Resolve attacker
        const iuAttacker = game.units.get(iuAttackerNid) ?? null;
        if (!iuAttacker) {
          console.warn(`interact_unit: attacker "${iuAttackerNid}" not found`);
          this.advancePointer();
          return false;
        }

        // Resolve defender - try unit NID first, then position
        let iuDefender: UnitObject | null = null;
        iuDefender = game.units.get(iuTargetArg) ?? null;
        if (!iuDefender) {
          // Try parsing as position (x,y)
          const posMatch = iuTargetArg.match(/\(?(\d+),\s*(\d+)\)?/);
          if (posMatch && game.board) {
            const tx = parseInt(posMatch[1], 10);
            const ty = parseInt(posMatch[2], 10);
            iuDefender = game.board.getUnit(tx, ty);
          }
        }
        if (!iuDefender) {
          console.warn(`interact_unit: target "${iuTargetArg}" not found`);
          this.advancePointer();
          return false;
        }

        // Parse combat script
        const iuScript = iuScriptStr
          ? iuScriptStr.split(',').map((t: string) => t.trim().toLowerCase())
          : null;

        // Resolve ability/item — equip specified weapon if provided
        if (iuAbilityNid) {
          let abilityItem = iuAttacker.items.find(
            (i: ItemObject) => i.nid === iuAbilityNid || i.name === iuAbilityNid,
          );
          if (!abilityItem && game.db) {
            // Create a temporary item from the DB
            const itemPrefab = game.db.items?.get(iuAbilityNid);
            if (itemPrefab) {
              abilityItem = new ItemObjectClass(itemPrefab);
              iuAttacker.items.unshift(abilityItem);
            }
          }
          if (abilityItem) {
            // Move to front of inventory (equip)
            const idx = iuAttacker.items.indexOf(abilityItem);
            if (idx > 0) {
              iuAttacker.items.splice(idx, 1);
              iuAttacker.items.unshift(abilityItem);
            }
          }
        }

        // Set up combat through CombatState
        game.selectedUnit = iuAttacker;
        game.combatTarget = iuDefender;
        game.combatScript = iuScript;
        game.eventCombat = true;  // Flag so CombatState doesn't double-push EventState

        if (iuImmediate) {
          // Immediate mode: resolve combat without visual animation
          const attackItem = iuAttacker.getEquippedWeapon();
          const defItem = iuDefender.getEquippedWeapon();
          if (attackItem) {
            const rngMode2 = game.db.getConstant('rng_mode', 'true_hit') as any;
            const mc = new MapCombat(
              iuAttacker, attackItem, iuDefender, defItem,
              game.db, rngMode2, game.board, iuScript,
            );
            // Run combat to completion instantly
            while (mc.state !== 'done') {
              mc.update(16);
            }
            const results = mc.applyResults();
            // Handle deaths
            if (results.defenderDead && iuDefender.position && game.board) {
              if (game.initiative) game.initiative.removeUnit(iuDefender);
              game.board.removeUnit(iuDefender.position[0], iuDefender.position[1]);
              game.units.delete(iuDefender.nid);
            }
            if (results.attackerDead && iuAttacker.position && game.board) {
              if (game.initiative) game.initiative.removeUnit(iuAttacker);
              game.board.removeUnit(iuAttacker.position[0], iuAttacker.position[1]);
              game.units.delete(iuAttacker.nid);
            }
          }
          game.combatScript = null;
          this.advancePointer();
          return false;
        } else {
          // Push combat state — event pauses until combat completes
          game.state.change('combat');
          this.advancePointer();
          return true; // Block until combat state completes
        }
      }

      // ----- Load unit into memory (doesn't place on map) -----
      case 'load_unit': {
        // load_unit;UniqueUnitNID;Team;AI
        const luNid = args[0] ?? '';
        const luTeam = args[1] || 'player';
        const luAi = args[2] || 'None';
        if (game.units.has(luNid)) {
          console.warn(`load_unit: Unit "${luNid}" already exists`);
          this.advancePointer();
          return false;
        }
        const luPrefab = game.db?.units?.get(luNid);
        if (!luPrefab) {
          console.warn(`load_unit: Unit prefab "${luNid}" not found in db`);
          this.advancePointer();
          return false;
        }
        // Spawn into memory with no position (doesn't place on map)
        const luUnit = game.spawnUnit(luPrefab, luTeam, null, luAi);
        this.loadMapSpriteForUnit(luUnit, game);
        this.advancePointer();
        return false;
      }

      case 'make_generic': {
        // make_generic;NID;Klass;Level;Team;AI;Faction;AnimVariant;ItemList
        let mgNid = args[0] ?? '';
        const mgKlass = args[1] ?? '';
        const mgLevel = parseInt(args[2], 10) || 1;
        const mgTeam = args[3] || 'player';
        const mgAi = args[4] || 'None';
        // args[5] = faction (ignored for now)
        const mgVariant = args[6] || '';
        // args[7] = comma-separated item list
        const mgItemStr = args[7] ?? '';
        const mgItems: [string, boolean][] = mgItemStr
          ? mgItemStr.split(',').map((s: string) => [s.trim(), false] as [string, boolean])
          : [];

        // Auto-generate NID if empty
        if (!mgNid) {
          let counter = 201;
          while (game.units.has(String(counter))) counter++;
          mgNid = String(counter);
        } else if (game.units.has(mgNid)) {
          console.warn(`make_generic: Unit "${mgNid}" already exists`);
          this.advancePointer();
          return false;
        }

        const mgKlassDef = game.db?.classes?.get(mgKlass);
        if (!mgKlassDef) {
          console.warn(`make_generic: Class "${mgKlass}" not found in db`);
          this.advancePointer();
          return false;
        }

        // Build synthetic GenericUnitData and spawn
        const mgData: any = {
          nid: mgNid,
          variant: mgVariant || null,
          level: mgLevel,
          klass: mgKlass,
          faction: args[5] || '',
          starting_items: mgItems,
          starting_skills: [],
          team: mgTeam,
          ai: mgAi,
          ai_group: null,
          starting_position: null,
          generic: true,
        };
        game.spawnGenericUnit(mgData);
        const mgUnit = game.units.get(mgNid);
        if (mgUnit) this.loadMapSpriteForUnit(mgUnit, game);
        this.advancePointer();
        return false;
      }

      // ----- Shop -----
      case 'shop': {
        // shop;UnitNid;Item1,Item2,...;[Flavor];[Stock1,Stock2,...];[ShopId];[preview]
        const shopUnitNid = args[0] ?? '';
        const shopItemsStr = args[1] ?? '';
        const shopFlavor = args[2] ?? 'armory';
        const shopStockStr = args[3] ?? '';
        const shopId = args[4] ?? '';
        const shopFlags = args.slice(5).join(';').toLowerCase();
        const shopPreview = shopFlags.includes('preview');

        // Resolve unit
        let shopUnit = game.units.get(shopUnitNid) ?? null;
        if (!shopUnit && shopUnitNid === '{unit}') {
          shopUnit = game.selectedUnit;
        }
        if (!shopUnit) {
          console.warn(`shop: unit "${shopUnitNid}" not found`);
          this.advancePointer();
          return false;
        }

        // Create item objects from NID list
        const shopItemNids = shopItemsStr.split(',').map((s: string) => s.trim()).filter(Boolean);
        const shopItems: ItemObject[] = [];
        for (const itemNid of shopItemNids) {
          const prefab = game.db?.items?.get(itemNid);
          if (prefab) {
            shopItems.push(new ItemObjectClass(prefab));
          } else {
            console.warn(`shop: item "${itemNid}" not found in db`);
          }
        }

        if (shopItems.length === 0) {
          console.warn('shop: no valid items');
          this.advancePointer();
          return false;
        }

        // Parse stock list
        let shopStock: number[] = shopItems.map(() => -1);
        if (shopStockStr) {
          const stockParts = shopStockStr.split(',').map((s: string) => parseInt(s.trim(), 10));
          for (let si = 0; si < shopItems.length && si < stockParts.length; si++) {
            if (!isNaN(stockParts[si])) {
              shopStock[si] = stockParts[si];
            }
          }
          // Adjust for persistent stock tracking
          if (shopId) {
            for (let si = 0; si < shopItems.length; si++) {
              if (shopStock[si] > 0) {
                const boughtKey = `__shop_${shopId}_${shopItems[si].nid}`;
                const bought = Number(game.gameVars.get(boughtKey) ?? 0);
                shopStock[si] = Math.max(0, shopStock[si] - bought);
              }
            }
          }
        }

        // Set up transient data for ShopState
        game.shopUnit = shopUnit;
        game.shopItems = shopItems;
        game.shopStock = shopStock;

        // Push shop state
        game.state.change('shop');
        this.advancePointer();
        return true; // Block until shop closes
      }

      case 'hide_combat_ui':
      case 'show_combat_ui':
      case 'pause_background':
      case 'unpause_background':
        // Visual/UI commands — skip for now to allow event progression
        this.advancePointer();
        return false;

      // ----- Preparation / Base (stubs) -----

      case 'prep': {
        // prep — opens preparations screen
        // args[0]: pick units enabled ('True'/'False'), default True
        // args[1]: music track to play during prep
        const pickEnabled = args[0] !== 'False' && args[0] !== 'false';
        game.levelVars.set('_prep_pick', pickEnabled);

        if (args[1]) {
          void game.audioManager.playMusic(args[1]);
        }

        // Advance pointer before pushing — when prep exits (back()),
        // the EventState resumes and processes the next command.
        this.advancePointer();
        game.state.change('prep_main');
        return true; // Block until prep closes
      }

      case 'base': {
        // base — opens base/camp screen with panorama background and menu.
        // args: [background, music, other_options, options_enabled, options_events]
        const baseBg = args[0] || '';
        const baseMusic = args[1] || '';
        if (baseBg) {
          game.gameVars.set('_base_bg_name', baseBg);
        }
        if (baseMusic) {
          game.gameVars.set('_base_music', baseMusic);
        }
        // Check for show_map flag
        if (args[0] === 'show_map' || args[0] === 'True') {
          game.gameVars.set('_base_transparent', true);
        }
        this.advancePointer();
        game.state.change('base_main');
        return true; // Block until base closes
      }

      // ----- Overworld commands -----

      case 'toggle_narration_mode': {
        // Narration mode toggle — visual-only, currently a no-op
        this.advancePointer();
        return false;
      }

      case 'overworld_cinematic': {
        // Set up overworld as a background for cutscenes
        // args[0] = overworld NID (optional, uses first if omitted)
        // The OverworldManager is imported lazily to avoid circular deps
        if (game.db.overworlds.size > 0) {
          const owNid = args[0] || null;
          let prefab = null;
          if (owNid) {
            prefab = game.db.overworlds.get(owNid);
          } else {
            prefab = game.db.overworlds.values().next().value ?? null;
          }
          if (prefab && !game.overworldController) {
            // Store the prefab NID so the overworld state can pick it up
            game.gameVars.set('_overworld_cinematic_nid', prefab.nid);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'reveal_overworld_node': {
        // args[0] = node NID
        const nodeNid = args[0];
        if (nodeNid && game.overworldController) {
          game.overworldController.enableNode(nodeNid);
        }
        this.advancePointer();
        return false;
      }

      case 'reveal_overworld_road': {
        // args[0] = road NID (format "nodeA-nodeB")
        const roadNid = args[0];
        if (roadNid && game.overworldController) {
          game.overworldController.enableRoad(roadNid);
        }
        this.advancePointer();
        return false;
      }

      case 'overworld_move_unit': {
        // args[0] = entity NID, args[1] = target node NID
        // This is non-blocking when no overworld controller exists
        const entityNid = args[0];
        const targetNodeNid = args[1];
        const owCtrl = game.overworldController;
        if (entityNid && targetNodeNid && owCtrl) {
          const entity = owCtrl.entities.get(entityNid);
          if (entity && entity.onNode) {
            const pathPoints = owCtrl.getPathPoints(entity.onNode, targetNodeNid);
            if (pathPoints && pathPoints.length >= 2 && game.overworldMovement) {
              game.overworldMovement.beginMove(entity, pathPoints, {
                follow: true,
                callback: () => {
                  owCtrl.movePartyToNode(entityNid, targetNodeNid);
                },
              });
              // Block until movement finishes — update loop will unblock
              this.advancePointer();
              return true;
            } else {
              // No path or no movement manager — instant move
              owCtrl.movePartyToNode(entityNid, targetNodeNid);
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'set_overworld_position': {
        // args[0] = entity NID, args[1] = node NID or "x,y"
        const entityNid = args[0];
        const posArg = args[1];
        const owCtrl = game.overworldController;
        if (entityNid && posArg && owCtrl) {
          const node = owCtrl.getNode(posArg);
          if (node) {
            owCtrl.movePartyToNode(entityNid, posArg);
          } else {
            // Try x,y format
            const coords = posArg.split(',');
            if (coords.length === 2) {
              const x = parseInt(coords[0], 10);
              const y = parseInt(coords[1], 10);
              const entity = owCtrl.entities.get(entityNid);
              if (entity && !isNaN(x) && !isNaN(y)) {
                entity.displayPosition = [x, y];
              }
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'create_overworld_entity': {
        // args[0] = entity NID, args[1] = dtype ('party'/'unit'),
        // args[2] = data NID (party/unit NID), args[3] = team, args[4] = node NID
        const owCtrl = game.overworldController;
        if (owCtrl && args[0]) {
          const eNid = args[0];
          const dtype = args[1] || 'party';
          const dnid = args[2] || eNid;
          const team = args[3] || 'player';
          const nodeNid = args[4] || null;
          owCtrl.createEntity(eNid, dtype, dnid, team, nodeNid);
        }
        this.advancePointer();
        return false;
      }

      case 'disable_overworld_entity': {
        // args[0] = entity NID
        const owCtrl = game.overworldController;
        if (owCtrl && args[0]) {
          owCtrl.removeEntity(args[0]);
        }
        this.advancePointer();
        return false;
      }

      case 'set_overworld_menu_option_enabled': {
        // args[0] = node NID, args[1] = option NID, args[2] = 'True'/'False'
        const owCtrl = game.overworldController;
        if (owCtrl && args[0] && args[1]) {
          const enabled = args[2] !== 'False' && args[2] !== 'false';
          owCtrl.toggleMenuOptionEnabled(args[0], args[1], enabled);
        }
        this.advancePointer();
        return false;
      }

      case 'set_overworld_menu_option_visible': {
        // args[0] = node NID, args[1] = option NID, args[2] = 'True'/'False'
        const owCtrl = game.overworldController;
        if (owCtrl && args[0] && args[1]) {
          const visible = args[2] !== 'False' && args[2] !== 'false';
          owCtrl.toggleMenuOptionVisible(args[0], args[1], visible);
        }
        this.advancePointer();
        return false;
      }

      case 'enter_level_from_overworld': {
        // args[0] = level NID (optional — uses node's level if omitted)
        const owCtrl = game.overworldController;
        if (owCtrl) {
          const levelNid = args[0] || owCtrl.nextLevel;
          if (levelNid) {
            game.gameVars.set('_overworld_level', levelNid);
            game.state.change('overworld_level_transition');
            this.advancePointer();
            return true; // Block until level transition completes
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Arena / overlay (stubs) -----

      // ----- Base screen event commands -----
      case 'add_base_convo':
      case 'ignore_base_convo':
      case 'remove_base_convo':
      case 'add_market_item':
      case 'remove_market_item':
      case 'clear_market_items': {
        handleBaseEventCommand(cmd.type, args, game);
        this.advancePointer();
        return false;
      }

      // ----- Victory / Credits event commands -----
      case 'victory_screen': {
        this.advancePointer();
        game.state.change('victory');
        return true; // Block until victory screen closes
      }

      case 'credits':
      case 'credit': {
        this.advancePointer();
        game.state.change('credit');
        return true; // Block until credits close
      }

      // ----- Support system event commands -----

      case 'enable_supports': {
        // Sets the _supports game var to enable supports
        game.gameVars.set('_supports', true);
        this.advancePointer();
        return false;
      }

      case 'increment_support_points': {
        // increment_support_points;unit1;unit2;amount
        const u1 = args[0];
        const u2 = args[1];
        const amount = parseInt(args[2] ?? '1', 10);
        if (u1 && u2 && game.supports) {
          const pair = game.supports.getPair(u1, u2);
          if (pair) {
            game.supports.incrementPoints(pair, amount);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'unlock_support_rank': {
        // unlock_support_rank;unit1;unit2;rank
        const u1 = args[0];
        const u2 = args[1];
        const rank = args[2];
        if (u1 && u2 && rank && game.supports) {
          const pair = game.supports.getPair(u1, u2);
          if (pair) {
            game.supports.unlockRank(pair.nid, rank);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'disable_support_rank': {
        // disable_support_rank;unit1;unit2;rank
        const u1 = args[0];
        const u2 = args[1];
        const rank = args[2];
        if (u1 && u2 && rank && game.supports) {
          const pair = game.supports.getPair(u1, u2);
          if (pair) {
            game.supports.disableRank(pair.nid, rank);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'enable_turnwheel': {
        // enable_turnwheel;true/false
        const activated = args[0]?.toLowerCase() !== 'false';
        game.gameVars.set('_turnwheel', activated);
        this.advancePointer();
        return false;
      }

      case 'activate_turnwheel': {
        // activate_turnwheel;force
        // Opens the turnwheel UI. If 'force' is specified, the player
        // must use the turnwheel (cannot cancel).
        const force = args[0]?.toLowerCase() !== 'false';
        if (!game.memory) game.memory = new Map();
        game.memory.set('force_turnwheel', force);
        game.memory.set('event_turnwheel', true);
        game.state.change('turnwheel');
        this.advancePointer();
        return true; // blocking — turnwheel state takes over
      }

      case 'clear_turnwheel': {
        // clear_turnwheel — sets the first free action to current position,
        // preventing the turnwheel from rewinding before this point.
        game.actionLog.setFirstFreeAction();
        this.advancePointer();
        return false;
      }

      case 'stop_turnwheel_recording': {
        game.actionLog.stopRecording();
        this.advancePointer();
        return false;
      }

      case 'start_turnwheel_recording': {
        game.actionLog.startRecording();
        this.advancePointer();
        return false;
      }

      case 'draw_overlay_sprite':
      case 'remove_overlay_sprite':
      case 'table':
      case 'remove_table':
      case 'textbox':
      case 'set_wexp':
      case 'resurrect':
      case 'autolevel_to':
      case 'add_lore': {
        // Advanced features not yet implemented — skip
        this.advancePointer();
        return false;
      }

      case 'enable_fog_of_war': {
        const fogEnableStr = args[0]?.toLowerCase?.() ?? 'true';
        const fogEnable = fogEnableStr === 'true' || fogEnableStr === '1';
        game.levelVars.set('_fog_of_war', fogEnable);
        console.log(`Event: enable_fog_of_war -> ${fogEnable}`);
        if (typeof game.recalculateAllFow === 'function') game.recalculateAllFow();
        this.advancePointer();
        return false;
      }

      case 'set_fog_of_war': {
        const fogModeStr = (args[0] ?? 'gba').toLowerCase();
        let fogMode = 1;
        if (fogModeStr === 'gba') fogMode = 1;
        else if (fogModeStr === 'thracia') fogMode = 2;
        else if (fogModeStr === 'hybrid') fogMode = 3;
        else if (fogModeStr === 'gba_deprecated') fogMode = 0;
        else { const fp = parseInt(fogModeStr, 10); if (!isNaN(fp)) fogMode = fp; }
        const fogRadius = parseInt(args[1] ?? '0', 10) || 0;
        const fogAiRadius = args[2] ? (parseInt(args[2], 10) || fogRadius) : fogRadius;
        const fogOtherRadius = args[3] ? (parseInt(args[3], 10) || fogAiRadius) : fogAiRadius;
        game.levelVars.set('_fog_of_war_type', fogMode);
        game.levelVars.set('_fog_of_war_radius', fogRadius);
        game.levelVars.set('_ai_fog_of_war_radius', fogAiRadius);
        game.levelVars.set('_other_fog_of_war_radius', fogOtherRadius);
        console.log(`Event: set_fog_of_war mode=${fogMode} radius=${fogRadius} ai=${fogAiRadius} other=${fogOtherRadius}`);
        if (typeof game.recalculateAllFow === 'function') game.recalculateAllFow();
        this.advancePointer();
        return false;
      }

      // ---------------------------------------------------------------
      // Initiative commands
      // ---------------------------------------------------------------

      case 'add_to_initiative': {
        // add_to_initiative;UnitNid;Position
        // Adds unit at position relative to current initiative index
        const unitNid = args[0] ?? '';
        const pos = parseInt(args[1] ?? '0', 10) || 0;
        const unit = this.findUnit(unitNid);
        if (unit && game.initiative) {
          game.initiative.removeUnit(unit);
          game.initiative.insertAt(
            unit.nid,
            game.initiative.currentIdx + pos,
            game.initiative.getInitiativeForUnit(unit.nid),
          );
        }
        this.advancePointer();
        return false;
      }

      case 'move_in_initiative': {
        // move_in_initiative;UnitNid;Offset
        // Moves unit by offset positions in the initiative order
        const unitNid = args[0] ?? '';
        const offset = parseInt(args[1] ?? '0', 10) || 0;
        const unit = this.findUnit(unitNid);
        if (unit && game.initiative) {
          const oldIdx = game.initiative.getIndex(unit.nid);
          const initVal = game.initiative.getInitiativeForUnit(unit.nid);
          if (oldIdx !== undefined && initVal !== undefined) {
            game.initiative.removeUnit(unit);
            const newIdx = Math.max(0, Math.min(oldIdx + offset, game.initiative.unitLine.length));
            game.initiative.insertAt(unit.nid, newIdx, initVal);
          }
        }
        this.advancePointer();
        return false;
      }

      // ---------------------------------------------------------------
      // Roam mode commands
      // ---------------------------------------------------------------

      case 'set_roam': {
        // set_roam;true/false
        const val = (args[0] ?? 'true').toLowerCase();
        game.roamInfo.roam = val !== 'false' && val !== '0';
        console.log(`Event: set_roam -> ${game.roamInfo.roam}`);
        this.advancePointer();
        return false;
      }

      case 'set_roam_unit': {
        // set_roam_unit;UnitNid
        game.roamInfo.roamUnitNid = args[0] || null;
        console.log(`Event: set_roam_unit -> ${game.roamInfo.roamUnitNid}`);
        this.advancePointer();
        return false;
      }

      // ----- Persistent records & achievements -----
      case 'create_record': {
        // create_record;nid;expression
        try {
          const nid = args[0];
          const value = args[1] ?? 'true';
          if (nid && RECORDS) {
            let evaluated: any = value;
            if (value === 'True' || value === 'true') evaluated = true;
            else if (value === 'False' || value === 'false') evaluated = false;
            else if (!isNaN(Number(value))) evaluated = Number(value);
            RECORDS.create(nid, evaluated);
          }
        } catch (e) { console.warn('create_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'update_record': {
        try {
          const nid = args[0];
          const value = args[1] ?? 'true';
          if (nid && RECORDS) {
            let evaluated: any = value;
            if (value === 'True' || value === 'true') evaluated = true;
            else if (value === 'False' || value === 'false') evaluated = false;
            else if (!isNaN(Number(value))) evaluated = Number(value);
            RECORDS.update(nid, evaluated);
          }
        } catch (e) { console.warn('update_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'replace_record': {
        try {
          const nid = args[0];
          const value = args[1] ?? 'true';
          if (nid && RECORDS) {
            let evaluated: any = value;
            if (value === 'True' || value === 'true') evaluated = true;
            else if (value === 'False' || value === 'false') evaluated = false;
            else if (!isNaN(Number(value))) evaluated = Number(value);
            RECORDS.replace(nid, evaluated);
          }
        } catch (e) { console.warn('replace_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'delete_record': {
        try {
          if (args[0] && RECORDS) RECORDS.delete(args[0]);
        } catch (e) { console.warn('delete_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'unlock_difficulty': {
        try {
          if (args[0] && RECORDS) RECORDS.unlockDifficulty(args[0]);
        } catch (e) { console.warn('unlock_difficulty error:', e); }
        this.advancePointer();
        return false;
      }
      case 'unlock_song': {
        try {
          if (args[0] && RECORDS) RECORDS.unlockSong(args[0]);
        } catch (e) { console.warn('unlock_song error:', e); }
        this.advancePointer();
        return false;
      }
      case 'add_achievement': {
        // add_achievement;nid;name;desc;[completed];[hidden]
        try {
          if (args[0] && ACHIEVEMENTS) {
            const nid = args[0];
            const name = args[1] ?? nid;
            const desc = args[2] ?? '';
            const complete = (args[3] ?? '').toLowerCase() === 'true';
            const hidden = (args[4] ?? '').toLowerCase() === 'true';
            ACHIEVEMENTS.add(nid, name, desc, complete, hidden);
          }
        } catch (e) { console.warn('add_achievement error:', e); }
        this.advancePointer();
        return false;
      }
      case 'complete_achievement': {
        // complete_achievement;nid;[True/False]
        try {
          if (args[0] && ACHIEVEMENTS) {
            const complete = (args[1] ?? 'True').toLowerCase() !== 'false';
            if (complete) ACHIEVEMENTS.complete(args[0]);
          }
        } catch (e) { console.warn('complete_achievement error:', e); }
        this.advancePointer();
        return false;
      }

      // ----- Save/load commands -----
      case 'battle_save':
      case 'battle_save_prompt': {
        // battle_save — save during chapter (auto-save or prompted)
        // For now, push the save menu state
        game.state.change('save_menu');
        this.advancePointer();
        return true; // blocking until save menu exits
      }
      case 'skip_save': {
        // skip_save — silently auto-save to current slot
        try {
          const slot = game.currentSaveSlot >= 0 ? game.currentSaveSlot : 0;
          doSaveGame(game, slot, 'battle').catch((err: any) => {
            console.warn('skip_save failed:', err);
          });
        } catch (e) { console.warn('skip_save error:', e); }
        this.advancePointer();
        return false;
      }
      case 'suspend': {
        // suspend — save and return to title
        try {
          doSuspendGame(game).then(() => {
            game.state.clear();
            game.state.change('title');
          }).catch(() => {
            game.state.clear();
            game.state.change('title');
          });
        } catch (e) {
          console.warn('suspend error:', e);
          game.state.clear();
          game.state.change('title');
        }
        this.advancePointer();
        return false;
      }

      default:
        // Unknown/unimplemented command — skip
        this.advancePointer();
        return false;
    }
  }

  // -----------------------------------------------------------------------
  // Group position lookup: mirrors Python's Event._get_position()
  // -----------------------------------------------------------------------

  /**
   * Resolve the position for a unit within a group command.
   *
   * @param nextPos     The StartingGroup parameter. Rules:
   *   - empty/null  → use the group's own positions dict
   *   - 'starting'  → use unit.startingPosition
   *   - 'x,y'       → literal coordinate (all units get same position)
   *   - other string → another group NID's positions dict
   * @param unitNid    The unit to look up
   * @param group      The primary group being operated on
   * @param allGroups  All level unit groups (for cross-group lookups)
   * @param game       GameState reference
   */
  private _getGroupPosition(
    nextPos: string,
    unitNid: string,
    group: any,
    allGroups: any[],
    game: any,
  ): [number, number] | null {
    if (!nextPos || nextPos === '') {
      // Use the group's own positions dict
      const pos = group.positions?.[unitNid];
      return pos ? [pos[0], pos[1]] : null;
    }

    if (nextPos.toLowerCase() === 'starting') {
      // Use the unit's starting_position
      const unit = this.findUnit(unitNid);
      if (unit?.startingPosition) {
        return [unit.startingPosition[0], unit.startingPosition[1]];
      }
      // Also check level data for starting_position
      const levelUnits = game.currentLevel?.units ?? [];
      const levelUnit = levelUnits.find((u: any) => u.nid === unitNid);
      if (levelUnit?.starting_position) {
        return [levelUnit.starting_position[0], levelUnit.starting_position[1]];
      }
      return null;
    }

    // Check if it's a literal "x,y" coordinate
    if (nextPos.includes(',')) {
      const parts = nextPos.split(',').map((s: string) => parseInt(s.trim(), 10));
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        return [parts[0], parts[1]];
      }
    }

    // Otherwise, treat as another group's NID and look up positions
    const otherGroup = allGroups.find((g: any) => g.nid === nextPos);
    if (otherGroup?.positions?.[unitNid]) {
      const pos = otherGroup.positions[unitNid];
      return [pos[0], pos[1]];
    }

    return null;
  }

  /**
   * Check placement validity: mirrors Python's Event._check_placement().
   *
   * @param position  Desired position
   * @param placement One of: 'giveup', 'stack', 'closest', 'push'
   * @param game      GameState reference
   * @returns The final position, or null if placement fails
   */
  private _checkPlacement(
    position: [number, number],
    placement: string,
    game: any,
  ): [number, number] | null {
    // Check bounds
    if (game.tilemap && !game.tilemap.checkBounds(position[0], position[1])) {
      return null;
    }

    // Check if tile is occupied
    const occupant = game.board?.getUnit(position[0], position[1]);
    if (!occupant) {
      return position; // tile is free
    }

    switch (placement) {
      case 'giveup':
        return null; // skip this unit
      case 'stack':
        return position; // place on top (units overlap)
      case 'closest': {
        // Find nearest unoccupied tile
        const maxRange = 10;
        for (let r = 1; r <= maxRange; r++) {
          for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
              if (Math.abs(dx) + Math.abs(dy) !== r) continue;
              const nx = position[0] + dx;
              const ny = position[1] + dy;
              if (game.tilemap && !game.tilemap.checkBounds(nx, ny)) continue;
              if (!game.board?.getUnit(nx, ny)) {
                return [nx, ny];
              }
            }
          }
        }
        return null;
      }
      case 'push': {
        // Push the occupant to a nearby tile, then use this position
        const maxRange = 5;
        for (let r = 1; r <= maxRange; r++) {
          for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
              if (Math.abs(dx) + Math.abs(dy) !== r) continue;
              const nx = position[0] + dx;
              const ny = position[1] + dy;
              if (game.tilemap && !game.tilemap.checkBounds(nx, ny)) continue;
              if (!game.board?.getUnit(nx, ny)) {
                game.board.moveUnit(occupant, nx, ny);
                return position;
              }
            }
          }
        }
        return null;
      }
      default:
        return position;
    }
  }

  // -----------------------------------------------------------------------
  // Unit spawning helper: handles both unique and generic units from level data
  // -----------------------------------------------------------------------

  private spawnUnitFromLevelData(
    unitData: any,
    posOverride: [number, number] | null,
    game: any,
  ): void {
    const isGeneric = unitData.generic === true;
    const pos = posOverride ?? unitData.starting_position ?? null;

    if (isGeneric) {
      // Generic unit — build synthetic prefab and spawn
      const data = { ...unitData, starting_position: pos };
      game.spawnGenericUnit(data);
      const spawned = game.units.get(unitData.nid);
      if (spawned) {
        this.loadMapSpriteForUnit(spawned, game);
        // Insert into initiative tracker if active
        if (game.initiative) {
          game.initiative.insertUnit(spawned, game.db);
        }
      }
    } else {
      // Unique unit — look up prefab from db
      const prefab = game.db.units.get(unitData.nid);
      if (prefab) {
        const spawned = game.spawnUnit(
          prefab,
          unitData.team ?? 'player',
          pos,
          unitData.ai ?? 'None',
        );
        this.loadMapSpriteForUnit(spawned, game);
        // Insert into initiative tracker if active
        if (game.initiative) {
          game.initiative.insertUnit(spawned, game.db);
        }
      } else {
        console.warn(`EventState: unique unit prefab "${unitData.nid}" not found in db`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Async helper: load map sprite for a newly spawned unit
  // -----------------------------------------------------------------------

  private loadMapSpriteForUnit(unit: UnitObject, game: any): void {
    const klassDef = game.db.classes.get(unit.klass);
    if (!klassDef) return;
    const spriteNid = klassDef.map_sprite_nid;
    if (!spriteNid) return;

    const teamDef = game.db.teams.defs.find((t: any) => t.nid === unit.team);
    const teamPalette = teamDef?.palette ?? undefined;

    // Fire-and-forget async load
    game.resources.tryLoadMapSprite(spriteNid).then((sprites: any) => {
      const mapSprite = MapSpriteClass.fromImages(sprites.stand, sprites.move, teamPalette);
      unit.sprite = mapSprite;
    }).catch((err: any) => {
      console.warn(`EventState: failed to load map sprite for unit "${unit.nid}":`, err);
    });
  }

  // -----------------------------------------------------------------------
  // Helper: grant skills from a new class after promotion/class change
  // -----------------------------------------------------------------------

  /**
   * Grant learned skills from the unit's current class.
   * After promotion/class change, iterate the new class's learned_skills
   * and add any skills the unit doesn't already have, up to their current level.
   * Matches Python's event_functions.py promote/change_class logic.
   */
  private grantClassSkills(unit: UnitObject, game: any): void {
    const unitKlass = game.db.classes.get(unit.klass);
    if (!unitKlass || !unitKlass.learned_skills) return;

    for (const [levelNeeded, classSkillNid] of unitKlass.learned_skills) {
      if (unit.level >= levelNeeded) {
        // Check if unit already has this skill
        const hasSkill = unit.skills.some((s: any) => s.nid === classSkillNid);
        if (!hasSkill) {
          const skillPrefab = game.db.skills.get(classSkillNid);
          if (skillPrefab) {
            const skill = new SkillObject(skillPrefab);
            unit.skills.push(skill);
            // Check for canto
            if (skill.hasComponent('canto')) {
              unit.hasCanto = true;
            }
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal flag for if/elif/else flow control
  // -----------------------------------------------------------------------
  private _jumpedToBranch: boolean = false;
}
