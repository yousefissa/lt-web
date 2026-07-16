import type { RngMode } from '../src/combat/combat-solver';

export type Position = [number, number];
export type SolverPhase = 'player' | 'enemy' | 'other';
export type SolverObjectiveType = 'auto' | 'seize' | 'rout' | 'defeat_boss';
export type SolverEventAdapter = 'none' | 'standard';

export interface TeamUnitConfig {
  enabled?: boolean;
  level?: number;
  exp?: number;
  items?: string[];
  stats?: Record<string, number>;
  position?: Position;
}

export interface ScriptedSpawn {
  turn: number;
  phase: SolverPhase;
  unitNid: string;
  team: string;
  position: Position;
  moveTo?: Position;
}

export interface SolverScenario {
  name: string;
  project?: string;
  levelNid: string;
  seed: number;
  rngMode?: RngMode;
  maxTurns: number;
  objective?: SolverObjectiveType;
  bossNid?: string;
  eventAdapter?: SolverEventAdapter;
  team: Record<string, TeamUnitConfig>;
  scriptedSpawns?: ScriptedSpawn[];
  requiredVisits?: string[];
  requiredRecruitments?: string[];
  requiredChests?: string[];
  requiredDoors?: string[];
  notes?: string[];
}

export interface PolicyWeights {
  kill: number;
  bossKill: number;
  damage: number;
  counterDamage: number;
  lethalRisk: number;
  progress: number;
  danger: number;
  wall: number;
  heal: number;
  stayHealthy: number;
  unitBias: Record<string, number>;
  /** Per-unit multiplier on the global expected-danger penalty. Defaults to 1. */
  unitRisk?: Record<string, number>;
}

export type SolverActionType = 'attack' | 'move' | 'wait' | 'heal' | 'seize' | 'spawn'
  | 'visit' | 'talk' | 'chest' | 'door' | 'interact';

export interface StrikeRecord {
  attacker: string;
  defender: string;
  item: string;
  hit: boolean;
  crit: boolean;
  damage: number;
  counter: boolean;
}

export interface UnitSnapshot {
  nid: string;
  name: string;
  team: string;
  klass: string;
  level: number;
  exp: number;
  hp: number;
  maxHp: number;
  position: Position | null;
  dead: boolean;
  items: Array<{ nid: string; uses: number }>;
}

export interface ReplayStep {
  index: number;
  turn: number;
  phase: SolverPhase;
  type: SolverActionType;
  actor?: string;
  from?: Position | null;
  to?: Position | null;
  target?: string;
  item?: string;
  description: string;
  strikes?: StrikeRecord[];
  units: UnitSnapshot[];
}

export interface MapSnapshot {
  width: number;
  height: number;
  terrain: string[][];
  terrainNames: Record<string, string>;
  seize: Position | null;
}

export interface SolverMetrics {
  cleared: boolean;
  lost: boolean;
  turns: number;
  actions: number;
  combats: number;
  damageTaken: number;
  healingReceived: number;
  playerDeaths: number;
  enemiesDefeated: number;
  wallsBroken: number;
  remainingPlayerHp: number;
  remainingEnemyHp: number;
}

export interface BenchmarkFingerprint {
  version: 1;
  scenarioSha256: string;
  projectDataSha256: string;
  engineSourceSha256: string;
  instanceSha256: string;
}

export interface SolverResult {
  scenario: string;
  levelNid: string;
  objective: Exclude<SolverObjectiveType, 'auto'>;
  seed: number;
  rngState: number;
  rngMode: RngMode;
  policy: PolicyWeights;
  metrics: SolverMetrics;
  score: number[];
  map: MapSnapshot;
  replay: ReplayStep[];
  finalUnits: UnitSnapshot[];
  elapsedMs: number;
  /** Explicit action route for planner-produced solutions. */
  plan?: PlannerAction[];
  planner?: BeamSearchStats;
  proof?: ProofSearchStats;
  interactions: SolverInteractionState;
  /** Immutable benchmark identity written by the CLI around simulator output. */
  benchmark?: BenchmarkFingerprint;
}

export type PlannerActionType = 'attack' | 'heal' | 'move' | 'wait' | 'seize'
  | 'visit' | 'talk' | 'chest' | 'door';

/** A fully specified, deterministic player action emitted by the simulator. */
export interface PlannerAction {
  type: PlannerActionType;
  turn: number;
  actor: string;
  position: Position;
  target?: string;
  item?: string;
  /** Inventory slot, used to distinguish duplicate copies of the same item. */
  itemIndex?: number;
  region?: string;
  /** Greedy policy estimate used only for branch ordering, never legality. */
  heuristic: number;
}

export interface LegalActionOptions {
  /** Optional search-only pruning. Omit to enumerate every legal move destination. */
  maxMovesPerUnit?: number;
  /** Optional search-only pruning. Omit to enumerate every legal attack. */
  maxAttacksPerUnit?: number;
  /** Optional search-only pruning. Omit to enumerate every legal heal. */
  maxHealsPerUnit?: number;
  includeWait?: boolean;
}

export interface TacticalItemCheckpoint {
  nid: string;
  uses: number;
  droppable: boolean;
}

export interface TacticalUnitCheckpoint {
  nid: string;
  name: string;
  team: string;
  klass: string;
  level: number;
  exp: number;
  position: Position | null;
  startingPosition: Position | null;
  currentHp: number;
  dead: boolean;
  stats: Record<string, number>;
  growths: Record<string, number>;
  maxStats: Record<string, number>;
  wexp: Record<string, number>;
  tags: string[];
  ai: string;
  aiGroup: string;
  items: TacticalItemCheckpoint[];
  hasAttacked: boolean;
  hasMoved: boolean;
  hasTraded: boolean;
  finished: boolean;
  hasCanto: boolean;
  party: string;
  persistent: boolean;
  statusEffects: unknown[];
  rescuing?: string;
  rescuedBy?: string;
}

/** Serializable simulator state. Immutable database/map data is intentionally excluded. */
export interface TacticalCheckpoint {
  version: 1;
  currentTurn: number;
  currentPhase: SolverPhase;
  playerPhasePrepared: boolean;
  cleared: boolean;
  lost: boolean;
  rngState: number;
  initialPlayerHp: number;
  metrics: SolverMetrics;
  firedEventRules: string[];
  activeRegions: string[];
  visibleLayers: string[];
  completedInteractions: string[];
  visitedRegions: string[];
  openedChests: string[];
  openedDoors: string[];
  destroyedRegions: string[];
  units: TacticalUnitCheckpoint[];
  replay?: ReplayStep[];
}

export interface SolverInteractionState {
  visitedRegions: string[];
  openedChests: string[];
  openedDoors: string[];
  destroyedRegions: string[];
  recruitedUnits: string[];
  requirementsSatisfied: boolean;
}

/** Irreversible path cost kept outside tactical transposition identity. */
export interface SearchCost {
  playerDeaths: number;
  damageTaken: number;
  actions: number;
}

export interface BeamSearchOptions extends LegalActionOptions {
  beamWidth: number;
  branchLimit: number;
  maxNodes: number;
  /** Fraction of the beam reserved for death/damage-first states (0..1). */
  damageFrontierRatio: number;
  maxPlayerDeaths?: number;
  maxDamage?: number;
  onProgress?: (stats: BeamSearchStats, incumbent: SolverResult) => void;
}

export interface BeamSearchStats {
  beamWidth: number;
  branchLimit: number;
  maxNodes: number;
  damageFrontierRatio: number;
  maxPlayerDeaths?: number;
  maxDamage?: number;
  nodesGenerated: number;
  nodesAccepted: number;
  cacheHits: number;
  dominancePrunes: number;
  boundPrunes: number;
  transpositionStates: number;
  transpositionLabels: number;
  frontierPeak: number;
  deepestTurn: number;
  incumbentSource: 'greedy' | 'beam';
  elapsedMs: number;
}

export interface BeamSearchResult {
  result: SolverResult;
  stats: BeamSearchStats;
}

export type ProofStatus = 'found' | 'infeasible' | 'unknown';

export interface ProofSearchOptions {
  maxNodes: number;
  maxPlayerDeaths?: number;
  maxDamage?: number;
  onProgress?: (stats: ProofSearchStats) => void;
}

export interface ProofSearchStats {
  maxNodes: number;
  prefixActions: number;
  maxPlayerDeaths?: number;
  maxDamage?: number;
  nodesGenerated: number;
  nodesAccepted: number;
  cacheHits: number;
  dominancePrunes: number;
  boundPrunes: number;
  transpositionStates: number;
  transpositionLabels: number;
  frontierPeak: number;
  deepestTurn: number;
  exhausted: boolean;
  elapsedMs: number;
}

export interface ProofSearchResult {
  status: ProofStatus;
  result?: SolverResult;
  stats: ProofSearchStats;
}

export interface SearchOptions {
  iterations: number;
  searchSeed: number;
  shardIndex?: number;
  shardCount?: number;
  onImprovement?: (result: SolverResult, iteration: number) => void;
}
