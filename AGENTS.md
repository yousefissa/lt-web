# AGENTS.md -- How the Engine Was Designed and Built

This document describes how the Lex Talionis web engine was architected
and built across multiple AI-assisted sessions, covering the analysis strategy,
design decisions, parallelization approach, and the full set of implemented
systems. The engine currently spans **~47,200 lines of TypeScript across 91
source files**, plus the deterministic solver and its tests.

When making modifications, you should generally plan out what to do in PLAN.md, and update what you accomplished in there. Also, make sure to keep this file up to date with the architecture of the project.

**Important:** Always update PLAN.md when you complete tasks (check off items, update line counts, add to "Recent Changes") or discover new tasks/bugs (add them to the appropriate section). PLAN.md is the source of truth for project status.

**Commit policy:** Always commit and push changes without asking for confirmation. Do not prompt the user before committing or pushing.
After finishing implementation work, create a commit and push it to the current branch.
This applies to all sessions and all change scopes (code, docs, config, and maintenance edits).

---

## 0. Reference Codebase

The original **Lex Talionis** Python codebase (lt-maker) is checked into
this repo at `lt-maker/`. Use it as the authoritative reference for how
any feature should work. Key directories:

- `lt-maker/app/engine/` — core engine (state machine, rendering, game systems)
- `lt-maker/app/events/` — event scripting (commands, functions, portraits)
- `lt-maker/app/data/` — data loading and database
- `lt-maker/app/editor/` — editor UI (not relevant for the web port)
- `lt-maker/default.ltproj/` — default Sacred Stones project data
- `lt-maker/AGENTS.md` — comprehensive technical reference for the
  original engine (architecture, data model, all systems, conventions)

When implementing a new feature, **always read the corresponding Python
source first** to understand the original behavior before writing TypeScript.
The `lt-maker/AGENTS.md` file is an excellent starting point for understanding
any system before diving into the Python source.

---

## 1. Analysis Phase: Three Parallel Deep Dives

The original Lex Talionis codebase is approximately 80,000+ lines of
Python across 200+ files. Reading it sequentially would have been
prohibitively slow, so the analysis was split into three parallel
`explore` agents, each given a different cross-section of the codebase:

| Agent | Focus Area | Key Discoveries |
|-------|-----------|-----------------|
| **Architecture Agent** | Entry points, game loop, state machine, rendering pipeline, `engine.py`, `driver.py`, `state_machine.py`, `map_view.py` | Stack-based state machine with deferred transitions; 240x160 fixed resolution scaled to display; `engine.py` is the Pygame abstraction seam; immediate-mode rendering (no scene graph); module-level singletons everywhere |
| **Data Agent** | `.ltproj` structure, JSON formats, serialization, resource loading, tilemap format, sprite organization | Chunked vs non-chunked data; `.orderkeys` for ordering; terrain grid uses `"x,y"` string keys; component-based items/skills; tileset sprite grids reference `[tileset_nid, [x, y]]` |
| **Game Logic Agent** | Combat, AI, pathfinding, movement, turns, events, input, UI | CombatPhaseSolver with attacker/defender state machine; 4 RNG modes; AI utility evaluation with offense/defense bias; Dijkstra for movement ranges + A* for paths; semicolon-delimited event scripting |

Each agent returned a detailed architectural summary with file paths and
line numbers for every key component. These three summaries formed the
"mental model" used for all subsequent design decisions.

**Why three agents instead of one?** The codebase is too large for a
single exploration pass to cover thoroughly. By splitting along
architectural boundaries (infrastructure / data / logic), each agent
could read files in depth rather than skimming. The results were
complementary with minimal overlap.

---

## 2. Architecture Decisions

### 2.1 Canvas, Not WebGL

The original engine renders at 240x160 pixels and uses immediate-mode
compositing (every frame, blit layers onto surfaces from scratch). This
maps directly to the HTML5 Canvas 2D API. WebGL would be overkill for
this resolution and would add complexity for no visual benefit.

The `Surface` class wraps `OffscreenCanvas` to provide the same API as
Pygame's `Surface`: `blit`, `fill`, `subsurface`, `getPixel`, `copy`,
`flipH`, `flipV`, `makeGray`, `makeTranslucent`, and `colorConvert`.
This makes the rendering code a near-direct translation from Python.

### 2.2 Singleton Game State (Faithful Translation)

The original engine uses a module-level `game = GameState()` singleton
imported everywhere. Rather than fighting this pattern with dependency
injection (which would have required rewriting every system's API), the
port preserves it:

```
engine/game-state.ts  -> export let game: GameState
                      -> export function initGameState(...)
```

Game states use a lazy reference (`setGameRef` / `getGame`) to avoid
circular import issues that would arise from `game-states.ts` importing
`game-state.ts` which transitively imports everything.

### 2.3 Stack-Based State Machine (Direct Port)

The state machine is the backbone of LT. Every game mode (title screen,
free cursor, movement, combat, AI turn, events) is a `State` on the
stack. The port preserves this exactly:

- States have lifecycle methods: `start`, `begin`, `takeInput`, `update`,
  `draw`, `end`, `finish`
- Transitions are deferred: `change(name)` / `back()` / `clear()` queue
  operations processed at end of frame
- Transparency: transparent states (menus, combat overlay, events) let
  states beneath them draw too
- `'repeat'` return: any lifecycle method can return `'repeat'` to re-run
  the state machine in the same frame (enables instant state chains)

### 2.4 Data Loading Over HTTP

The original engine loads `.ltproj` data from the local filesystem. For
the web, assets are served as static files and fetched over HTTP:

```
/game-data/default.ltproj/
  metadata.json
  game_data/
    constants.json
    items/.orderkeys
    items/Iron_Sword.json
    ...
  resources/
    tilesets/Prologue.png
    map_sprites/Eirika_Lord-stand.png
    ...
```

The `ResourceManager` handles all fetching with caching and deduplication.
The `Database` loads chunked data by reading `.orderkeys` first, then
fetching each chunk in parallel.

### 2.5 TypeScript Constraints

The project uses `erasableSyntaxOnly: true` (a recent TypeScript strict
mode option). This disallows constructor parameter properties
(`constructor(private x: number)`) and enums, requiring explicit field
declarations. All agents were instructed about this constraint.

---

## 3. Build Phase: Parallel Agent Batches

After analysis, the engine was built in **5 batches**, each batch
launching 2-3 `general` agents in parallel. Each agent was given:

1. A list of files to write with detailed API signatures
2. Knowledge of the LT architecture from the analysis phase
3. The TypeScript constraint (`erasableSyntaxOnly`)
4. Instructions to read existing files for API compatibility

### Batch 1: Foundations (4 files written directly)
- `constants.ts`, `surface.ts`, `input.ts`, `state.ts`
- Written directly (not via agents) since they're small and foundational

### Batch 2: Three Agents in Parallel
| Agent | Files | Lines |
|-------|-------|------:|
| State Machine + Camera + Cursor | `state-machine.ts`, `camera.ts`, `cursor.ts` | ~470 |
| Data Types + Game Objects | `types.ts`, `unit.ts`, `item.ts`, `skill.ts` | ~625 |
| Resource Manager + Database | `resource-manager.ts`, `database.ts` | ~684 |

### Batch 3: Three Agents in Parallel
| Agent | Files | Lines |
|-------|-------|------:|
| Tilemap + Map View + Highlights | `tilemap.ts`, `map-view.ts`, `highlight.ts` | ~520 |
| Pathfinding + Movement | `pathfinding.ts`, `path-system.ts`, `movement-system.ts` | ~779 |
| Game Board + Phase + Actions | `game-board.ts`, `phase.ts`, `action.ts` | ~500 |

### Batch 4: Three Agents in Parallel
| Agent | Files | Lines |
|-------|-------|------:|
| Combat System | `combat-calcs.ts`, `combat-solver.ts`, `map-combat.ts` | ~861 |
| AI System | `ai-controller.ts` | ~413 |
| Map Sprite + Unit Renderer | `map-sprite.ts`, `unit-renderer.ts` | ~306 |

### Batch 5: Two Agents in Parallel
| Agent | Files | Lines |
|-------|-------|------:|
| UI System | `menu.ts`, `hud.ts`, `health-bar.ts`, `dialog.ts`, `banner.ts` | ~699 |
| Events + Audio | `event-manager.ts`, `audio-manager.ts` | ~630 |

### Batch 6: Two Agents in Parallel (Integration)
| Agent | Files | Lines |
|-------|-------|------:|
| GameState Singleton | `game-state.ts` | ~405 |
| All Game States | `game-states.ts` | ~1353 |

### Batch 7: One Agent (Entry Point)
| Agent | Files | Lines |
|-------|-------|------:|
| Main Entry Point | `main.ts` | ~308 |

**Total: ~15 agent invocations across 7 batches**, plus direct file
writes for the smallest files.

---

## 4. Agent Communication Pattern

Each agent was given a self-contained task with:

- **Exact file paths** to write
- **API signatures** (interfaces, method signatures, constructor shapes)
- **Implementation notes** (algorithm details, LT-specific behavior)
- **Constraints** (no constructor parameter properties, import paths)
- **Verification**: agents were told to read existing files first to match
  APIs, and the project was type-checked after each batch

The key challenge was **cross-file API compatibility**. When Agent A
writes `PathSystem` and Agent B writes `GameBoard`, they both need to
agree on the `GameBoard` API. This was handled by:

1. Writing foundational types first (`types.ts`, `unit.ts`, `item.ts`)
2. Specifying exact API contracts in agent prompts
3. Having later agents read earlier files before writing
4. Running `tsc --noEmit` after each batch to catch mismatches

No batch produced type errors. The final build was clean on the first
try.

---

## 5. Design Patterns Used

### Immediate-Mode Rendering
Every frame, the entire visible scene is redrawn from scratch. There is
no retained scene graph. This matches LT's Pygame rendering and is
simple to reason about:

```
MapView.draw() {
  blit background tilemap
  draw highlights
  draw grid
  draw units (Y-sorted)
  draw foreground tilemap
  draw cursor
}
```

### Command Pattern (Actions)
Every game mutation is an `Action` with `execute()` and `reverse()`.
This enables the turnwheel (time-rewind) feature and makes the game
state fully deterministic.

### Component-Based Items/Skills
Items and skills are bags of named components (`[name, value]` pairs).
The component name determines behavior (e.g., `"weapon"`, `"brave"`,
`"damage"`, `"uses"`). This is an entity-component pattern without the
"system" -- components are queried directly by the combat/targeting code.

### State Machine for Everything
Combat resolution, AI decision-making, event execution, and even the
map combat visual presentation all use internal state machines. The
top-level game state machine manages which of these is active.

---

## 6. What Worked Well

- **Parallel analysis** saved significant time. Three agents exploring
  different parts of the codebase simultaneously produced a comprehensive
  understanding in one round-trip.
- **Batch parallelism** for writing files was highly effective. Independent
  modules (pathfinding, combat, AI, UI) can be written simultaneously
  without conflicts.
- **Specifying exact APIs in prompts** prevented most cross-file
  compatibility issues. Type-checking after each batch caught the rest.
- **Faithful architectural translation** (keeping the singleton pattern,
  stack-based state machine, and immediate-mode rendering) avoided the
  need to redesign the game's control flow, which would have been the
  biggest risk.

## 7. What Could Be Improved

- **The `any` type** is used in a few places (the lazy game reference in
  `game-states.ts`, the `MapSprite = unknown` type alias). These should
  be replaced with proper typed interfaces to prevent runtime surprises.
- **Agent prompt size** became a challenge for the larger files
  (`game-states.ts` at 1353 lines). Extremely detailed prompts were
  needed to get all 11 states correct in a single pass.
- **Duplicate combat-calcs.** Two agents independently wrote
  `combat-calcs.ts` with slightly different APIs. This was resolved by
  keeping the more complete version, but better coordination (or writing
  shared interfaces first) would have prevented it.

### Known Bugs

All previously tracked bugs have been resolved. See PLAN.md "Known Bugs"
section for the full resolution history.

---

## 8. Implemented Systems

This section summarizes all major systems that have been implemented
across multiple development sessions. For detailed change logs, see
`PLAN.md`.

### 8.1 Core Gameplay (Phase 0 + 1)

All foundation and core gameplay systems are complete:

- **State machine**: Stack-based with 21+ states (Title, Free, Move, Menu,
  Targeting, Combat, AI, TurnChange, PhaseChange, Movement, Event, Shop,
  Prep, Base, Settings, Minimap, Victory, Credits, Turnwheel, Info, Overworld, etc.)
- **Tilemap rendering**: Multi-layer tilemaps with autotile animation, weather
  particles (7 types), foreground layers, layer show/hide, map animations
- **Unit system**: Full UnitObject with stats, items, skills, status effects,
  rescue/carry, canto, affinity, party assignment, portrait NID
- **Action menu**: Dynamic options (Attack, Item, Trade, Rescue, Drop, Visit,
  Shop, Seize, Talk, Wait) with eligibility checks
- **Combat**: Full combat calcs with weapon triangle, terrain bonuses, support
  bonuses, component dispatch, scripted combat (`interact_unit`), both
  MapCombat and AnimationCombat paths
- **AI**: Behaviour iteration with primary/secondary fallback, all view_range
  modes, target_spec filtering, guard/defend/retreat, group activation,
  healing item/staff use, Interact behaviour for destructible regions
- **Experience/leveling**: Growth-based stat rolls, animated EXP bar, level-up
  display, random and fixed growth modes
- **Win/loss conditions**: Rout, Defeat Boss, Seize, Survive X turns,
  specific unit death, Lord death

### 8.2 Event System (~100+ Commands)

The event system supports both semicolon-delimited (EVNT) and Python-syntax
(PYEV1) event scripts. Key command categories:

- **Dialog**: `speak`/`s`, `narrate`, `choice`/`unchoice`, `alert`,
  `chapter_title`, `location_card`, `change_background`
- **Portraits**: `add_portrait`, `multi_add_portrait`, `remove_portrait`,
  `multi_remove_portrait`, `remove_all_portraits`, `move_portrait`,
  `bop_portrait`/`bop`, `mirror_portrait`, `expression`
- **Units**: `add_unit`, `load_unit`, `make_generic`, `remove_unit`,
  `kill_unit`, `move_unit`, `add_group`, `spawn_group`, `remove_group`,
  `move_group`, `set_name`, `equip_item`, `set_stats`, `change_class`,
  `promote`, `has_visited`
- **Items/Money**: `give_item`, `remove_item`, `give_money`, `give_exp`,
  `give_bexp`, `unlock`
- **Map**: `show_layer`, `hide_layer`, `change_tilemap`, `add_region`,
  `remove_region`, `region_condition`, `map_anim`, `remove_map_anim`,
  `add_weather`, `remove_weather`, `screen_shake`
- **Flow**: `if`/`elif`/`else`/`end`, `for`/`endf`, `transition`,
  `wait`, `end_turn`, `win_game`, `lose_game`
- **Audio**: `music`, `sound`, `music_fade_back`, `music_clear`,
  `change_music`
- **Camera**: `center_cursor`, `move_cursor`, `disp_cursor`, `flicker_cursor`
- **Game state**: `set_game_var`, `inc_game_var`, `modify_game_var`,
  `change_objective`, `change_team`, `add_talk`, `remove_talk`
- **Combat**: `interact_unit` (scripted combat with forced outcomes), `shop`
- **Prep/Base**: `prep`, `base`, `add_base_convo`, `add_market_item`
- **Overworld**: 11 commands (`overworld_cinematic`, `reveal_overworld_node`,
  `overworld_move_unit`, `set_overworld_position`, etc.)
- **Fog/Turnwheel**: `enable_fog_of_war`, `set_fog_of_war`,
  `enable_turnwheel`, `activate_turnwheel`, `clear_turnwheel`
- **Initiative**: `add_to_initiative`, `move_in_initiative`
- **Records**: `create_record`, `update_record`, `add_achievement`,
  `complete_achievement`
- **Save**: `battle_save`, `battle_save_prompt`, `skip_save`, `suspend`
- **Roam**: `set_roam`, `set_roam_unit`

### 8.3 Visual Polish (Phase 2)

- **GBA-style combat animations**: ~2,600 lines across 5 files. Full pose
  playback, weapon animation resolution, combat effects (spell/weapon),
  terrain panorama backgrounds, platform images, viewbox iris transition,
  screen shake, damage numbers (bounce physics), hit/crit sparks
- **Bitmap font rendering**: 23 font variants with variable-width glyphs,
  19 color palette variants, stacked rendering
- **Portrait system**: Sprite sheet compositing (face + mouth + eyes),
  automatic blinking, talking animation, expressions, transitions
- **9-slice menu backgrounds**: Arbitrarily-sized window backgrounds from
  24x24 source tiles
- **Icon rendering**: 16x16 and 32x32 icon sheets for item display
- **Team palette swap**: Color conversion on map sprites for team colors
- **Weather**: 7 particle types (rain, snow, sand, light, dark, night, sunset)
- **Autotile animation**: 16-frame cycling for animated water/lava tiles
- **Map animations**: Spritesheet-based animations at map positions
- **Enemy threat zones**: All-enemy and individual-enemy range overlays
- **Cursor sprite**: Animated 3-frame bounce from actual sprite sheet

### 8.4 Advanced Game Systems (Phase 3)

- **Support system**: Adjacency-based support points, rank progression,
  5 affinity bonus methods, combat stat bonuses, per-chapter limits
- **Fog of war**: GBA/Thracia/Hybrid modes, per-team vision grids, Bresenham
  LOS, torch/thief sight bonuses, fog overlay rendering
- **Turnwheel / Divine Pulse**: Full undo/redo of game actions, action groups,
  navigation UI, lock mechanism, recording control
- **Initiative turn system**: Speed-based per-unit turn order as alternative
  to standard phase cycle, auto-insert/remove on spawn/death
- **Overworld map**: FE8-style world map with nodes, roads, Dijkstra pathfinding,
  animated entity movement, level entry, 11 event commands
- **Free roam mode**: ARPG-style direct unit control with physics-based
  movement, collision detection, NPC/region interaction
- **Promotion / class change**: Full stat recalculation with sentinel values,
  growth changes, wexp gain, class skill granting
- **Difficulty modes**: Runtime difficulty with permadeath, growths, RNG mode,
  base stat bonuses, autolevel counters
- **Party/Convoy**: Multi-party support with separate inventories, 7 convoy
  action classes, money/bexp management
- **Save/Load**: IndexedDB storage with localStorage fallback, full game state
  serialization (units/items/skills/levels/parties/supports), 15-step
  ordered restoration, suspend/resume
- **Records**: Per-save statistics (kills, damage, healing, etc.),
  cross-save persistent records, achievement system
- **Query engine**: 28 Python-compatible query functions with camelCase and
  snake_case aliases for event condition evaluation
- **Python events (PYEV1)**: Line-by-line interpreter with indentation-based
  blocks, if/elif/else/for/while, Python-to-JS expression translation
- **Equation evaluator**: Python ternary expressions, unit tag checks,
  DB constant/equation references, JS fallback for complex expressions

### 8.5 Mobile / Distribution (Phase 4)

- **Touch controls**: Tap-to-move, pinch-to-zoom, drag-to-pan
- **Responsive scaling**: Dynamic viewport, orientation-aware, DPR-aware HUD
- **PWA**: Service worker with precaching, offline support, install prompt,
  update detection, connectivity tracking
- **Asset bundling**: Client-side zip parser, transparent ResourceManager
  interceptors, zero external dependencies
- **Performance profiling**: Frame budget monitor, per-function timing,
  histogram, profiling sessions (F4), exportable JSON reports
- **Capacitor / TWA**: iOS/Android wrapper config, wake lock, status bar,
  pause/resume lifecycle, back button handling, safe area insets

### 8.6 Deterministic Level Solver

- **Headless `.ltproj` loading**: Node file resource adapter feeds the same
  `Database` used by the browser without loading rendering assets
- **Shared engine rules**: Solver reuses runtime units/items/skills, layered map
  terrain, movement costs, Dijkstra/A*, AI behaviours, combat formulas, weapon
  triangle, doubling, terrain bonuses, and strike sequencing
- **Scenario inputs**: JSON controls level, roster, levels, EXP, items, stat
  overrides, RNG seed/mode, turn cap, objective mode, standard event adapter,
  and any remaining explicit spawns
- **Event adapter**: Infers seize/rout objectives and applies common level-start
  unit/group/stat/tag/scripted-combat effects plus turn/region group
  reinforcements. Player, enemy, and other phase turn-change commands execute
  before their matching phases, as in Python LT. It also derives visits, directional talks/recruitment,
  doors/chests, unlock consumption/rewards, destructible-region AI effects,
  repeatable turn/region triggers, off-map recruit placement, and regional
  `Interact` AI for destructibles, doors, and chests. Layer commands rebuild
  movement/FOW grids on both live and headless paths.
- **Search**: Deterministic fixed-seed hill climbing with multi-core policy
  shards plus action-level beam search with bounded per-actor branching,
  objective/damage frontier diversity, protected incumbent prefixes,
  irreversible incumbent bounds, and a SHA-256 future-state transposition table
  with Pareto death/damage/action labels. Lexicographic scoring requires a clear before
  deaths, damage, turns, and action count are minimized. Seed scans are gated as
  non-benchmark diagnostics. `--policy` imports heuristic weights without
  trusting stale artifacts, while `refresh` replays every saved action before
  migrating a route to a current benchmark fingerprint.
- **Global policy pipeline**: A deterministic closed-loop policy consumes only
  deeply frozen observable tactical state and complete legal actions. It never
  receives the numeric scenario seed, raw RNG state, simulator object, or
  future rolls. Immutable train/validation/test seed manifests are derived from
  seed-neutral scenario/project/engine fingerprints plus split/index and are
  validated against reordering, filtering, or mutation. Parallel evaluation
  reports every seed; training mutates/checks candidates on train seeds only,
  selects checkpoints on validation, and reserves `verify-policy` for the held-
  out test manifest. Global scores lexicographically minimize failed clears,
  death-bearing seeds, deaths, worst/CVaR-95/mean damage, turns, then actions.
- **Per-seed coverage farm**: `solve-seeds` invokes the existing fixed-seed
  beam or proof search for every immutable manifest entry and reports solve
  coverage, per-seed witnesses, failures, unknown proofs, and errors without
  selecting or discarding seeds.
- **Planner state**: Versioned checkpoints and independent clones preserve RNG,
  turn/event lifecycle, metrics, unit flags/stats/positions, inventories/uses,
  explicit equipment, exact skills and mutable skill data, active
  regions/layers/interactions, off-map level units, and replay state. Live
  checkpoint restoration can materialize carried roster units absent from the
  chapter prefab. Legal player actions are
  enumerable and validated one at a time, with deterministic enemy/other phase
  stepping, LT-preserved dead-unit phase flags, broken non-combat item removal,
  and cache-stable keys. Search supports zero-death pruning and exact
  action-prefix continuation. Beam nodes store checkpoints and reuse a simulator
  workspace instead of reconstructing the level for every branch.
- **Proof mode**: Complete fixed-seed legal-action DFS supports death/damage
  feasibility bounds. It distinguishes route found, exhaustive infeasibility in
  the supported model, and unknown due to node budget.
- **Benchmark identity**: Saved canonical routes fingerprint gameplay scenario
  fields, project data, engine source, and solver transition files. CLI verification,
  continuation, and prefixes reject missing or mismatched fingerprints.
- **Parity audit**: Solver and live browser harness expose a shared normalized
  action-boundary snapshot plus field-level diffs for RNG, phases, units,
  inventories/equipment, regions, and layers. The saved Chapter 4 and Chapter 5
  routes plus representative Chapter 3 global-policy traces are replayed
  through live attacks, heals, moves, waits, visits, talks, doors, chests,
  recruitment, explicit seize, and phase transitions. Combat durability,
  non-combat breakage, and combat EXP use shared semantics in the solver and
  both visual combat paths.
- **Replay**: Every action records a state snapshot for JSON verification and an
  interactive grid animation
- **Chapter 3 result**: Canonical fixed seed 3 policy clears in 7 turns/86
  actions with zero deaths and zero damage; this is best-found, not a proof.
- **Chapter 4 result**: Canonical fixed seed 4 explicit plan clears the
  event-derived rout objective in 6 turns/90 total actions (49 player actions)
  with zero deaths and 2 damage. It includes both villages, Lute recruitment,
  Turn 2/3 events, and lower-map trigger reinforcements. A 26,044-node <=1
  frontier found no improvement; this is not an optimality proof.
- **Chapter 5 result**: Canonical fixed seed 5 explicit plan recruits Joshua,
  visits Village 2, and defeats Saar in 4 turns/66 actions with zero deaths and
  71 damage under corrected equipment/EXP/AI semantics. A 22,383-node <=70
  challenge found no improvement. The all-four-villages stress fixture has a
  separate verified 10-turn/1-death/66-damage incumbent under current semantics;
  its prior 5-turn artifact was rejected when exact replay found Vanessa dead
  before a later saved action.

---

## 9. File Architecture

### Core Engine (`src/engine/`)
| File | Lines | Purpose |
|------|------:|---------|
| `game-state.ts` | ~1450 | Singleton hub: subsystem refs, level loading/cleanup, win/loss, difficulty, unit persistence |
| `state-machine.ts` | ~207 | Stack-based state machine with deferred transitions |
| `action.ts` | ~1720 | All game actions (Move, Damage, Heal, Promote, Convoy, etc.) |
| `camera.ts` | ~180 | Smooth scrolling, map bounds, screen shake (5 patterns) |
| `cursor.ts` | ~194 | Tile-grid cursor with sprite animation |
| `initiative.ts` | ~210 | Initiative-based turn system tracker |
| `difficulty.ts` | ~135 | Difficulty mode runtime class |
| `save.ts` | ~1442 | IndexedDB save/load with full serialization, including equipment |
| `records.ts` | ~903 | Recordkeeper, persistent records, achievements |
| `query-engine.ts` | ~874 | 28 Python-compatible query functions |
| `support-system.ts` | ~500 | Support pairs, ranks, affinity bonuses |
| `line-of-sight.ts` | ~170 | Bresenham LOS for fog of war |
| `perf-monitor.ts` | ~440 | Frame budget monitor, profiling |
| `parity.ts` | ~78 | Renderer-independent solver/live-engine state snapshots and diffs |

### Game States (`src/engine/states/`)
| File | Lines | Purpose |
|------|------:|---------|
| `game-states.ts` | ~9230 | 21+ states, ~100 event commands, all gameplay logic |
| `prep-state.ts` | ~499 | GBA-style preparation screen |
| `base-state.ts` | ~510 | Base screen hub menu |
| `settings-state.ts` | ~621 | Settings menu (Config/Controls) |
| `minimap-state.ts` | ~355 | Minimap overlay |
| `victory-state.ts` | ~332 | Victory screen |
| `credit-state.ts` | ~438 | Credits screen |
| `info-menu-state.ts` | ~621 | Unit info/status screen |
| `save-load-state.ts` | ~300 | Save/Load UI |
| `overworld-state.ts` | ~668 | Overworld map (3 states) |
| `turnwheel-state.ts` | ~300 | Turnwheel undo/redo UI |

### Combat (`src/combat/`)
| File | Lines | Purpose |
|------|------:|---------|
| `combat-calcs.ts` | ~722 | Hit, damage, crit, avoid, weapon triangle, component dispatch |
| `combat-solver.ts` | ~409 | Strike sequencing, vantage/desperation/miracle |
| `combat-uses.ts` | ~33 | Shared LT durability consumption for solver/map/animation combat |
| `combat-exp.ts` | ~45 | Shared combat EXP and deterministic level-up rolls |
| `animation-combat.ts` | ~1078 | GBA-style animation combat state machine |
| `battle-animation.ts` | ~763 | Frame-by-frame pose playback |
| `map-combat.ts` | ~555 | Map-mode combat (no animations) |
| `sprite-loader.ts` | ~453 | Palette conversion, spritesheet extraction |
| `item-system.ts` | ~247 | Item component dispatch |
| `skill-system.ts` | ~398 | Skill component dispatch |

### Events (`src/events/`)
| File | Lines | Purpose |
|------|------:|---------|
| `event-manager.ts` | ~1265 | Event queue, condition evaluator, JS fallback eval |
| `event-portrait.ts` | ~700 | Portrait compositing, blinking, talking, expressions |
| `python-events.ts` | ~995 | PYEV1 Python-syntax event interpreter |
| `screen-positions.ts` | ~117 | Named screen position resolver |

### Data (`src/data/`)
| File | Lines | Purpose |
|------|------:|---------|
| `database.ts` | ~479 | All game data loading (chunked + non-chunked JSON) |
| `resource-manager.ts` | ~309 | HTTP asset loader with caching |
| `types.ts` | ~371 | TypeScript interfaces for all LT data formats |
| `asset-bundle.ts` | ~497 | Client-side zip parser for bundled assets |

### Rendering (`src/rendering/`)
| File | Lines | Purpose |
|------|------:|---------|
| `tilemap.ts` | ~360 | Multi-layer tilemap, autotile, weather management |
| `map-view.ts` | ~287 | Full rendering pipeline (tilemap, units, fog, weather) |
| `bmp-font.ts` | ~526 | Bitmap font system (23 variants, 19 color palettes) |
| `map-sprite.ts` | ~294 | Unit map sprites with team palette swap |
| `weather.ts` | ~238 | Weather particle system (7 types) |
| `map-animation.ts` | ~169 | Spritesheet-based map animations |

### AI (`src/ai/`)
| File | Lines | Purpose |
|------|------:|---------|
| `ai-controller.ts` | ~1227 | Full AI plus Python-LT phase unit ordering |

### UI (`src/ui/`)
| File | Lines | Purpose |
|------|------:|---------|
| `dialog.ts` | ~367 | Dialog boxes with portrait awareness, word-wrap |
| `hud.ts` | ~253 | Unit info + terrain info panels |
| `base-surf.ts` | ~228 | 9-slice menu window backgrounds |
| `menu.ts` | ~204 | Choice menu with mouse/touch support |
| `icons.ts` | ~151 | Item icon rendering (16x16/32x32) |
| `banner.ts` | ~113 | Phase/alert banners |

### Platform (`src/`)
| File | Lines | Purpose |
|------|------:|---------|
| `main.ts` | ~496 | Bootstrap, canvas, game loop, state registration |
| `pwa.ts` | ~310 | Service worker, install prompt, connectivity |
| `native.ts` | ~210 | Capacitor/TWA platform detection, lifecycle |

### Solver (`solver/`)
| File | Purpose |
|------|---------|
| `cli.ts` | `inspect`/`run`/`solve`/`plan`/`prove`/`verify`/`refresh` command interface |
| `benchmark.ts` | Scenario/project/engine benchmark fingerprinting |
| `project-loader.ts` | Filesystem `.ltproj` adapter for the engine database |
| `event-adapter.ts` | Objective inference and standard LT event effect derivation |
| `simulator.ts` | Fast tactical runner, cloneable checkpoints, legal actions, off-map/event lifecycle, deterministic phase stepping, policy evaluation, and replay capture |
| `beam-search.ts` | Fixed-seed action beam, incumbent protection, transposition cache, and explicit plan replay |
| `proof-search.ts` | Exhaustive bounded fixed-seed feasibility search with honest proof status |
| `transposition.ts` | Pareto dominance table for exact future-state hashes |
| `search.ts` | Seed scans, policy mutation, hill climbing, result ordering |
| `parallel-search.ts` / `worker.ts` | Multi-core search sharding |
| `global-policy.ts` / `global-policy-worker.ts` | Seed-isolated closed-loop policy API, deterministic manifests, global scoring/training/evaluation, and per-seed solve farms |
| `policy-report.ts` | Aggregate HTML plus typical/worst/failed representative replay pages |
| `visualize.ts` | Standalone and Codex-inline replay renderers |
| `scenarios/chapter-{3,4,5}.json` | Controllable roster/loadout/seed/event/interaction fixtures |
| `seed-manifests/chapter-{3,4,5}/*.json` | Precommitted train/validation/held-out test distributions |
| `solutions/chapter-{3,4,5}.json` | Canonical verifiable fixed-seed policies/plans |
| `solutions/*-seed-selected.json` | Explicitly non-benchmark RNG diagnostics |

---

## 10. Testing

See [TESTING.md](./TESTING.md) for the full testing guide.
