// ---------------------------------------------------------------------------
// Save / Load System — Serialize GameState to JSON, store in IndexedDB.
// Mirrors LT's app/engine/save.py.
// ---------------------------------------------------------------------------

import type { NID, LevelPrefab, ItemPrefab, SkillPrefab } from '../data/types';
import type { UnitObject, StatusEffect } from '../objects/unit';
import { ItemObject as ItemObjectCtor } from '../objects/item';
import type { ItemObject } from '../objects/item';
import { SkillObject as SkillObjectCtor } from '../objects/skill';
import type { SkillObject } from '../objects/skill';
import { UnitObject as UnitObjectCtor } from '../objects/unit';
import type { PartyObject } from './party';
import { PartyObject as PartyObjectCtor } from './party';
import type { TileMapObject } from '../rendering/tilemap';
import { TileMapObject as TileMapObjectCtor } from '../rendering/tilemap';
import { DifficultyModeObject } from './difficulty';
import { Recordkeeper, type RecordkeeperSaveData } from './records';
import type { SupportPair } from './support-system';
import { SupportController } from './support-system';
import { GameBoard } from '../objects/game-board';
import { PathSystem } from '../pathfinding/path-system';
import { PhaseController } from './phase';
import { EventManager } from '../events/event-manager';
import { AIController } from '../ai/ai-controller';
import { MapSprite as MapSpriteCtor } from '../rendering/map-sprite';
import { RoamInfo } from './roam-info';

// ============================================================================
// Save Data Interfaces
// ============================================================================

export interface UnitSaveData {
  nid: string;
  name: string;
  position: [number, number] | null;
  team: string;
  klass: string;
  level: number;
  exp: number;
  stats: Record<string, number>;
  currentHp: number;
  growths: Record<string, number>;
  maxStats: Record<string, number>;
  items: string[];        // item key references into items map
  equippedItemIndex?: number | null;
  skills: string[];       // skill NIDs
  tags: string[];
  ai: string;
  wexp: Record<string, number>;
  startingPosition: [number, number] | null;
  aiGroup: string;
  portraitNid: string;
  affinity: string;
  hasAttacked: boolean;
  hasMoved: boolean;
  hasTraded: boolean;
  finished: boolean;
  dead: boolean;
  hasCanto: boolean;
  party: string;
  persistent: boolean;
  statusEffects: StatusEffect[];
  rescuingNid: string | null;
  rescuedByNid: string | null;
}

export interface ItemSaveData {
  nid: string;
  name: string;
  desc: string;
  iconNid: string;
  iconIndex: [number, number];
  components: [string, any][];
  uses: number;
  maxUses: number;
  droppable: boolean;
  ownerNid: string | null;
  /** Key used in game.items map for lookup during restore. */
  mapKey: string;
}

export interface SkillSaveData {
  nid: string;
  name: string;
  desc: string;
  iconNid: string;
  iconIndex: [number, number];
  components: [string, any][];
  data: [string, any][];
}

export interface LevelSaveData {
  nid: string;
  name: string;
  tilemapNid: string;
  layerVisibility: [string, boolean][];
  weather: string[];
  party: string;
  music: Record<string, string>;
  objective: { simple: string; win: string; loss: string };
  unitNids: string[];
  regionNids: string[];
}

export interface PartySaveData {
  nid: string;
  name: string;
  leaderNid: string;
  money: number;
  convoyItemKeys: string[];
  bexp: number;
}

export interface SupportPairSaveData {
  nid: string;
  unit1Nid: string;
  unit2Nid: string;
  points: number;
  lockedRanks: string[];
  unlockedRanks: string[];
  pointsGainedThisChapter: number;
  ranksGainedThisChapter: number;
}

export interface SaveDict {
  units: UnitSaveData[];
  items: ItemSaveData[];
  skills: SkillSaveData[];
  level: LevelSaveData | null;
  turncount: number;
  playtime: number;
  gameVars: [string, any][];
  levelVars: [string, any][];
  currentMode: Record<string, any> | null;
  parties: PartySaveData[];
  currentParty: string;
  stateStack: string[];
  activeAiGroups: string[];
  records: RecordkeeperSaveData | null;
  supports: SupportPairSaveData[] | null;
  marketItems: [string, number][];
  baseConvos: [string, boolean][];
  talkOptions: [string, string][];
  fogState: any | null;
  roamInfo: { roam: boolean; roamUnitNid: string | null };
  overworldRegistry: [string, any][];
  memory: [string, any][];
}

export interface SaveMetadata {
  playtime: number;
  realtime: number;
  version: string;
  title: string;
  mode: string | null;
  levelNid: string | null;
  levelTitle: string;
  kind: string;
  displayName: string | null;
}

export interface SaveSlot {
  idx: number;
  name: string;
  playtime: number;
  realtime: number;
  kind: string;
  mode: string | null;
  levelNid: string | null;
  displayName: string | null;
}

// ============================================================================
// IndexedDB Helpers
// ============================================================================

const DB_NAME = 'lt-web-saves';
const STORE_NAME = 'saves';
const DB_VERSION = 1;

/** Cached database connection. */
let _dbInstance: IDBDatabase | null = null;

async function openDB(): Promise<IDBDatabase> {
  if (_dbInstance) return _dbInstance;

  return new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => {
        _dbInstance = request.result;
        // Clear cached handle if the connection closes unexpectedly
        _dbInstance.onclose = () => { _dbInstance = null; };
        _dbInstance.onversionchange = () => {
          _dbInstance?.close();
          _dbInstance = null;
        };
        resolve(_dbInstance);
      };

      request.onerror = () => {
        console.warn('IndexedDB open failed:', request.error);
        reject(request.error);
      };
    } catch (err) {
      console.warn('IndexedDB not available:', err);
      reject(err);
    }
  });
}

async function idbGet(key: string): Promise<any> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn(`idbGet("${key}") failed, trying localStorage fallback:`, err);
    return localStorageGet(key);
  }
}

async function idbSet(key: string, value: any): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn(`idbSet("${key}") failed, trying localStorage fallback:`, err);
    localStorageSet(key, value);
  }
}

async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn(`idbDelete("${key}") failed, trying localStorage fallback:`, err);
    localStorageDelete(key);
  }
}

async function idbKeys(): Promise<string[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('idbKeys() failed, trying localStorage fallback:', err);
    return localStorageKeys();
  }
}

// ============================================================================
// localStorage Fallback
// ============================================================================

const LS_PREFIX = 'lt-save:';

function localStorageGet(key: string): any {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function localStorageSet(key: string, value: any): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    console.warn('localStorage save failed (quota exceeded?)');
  }
}

function localStorageDelete(key: string): void {
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {
    // ignore
  }
}

function localStorageKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) {
        keys.push(k.slice(LS_PREFIX.length));
      }
    }
  } catch {
    // ignore
  }
  return keys;
}

// ============================================================================
// Serialization Functions
// ============================================================================

function serializeUnit(unit: UnitObject): UnitSaveData {
  // Collect item map keys from the unit's items
  const itemKeys: string[] = [];
  for (let i = 0; i < unit.items.length; i++) {
    const item = unit.items[i];
    // Reconstruct the key format used in game.items
    itemKeys.push(`${unit.nid}_${item.nid}_${i + 1}`);
  }

  // Collect skill NIDs
  const skillNids: string[] = unit.skills.map(s => s.nid);

  return {
    nid: unit.nid,
    name: unit.name,
    position: unit.position ? [unit.position[0], unit.position[1]] : null,
    team: unit.team,
    klass: unit.klass,
    level: unit.level,
    exp: unit.exp,
    stats: { ...unit.stats },
    currentHp: unit.currentHp,
    growths: { ...unit.growths },
    maxStats: { ...unit.maxStats },
    items: itemKeys,
    equippedItemIndex: unit.equippedWeapon ? unit.items.indexOf(unit.equippedWeapon) : null,
    skills: skillNids,
    tags: [...unit.tags],
    ai: unit.ai,
    wexp: { ...unit.wexp },
    startingPosition: unit.startingPosition
      ? [unit.startingPosition[0], unit.startingPosition[1]]
      : null,
    aiGroup: unit.aiGroup,
    portraitNid: unit.portraitNid,
    affinity: unit.affinity,
    hasAttacked: unit.hasAttacked,
    hasMoved: unit.hasMoved,
    hasTraded: unit.hasTraded,
    finished: unit.finished,
    dead: unit.dead,
    hasCanto: unit.hasCanto,
    party: unit.party,
    persistent: unit.persistent,
    statusEffects: unit.statusEffects.map(se => ({ ...se })),
    rescuingNid: unit.rescuing ? unit.rescuing.nid : null,
    rescuedByNid: unit.rescuedBy ? unit.rescuedBy.nid : null,
  };
}

function serializeItem(item: ItemObject, mapKey: string): ItemSaveData {
  const components: [string, any][] = [];
  for (const [k, v] of item.components) {
    components.push([k, v]);
  }

  return {
    nid: item.nid,
    name: item.name,
    desc: item.desc,
    iconNid: item.iconNid,
    iconIndex: [item.iconIndex[0], item.iconIndex[1]],
    components,
    uses: item.uses,
    maxUses: item.maxUses,
    droppable: item.droppable,
    ownerNid: item.owner ? item.owner.nid : null,
    mapKey,
  };
}

function serializeSkill(skill: SkillObject): SkillSaveData {
  const components: [string, any][] = [];
  for (const [k, v] of skill.components) {
    components.push([k, v]);
  }

  const data: [string, any][] = [];
  for (const [k, v] of skill.data) {
    data.push([k, v]);
  }

  return {
    nid: skill.nid,
    name: skill.name,
    desc: skill.desc,
    iconNid: skill.iconNid,
    iconIndex: [skill.iconIndex[0], skill.iconIndex[1]],
    components,
    data,
  };
}

function serializeLevel(
  level: LevelPrefab,
  tilemap: TileMapObject | null,
): LevelSaveData {
  // Collect layer visibility
  const layerVisibility: [string, boolean][] = [];
  if (tilemap) {
    for (const layer of tilemap.layers) {
      layerVisibility.push([layer.nid, layer.visible]);
    }
  }

  // Collect active weather
  const weather: string[] = [];
  if (tilemap) {
    for (const w of tilemap.weather) {
      weather.push(w.nid);
    }
  }

  // Collect unit NIDs from level units
  const unitNids: string[] = level.units.map(u => u.nid);

  // Collect region NIDs
  const regionNids: string[] = level.regions.map(r => r.nid);

  return {
    nid: level.nid,
    name: level.name,
    tilemapNid: level.tilemap,
    layerVisibility,
    weather,
    party: level.party,
    music: { ...level.music },
    objective: { ...level.objective },
    unitNids,
    regionNids,
  };
}

function serializeParty(party: PartyObject): PartySaveData {
  // Collect convoy item keys
  const convoyItemKeys: string[] = [];
  for (let i = 0; i < party.convoy.length; i++) {
    const item = party.convoy[i];
    convoyItemKeys.push(`convoy_${party.nid}_${item.nid}_${i}`);
  }

  return {
    nid: party.nid,
    name: party.name,
    leaderNid: party.leaderNid,
    money: party.money,
    convoyItemKeys,
    bexp: party.bexp,
  };
}

function serializeSupportPair(pair: SupportPair): SupportPairSaveData {
  return {
    nid: pair.nid,
    unit1Nid: pair.unit1Nid,
    unit2Nid: pair.unit2Nid,
    points: pair.points,
    lockedRanks: [...pair.lockedRanks],
    unlockedRanks: [...pair.unlockedRanks],
    pointsGainedThisChapter: pair.pointsGainedThisChapter,
    ranksGainedThisChapter: pair.ranksGainedThisChapter,
  };
}

// ============================================================================
// Build SaveDict from Game State
// ============================================================================

function buildSaveDict(game: any): SaveDict {
  // Serialize all items (including convoy items)
  const items: ItemSaveData[] = [];
  const serializedItemKeys = new Set<string>();

  // Items from the game.items map
  for (const [key, item] of game.items as Map<string, ItemObject>) {
    items.push(serializeItem(item, key));
    serializedItemKeys.add(key);
  }

  // Convoy items from parties (if not already in game.items)
  for (const party of (game.parties as Map<string, PartyObject>).values()) {
    for (let i = 0; i < party.convoy.length; i++) {
      const item = party.convoy[i];
      const key = `convoy_${party.nid}_${item.nid}_${i}`;
      if (!serializedItemKeys.has(key)) {
        items.push(serializeItem(item, key));
        serializedItemKeys.add(key);
      }
    }
  }

  // Serialize all units
  const units: UnitSaveData[] = [];
  for (const unit of (game.units as Map<string, UnitObject>).values()) {
    units.push(serializeUnit(unit));
  }

  // Serialize all unique skills from units
  const skills: SkillSaveData[] = [];
  const seenSkillNids = new Set<string>();
  for (const unit of (game.units as Map<string, UnitObject>).values()) {
    for (const skill of unit.skills) {
      if (!seenSkillNids.has(skill.nid)) {
        skills.push(serializeSkill(skill));
        seenSkillNids.add(skill.nid);
      }
    }
  }

  // Serialize level
  let level: LevelSaveData | null = null;
  if (game.currentLevel) {
    level = serializeLevel(game.currentLevel as LevelPrefab, game.tilemap as TileMapObject | null);
  }

  // Serialize parties
  const parties: PartySaveData[] = [];
  for (const party of (game.parties as Map<string, PartyObject>).values()) {
    parties.push(serializeParty(party));
  }

  // Serialize state stack
  const stateStack: string[] = [];
  // Access the state machine's internal stack via getCurrentState or iteration
  // The StateMachine doesn't expose its stack directly, so we store the current state name
  const currentState = game.state?.getCurrentState?.();
  if (currentState) {
    stateStack.push(currentState.name);
  }

  // Serialize supports
  let supports: SupportPairSaveData[] | null = null;
  if (game.supports) {
    try {
      // Access the pairs from the SupportController
      // The pairs are private, so we check for a save method or iterate
      const supportCtrl = game.supports;
      if (supportCtrl && typeof supportCtrl === 'object') {
        // Try to access pairs via any cast since it's private
        const pairs = (supportCtrl as any).pairs as Map<string, SupportPair> | undefined;
        if (pairs) {
          supports = [];
          for (const pair of pairs.values()) {
            supports.push(serializeSupportPair(pair));
          }
        }
      }
    } catch (err) {
      console.warn('Failed to serialize supports:', err);
    }
  }

  // Serialize records
  let records: RecordkeeperSaveData | null = null;
  if (game.records) {
    try {
      const rk = game.records as Recordkeeper;
      records = rk.save();
    } catch {
      // No records available
    }
  }

  // Serialize fog state from levelVars
  let fogState: any | null = null;
  const fogActive = game.levelVars?.get?.('_fog_of_war');
  if (fogActive) {
    fogState = {
      isActive: fogActive,
      type: game.levelVars?.get?.('_fog_of_war_type') ?? 1,
      radius: game.levelVars?.get?.('_fog_of_war_radius') ?? 0,
      aiRadius: game.levelVars?.get?.('_ai_fog_of_war_radius') ?? null,
      otherRadius: game.levelVars?.get?.('_other_fog_of_war_radius') ?? null,
    };
  }

  // Playtime: check if game tracks it; default to 0
  const playtime: number = (game as any).playtime ?? 0;

  // Talk options: may not exist on GameState yet
  const talkOptions: [string, string][] = [];
  if ((game as any).talkOptions) {
    for (const [k, v] of (game as any).talkOptions as Map<string, string>) {
      talkOptions.push([k, v]);
    }
  }

  return {
    units,
    items,
    skills,
    level,
    turncount: game.turnCount ?? 1,
    playtime,
    gameVars: Array.from((game.gameVars as Map<string, any>).entries()),
    levelVars: Array.from((game.levelVars as Map<string, any>).entries()),
    currentMode: game.currentMode
      ? (game.currentMode as DifficultyModeObject).save()
      : null,
    parties,
    currentParty: game.currentParty ?? '',
    stateStack,
    activeAiGroups: Array.from((game.activeAiGroups as Set<string>).values()),
    records,
    supports,
    marketItems: Array.from((game.marketItems as Map<string, number>).entries()),
    baseConvos: Array.from((game.baseConvos as Map<string, boolean>).entries()),
    talkOptions,
    fogState,
    roamInfo: {
      roam: game.roamInfo?.roam ?? false,
      roamUnitNid: game.roamInfo?.roamUnitNid ?? null,
    },
    overworldRegistry: Array.from(
      (game.overworldRegistry as Map<string, any>).entries(),
    ),
    memory: Array.from((game.memory as Map<string, any>).entries()),
  };
}

// ============================================================================
// Build Metadata
// ============================================================================

function buildMetadata(game: any, kind: string): SaveMetadata {
  const level = game.currentLevel as LevelPrefab | null;
  const playtime: number = (game as any).playtime ?? 0;

  return {
    playtime,
    realtime: Date.now(),
    version: '1.0.0',
    title: game.db?.getConstant?.('title', 'Lex Talionis') ?? 'Lex Talionis',
    mode: game.currentMode?.nid ?? null,
    levelNid: level?.nid ?? null,
    levelTitle: level?.name ?? 'Unknown',
    kind,
    displayName: null,
  };
}

// ============================================================================
// Save Functions
// ============================================================================

/**
 * Save the current game state to a numbered slot.
 *
 * @param game  The GameState singleton (typed as `any` to avoid circular deps).
 * @param slot  The save slot index (0-based).
 * @param kind  The save kind: 'start' | 'suspend' | 'battle' | 'turn_change'.
 */
export async function saveGame(
  game: any,
  slot: number,
  kind: string = 'battle',
): Promise<void> {
  try {
    const saveDict = buildSaveDict(game);
    const meta = buildMetadata(game, kind);

    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const saveKey = `${gameNid}-${slot}`;
    const metaKey = `${saveKey}.meta`;

    await idbSet(saveKey, saveDict);
    await idbSet(metaKey, meta);

    console.log(`Game saved to slot ${slot} (kind: ${kind})`);
  } catch (err) {
    console.error('Failed to save game:', err);
    throw err;
  }
}

/**
 * Save a suspend (quicksave) that is deleted after loading.
 */
export async function suspendGame(game: any): Promise<void> {
  try {
    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const saveKey = `${gameNid}-suspend`;
    const saveDict = buildSaveDict(game);
    const meta = buildMetadata(game, 'suspend');

    await idbSet(saveKey, saveDict);
    await idbSet(`${saveKey}.meta`, meta);

    console.log('Game suspended');
  } catch (err) {
    console.error('Failed to suspend game:', err);
    throw err;
  }
}

// ============================================================================
// Restore Helpers
// ============================================================================

// ============================================================================
// Main Restore Function
// ============================================================================

/**
 * Restore the full game state from a SaveDict.
 *
 * CRITICAL: Restoration order matters. Items must be restored before units
 * (since units reference items), and units before parties, etc.
 *
 * This function uses dynamic imports to avoid circular dependency issues
 * with the object constructors.
 */
async function restoreGameState(game: any, s: SaveDict): Promise<void> {
  // Use static imports (already imported at top of file)
  const ItemCtor = ItemObjectCtor;
  const SkillCtor = SkillObjectCtor;
  const UnitCtor = UnitObjectCtor;
  const PartyCtor = PartyObjectCtor;

  // 1. Reset transient game state
  game.units.clear();
  game.items.clear();
  game.activeAiGroups.clear();
  game.selectedUnit = null;
  game.infoMenuUnit = null;
  game.combatTarget = null;
  game.combatScript = null;
  game.shopUnit = null;
  game.shopItems = null;
  game.shopStock = null;
  game.currentEvent = null;
  game._moveOrigin = null;
  game._pendingAfterMovement = null;

  // 2. Restore game vars and level vars
  game.gameVars = new Map(s.gameVars);
  game.levelVars = new Map(s.levelVars);

  // 3. Restore difficulty mode
  if (s.currentMode) {
    game.currentMode = DifficultyModeObject.restore(s.currentMode);
  } else {
    game.currentMode = null;
  }

  // 4. Restore playtime and turncount
  game.turnCount = s.turncount;
  if ((game as any).playtime !== undefined) {
    (game as any).playtime = s.playtime;
  }

  // 5. Restore items FIRST (units reference items by key)
  const itemsByKey = new Map<string, ItemObject>();
  for (const itemData of s.items) {
    try {
      // Try to find prefab in DB for full fidelity
      const dbPrefab: ItemPrefab | undefined = game.db?.items?.get?.(itemData.nid);
      const prefab: ItemPrefab = dbPrefab ?? {
        nid: itemData.nid,
        name: itemData.name,
        desc: itemData.desc,
        icon_nid: itemData.iconNid,
        icon_index: itemData.iconIndex,
        components: itemData.components,
      };

      const item = new ItemCtor(prefab);

      // Override runtime state from save
      item.uses = itemData.uses;
      item.maxUses = itemData.maxUses;
      item.droppable = itemData.droppable;

      // Override component values from save (they may have been modified at runtime)
      (item as any).components = new Map<string, any>();
      for (const [k, v] of itemData.components) {
        item.components.set(k, v);
      }

      itemsByKey.set(itemData.mapKey, item);
      game.items.set(itemData.mapKey, item);
    } catch (err) {
      console.warn(`Failed to restore item "${itemData.nid}" (key: ${itemData.mapKey}):`, err);
    }
  }

  // 6. Restore skills (build a lookup by NID for unit restoration)
  const skillsByNid = new Map<string, SkillSaveData>();
  for (const skillData of s.skills) {
    skillsByNid.set(skillData.nid, skillData);
  }

  // 7. Restore units (reference items/skills by key/nid lookup)
  const unitsByNid = new Map<string, UnitObject>();
  for (const unitData of s.units) {
    try {
      // Get the class definition from DB
      const klassDef = game.db?.classes?.get?.(unitData.klass);
      if (!klassDef) {
        console.warn(`Skipping unit "${unitData.nid}": class "${unitData.klass}" not found in DB`);
        continue;
      }

      // Build a synthetic UnitPrefab from the saved data
      const syntheticPrefab = {
        nid: unitData.nid,
        name: unitData.name,
        desc: '',
        level: unitData.level,
        klass: unitData.klass,
        tags: unitData.tags,
        bases: unitData.stats,
        growths: unitData.growths,
        starting_items: [] as [string, boolean][],
        learned_skills: [] as [number, string][],
        wexp_gain: {} as Record<string, [boolean, number, number]>,
        portrait_nid: unitData.portraitNid,
        affinity: unitData.affinity,
      };

      const unit = new UnitCtor(syntheticPrefab, klassDef);

      // Override all fields from saved data
      unit.position = unitData.position;
      unit.team = unitData.team;
      unit.level = unitData.level;
      unit.exp = unitData.exp;
      unit.stats = { ...unitData.stats };
      unit.currentHp = unitData.currentHp;
      unit.growths = { ...unitData.growths };
      unit.maxStats = { ...unitData.maxStats };
      unit.tags = [...unitData.tags];
      unit.ai = unitData.ai;
      unit.wexp = { ...unitData.wexp };
      unit.startingPosition = unitData.startingPosition;
      unit.aiGroup = unitData.aiGroup;
      unit.portraitNid = unitData.portraitNid;
      unit.affinity = unitData.affinity;
      unit.hasAttacked = unitData.hasAttacked;
      unit.hasMoved = unitData.hasMoved;
      unit.hasTraded = unitData.hasTraded;
      unit.finished = unitData.finished;
      unit.dead = unitData.dead;
      unit.hasCanto = unitData.hasCanto;
      unit.party = unitData.party;
      unit.persistent = unitData.persistent;
      unit.statusEffects = unitData.statusEffects.map(se => ({ ...se }));

      // Restore items onto the unit
      unit.items = [];
      for (const itemKey of unitData.items) {
        const item = itemsByKey.get(itemKey);
        if (item) {
          item.owner = unit;
          unit.items.push(item);
        } else {
          console.warn(`Unit "${unitData.nid}": item key "${itemKey}" not found in restored items`);
        }
      }
      unit.equippedWeapon = unitData.equippedItemIndex === undefined
        ? unit.getEquippedWeapon()
        : unitData.equippedItemIndex === null
          ? null
          : unit.items[unitData.equippedItemIndex] ?? null;

      // Restore skills
      unit.skills = [];
      for (const skillNid of unitData.skills) {
        try {
          // Try DB prefab first
          const dbSkillPrefab: SkillPrefab | undefined = game.db?.skills?.get?.(skillNid);
          const savedSkillData = skillsByNid.get(skillNid);

          if (dbSkillPrefab) {
            const skill = new SkillCtor(dbSkillPrefab);

            // Override component values from save if available
            if (savedSkillData) {
              (skill as any).components = new Map<string, any>();
              for (const [k, v] of savedSkillData.components) {
                skill.components.set(k, v);
              }
              // Restore skill data
              (skill as any).data = new Map<string, any>();
              for (const [k, v] of savedSkillData.data) {
                skill.data.set(k, v);
              }
            }

            unit.skills.push(skill);
          } else if (savedSkillData) {
            // No DB prefab; construct from save data
            const syntheticSkillPrefab: SkillPrefab = {
              nid: savedSkillData.nid,
              name: savedSkillData.name,
              desc: savedSkillData.desc,
              icon_nid: savedSkillData.iconNid,
              icon_index: savedSkillData.iconIndex,
              components: savedSkillData.components,
            };
            const skill = new SkillCtor(syntheticSkillPrefab);
            // Restore data
            (skill as any).data = new Map<string, any>();
            for (const [k, v] of savedSkillData.data) {
              skill.data.set(k, v);
            }
            unit.skills.push(skill);
          } else {
            console.warn(`Unit "${unitData.nid}": skill "${skillNid}" not found in DB or save`);
          }
        } catch (err) {
          console.warn(`Unit "${unitData.nid}": failed to restore skill "${skillNid}":`, err);
        }
      }

      unitsByNid.set(unit.nid, unit);
      game.units.set(unit.nid, unit);
    } catch (err) {
      console.warn(`Failed to restore unit "${unitData.nid}":`, err);
    }
  }

  // 7b. Resolve rescue references (needs all units to be created first)
  for (const unitData of s.units) {
    const unit = unitsByNid.get(unitData.nid);
    if (!unit) continue;

    if (unitData.rescuingNid) {
      unit.rescuing = unitsByNid.get(unitData.rescuingNid) ?? null;
    }
    if (unitData.rescuedByNid) {
      unit.rescuedBy = unitsByNid.get(unitData.rescuedByNid) ?? null;
    }
  }

  // 8. Restore parties
  game.parties.clear();
  for (const partyData of s.parties) {
    try {
      const party = new PartyCtor(
        partyData.nid,
        partyData.name,
        partyData.leaderNid,
        partyData.money,
        partyData.bexp,
      );

      // Restore convoy items
      party.convoy = [];
      for (const itemKey of partyData.convoyItemKeys) {
        const item = itemsByKey.get(itemKey);
        if (item) {
          item.owner = null; // Convoy items are unowned
          party.convoy.push(item);
        }
      }

      game.parties.set(party.nid, party);
    } catch (err) {
      console.warn(`Failed to restore party "${partyData.nid}":`, err);
    }
  }
  game.currentParty = s.currentParty;

  // 9. Restore market/base
  game.marketItems = new Map(s.marketItems);
  game.baseConvos = new Map(s.baseConvos);

  // 9b. Restore talk options if game supports them
  if ((game as any).talkOptions !== undefined) {
    (game as any).talkOptions = new Map(s.talkOptions);
  }

  // 10. Restore records
  if (s.records) {
    try {
      game.records = Recordkeeper.restore(s.records);
    } catch (err) {
      console.warn('Failed to restore records:', err);
    }
  }

  // 11. Restore supports
  if (s.supports && game.supports) {
    try {
      const supportCtrl = game.supports;
      const pairs = (supportCtrl as any).pairs as Map<string, SupportPair> | undefined;
      if (pairs) {
        for (const savedPair of s.supports) {
          const existing = pairs.get(savedPair.nid);
          if (existing) {
            existing.points = savedPair.points;
            existing.lockedRanks = [...savedPair.lockedRanks];
            existing.unlockedRanks = [...savedPair.unlockedRanks];
            existing.pointsGainedThisChapter = savedPair.pointsGainedThisChapter;
            existing.ranksGainedThisChapter = savedPair.ranksGainedThisChapter;
          }
        }
      }
    } catch (err) {
      console.warn('Failed to restore supports:', err);
    }
  }

  // 12. Restore active AI groups
  game.activeAiGroups = new Set(s.activeAiGroups);

  // 13. Restore roam info
  if (game.roamInfo) {
    game.roamInfo.roam = s.roamInfo.roam;
    game.roamInfo.roamUnitNid = s.roamInfo.roamUnitNid;
  } else {
    game.roamInfo = new RoamInfo(s.roamInfo.roam, s.roamInfo.roamUnitNid);
  }

  // 14. Restore memory
  game.memory = new Map(s.memory);

  // 15. Restore level (if present)
  if (s.level) {
    await restoreLevel(game, s.level, unitsByNid);
  }

  // 16. Restore overworld registry
  game.overworldRegistry = new Map(s.overworldRegistry);
}

// ============================================================================
// Level Restoration
// ============================================================================

/**
 * Restore a level from saved data. This rebuilds the tilemap, game board,
 * path system, phase controller, etc.
 *
 * This is the most complex part of loading — it mirrors the level-loading
 * sequence in GameState.loadLevel() but uses saved state instead of fresh
 * prefab data.
 */
async function restoreLevel(
  game: any,
  levelData: LevelSaveData,
  unitsByNid: Map<string, UnitObject>,
): Promise<void> {
  try {
    // Get the level prefab from DB
    const levelPrefab = game.db?.levels?.get?.(levelData.nid);
    if (!levelPrefab) {
      console.warn(`restoreLevel: level "${levelData.nid}" not found in DB`);
      return;
    }

    game.currentLevel = levelPrefab;

    // Load tilemap
    const tilemapData = game.db?.tilemaps?.get?.(levelData.tilemapNid);
    if (!tilemapData) {
      console.warn(`restoreLevel: tilemap "${levelData.tilemapNid}" not found in DB`);
      return;
    }

    // Load tileset images
    const tilesetImages = new Map<string, HTMLImageElement>();
    const autotileImages = new Map<string, HTMLImageElement>();
    const tilesetDefs = new Map<string, any>();

    await Promise.all(
      tilemapData.tilesets.map(async (tsNid: string) => {
        const img = await game.resources?.tryLoadImage?.(
          `resources/tilesets/${tsNid}.png`,
        );
        if (img) tilesetImages.set(tsNid, img);

        const tsDef = game.db?.tilesets?.get?.(tsNid);
        if (tsDef) {
          tilesetDefs.set(tsNid, tsDef);
          if (tsDef.autotiles && Object.keys(tsDef.autotiles).length > 0) {
            const autoImg = await game.resources?.tryLoadImage?.(
              `resources/tilesets/${tsNid}_autotiles.png`,
            );
            if (autoImg) autotileImages.set(tsNid, autoImg);
          }
        }
      }),
    );

    // Build tilemap
    game.tilemap = TileMapObjectCtor.fromPrefab(tilemapData, tilesetImages, tilesetDefs, autotileImages);

    // Restore layer visibility
    if (game.tilemap && levelData.layerVisibility) {
      for (const [layerNid, visible] of levelData.layerVisibility) {
        if (visible) {
          game.tilemap.showLayer(layerNid);
        } else {
          game.tilemap.hideLayer(layerNid);
        }
      }
    }

    // Restore weather
    if (game.tilemap && levelData.weather) {
      for (const weatherNid of levelData.weather) {
        game.tilemap.addWeather(weatherNid);
      }
    }

    // Create GameBoard
    game.board = new GameBoard(game.tilemap.width, game.tilemap.height);
    game.board.initFromTilemap(game.tilemap);

    // Initialize fog grids and opacity
    const teamOrder = game.db?.teams?.defs?.map((t: any) => t.nid) ?? [];
    game.board.initFogGrids(teamOrder);
    game.board.initOpacityGrid(game.db);

    // Place units on the board
    for (const unit of unitsByNid.values()) {
      if (unit.position && !unit.dead) {
        try {
          game.board.setUnit(unit.position[0], unit.position[1], unit);
        } catch (err) {
          console.warn(`restoreLevel: failed to place unit "${unit.nid}" at ${unit.position}:`, err);
        }
      }
    }

    // Recalculate fog of war
    if (game.recalculateAllFow) {
      game.recalculateAllFow();
    }

    // Load map sprites for each unit
    const spriteCache = new Map<string, any>();
    const spriteLoadPromises: Promise<void>[] = [];

    for (const unit of unitsByNid.values()) {
      const klassDef = game.db?.classes?.get?.(unit.klass);
      if (!klassDef?.map_sprite_nid) continue;

      const spriteNid = klassDef.map_sprite_nid;
      const teamDef = game.db?.teams?.defs?.find?.((t: any) => t.nid === unit.team);
      const teamPalette = teamDef?.palette ?? undefined;
      const cacheKey = `${spriteNid}__${teamPalette ?? ''}`;

      spriteLoadPromises.push(
        (async () => {
          if (spriteCache.has(cacheKey)) {
            unit.sprite = spriteCache.get(cacheKey) ?? null;
            return;
          }
          try {
            const sprites = await game.resources?.tryLoadMapSprite?.(spriteNid);
            if (sprites) {
              const mapSprite = MapSpriteCtor.fromImages(sprites.stand, sprites.move, teamPalette);
              spriteCache.set(cacheKey, mapSprite);
              unit.sprite = mapSprite;
            }
          } catch {
            console.warn(`restoreLevel: failed to load sprite for unit "${unit.nid}"`);
          }
        })(),
      );
    }
    await Promise.all(spriteLoadPromises);

    // Create PathSystem
    game.pathSystem = new PathSystem(game.db);

    // Create PhaseController
    game.phase = new PhaseController(teamOrder);

    // Create EventManager
    game.eventManager = new EventManager(game.db?.events);

    // Create AIController
    game.aiController = new AIController(game.db, game.board, game.pathSystem);
    game.aiController.gameRef = game;

    // Create/restore SupportController
    if (!game.supports && game.db?.supportPairs) {
      game.supports = new SupportController(
        game.db.supportPairs,
        game.db.supportRanks,
        game.db.supportConstants,
        game.db.affinities,
      );
      game.supports.initPairs();
    }

    // Initialize camera and cursor
    if (game.camera && game.tilemap) {
      game.camera.setMapSize(game.tilemap.width, game.tilemap.height);
      game.camera.forcePosition(0, 0);
    }
    if (game.cursor && game.tilemap) {
      game.cursor.setMapSize(game.tilemap.width, game.tilemap.height);
      game.cursor.setPos(0, 0);
    }

    // Clear highlights
    if (game.highlight) {
      game.highlight.clear();
    }

    // Restore music
    if (levelData.music?.player_phase && game.audioManager) {
      try {
        await game.audioManager.playMusic(levelData.music.player_phase);
      } catch {
        // Music load failure is non-fatal
      }
    }
  } catch (err) {
    console.error('restoreLevel failed:', err);
  }
}

// ============================================================================
// Load Functions
// ============================================================================

/**
 * Load a saved game from a numbered slot.
 *
 * @param game  The GameState singleton.
 * @param slot  The save slot index.
 * @returns     True if the load succeeded, false if no save was found.
 */
export async function loadGame(game: any, slot: number): Promise<boolean> {
  try {
    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const saveKey = `${gameNid}-${slot}`;
    const saveDict: SaveDict | undefined = await idbGet(saveKey);

    if (!saveDict) {
      console.warn(`loadGame: no save found in slot ${slot}`);
      return false;
    }

    await restoreGameState(game, saveDict);
    console.log(`Game loaded from slot ${slot}`);
    return true;
  } catch (err) {
    console.error(`Failed to load game from slot ${slot}:`, err);
    return false;
  }
}

/**
 * Load a suspend (quicksave). The suspend is deleted after successful load.
 */
export async function loadSuspend(game: any): Promise<boolean> {
  try {
    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const saveKey = `${gameNid}-suspend`;
    const saveDict: SaveDict | undefined = await idbGet(saveKey);

    if (!saveDict) {
      console.warn('loadSuspend: no suspend save found');
      return false;
    }

    await restoreGameState(game, saveDict);

    // Delete suspend after successful load
    await idbDelete(saveKey);
    await idbDelete(`${saveKey}.meta`);

    console.log('Suspend loaded and cleared');
    return true;
  } catch (err) {
    console.error('Failed to load suspend:', err);
    return false;
  }
}

// ============================================================================
// Slot Management
// ============================================================================

/**
 * Load metadata for all save slots to display in the save/load menu.
 *
 * @param gameNid   The game project NID.
 * @param numSlots  Number of save slots to check.
 * @returns         Array of SaveSlot objects (empty slots have name '--NO DATA--').
 */
export async function loadSaveSlots(
  gameNid: string,
  numSlots: number,
): Promise<SaveSlot[]> {
  const slots: SaveSlot[] = [];

  for (let i = 0; i < numSlots; i++) {
    try {
      const metaKey = `${gameNid}-${i}.meta`;
      const meta: SaveMetadata | undefined = await idbGet(metaKey);

      if (meta) {
        slots.push({
          idx: i,
          name: meta.levelTitle,
          playtime: meta.playtime,
          realtime: meta.realtime,
          kind: meta.kind,
          mode: meta.mode,
          levelNid: meta.levelNid,
          displayName: meta.displayName,
        });
      } else {
        slots.push({
          idx: i,
          name: '--NO DATA--',
          playtime: 0,
          realtime: 0,
          kind: '',
          mode: null,
          levelNid: null,
          displayName: null,
        });
      }
    } catch (err) {
      console.warn(`Failed to load save slot ${i} metadata:`, err);
      slots.push({
        idx: i,
        name: '--NO DATA--',
        playtime: 0,
        realtime: 0,
        kind: '',
        mode: null,
        levelNid: null,
        displayName: null,
      });
    }
  }

  return slots;
}

/**
 * Delete a save from a specific slot.
 */
export async function deleteSave(
  gameNid: string,
  slot: number,
): Promise<void> {
  try {
    await idbDelete(`${gameNid}-${slot}`);
    await idbDelete(`${gameNid}-${slot}.meta`);
    console.log(`Save slot ${slot} deleted`);
  } catch (err) {
    console.error(`Failed to delete save slot ${slot}:`, err);
  }
}

/**
 * Check whether a suspend save exists for the given game.
 */
export async function hasSuspend(gameNid: string): Promise<boolean> {
  try {
    const meta = await idbGet(`${gameNid}-suspend.meta`);
    return !!meta;
  } catch {
    return false;
  }
}

/**
 * Delete the suspend save.
 */
export async function deleteSuspend(gameNid: string): Promise<void> {
  try {
    await idbDelete(`${gameNid}-suspend`);
    await idbDelete(`${gameNid}-suspend.meta`);
  } catch (err) {
    console.warn('Failed to delete suspend:', err);
  }
}

// ============================================================================
// Utility: List all save keys (for debugging / cleanup)
// ============================================================================

/**
 * List all save keys in the store. Useful for debugging.
 */
export async function listAllSaves(): Promise<string[]> {
  return idbKeys();
}

/**
 * Format playtime in milliseconds to a human-readable string.
 * e.g., 3661000 -> "1:01:01"
 */
export function formatPlaytime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number) => n.toString().padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}
