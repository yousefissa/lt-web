import type { Database } from '../src/data/database';
import type { EventPrefab, LevelPrefab, RegionData, UnitGroupData } from '../src/data/types';
import type { SolverObjectiveType, SolverPhase } from './types';

export interface ParsedEventCommand {
  nid: string;
  args: string[];
  raw: string;
}

export type EventSpawnTrigger =
  | { type: 'turn'; turn: number }
  | { type: 'region'; regionNid: string };

export interface EventGroupSpawnRule {
  id: string;
  groupNid: string;
  startingGroup?: string;
  trigger: EventSpawnTrigger;
  onlyOnce: boolean;
}

export interface EventTurnRule {
  id: string;
  turn: number;
  phase: SolverPhase;
  commands: ParsedEventCommand[];
}

export type EventInteractionType = 'visit' | 'chest' | 'door' | 'talk' | 'destructible';

export interface EventInteractionRule {
  id: string;
  type: EventInteractionType;
  commands: ParsedEventCommand[];
  regionNid?: string;
  actorNid?: string;
  targetNid?: string;
}

export interface StandardEventPlan {
  events: EventPrefab[];
  initialCommands: ParsedEventCommand[];
  turnRules: EventTurnRule[];
  spawnRules: EventGroupSpawnRule[];
  interactionRules: EventInteractionRule[];
}

export function parseEventCommand(raw: string): ParsedEventCommand | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const [nid, ...args] = trimmed.split(';').map((part) => part.trim());
  if (!nid) return null;
  return { nid: nid.toLowerCase(), args, raw };
}

export function eventsForLevel(db: Database, levelNid: string): EventPrefab[] {
  return Array.from(db.events.values())
    .filter((event) => event.level_nid === levelNid)
    .sort((a, b) => a.priority - b.priority || a.nid.localeCompare(b.nid));
}

export function inferObjectiveType(
  level: LevelPrefab,
  events: EventPrefab[],
  configured: SolverObjectiveType = 'auto',
): Exclude<SolverObjectiveType, 'auto'> {
  if (configured !== 'auto') return configured;
  if (level.regions.some((region) => region.sub_nid?.toLowerCase() === 'seize')) return 'seize';

  const winEvents = events.filter((event) => event._source.some((line) => parseEventCommand(line)?.nid === 'win_game'));
  if (winEvents.some((event) => /get_enemy_units\s*\(\s*\)/.test(event.condition) && /==\s*0/.test(event.condition))) {
    return 'rout';
  }
  if (winEvents.some((event) => /Boss|boss/.test(event.condition))) return 'defeat_boss';

  const objective = `${level.objective.simple} ${level.objective.win}`.toLowerCase();
  if (objective.includes('seize')) return 'seize';
  if (objective.includes('boss')) return 'defeat_boss';
  if (objective.includes('defeat enemy') || objective.includes('rout')) return 'rout';
  return 'rout';
}

export function buildStandardEventPlan(db: Database, level: LevelPrefab): StandardEventPlan {
  const events = eventsForLevel(db, level.nid);
  const initialCommands = events
    .filter((event) => event.trigger === 'level_start' && isAlwaysCondition(event.condition))
    .flatMap((event) => event._source.map(parseEventCommand).filter(isPresent));
  return {
    events,
    initialCommands,
    turnRules: deriveTurnRules(events),
    spawnRules: deriveGroupSpawnRules(events),
    interactionRules: deriveInteractionRules(events, level),
  };
}

export function deriveTurnRules(events: EventPrefab[]): EventTurnRule[] {
  const rules: EventTurnRule[] = [];
  for (const event of events) {
    const phase = phaseForTurnTrigger(event.trigger);
    if (!phase) continue;
    const trigger = parseTrigger(event.condition);
    if (trigger?.type !== 'turn') continue;
    rules.push({
      id: `${phase}-turn:${event.nid}`,
      turn: trigger.turn,
      phase,
      commands: event._source.map(parseEventCommand).filter(isPresent),
    });
  }
  return rules;
}

function phaseForTurnTrigger(trigger: string): SolverPhase | null {
  if (trigger === 'turn_change' || trigger === 'player_turn_change') return 'player';
  if (trigger === 'enemy_turn_change') return 'enemy';
  if (trigger === 'other_turn_change') return 'other';
  return null;
}

export function deriveInteractionRules(events: EventPrefab[], level: LevelPrefab): EventInteractionRule[] {
  const rules: EventInteractionRule[] = [];
  for (const event of events) {
    const trigger = event.trigger.toLowerCase();
    const commands = event._source.map(parseEventCommand).filter(isPresent);
    if (trigger === 'on_talk') {
      const actor = event.condition.match(/unit\.nid\s*==\s*['"]([^'"]+)['"]/i)?.[1];
      const target = event.condition.match(/unit2\.nid\s*==\s*['"]([^'"]+)['"]/i)?.[1];
      if (actor && target) {
        rules.push({ id: event.nid, type: 'talk', actorNid: actor, targetNid: target, commands });
      }
      continue;
    }

    const type = normalizeInteractionType(trigger);
    if (!type) continue;
    const conditionRegion = event.condition.match(/region\.nid\s*==\s*['"]([^'"]+)['"]/i)?.[1];
    const region = level.regions.find((candidate) =>
      candidate.sub_nid.toLowerCase() === trigger
      && (candidate.nid === event.name || candidate.nid === conditionRegion),
    ) ?? level.regions.find((candidate) =>
      candidate.sub_nid.toLowerCase() === trigger && candidate.nid === event.name,
    );
    if (region) rules.push({ id: event.nid, type, regionNid: region.nid, commands });
  }
  return rules;
}

export function deriveGroupSpawnRules(events: EventPrefab[]): EventGroupSpawnRule[] {
  const rules: EventGroupSpawnRule[] = [];
  for (const event of events) {
    if (event.trigger !== 'turn_change') continue;
    const trigger = parseTrigger(event.condition);
    if (!trigger) continue;

    const placements = new Map<string, string | undefined>();
    for (const command of event._source.map(parseEventCommand).filter(isPresent)) {
      if (command.nid === 'spawn_group') placements.set(command.args[0], command.args[2] || undefined);
      else if (command.nid === 'add_group') placements.set(command.args[0], command.args[1] || undefined);
      else if (command.nid === 'move_group' && placements.has(command.args[0])) {
        placements.set(command.args[0], command.args[1] || undefined);
      }
    }
    for (const [groupNid, startingGroup] of placements) {
      if (!groupNid) continue;
      rules.push({
        id: `${event.nid}:${groupNid}`,
        groupNid,
        startingGroup,
        trigger,
        onlyOnce: event.only_once,
      });
    }
  }
  return rules;
}

export function getGroup(level: LevelPrefab, nid: string): UnitGroupData | undefined {
  return level.unit_groups.find((group) => group.nid === nid);
}

export function resolveGroupPosition(
  level: LevelPrefab,
  group: UnitGroupData,
  unitNid: string,
  startingGroup?: string,
): [number, number] | null {
  if (!startingGroup) return clonePosition(group.positions[unitNid]);
  if (startingGroup.toLowerCase() === 'starting') {
    return clonePosition(level.units.find((unit) => unit.nid === unitNid)?.starting_position);
  }
  const literal = parsePosition(startingGroup);
  if (literal) return literal;
  return clonePosition(getGroup(level, startingGroup)?.positions[unitNid]);
}

export function findRegion(level: LevelPrefab, nid: string): RegionData | undefined {
  return level.regions.find((region) => region.nid === nid);
}

export function parsePosition(value: string | undefined): [number, number] | null {
  const match = value?.match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function parseTrigger(condition: string): EventSpawnTrigger | null {
  const turn = condition.match(/game\.turncount\s*==\s*(\d+)/);
  if (turn) return { type: 'turn', turn: Number(turn[1]) };
  const region = condition.match(/regions\.get\(\s*['"]([^'"]+)['"]\s*\)\.contains/);
  if (region) return { type: 'region', regionNid: region[1] };
  return null;
}

function isAlwaysCondition(condition: string): boolean {
  return ['true', '1'].includes(condition.trim().toLowerCase());
}

function normalizeInteractionType(trigger: string): EventInteractionType | null {
  if (trigger === 'visit' || trigger === 'chest' || trigger === 'door'
    || trigger === 'destructible') return trigger;
  return null;
}

function clonePosition(position: [number, number] | null | undefined): [number, number] | null {
  return position ? [position[0], position[1]] : null;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
