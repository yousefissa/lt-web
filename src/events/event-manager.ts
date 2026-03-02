import type { NID, EventPrefab } from '../data/types';
import { isPyev1 as _isPyev1, PythonEventProcessor as _PythonEventProcessor } from './python-events';
import { GameQueryEngine } from '../engine/query-engine';

// Lazy accessor to avoid circular-import issues at module evaluation time.
function _getPythonEvents() {
  return { isPyev1: _isPyev1, PythonEventProcessor: _PythonEventProcessor };
}

// ============================================================
// Event Scripting System
// ============================================================

/**
 * EventTrigger describes what kind of event to match.
 * Fields beyond `type` are optional and used for context-sensitive matching.
 */
export interface EventTrigger {
  type: string; // 'level_start', 'turn_change', 'combat_end', 'combat_death', 'on_talk', etc.
  levelNid?: NID;
  unitNid?: NID;        // primary unit (unit1)
  unitA?: NID;           // alias for unit1 in talk triggers
  unitB?: NID;           // unit2 in talk triggers
  regionNid?: NID;
  turnCount?: number;
  team?: string;
  // Context objects for condition evaluation
  unit1?: any;           // UnitObject reference
  unit2?: any;           // UnitObject reference
  position?: [number, number];
  region?: any;          // RegionData reference
  item?: any;            // ItemObject reference
}

export type EventCommandType =
  // Flow control
  | 'comment' | 'if' | 'elif' | 'else' | 'end' | 'for' | 'endf' | 'finish' | 'wait' | 'end_skip'
  // Music/sound
  | 'music' | 'music_fade_back' | 'music_clear' | 'sound' | 'stop_sound' | 'change_music' | 'change_special_music'
  // Portraits
  | 'add_portrait' | 'multi_add_portrait' | 'remove_portrait' | 'multi_remove_portrait'
  | 'remove_all_portraits' | 'move_portrait' | 'bop_portrait' | 'mirror_portrait' | 'expression'
  // Dialogue
  | 'speak_style' | 'speak' | 'say' | 'unhold' | 'unpause' | 'narrate' | 'alert' | 'location_card'
  | 'credits' | 'ending' | 'paired_ending' | 'pop_dialog' | 'toggle_narration_mode'
  | 'hide_combat_ui' | 'show_combat_ui'
  // Background/foreground
  | 'transition' | 'change_background' | 'pause_background' | 'unpause_background'
  // Cursor/camera
  | 'disp_cursor' | 'move_cursor' | 'center_cursor' | 'flicker_cursor' | 'screen_shake' | 'screen_shake_end'
  // Game-wide variables
  | 'game_var' | 'inc_game_var' | 'modify_game_var' | 'set_next_chapter'
  | 'enable_convoy' | 'disable_convoy' | 'open_convoy' | 'enable_supports' | 'enable_turnwheel'
  | 'activate_turnwheel' | 'clear_turnwheel'
  | 'stop_turnwheel_recording' | 'start_turnwheel_recording'
  | 'give_money' | 'give_bexp' | 'add_market_item' | 'remove_market_item'
  // Level-wide variables
  | 'level_var' | 'inc_level_var' | 'modify_level_var'
  | 'end_turn' | 'win_game' | 'lose_game' | 'main_menu' | 'skip_save'
  | 'add_talk' | 'remove_talk' | 'hide_talk' | 'unhide_talk'
  | 'change_objective_simple' | 'change_objective_win' | 'change_objective_loss'
  // Tilemap
  | 'change_tilemap' | 'show_layer' | 'hide_layer'
  | 'add_weather' | 'remove_weather' | 'map_anim' | 'remove_map_anim'
  // Regions
  | 'add_region' | 'region_condition' | 'remove_region'
  // Add/remove/interact units
  | 'load_unit' | 'make_generic' | 'create_unit'
  | 'add_unit' | 'move_unit' | 'remove_unit' | 'kill_unit' | 'remove_all_units' | 'remove_all_enemies'
  | 'interact_unit' | 'resurrect'
  // Modify unit properties
  | 'set_name' | 'set_current_hp' | 'set_current_mana'
  | 'reset' | 'has_attacked' | 'has_traded' | 'has_finished'
  | 'give_item' | 'equip_item' | 'remove_item' | 'move_item'
  | 'give_exp' | 'set_exp' | 'give_wexp' | 'set_wexp'
  | 'give_skill' | 'remove_skill'
  | 'change_ai' | 'change_party' | 'change_faction' | 'change_team'
  | 'change_portrait' | 'change_stats' | 'set_stats' | 'change_growths' | 'set_growths'
  | 'set_unit_level' | 'autolevel_to' | 'promote' | 'change_class'
  | 'add_tag' | 'remove_tag'
  // Unit groups
  | 'add_group' | 'spawn_group' | 'move_group' | 'remove_group'
  // Misc
  | 'battle_save' | 'prep' | 'base' | 'shop' | 'choice' | 'unchoice'
  | 'chapter_title' | 'set_tile'
  | 'has_visited' | 'unlock' | 'find_unlock' | 'spend_unlock'
  // Overworld
  | 'toggle_narration_mode' | 'overworld_cinematic' | 'reveal_overworld_node'
  | 'reveal_overworld_road' | 'overworld_move_unit' | 'set_overworld_position'
  | 'create_overworld_entity' | 'disable_overworld_entity'
  | 'set_overworld_menu_option_enabled' | 'set_overworld_menu_option_visible'
  | 'enter_level_from_overworld'
  // Arena / overlay
  | 'draw_overlay_sprite' | 'remove_overlay_sprite' | 'table' | 'remove_table' | 'textbox'
  // Fog of war
  | 'enable_fog_of_war' | 'set_fog_of_war'
  // Misc advanced
  | 'add_lore' | 'add_base_convo' | 'ignore_base_convo' | 'remove_base_convo'
  | 'clear_market_items'
  // Victory / credits
  | 'victory_screen' | 'credit'
  // Support system
  | 'increment_support_points' | 'unlock_support_rank' | 'disable_support_rank'
  // Initiative
  | 'add_to_initiative' | 'move_in_initiative'
  // Roam mode
  | 'set_roam' | 'set_roam_unit'
  // Persistent records & achievements
  | 'create_record' | 'update_record' | 'replace_record' | 'delete_record'
  | 'unlock_difficulty' | 'unlock_song'
  | 'add_achievement' | 'complete_achievement'
  // Save/load
  | 'battle_save_prompt' | 'suspend'
  // Short aliases
  | 's' | 'bop'
  // Legacy aliases (resolved to canonical form)
  | 'set_game_var' | 'change_objective';

export interface EventCommand {
  type: EventCommandType;
  args: string[];
}

// Canonical command set — all commands we recognize
const VALID_COMMANDS: Set<string> = new Set<string>([
  // Flow control
  'comment', 'if', 'elif', 'else', 'end', 'for', 'endf', 'finish', 'wait', 'end_skip',
  // Music/sound
  'music', 'music_fade_back', 'music_clear', 'sound', 'stop_sound', 'change_music', 'change_special_music',
  // Portraits
  'add_portrait', 'multi_add_portrait', 'remove_portrait', 'multi_remove_portrait',
  'remove_all_portraits', 'move_portrait', 'bop_portrait', 'mirror_portrait', 'expression',
  // Dialogue
  'speak_style', 'speak', 'say', 'unhold', 'unpause', 'narrate', 'alert', 'location_card',
  'credits', 'ending', 'paired_ending', 'pop_dialog', 'toggle_narration_mode',
  'hide_combat_ui', 'show_combat_ui',
  // Background/foreground
  'transition', 'change_background', 'pause_background', 'unpause_background',
  // Cursor/camera
  'disp_cursor', 'move_cursor', 'center_cursor', 'flicker_cursor', 'screen_shake', 'screen_shake_end',
  // Game-wide variables
  'game_var', 'inc_game_var', 'modify_game_var', 'set_next_chapter',
  'enable_convoy', 'disable_convoy', 'open_convoy', 'enable_supports', 'enable_turnwheel',
  'activate_turnwheel', 'clear_turnwheel',
  'stop_turnwheel_recording', 'start_turnwheel_recording',
  'give_money', 'give_bexp', 'add_market_item', 'remove_market_item',
  // Level-wide variables
  'level_var', 'inc_level_var', 'modify_level_var',
  'end_turn', 'win_game', 'lose_game', 'main_menu', 'skip_save',
  'add_talk', 'remove_talk', 'hide_talk', 'unhide_talk',
  'change_objective_simple', 'change_objective_win', 'change_objective_loss',
  // Tilemap
  'change_tilemap', 'show_layer', 'hide_layer',
  'add_weather', 'remove_weather', 'map_anim', 'remove_map_anim',
  // Regions
  'add_region', 'region_condition', 'remove_region',
  // Add/remove/interact units
  'load_unit', 'make_generic', 'create_unit',
  'add_unit', 'move_unit', 'remove_unit', 'kill_unit', 'remove_all_units', 'remove_all_enemies',
  'interact_unit', 'resurrect',
  // Modify unit properties
  'set_name', 'set_current_hp', 'set_current_mana',
  'reset', 'has_attacked', 'has_traded', 'has_finished',
  'give_item', 'equip_item', 'remove_item', 'move_item',
  'give_exp', 'set_exp', 'give_wexp', 'set_wexp',
  'give_skill', 'remove_skill',
  'change_ai', 'change_party', 'change_faction', 'change_team',
  'change_portrait', 'change_stats', 'set_stats', 'change_growths', 'set_growths',
  'set_unit_level', 'autolevel_to', 'promote', 'change_class',
  'add_tag', 'remove_tag',
  // Unit groups
  'add_group', 'spawn_group', 'move_group', 'remove_group',
  // Misc
  'battle_save', 'prep', 'base', 'shop', 'choice', 'unchoice',
  'chapter_title', 'set_tile',
  'has_visited', 'unlock', 'find_unlock', 'spend_unlock',
  // Base screen
  'add_base_convo', 'ignore_base_convo', 'remove_base_convo',
  'clear_market_items',
  // Support system
  'increment_support_points', 'unlock_support_rank', 'disable_support_rank',
  // Fog of war
  'enable_fog_of_war', 'set_fog_of_war',
  // Initiative
  'add_to_initiative', 'move_in_initiative',
  // Victory / credits
  'victory_screen', 'credit',
  // Overworld
  'create_overworld_entity', 'disable_overworld_entity',
  'set_overworld_menu_option_enabled', 'set_overworld_menu_option_visible',
  'enter_level_from_overworld',
  // Persistent records & achievements
  'create_record', 'update_record', 'replace_record', 'delete_record',
  'unlock_difficulty', 'unlock_song',
  'add_achievement', 'complete_achievement',
  // Save/load
  'battle_save', 'battle_save_prompt', 'skip_save', 'suspend',
  // Legacy/aliases from our old code
  'set_game_var', 'change_objective',
]);

/** Map of command aliases to their canonical names. */
const COMMAND_ALIASES: Record<string, string> = {
  // Common aliases from LT
  's': 'speak',
  'u': 'add_portrait',
  'uu': 'multi_add_portrait',
  'r': 'remove_portrait',
  'rr': 'multi_remove_portrait',
  'rrr': 'remove_all_portraits',
  'e': 'expression',
  'bop': 'bop_portrait',
  'mirror': 'mirror_portrait',
  't': 'transition',
  'b': 'change_background',
  'm': 'music',
  'mf': 'music_fade_back',
  'highlight': 'flicker_cursor',
  'set_cursor': 'move_cursor',
  'gvar': 'game_var',
  'ginc': 'inc_game_var',
  'mgvar': 'modify_game_var',
  'lvar': 'level_var',
  'linc': 'inc_level_var',
  'mlvar': 'modify_level_var',
  'add': 'add_unit',
  'move': 'move_unit',
  'remove': 'remove_unit',
  'kill': 'kill_unit',
  'interact': 'interact_unit',
  'reset_unit': 'reset',
  'add_skill': 'give_skill',
  'set_ai': 'change_ai',
  'set_roam_ai': 'change_roam_ai',
  'omove': 'overworld_move_unit',
  'set_ai_group': 'change_ai_group',
  'morph_group': 'move_group',
  'break': 'finish',
  'resurrect_unit': 'resurrect',
  'unlock_lore': 'add_lore',
  // Legacy names from our old code
  'set_game_var': 'game_var',
  'change_objective': 'change_objective_simple',
};

/**
 * GameEvent - A single event instance being executed.
 * Commands are parsed from semicolon-delimited source lines,
 * or processed through the PYEV1 Python-syntax event system.
 */
export class GameEvent {
  nid: NID;
  commands: EventCommand[];
  commandPointer: number;
  state: 'running' | 'waiting' | 'done';
  trigger: EventTrigger;

  // For speak commands
  currentDialog: { speaker: string; text: string } | null;
  waitingForInput: boolean;

  /** PYEV1 processor for Python-syntax events (null for standard events). */
  pyev1Processor: any | null;

  constructor(prefab: EventPrefab, trigger: EventTrigger, gameGetter?: () => any) {
    this.nid = prefab.nid;
    this.commands = [];
    this.commandPointer = 0;
    this.state = 'running';
    this.trigger = trigger;
    this.currentDialog = null;
    this.waitingForInput = false;
    this.pyev1Processor = null;

    // Check for PYEV1 format
    const { isPyev1, PythonEventProcessor } = _getPythonEvents();
    if (isPyev1(prefab._source)) {
      // Use PYEV1 processor
      this.pyev1Processor = new PythonEventProcessor(prefab._source, gameGetter);
      // Pre-fetch initial commands won't be used — getNextCommand will use pyev1
    } else {
      // Standard semicolon-delimited format
      for (const line of prefab._source) {
        const cmd = GameEvent.parseCommand(line);
        if (cmd) {
          this.commands.push(cmd);
        }
      }
    }

    // If the event has no commands and no pyev1 processor, mark as done immediately
    if (this.commands.length === 0 && !this.pyev1Processor) {
      this.state = 'done';
    }
  }

  /**
   * Get the next command for this event.
   * For PYEV1 events, fetches from the Python processor.
   * For standard events, returns the command at the current pointer.
   */
  getNextCommand(): EventCommand | null {
    if (this.pyev1Processor) {
      const cmd = this.pyev1Processor.fetchNextCommand();
      if (!cmd) {
        if (this.pyev1Processor.finished) {
          this.state = 'done';
        }
        return null;
      }
      return cmd;
    }
    // Standard path
    if (this.commandPointer >= this.commands.length) return null;
    return this.commands[this.commandPointer];
  }

  /**
   * Parse a source line into a command.
   * Format: "command_type;arg1;arg2;..."
   * Lines that are empty, whitespace-only, or start with '#' are comments.
   */
  static parseCommand(line: string): EventCommand | null {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) {
      return null;
    }

    const parts = trimmed.split(';');
    let rawType = parts[0].trim().toLowerCase();

    // Resolve aliases to canonical command names
    if (COMMAND_ALIASES[rawType]) {
      rawType = COMMAND_ALIASES[rawType];
    }

    if (!VALID_COMMANDS.has(rawType)) {
      return null;
    }

    const type = rawType as EventCommandType;
    const args = parts.slice(1).map((a) => a.trim());

    return { type, args };
  }

  /** Check if event is complete */
  isDone(): boolean {
    return this.state === 'done';
  }

  /** Mark event as done */
  finish(): void {
    this.state = 'done';
  }
}

// ============================================================
// Condition Evaluator
// ============================================================

/**
 * Evaluate a condition string from event data.
 * 
 * Supports a subset of the Python conditions used in LT:
 * - "True" / "False" / "1" / "0" / ""
 * - "game.turncount == N" / "game.turncount >= N" etc.
 * - "unit.nid == 'Name'" / "unit1.nid == 'Name'"
 * - "unit2.nid == 'Name'" / "unit.team == 'player'"
 * - "game.check_dead('Name')" / "check_dead('Name')"
 * - "not <condition>"
 * - "A and B" / "A or B"
 * - "region.nid == 'Name'"
 * - "check_pair('A', 'B')" — checks if unit1/unit2 match A/B in either order
 * - Simple variable lookups in gameVars/levelVars
 */
export function evaluateCondition(
  condition: string,
  context: ConditionContext,
): boolean {
  const trimmed = condition.trim();

  // Empty condition or literal True
  if (trimmed === '' || trimmed === 'True' || trimmed === 'true' || trimmed === '1') {
    return true;
  }

  // Literal False
  if (trimmed === 'False' || trimmed === 'false' || trimmed === '0') {
    return false;
  }

  // Handle 'and' / 'or' (split at top level, respecting parens)
  const andParts = splitAtTopLevel(trimmed, ' and ');
  if (andParts.length > 1) {
    return andParts.every(part => evaluateCondition(part, context));
  }

  const orParts = splitAtTopLevel(trimmed, ' or ');
  if (orParts.length > 1) {
    return orParts.some(part => evaluateCondition(part, context));
  }

  // Negation: "not <expr>"
  if (trimmed.toLowerCase().startsWith('not ')) {
    return !evaluateCondition(trimmed.slice(4), context);
  }

  // Strip outer parentheses
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const inner = trimmed.slice(1, -1);
    // Only strip if the parens are balanced
    if (findMatchingParen(trimmed, 0) === trimmed.length - 1) {
      return evaluateCondition(inner, context);
    }
  }

  // 'X' in unit.tags / 'X' in unit1.tags / 'X' in unit2.tags (Python `in` for lists)
  const inMatch = trimmed.match(/^['"](.+?)['"]\s+in\s+(.+)$/);
  if (inMatch) {
    const needle = inMatch[1];
    const haystack = resolvePath(inMatch[2], context);
    if (Array.isArray(haystack)) return haystack.includes(needle);
    if (typeof haystack === 'string') return haystack.includes(needle);
    return false;
  }

  // 'X' not in unit.tags
  const notInMatch = trimmed.match(/^['"](.+?)['"]\s+not\s+in\s+(.+)$/);
  if (notInMatch) {
    const needle = notInMatch[1];
    const haystack = resolvePath(notInMatch[2], context);
    if (Array.isArray(haystack)) return !haystack.includes(needle);
    if (typeof haystack === 'string') return !haystack.includes(needle);
    return true;
  }

  // Function calls: game.check_dead('Name'), check_dead('Name'), check_pair('A','B')
  const funcMatch = trimmed.match(/^(?:game\.)?check_dead\s*\(\s*['"](.+?)['"]\s*\)/);
  if (funcMatch) {
    const unitNid = funcMatch[1];
    return isUnitDead(unitNid, context);
  }

  // game.check_alive('Name') / check_alive('Name') — opposite of check_dead
  const aliveMatch = trimmed.match(/^(?:game\.)?check_alive\s*\(\s*['"](.+?)['"]\s*\)/);
  if (aliveMatch) {
    return !isUnitDead(aliveMatch[1], context);
  }

  const checkPairMatch = trimmed.match(/^check_pair\s*\(\s*['"](.+?)['"]\s*,\s*['"](.+?)['"]\s*\)/);
  if (checkPairMatch) {
    const a = checkPairMatch[1];
    const b = checkPairMatch[2];
    const u1 = context.unit1?.nid;
    const u2 = context.unit2?.nid;
    return (u1 === a && u2 === b) || (u1 === b && u2 === a);
  }

  const checkDefaultMatch = trimmed.match(/^check_default\s*\(\s*['"](.+?)['"]\s*,\s*\[(.+?)\]\s*\)/);
  if (checkDefaultMatch) {
    // check_default("target_nid", ['unit1_nid', 'unit2_nid'])
    // Returns true if unit2 matches target_nid AND unit1 is NOT in the exception list
    const targetNid = checkDefaultMatch[1];
    const exceptionList = checkDefaultMatch[2].split(',').map(s => s.trim().replace(/['"]/g, ''));
    const u1 = context.unit1?.nid;
    const u2 = context.unit2?.nid;
    if (u2 !== targetNid) return false;
    return !exceptionList.includes(u1 ?? '');
  }

  // has_item('ItemNid', unit_nid_or_specifier) — check if a unit has an item
  const hasItemMatch = trimmed.match(/^has_item\s*\(\s*['"](.+?)['"]\s*(?:,\s*(.+?))?\s*\)/);
  if (hasItemMatch) {
    const itemNid = hasItemMatch[1];
    const specifier = hasItemMatch[2]?.trim();
    // If specifier is a path like unit.nid, resolve it
    let targetNid: string | undefined;
    if (specifier) {
      const resolved = resolvePath(specifier, context);
      targetNid = typeof resolved === 'string' ? resolved : undefined;
    }
    // Search units for the item
    if (context.game?.units) {
      for (const [_, u] of context.game.units) {
        if (targetNid && (u as any).nid !== targetNid) continue;
        const items = (u as any).items ?? [];
        if (items.some((item: any) => item.nid === itemNid)) return true;
      }
    }
    return false;
  }

  // has_skill('SkillNid', unit_nid_or_specifier) — check if a unit has a skill
  const hasSkillFuncMatch = trimmed.match(/^has_skill\s*\(\s*['"](.+?)['"]\s*(?:,\s*(.+?))?\s*\)/);
  if (hasSkillFuncMatch) {
    const skillNid = hasSkillFuncMatch[1];
    const specifier = hasSkillFuncMatch[2]?.trim();
    let targetUnit = context.unit1;
    if (specifier) {
      const resolved = resolvePath(specifier, context);
      if (typeof resolved === 'string' && context.game?.units) {
        targetUnit = context.game.units.get(resolved);
      } else if (resolved && typeof resolved === 'object') {
        targetUnit = resolved;
      }
    }
    if (!targetUnit) return false;
    const skills = targetUnit.skills ?? [];
    return skills.some((s: any) => s.nid === skillNid);
  }

  // v('varname') / v('varname', default) — variable lookup (level vars then game vars)
  const vMatch = trimmed.match(/^v\s*\(\s*['"](.+?)['"]\s*(?:,\s*(.+?))?\s*\)/);
  if (vMatch) {
    const varName = vMatch[1];
    const fallback = vMatch[2] !== undefined ? resolvePath(vMatch[2], context) : undefined;
    if (context.levelVars?.has(varName)) return context.levelVars.get(varName);
    if (context.gameVars?.has(varName)) return context.gameVars.get(varName);
    return fallback ?? 0;
  }

  // unit.can_unlock(region) — check if unit has a key/lockpick item
  const canUnlockMatch = trimmed.match(/^(?:unit\d?\.)?can_unlock\s*\(\s*(\w+)\s*\)/);
  if (canUnlockMatch) {
    const unit = context.unit1;
    const region = context.region;
    if (!unit) return false;
    const items = unit.items ?? [];

    const canUnlockByExpr = (expr: unknown): boolean => {
      if (typeof expr !== 'string') return !!expr;
      const trimmedExpr = expr.trim();
      if (!region?.nid) return false;

      // Common LT patterns for key restrictions.
      const chestMatch = trimmedExpr.match(/^region\.nid\.startswith\(\s*['"]Chest['"]\s*\)$/);
      if (chestMatch) return String(region.nid).startsWith('Chest');
      const doorMatch = trimmedExpr.match(/^region\.nid\.startswith\(\s*['"]Door['"]\s*\)$/);
      if (doorMatch) return String(region.nid).startsWith('Door');

      // Fallback: try generic condition evaluation with current context.
      return evaluateCondition(trimmedExpr, context);
    };

    return items.some((item: any) => {
      const comps = item.components;

      // Runtime ItemObject stores components as Map<string, any>.
      if (comps instanceof Map) {
        if (comps.has('can_unlock')) {
          return canUnlockByExpr(comps.get('can_unlock'));
        }
        return comps.has('unlock') || comps.has('lockpick') || comps.has('key') ||
               comps.has('keys') || comps.has('Key') || comps.has('Keys');
      }

      // Fallbacks for prefab-like shapes used by tools/tests.
      if (Array.isArray(comps)) {
        const canUnlockComp = comps.find((c: any) => (Array.isArray(c) ? c[0] : c?.nid ?? c?.name) === 'can_unlock');
        if (canUnlockComp) {
          const expr = Array.isArray(canUnlockComp) ? canUnlockComp[1] : canUnlockComp?.value;
          return canUnlockByExpr(expr);
        }
        return comps.some((c: any) => {
          const name = Array.isArray(c) ? c[0] : c?.nid ?? c?.name ?? '';
          return name === 'unlock' || name === 'lockpick' || name === 'key' ||
                 name === 'keys' || name === 'Key' || name === 'Keys';
        });
      }

      if (comps && typeof comps === 'object') {
        if ('can_unlock' in comps) {
          return canUnlockByExpr((comps as any).can_unlock);
        }
        return 'unlock' in comps || 'lockpick' in comps || 'key' in comps ||
               'keys' in comps || 'Key' in comps || 'Keys' in comps;
      }

      return false;
    });
  }

  // is_dead('UnitNid') — shorthand for check_dead
  const isDeadMatch = trimmed.match(/^(?:game\.)?is_dead\s*\(\s*['"](.+?)['"]\s*\)/);
  if (isDeadMatch) {
    return isUnitDead(isDeadMatch[1], context);
  }

  // len(game.get_enemy_units()) == N
  const lenEnemyMatch = trimmed.match(/^len\s*\(\s*game\.get_enemy_units\s*\(\s*\)\s*\)\s*(==|!=|>=|<=|>|<)\s*(\d+)/);
  if (lenEnemyMatch) {
    const op = lenEnemyMatch[1];
    const n = parseInt(lenEnemyMatch[2], 10);
    const enemies = context.game?.board?.getTeamUnits('enemy') ?? [];
    const count = enemies.filter((u: any) => !u.isDead()).length;
    return compareNumbers(count, op, n);
  }

  // any_unit_in_region('RegionNid', team='enemy') and similar patterns
  const anyUnitInRegionMatch = trimmed.match(/^any_unit_in_region\s*\(\s*['"](.+?)['"]\s*(?:,\s*(?:team\s*=\s*)?['"](.+?)['"]\s*)?\)/);
  if (anyUnitInRegionMatch) {
    const regionNid = anyUnitInRegionMatch[1];
    const teamFilter = anyUnitInRegionMatch[2];
    const regions = context.game?.currentLevel?.regions ?? [];
    const region = regions.find((r: any) => r.nid === regionNid);
    if (!region) return false;
    const [rx, ry] = region.position;
    const [rw, rh] = region.size;
    if (context.game?.units) {
      for (const [_, u] of context.game.units) {
        if (teamFilter && (u as any).team !== teamFilter) continue;
        const pos = (u as any).position;
        if (!pos) continue;
        if (pos[0] >= rx && pos[0] < rx + rw && pos[1] >= ry && pos[1] < ry + rh) {
          return true;
        }
      }
    }
    return false;
  }

  // Comparison operators: resolve dotted paths
  const comparisonOps = ['==', '!=', '>=', '<=', '>', '<'] as const;
  for (const op of comparisonOps) {
    const idx = findTopLevelOperator(trimmed, op);
    if (idx !== -1) {
      const lhs = trimmed.slice(0, idx).trim();
      const rhs = trimmed.slice(idx + op.length).trim();
      return evaluateComparison(lhs, op, rhs, context);
    }
  }

  // Bare variable/path: truthy check
  const value = resolvePath(trimmed, context);
  if (value !== undefined) {
    return !!value;
  }

  // Fallback: try JavaScript-based evaluation with Python-compatible scope.
  // This handles complex expressions like:
  //   game.level.regions.get('EnemyRein').contains(game.get_unit('Eirika').position)
  //   any(game.level.regions.get('X').contains(u.position) for u in game.get_units_in_party())
  //   len(game.get_enemy_units()) == 0
  try {
    const result = evaluateWithJsFallback(trimmed, context);
    if (result !== undefined) {
      return !!result;
    }
  } catch (e) {
    // Fall through to default
  }

  // Unknown condition — warn and default to false (skip events with un-evaluable conditions;
  // firing them would cause reinforcements/etc. to trigger at wrong times)
  console.warn(`EventCondition: cannot evaluate "${trimmed}", defaulting to false`);
  return false;
}

/** Context object for condition evaluation. */
export interface ConditionContext {
  game?: any;            // GameState reference
  unit1?: any;           // Primary unit (from trigger)
  unit2?: any;           // Secondary unit (from trigger)
  position?: [number, number];
  region?: any;          // RegionData
  item?: any;            // ItemObject
  gameVars?: Map<string, any>;
  levelVars?: Map<string, any>;
  localArgs?: Map<string, any>;  // Trigger-specific extra args
}

/** Resolve a dotted path like "game.turncount", "unit.nid", "region.nid" to a value. */
function resolvePath(path: string, ctx: ConditionContext): any {
  const trimmed = path.trim();

  // String literals
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }

  // Numeric literals
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== '') {
    return num;
  }

  // Boolean literals
  if (trimmed === 'True' || trimmed === 'true') return true;
  if (trimmed === 'False' || trimmed === 'false') return false;

  // Dotted path resolution
  const parts = trimmed.split('.');

  // game.turncount, game.game_vars, game.level_vars, etc.
  if (parts[0] === 'game' && ctx.game) {
    return resolveObject(ctx.game, parts.slice(1));
  }

  // unit.nid, unit.team, unit.level, etc. (alias for unit1)
  if ((parts[0] === 'unit' || parts[0] === 'unit1') && ctx.unit1) {
    return resolveObject(ctx.unit1, parts.slice(1));
  }

  // unit2.nid, unit2.team, etc.
  if (parts[0] === 'unit2' && ctx.unit2) {
    return resolveObject(ctx.unit2, parts.slice(1));
  }

  // region.nid, region.region_type, etc.
  if (parts[0] === 'region' && ctx.region) {
    return resolveObject(ctx.region, parts.slice(1));
  }

  // item.nid, etc.
  if (parts[0] === 'item' && ctx.item) {
    return resolveObject(ctx.item, parts.slice(1));
  }

  // position
  if (trimmed === 'position') return ctx.position;

  // support_rank_nid (from trigger local args)
  if (ctx.localArgs?.has(trimmed)) {
    return ctx.localArgs.get(trimmed);
  }

  // Game vars lookup
  if (ctx.gameVars?.has(trimmed)) {
    return ctx.gameVars.get(trimmed);
  }

  // Level vars lookup
  if (ctx.levelVars?.has(trimmed)) {
    return ctx.levelVars.get(trimmed);
  }

  return undefined;
}

/** Walk an object by property names. */
function resolveObject(obj: any, parts: string[]): any {
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    // Handle snake_case -> camelCase mapping for common fields
    const camelPart = snakeToCamel(part);
    if (part in current) {
      current = current[part];
    } else if (camelPart in current) {
      current = current[camelPart];
    } else {
      // Special cases for GameState
      if (part === 'turncount' || part === 'turn_count') return current.turnCount ?? current.turncount;
      if (part === 'game_vars') return current.gameVars ?? current.game_vars;
      if (part === 'level_vars') return current.levelVars ?? current.level_vars;
      if (part === 'current_hp') return current.currentHp ?? current.current_hp;
      if (part === 'max_hp') return current.maxHp ?? current.max_hp;
      return undefined;
    }
  }
  return current;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function isUnitDead(nid: string, ctx: ConditionContext): boolean {
  if (!ctx.game) return false;
  const unit = ctx.game.units?.get(nid) ?? ctx.game.getUnit?.(nid);
  if (!unit) return true; // Unit not found = treated as dead
  return unit.isDead?.() ?? unit.dead ?? false;
}

function compareNumbers(lhs: number, op: string, rhs: number): boolean {
  switch (op) {
    case '==': return lhs === rhs;
    case '!=': return lhs !== rhs;
    case '>': return lhs > rhs;
    case '<': return lhs < rhs;
    case '>=': return lhs >= rhs;
    case '<=': return lhs <= rhs;
    default: return false;
  }
}

function evaluateComparison(
  lhsStr: string,
  op: string,
  rhsStr: string,
  ctx: ConditionContext,
): boolean {
  const lhsValue = resolvePath(lhsStr, ctx);
  const rhsValue = resolvePath(rhsStr, ctx);

  // If both resolve to numbers, compare numerically
  const lhsNum = typeof lhsValue === 'number' ? lhsValue : Number(lhsValue);
  const rhsNum = typeof rhsValue === 'number' ? rhsValue : Number(rhsValue);
  const bothNumeric = !isNaN(lhsNum) && !isNaN(rhsNum) &&
    lhsValue !== undefined && rhsValue !== undefined &&
    lhsStr !== '' && rhsStr !== '';

  if (bothNumeric) {
    return compareNumbers(lhsNum, op, rhsNum);
  }

  // String comparison
  const lhsFinal = lhsValue !== undefined ? String(lhsValue) : lhsStr;
  const rhsFinal = rhsValue !== undefined ? String(rhsValue) : rhsStr;

  switch (op) {
    case '==': return lhsFinal === rhsFinal;
    case '!=': return lhsFinal !== rhsFinal;
    case '>': return lhsFinal > rhsFinal;
    case '<': return lhsFinal < rhsFinal;
    case '>=': return lhsFinal >= rhsFinal;
    case '<=': return lhsFinal <= rhsFinal;
    default: return false;
  }
}

/** Find the index of a comparison operator, skipping operators inside strings/parens. */
function findTopLevelOperator(str: string, op: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (ch === inString && str[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && str.slice(i, i + op.length) === op) {
      // Make sure we're not matching a longer operator (e.g., '=' inside '==')
      if (op === '>' && str[i + 1] === '=') continue;
      if (op === '<' && str[i + 1] === '=') continue;
      if (op === '=' && str[i + 1] === '=') continue;
      if (op === '!' && str[i + 1] === '=') continue;
      return i;
    }
  }
  return -1;
}

/** Split a string at a delimiter, but only at the top level (not inside parens/strings). */
function splitAtTopLevel(str: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (ch === inString && str[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && str.slice(i, i + delimiter.length) === delimiter) {
      parts.push(str.slice(start, i));
      start = i + delimiter.length;
      i += delimiter.length - 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

/** Find the matching closing paren for the paren at index `start`. */
function findMatchingParen(str: string, start: number): number {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '(') depth++;
    if (str[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ============================================================
// JavaScript-based fallback evaluator for complex Python conditions
// ============================================================

/**
 * Build a Python-compatible game object proxy for use in eval.
 * This creates wrapper objects that mirror the Python API so expressions
 * like `game.level.regions.get('X').contains(pos)` work in JavaScript.
 */
function buildEvalScope(ctx: ConditionContext): Record<string, any> {
  const game = ctx.game;
  if (!game) return {};

  // Region wrapper: adds .contains() method and makes regions accessible via .get()
  function wrapRegion(r: any) {
    if (!r) return null;
    return {
      nid: r.nid,
      region_type: r.region_type,
      position: r.position,
      size: r.size,
      sub_nid: r.sub_nid,
      condition: r.condition,
      contains(pos: [number, number] | null): boolean {
        if (!pos || !r.position) return false;
        const [px, py] = pos;
        const [rx, ry] = r.position;
        const [rw, rh] = r.size ?? [1, 1];
        return px >= rx && px < rx + rw && py >= ry && py < ry + rh;
      },
    };
  }

  // Regions collection wrapper: adds .get(nid) method
  function wrapRegions(regions: any[]) {
    return {
      get(nid: string) {
        const r = regions.find((reg: any) => reg.nid === nid);
        return wrapRegion(r);
      },
      values() { return regions.map(wrapRegion); },
    };
  }

  // Unit wrapper: ensures consistent API
  function wrapUnit(u: any) {
    if (!u) return null;
    return {
      nid: u.nid,
      name: u.name,
      team: u.team,
      position: u.position,
      tags: u.tags ?? [],
      klass: u.klass,
      dead: u.isDead?.() ?? u.dead ?? false,
      level: u.level,
      current_hp: u.currentHp ?? u.current_hp,
      max_hp: u.maxHp ?? u.max_hp,
    };
  }

  // Helper: get all alive units of a team
  function getTeamUnits(team: string) {
    const units: any[] = [];
    if (game.units) {
      for (const [_, u] of game.units) {
        if ((u as any).team === team && !(u as any).isDead?.()) {
          units.push(wrapUnit(u));
        }
      }
    }
    return units;
  }

  // Build the game proxy object
  const regions = game.currentLevel?.regions ?? [];
  const gameProxy: any = {
    turncount: game.turnCount ?? game.turncount ?? 0,
    turn_count: game.turnCount ?? game.turncount ?? 0,
    game_vars: game.gameVars ?? new Map(),
    level_vars: game.levelVars ?? new Map(),
    level: {
      regions: wrapRegions(regions),
      nid: game.currentLevel?.nid ?? '',
    },
    get_unit(nid: string) {
      const u = game.units?.get(nid) ?? game.getUnit?.(nid);
      return wrapUnit(u);
    },
    get_enemy_units() { return getTeamUnits('enemy'); },
    get_player_units() { return getTeamUnits('player'); },
    get_units_in_party() { return getTeamUnits('player'); },
    get_all_units() {
      const units: any[] = [];
      if (game.units) {
        for (const [_, u] of game.units) {
          units.push(wrapUnit(u));
        }
      }
      return units;
    },
    check_dead(nid: string) {
      const u = game.units?.get(nid) ?? game.getUnit?.(nid);
      if (!u) return true;
      return u.isDead?.() ?? u.dead ?? false;
    },
    check_alive(nid: string) {
      return !gameProxy.check_dead(nid);
    },
  };

  return gameProxy;
}

/**
 * Attempt to evaluate a Python condition using JavaScript Function().
 * Translates common Python idioms to JS before eval.
 * Returns the evaluation result, or undefined if it fails.
 */
function evaluateWithJsFallback(
  condition: string,
  ctx: ConditionContext,
): any {
  const game = ctx.game;
  if (!game) return undefined;

  // Translate Python idioms to JavaScript
  let jsExpr = condition;

  // Python `len(x)` -> `x.length`
  jsExpr = jsExpr.replace(/\blen\s*\(/g, '__len__(');

  // Python `True`/`False` -> `true`/`false`
  jsExpr = jsExpr.replace(/\bTrue\b/g, 'true');
  jsExpr = jsExpr.replace(/\bFalse\b/g, 'false');
  jsExpr = jsExpr.replace(/\bNone\b/g, 'null');

  // Python `and`/`or`/`not` -> `&&`/`||`/`!`
  jsExpr = jsExpr.replace(/\band\b/g, '&&');
  jsExpr = jsExpr.replace(/\bor\b/g, '||');
  jsExpr = jsExpr.replace(/\bnot\b/g, '!');

  // Python `'x' in list` -> `list.includes('x')` (simple cases)
  // This is hard to do generically with regex, so we leave it for
  // the pattern matcher above which handles these well.

  // Python `any(expr for x in xs)` -> `xs.some(x => expr)`
  jsExpr = jsExpr.replace(
    /\bany\s*\(\s*(.+?)\s+for\s+(\w+)\s+in\s+(.+?)\s*\)/g,
    '($3).some(($2) => ($1))',
  );

  // Build scope
  const gameProxy = buildEvalScope(ctx);

  // Build check_pair / check_default helpers
  const unit1 = ctx.unit1;
  const unit2 = ctx.unit2;
  const check_pair = (a: string, b: string) => {
    const u1 = unit1?.nid;
    const u2 = unit2?.nid;
    return (u1 === a && u2 === b) || (u1 === b && u2 === a);
  };
  const check_default = (targetNid: string, exceptions: string[]) => {
    if (!unit1 || !unit2) return false;
    if (unit1.nid === targetNid && unit2.team === 'player') {
      return !exceptions.includes(unit2.nid);
    }
    if (unit2.nid === targetNid && unit1.team === 'player') {
      return !exceptions.includes(unit1.nid);
    }
    return false;
  };

  // len() helper
  const __len__ = (x: any) => {
    if (Array.isArray(x)) return x.length;
    if (x && typeof x === 'object' && 'size' in x) return x.size;
    return 0;
  };

  // v() helper: level vars take priority over game vars
  const v = (varName: string, fallback?: any) => {
    if (ctx.levelVars?.has(varName)) return ctx.levelVars.get(varName);
    if (ctx.gameVars?.has(varName)) return ctx.gameVars.get(varName);
    return fallback ?? 0;
  };

  // cf proxy (just for cf.SETTINGS['debug'])
  const cf = { SETTINGS: { debug: false } };

  // Wrap unit/region from context
  const unit = unit1 ? {
    nid: unit1.nid, name: unit1.name, team: unit1.team,
    position: unit1.position, tags: unit1.tags ?? [],
    klass: unit1.klass, dead: unit1.isDead?.() ?? false,
  } : null;
  const target = unit2 ? {
    nid: unit2.nid, name: unit2.name, team: unit2.team,
    position: unit2.position, tags: unit2.tags ?? [],
    klass: unit2.klass, dead: unit2.isDead?.() ?? false,
  } : null;
  const region = ctx.region ? {
    nid: ctx.region.nid, position: ctx.region.position,
    size: ctx.region.size, region_type: ctx.region.region_type,
    sub_nid: ctx.region.sub_nid,
    contains(pos: [number, number] | null) {
      if (!pos || !ctx.region.position) return false;
      const [px, py] = pos;
      const [rx, ry] = ctx.region.position;
      const [rw, rh] = ctx.region.size ?? [1, 1];
      return px >= rx && px < rx + rw && py >= ry && py < ry + rh;
    },
  } : null;
  const position = ctx.position;

  // Also inject support_rank_nid from localArgs
  const support_rank_nid = ctx.localArgs?.get('support_rank_nid') ?? null;

  // Inject query engine functions (u, v, get_item, has_item, is_dead, etc.)
  const _queryEngine = new GameQueryEngine();
  const _queryFuncs = _queryEngine.getFuncDict();

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'game', 'unit', 'unit1', 'unit2', 'target', 'region', 'position',
      'check_pair', 'check_default', '__len__', 'v', 'cf', 'support_rank_nid',
      '_qf',
      `"use strict";
       // Spread query engine functions into local scope
       var u = _qf.u, get_item = _qf.get_item, has_item = _qf.has_item,
           get_subitem = _qf.get_subitem, get_skill = _qf.get_skill,
           has_skill = _qf.has_skill, get_klass = _qf.get_klass,
           get_class = _qf.get_class, get_closest_allies = _qf.get_closest_allies,
           get_units_within_distance = _qf.get_units_within_distance,
           get_allies_within_distance = _qf.get_allies_within_distance,
           get_units_in_area = _qf.get_units_in_area, get_debuff_count = _qf.get_debuff_count,
           get_units_in_region = _qf.get_units_in_region, any_unit_in_region = _qf.any_unit_in_region,
           is_dead = _qf.is_dead, check_alive = _qf.check_alive,
           get_internal_level = _qf.get_internal_level,
           get_support_rank = _qf.get_support_rank, get_terrain = _qf.get_terrain,
           has_achievement = _qf.has_achievement, check_shove = _qf.check_shove,
           get_money = _qf.get_money, get_bexp = _qf.get_bexp,
           is_roam = _qf.is_roam, get_roam_unit = _qf.get_roam_unit,
           ai_group_active = _qf.ai_group_active, get_team_units = _qf.get_team_units,
           get_player_units = _qf.get_player_units, get_enemy_units = _qf.get_enemy_units,
           get_all_units = _qf.get_all_units, get_convoy_inventory = _qf.get_convoy_inventory;
       return (${jsExpr});`,
    );
    return fn(
      gameProxy, unit, unit, target, target, region, position,
      check_pair, check_default, __len__, v, cf, support_rank_nid,
      _queryFuncs,
    );
  } catch (e) {
    // Expression evaluation failed — log the error for debugging
    console.warn(`EventCondition JS eval failed for "${condition}":`, e);
    return undefined;
  }
}

// ============================================================
// EventManager
// ============================================================

/**
 * EventManager - Queues and dispatches events based on triggers.
 * Events are matched by trigger type & level, sorted by priority,
 * and filtered by condition and only_once flags.
 *
 * CRITICAL CHANGE: trigger() now returns the GameEvent objects and
 * the caller is responsible for pushing them to the EventState.
 * The EventState reads from the eventQueue and processes events
 * sequentially.
 */
export class EventManager {
  private allEvents: Map<NID, EventPrefab>;
  /** Queue of events waiting to be processed. First in = first out. */
  eventQueue: GameEvent[];
  private onceTriggered: Set<NID>;
  /** Dynamic talk pairs added via event commands: Set of "unitA|unitB" keys. */
  private talkPairs: Set<string>;

  constructor(events: Map<NID, EventPrefab>) {
    this.allEvents = events;
    this.eventQueue = [];
    this.onceTriggered = new Set();
    this.talkPairs = new Set();
  }

  /**
   * Check for matching events and queue them.
   * Returns true if at least one event was triggered.
   *
   * The caller MUST check hasActiveEvents() after this and push
   * EventState onto the state machine if events are queued.
   */
  trigger(trigger: EventTrigger, context: ConditionContext): boolean {
    const matches = this.findMatchingEvents(trigger);
    let triggered = false;

    for (const prefab of matches) {
      // Skip events that have already been triggered (only_once)
      if (prefab.only_once && this.onceTriggered.has(prefab.nid)) {
        continue;
      }

      // Build full condition context
      const fullContext: ConditionContext = {
        ...context,
        unit1: trigger.unit1 ?? context.unit1,
        unit2: trigger.unit2 ?? context.unit2,
        position: trigger.position ?? context.position,
        region: trigger.region ?? context.region,
        item: trigger.item ?? context.item,
      };

      // Evaluate the condition
      if (!evaluateCondition(prefab.condition, fullContext)) {
        continue;
      }

      // Mark as triggered if only_once
      if (prefab.only_once) {
        this.onceTriggered.add(prefab.nid);
      }

      // Create and enqueue the event
      const event = new GameEvent(prefab, trigger);
      if (!event.isDone()) {
        this.eventQueue.push(event);
        triggered = true;
        console.log(`EventManager: triggered "${prefab.nid}" (${prefab.trigger})`);
      }
    }

    return triggered;
  }

  /** Get the current event being processed (front of queue). */
  getCurrentEvent(): GameEvent | null {
    if (this.eventQueue.length === 0) return null;
    return this.eventQueue[0];
  }

  /** Remove the front event from the queue (called when event finishes). */
  dequeueCurrentEvent(): void {
    if (this.eventQueue.length > 0) {
      this.eventQueue.shift();
    }
  }

  /** Check if any events are queued. */
  hasActiveEvents(): boolean {
    return this.eventQueue.length > 0;
  }

  /**
   * Get all event prefabs that match a trigger, without actually triggering them.
   * Used for checking if a Talk, Visit, etc. option should be shown.
   */
  getEventsForTrigger(trigger: EventTrigger, context?: ConditionContext): EventPrefab[] {
    return this.findMatchingEvents(trigger).filter((prefab) => {
      if (prefab.only_once && this.onceTriggered.has(prefab.nid)) return false;
      // If context provided, also check condition
      if (context) {
        return evaluateCondition(prefab.condition, context);
      }
      return true;
    });
  }

  /** Add a dynamic talk pair (used by add_talk event command). */
  addTalkPair(unit1Nid: string, unit2Nid: string): void {
    this.talkPairs.add(`${unit1Nid}|${unit2Nid}`);
  }

  /** Remove a dynamic talk pair (used by remove_talk event command). */
  removeTalkPair(unit1Nid: string, unit2Nid: string): void {
    this.talkPairs.delete(`${unit1Nid}|${unit2Nid}`);
  }

  /** Check if a talk pair exists. */
  hasTalkPair(unit1Nid: string, unit2Nid: string): boolean {
    return this.talkPairs.has(`${unit1Nid}|${unit2Nid}`) ||
           this.talkPairs.has(`${unit2Nid}|${unit1Nid}`);
  }

  /**
   * Find events matching a trigger.
   * Matches on trigger type and optionally level_nid.
   * Results are sorted by priority (higher first).
   */
  private findMatchingEvents(trigger: EventTrigger): EventPrefab[] {
    const matches: EventPrefab[] = [];

    for (const prefab of this.allEvents.values()) {
      // Trigger type must match
      if (prefab.trigger !== trigger.type) {
        continue;
      }

      // If the event is scoped to a level, it must match the trigger's level
      if (prefab.level_nid !== null && prefab.level_nid !== '' && trigger.levelNid !== undefined) {
        if (prefab.level_nid !== trigger.levelNid) {
          continue;
        }
      }

      // If the event is scoped to a level but the trigger has no level, skip
      if (prefab.level_nid !== null && prefab.level_nid !== '' && trigger.levelNid === undefined) {
        continue;
      }

      matches.push(prefab);
    }

    // Sort by priority descending (higher priority first)
    matches.sort((a, b) => b.priority - a.priority);

    return matches;
  }
}
