# lt-web: Lex Talionis Web Engine -- Development Plan

This document tracks what has been built, what is partially complete, and what
remains to bring the TypeScript web port to feature parity with the original
Lex Talionis Python/Pygame engine.

---

## Current State

**91 engine source files, ~47,200 lines of TypeScript, plus 13 solver runtime
files (~4,500 lines) and 7 solver test files.**
Builds cleanly with zero type errors. All four development phases (Foundation,
Playable, Visual Polish, Mobile/Distribution) are complete. The engine loads
`.ltproj` game data over HTTP and runs at 60 fps on Canvas 2D with dynamic
viewport scaling for mobile and desktop.

### Multi-Project Support

The engine supports loading different `.ltproj` projects via the `?project=`
query parameter. Both **chunked** (directory-per-type with `.orderkeys`) and
**non-chunked** (single JSON array files) data formats are supported.

**Completed:**
- [x] Configurable project path via `?project=` query param
- [x] Non-chunked game_data fallback (items.json, skills.json, etc.)
- [x] Non-chunked tilemap fallback (single tilemaps.json)
- [x] Engine-level shared assets separated from project assets (sprites/menus, platforms, cursor)
- [x] Combat palette loading: added `palette_data/` subdirectory fallback path
- [x] URL encoding: `ResourceManager.resolveUrl()` now encodes path segments for spaces/special chars
- [x] Title screen: animated panorama fallback (tries `title_background0.png` when single file missing)
- [x] Icons, fonts, base-surf, sprite-loader all encode NIDs in URLs

**Known Limitations (per-project content):**
- Missing `combat_*.png` panoramas in non-default projects (combat backgrounds show nothing)
- Projects may reference combat effects/palettes not present — renders without them gracefully

---

### Known Bugs

- [x] **Magic weapons used the physical `DAMAGE` equation.** *(Fixed)*
  `combat-calcs.ts` now maps the serialized `magic` component to
  `MAGIC_DAMAGE`/`MAGIC_DEFENSE`, while `magic_at_range` remains physical at
  melee and performs its dynamic formula swap only beyond range 1.

- [x] **Settings `Text Speed` had no effect on dialogue typing.** *(Fixed)*
  `EventState` now passes `_setting_text_speed` into `Dialog`, and dialog typing
  now uses LT-style time-based cadence (ms-per-character, including `0` = instant).
- [x] **Some Ch.5 destructible village events failed to fire from `DestroyVillageX` regions.** *(Fixed)*
  Event conditions in default data can target sibling `VillageX` NIDs while the
  interaction region is `DestroyVillageX`. Added compatibility fallback for
  Destructible triggers to retry with sibling region context when needed.
- [x] **Chest/Door region checks could crash in menu state (`comps.some is not a function`).** *(Fixed)*
  `evaluateCondition(unit.can_unlock(region))` assumed item components were array-shaped,
  but runtime `ItemObject.components` is a `Map`. Added robust `Map`/array/object handling,
  support for `can_unlock` expressions, and region-prefix checks (`Chest`/`Door`).
- [x] **Talk command menu missed level-scoped conversations (e.g. Natasha→Joshua in Ch.5).** *(Fixed)*
  Talk option detection in `MenuState` called `getEventsForTrigger()` without
  `levelNid`, so level-specific `on_talk` events were filtered out. Added
  `levelNid` in both talk option discovery and talk target re-check.
- [x] **Harness chapter intros (Ch.2/Ch.3) intermittently soft-locked with empty top state.** *(Fixed)*
  `harness.loadLevel(clean=false)` was manually pushing `event` after `free`, while
  `FreeState` already auto-pushes `event` when level_start events exist. This could stack
  duplicate `EventState` instances and leave transient/empty state behavior in long intros.
  Fix: removed manual event push from harness and let normal state flow handle it.
- [x] **Animation combat sometimes shows cyan/red placeholder blocks.** *(Fixed)*
  `AnimationCombat` now waits in `init` until both sides resolve a real
  `mainFrame` (or timeout fail-safe), preventing first-load async sprite races
  from flashing stub rectangles at combat start.
- [x] **Harness mode blocked by project picker overlay.** *(Fixed)* When
  multiple `.ltproj` folders existed and `?project=` was omitted, the picker
  overlay prevented `window.__harness.ready` from ever becoming true. Harness
  mode now auto-selects `default.ltproj` (or first discovered project fallback)
  without redirect, restoring deterministic Playwright startup.
- [x] **First dialogue still renders over the portrait.** *(Fixed)* Dialog now
  auto-sizes to text content width and uses `get_desired_center()` mapping for
  portrait-aware horizontal positioning (matching Python).
- [x] **Combat animations at half speed sometimes.** *(Fixed)* Removed
  `Math.max(1, ticks)` override that tied animation speed to browser refresh
  rate. Animation ticking is now unconditional at the top of `update()`,
  matching Python's `update_anims()` pattern.
- [x] **Enemies leave blue rectangle at start position when attacking.** *(Fixed)*
  Added `highlight.clear()` in `FreeState.begin()`, `FreeState.end()`, and
  `TurnChangeState.begin()` to match Python's highlight cleanup lifecycle.
- [x] **Lose cursor control after combat.** *(Fixed)* Added finished-unit
  check to `WeaponChoiceState.begin()` with `'repeat'` return, plus added
  `'repeat'` to all dead-unit early-exit paths in MoveState, MenuState, and
  TargetingState for instant state cascade.
- [x] **Red rectangle randomly appears during magic attack.** *(Fixed)* Cleared
  `this.targets` in `TargetingState.end()` to prevent stale red rectangle
  draw when CombatState (transparent) draws on top.
- [x] **Terrain platforms swap/move and sprites float in ranged/magic combat.**
  *(Fixed)* Three related bugs in combat animation platform/sprite positioning:
  1. `at_range` off-by-one — now computes `atRange = distance - 1` matching Python
  2. Sprites now receive `range_offset` and `pan_offset` so they track with platforms
  3. Shake direction negated for sprites (`-totalShakeX`) matching Python behavior
- [x] **Combat UI layout is wrong.** *(Fixed)* Corrected name tag dimensions
  (66x16, matching Python sprites), centered name text, fixed HP bar height
  (56→40px), adjusted Y positioning, and removed always-shown CRT row.
- [x] **Reinforcements arrive too early in Ch.1.** *(Fixed)* Changed event
  condition fallback from `true` to `false` — events with un-evaluable
  conditions are now skipped instead of fired. Added error logging to JS
  fallback evaluator.
- [x] **Portrait mouths keep moving after dialog text finishes scrolling.** *(Fixed)*
  Event dialog now toggles portrait talking based on dialog typing state
  (`typing` vs `waiting`) instead of only stopping on full dialog close.
- [x] **Cutscene background can be missing for first lines after `change_background`.** *(Fixed)*
  `change_background` now blocks event command progression until panorama load
  resolves, matching Python's synchronous behavior and preventing async race frames.

### Recent Changes

- **Chapter 5 live differential matrix + exact checkpoint restoration:**
  - Generalized the saved-route Playwright differential into a Chapter 4/5
    scenario matrix. The canonical fixed-seed Chapter 5 route now matches the
    live engine after every player action and enemy/other phase boundary,
    including Village 2 and Natasha-to-Joshua recruitment.
  - Made tactical checkpoints self-contained across chapter boundaries: live
    restoration now materializes missing carried roster units, and simulator
    clones/checkpoints preserve exact skill NIDs plus mutable skill data in
    future-state/transposition identity.
  - Matched Python LT interaction semantics: Talk applies `HasTraded` without
    prematurely finishing the unit, and one-shot Visit/Destructible regions
    consume only the selected region unless an event script explicitly removes
    its sibling. Chapter 2's scripted pairing and Chapter 5's independent
    regions are both covered.
  - `GameState.loadLevel()` now clones mutable level runtime state from the
    database prefab, matching Python's `LevelObject.from_prefab`; region/layer
    mutations no longer corrupt same-chapter reloads.
  - Rejected the stale Chapter 5 all-content route when replay proved Vanessa
    died before action 19. A fresh 50,000-node fixed-seed beam run established a
    valid all-four-villages + Joshua incumbent at 10 turns/155 actions,
    1 death/66 damage. This is best-found and remains a priority to improve.
  - Verification: production build, 22/22 solver tests, 54/54 browser harness
    tests, and the 2/2 Chapter 4/5 action-boundary parity matrix pass.

- **Fixed-seed live differential planner + combat/event parity correction:**
  - Added explicit LT-style equipped-weapon state without inventory reordering,
    persisted it through saves and cloneable solver checkpoints, and shared
    combat EXP/level-up RNG between map combat, animation combat, and the
    headless simulator.
  - Matched Python LT enemy-phase ordering by AI priority and closest-enemy
    distance, then fixed simulator movement/attack flags and dead-attacker
    lifecycle semantics discovered by boundary diffs.
  - Generalized standard turn events and repeatable region reinforcements,
    including Chapter 4's turn-2 group, turn-3 cameo, and repeatable lower-map
    trigger. Off-map level units now remain registered, and interaction events
    support `change_team`, `add_unit`, `move_unit`, and `remove_unit` so visits
    can recruit and place units such as Lute exactly like the live engine.
  - Added exact live tactical checkpoint restoration and an async planner-action
    driver for attacks, heals, moves, waits, visits, talks, doors, chests, and
    seize interactions. The saved Chapter 4 route now passes field-level
    simulator/live comparison after every player action and phase boundary,
    including both village visits and Lute recruitment.
  - Added safe `--policy` imports that reuse weights without trusting stale
    metrics/fingerprints, plus `refresh`, which replays every fixed-seed action
    before migrating a route to the current benchmark identity.
  - Fixed-seed search improved Chapter 3 seed 3 to a 0-damage/0-death clear in
    6 turns/73 actions. Chapter 4 seed 4 improved through 17, 13, 12, 5, and 2
    damage incumbents; the canonical route is now 2 damage/0 deaths in 6
    turns/90 total actions (49 player actions), visits both villages, and
    recruits Lute. A 26,044-node <=1-damage frontier found no improvement; this
    is best-found, not a proof. Chapter 5 seed 5 remains a verified
    71-damage/0-death clear in 4 turns/66 actions with Joshua recruited after a
    22,383-node <=70-damage challenge found no improvement.

- **Dominance/proof search + engine parity audit:**
  - Split exact future-state identity from irreversible path cost. The
    transposition table now keeps Pareto-minimal death/damage/action labels and
    discards duplicate or dominated routes without weakening RNG identity.
  - Reworked beam nodes to store replay-free checkpoints and reuse one simulator
    workspace instead of constructing a full chapter for every branch. A
    10,000-node Chapter 4 benchmark completed in 5.3s (~1,886 nodes/s), about
    34% faster than the prior 80,000-node run's average throughput (~1,411/s).
  - Added irreversible incumbent, `--max-deaths`, and `--max-damage` pruning.
    Added `prove`, a complete legal-action DFS for the supported headless model:
    it reports `found`, `infeasible` only when the bounded tree is exhausted, or
    `unknown` when `--max-nodes` interrupts the proof.
  - Added versioned benchmark fingerprints over gameplay scenario fields,
    project text/game data, engine source, and solver transition files. Verify,
    continuation, and prefixes now reject stale or mismatched artifacts even if
    their numeric seed happens to match.
  - Added a shared renderer-independent parity snapshot and field-level diff for
    solver/live-harness action boundaries: turn, phase, RNG, unit stats/flags,
    positions, inventories/equipment, active regions, and visible layers.
  - Parity review found and fixed weapon durability semantics in map combat,
    animation combat, and the headless solver. They now match Python LT: uses
    are lost per successful strike by default, misses only when configured, and
    `one_loss_per_combat` collapses eligible strikes to one use.

- **Chapter 5 fixed-seed solver + reusable map interactions:**
  - Generalized standard events into legal `visit`, directional `talk`, `chest`,
    and `door` actions plus enemy `Destructible` interactions. Event effects
    support item rewards/removal, team/AI changes, one-shot regions, visited
    state, unlock-use consumption, and tilemap layer changes.
  - Added scenario deployment positions and optional required visits,
    recruitments, chests, and doors. These requirements participate in clear
    detection and incomplete-state scoring instead of being hidden policy hints.
  - Extended checkpoints/transposition identity with active regions, visible
    layers, completed interactions, opened/visited/destroyed sets, and recruited
    team state. Added Chapter 3 chest/door and Chapter 5 visit/recruitment tests.
  - Added danger-aware heal destinations, survival-frontier tuning,
    `--max-deaths`, and deterministic `--prefix` continuation. Prefix search
    found the original seed-5 Chapter 5 clear: Joshua recruited, Saar defeated,
    Village 2 visited. Explicit equipment, shared EXP, and AI-order parity later
    corrected its canonical metrics to 4 turns/0 deaths/71 damage/66 actions.
  - Added an all-content Chapter 5 stress fixture requiring all four villages
    and Joshua. Its verified incumbent is 5 turns/1 death/66 damage after the
    initial clear plus 210,000 continuation nodes; it remains an optimization
    target and is not conflated with the native-objective benchmark.

- **Cloneable tactical planner foundation:**
  - Added versioned simulator checkpoints covering the exact RNG stream, turn
    lifecycle, event trigger set, cumulative metrics, mutable unit state,
    inventories/uses, rescue links, and optional replay history.
  - Added independent simulator cloning/restoration and canonical transposition
    keys so search branches cannot share mutable state or silently change seeds.
  - Added full legal player-action enumeration (attack/heal/move/wait/seize),
    duplicate-item slot identity, optional beam pruning limits, validated action
    application, and deterministic enemy/other phase advancement.
  - Added integration coverage proving a cloned branch stays identical after
    applying the same action, including RNG, unit, inventory, and metric state.
  - Added transposition-cached, action-level beam search with objective/damage
    frontier diversity, protected incumbent prefixes, bounded branching, and
    replay-free search checkpoints to control memory use.
  - Planner incumbents are saved as explicit turn-stamped action plans and
    `verify` replays those actions instead of assuming policy weights reproduce
    a planner route. Cache keys retain exact state identity through SHA-256
    digests of canonical checkpoints.
  - Initially promoted a verified fixed-seed Chapter 4 plan at 22 damage/5
    turns. The current live-audited planner has since improved this to 2 damage
    while incorporating the corrected event/recruitment lifecycle.

- **Fixed-seed benchmark contract correction:**
  - Made the scenario seed part of the immutable benchmark instance; canonical
    Chapter 3/4 solutions now use seeds 3/4 respectively.
  - CLI verification and continuation reject solution/scenario seed mismatches.
  - `--seed-range` now requires `--allow-seed-search` and emits a non-benchmark
    warning; seed-selected artifacts are retained only as diagnostic history.
  - Canonical results are currently Chapter 3: 6 turns/0 deaths/0 damage and
    Chapter 4: 6 turns/0 deaths/2 damage, both on their scenario seeds.

- **Generalized objectives/events + Chapter 4 rout solution:**
  - Added automatic seize/rout/defeat-boss objective inference and rout-aware
    progress, completion, and incomplete-run scoring.
  - Added a standard LT event adapter for level-start unit/group placement,
    stat/tag changes, scripted combat, and turn/region group reinforcements.
  - Added scenario-derived unit policy dimensions and per-unit risk multipliers.
  - Parallelized diagnostic seed-range scanning across worker threads in
    addition to policy hill climbing, with regression coverage against the
    sequential implementation.
  - Added `chapter-4.json` plus a verified fixed-seed solution. The original
    seed-4 22-damage route and seed-211 diagnostic have since been superseded by
    the live-audited fixed-seed-4 2-damage route.
  - Added Chapter 4 adapter/integration tests and fixed magic-equation parity
    discovered through Artur's intro combat. The former seed-211 17-damage
    diagnostic is now superseded by the fixed-seed-4 2-damage canonical route.

- **Deterministic headless level solver + Chapter 3 solution:**
  - Added `solver/` CLI that directly loads `.ltproj` JSON and reuses engine
    `Database`, `UnitObject`, `ItemObject`, `GameBoard`, `PathSystem`,
    `AIController`, combat calculations, and `CombatPhaseSolver`.
  - Added scenario control for roster selection, unit level/EXP, inventories,
    stat overrides, RNG seed/mode, max turns, and explicit scripted spawns.
  - Added `inspect`, `run`, `solve`, and `verify` workflows, deterministic
    diagnostic seed-range search, hill-climbing policy mutations, and worker-thread shards.
  - Added replay JSON plus standalone/inline animated map visualization output.
  - Checked in canonical `solver/solutions/chapter-3.json`: fixed seed 3,
    now improved to 6 turns, 0 player damage, 0 deaths, 10 enemies defeated,
    and 3 walls broken.
  - Preserved seed 115's zero-damage route only as non-benchmark diagnostic
    history in `chapter-3-seed-selected.json`.
  - Added solver unit/integration tests and a separate solver typecheck config.
  - Added seeded gameplay RNG control to combat, level-ups, and the browser harness.
  - Fixed class-learned skill installation and LT serialized combat component
    aliases (`damage`, `resist`, `hit`, `avoid`, `crit`, `crit_avoid`), discovered
    when Level 3 breakable walls incorrectly retained ~80 avoid.

- **Local development setup verified (July 15, 2026):**
  - Added a fresh shallow checkout of upstream `lt-maker` in the ignored
    `lt-maker/` directory and installed the npm dependencies.
  - Confirmed `npm run build` succeeds and the Vite development server renders
    the `default.ltproj` title screen without browser errors.

- **Process docs update (agent commit/push policy clarified):**
  - Updated `AGENTS.md` commit policy section to explicitly state the
    rule applies to all session types and all edit scopes (code/docs/config).

- **Dialogue text-speed parity fix (settings now actually affect typing):**
  - Updated `src/ui/dialog.ts` to use LT-style time-based typing speed
    (milliseconds per character) instead of a fixed chars-per-frame step.
  - Updated `src/engine/states/game-states.ts` to read `_setting_text_speed`
    and pass it into each new `Dialog` instance, with default fallback `32`.
  - Added LT dialog speed overrides:
    - Per-command `text_speed` (keyword and semicolon positional forms)
    - Inline text commands `{speed:X}`, `{starting_speed}`, `{max_speed}`
    now update typing cadence during the same dialog line.
  - `Text Speed = 0` now behaves like LT max-speed mode (instant reveal).

- **Event-state dialog/background parity fixes + regression coverage:**
  - Fixed portrait mouth animation lifecycle in `src/engine/states/game-states.ts`:
    speaking portraits now start/stop talking on dialog typing-state transitions,
    and reliably stop on skip/dismiss paths.
  - Fixed async cutscene background race in `src/engine/states/game-states.ts`:
    `change_background` now blocks until panorama load completes (or fails),
    with token-guarded completion to avoid stale async overwrites.
  - Added regression in `tests/harness.spec.ts`:
    `Dialog portraits stop talking while waiting for input`.

- **AI region interaction + recruit persistence + Sacred Stones soak automation:**
  - Added two new harness regressions in `tests/harness.spec.ts`:
    - Ch.2 AI-driven `PursueVillage` `Destructible` interaction (forced enemy AI phase)
      verifies `DestroyVillage3` + `Village3` region consumption and `Ruin3` layer reveal.
    - Recruit persistence regression: simulated recruited Joshua survives chapter cleanup/reload
      with player allegiance intact and appears in `prep_pick` party roster.
  - Fixed persistent-unit chapter load behavior in `src/engine/game-state.ts` to match Python:
    persisted units now preserve runtime team/AI allegiance instead of being overwritten by
    next-level prefab team/AI fields.
  - Added Sacred Stones reliability soak automation:
    - New script `scripts/sacred-stones-soak.mjs` loops Playwright Sacred Stones suites
      (`SOAK_ITERATIONS`, `SOAK_GREP`, `SOAK_WORKERS` configurable, fail-fast on first failure).
    - Added npm scripts: `test:harness`, `test:ss:soak`.
    - Documented soak usage in `TESTING.md`.
  - Added screenshots:
    `60-ch2-ai-destructible-interact-ruin3.png`,
    `61-recruit-persistence-prep-flow-joshua.png`.

- **Chapter 4/5 regression matrix sweep (outro branches, villages, arena, ordering, turn idempotency):**
  - Added five harness regressions in `tests/harness.spec.ts` for:
    - Ch.4 outro branch matrix across Artur/Lute permutations (Artur-only, Lute-only, both alive, both dead)
    - Ch.5 `Village1/3/4` visit reward matrix with one-time reward + region-consumption checks
    - Ch.5 arena interaction flow (menu option, event progression, return-to-map control)
    - Ch.5 script-driven visit-vs-destroy ordering semantics in both directions
    - Ch.5 turn-event idempotency for `Turn2/4/8` over repeated long-window retriggers
  - Updated region cleanup semantics in `src/engine/states/game-states.ts` so
    each one-shot region consumes itself; event scripts control whether a
    co-located Visit/Destructible sibling is also removed.
  - Added screenshots:
    `55-ch4-outro-branch-matrix.png`,
    `56-ch5-village134-visit-matrix.png`,
    `57-ch5-arena-flow-return.png`,
    `58-ch5-village-ordering-visit-vs-destroy.png`,
    `59-ch5-turn-event-idempotency.png`.
  - Focused Playwright pass for these five new regressions: **5/5**. Build also passes (`npm run build`).

### Solver Next Milestones

- [x] Drive a complete saved planner route through the live browser state
  machine and compare the parity snapshot after every action/phase boundary.
- [x] Extend the saved-route live differential audit to Chapter 5's visit and
  Natasha-to-Joshua recruitment path, then make it a reusable scenario matrix.
- [ ] Add an exhaustive or admissibly bounded fixed-seed proof attempt for the
  Chapter 4 zero/one-damage frontier; the current 2-damage result is not proven.
- [ ] Replace checkpoint restoration with compact apply/undo or copy-on-write
  state and incremental hashing; keep the checkpoint path as an oracle.
- [ ] Add deterministic fixed-seed worker sharding across opening actions with
  reproducible incumbent merges.
- [ ] Add campaign-state carryover for EXP, levels, WEXP, inventory uses,
  recruits, deaths, convoy, and money before importing Chapter 6.

### Ralph Loop Backlog (Autonomous)

- [x] **Chapter 4 outro branch matrix regression coverage.** Add tests for Artur-only, Lute-only,
  both alive, and both dead paths; verify dialogue/event progression and clean transition behavior.
- [x] **Chapter 5 village visit matrix regression coverage.** Add deterministic tests for
  `Village1/3/4` rewards and region consumption; verify no duplicate rewards on re-interact attempts.
- [x] **Chapter 5 arena interaction flow coverage.** Validate arena menu availability,
  interaction state flow, and safe return to map control without soft-lock.
- [x] **Chapter 5 village destroy-vs-visit ordering checks.** Add race-condition tests for
  enemy destructible events vs player visits to ensure script-driven region consumption and layer toggles are correct.
- [x] **Chapter 5 turn-event idempotency sweep.** Re-trigger `Turn2/4/8` conditions across long
  frame windows and confirm no duplicate group spawn or stale event-state stacking.
- [x] **Enemy AI region interaction regression.** Add harness coverage for AI-driven
  `Destructible` interactions and validate region removal + event side effects match manual interactions.
- [x] **Recruit persistence across chapter transitions.** Add regression tests ensuring recruited
  units remain correctly assigned/serialized through subsequent chapter loads and prep flow.
- [x] **Sacred Stones reliability soak run automation.** Add a long-run harness pass that executes
  multi-chapter mechanics batches repeatedly and fails on non-deterministic state regressions.

- **Chapter 4/5 additional event sweep (Village1, Turn3 cameo, Turn4 brigands):**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.4 Village1 visit grants `Iron_Axe` and consumes region
    - Ch.4 Turn3 cameo event (`L'arachel`/`Dozla`/`Rennac`) exits cleanly
      with temporary units removed from map
    - Ch.5 Turn4 event spawns `Brigand2` group (`118`,`119`)
  - Added screenshots:
    `52-ch4-village1-iron-axe.png`,
    `53-ch4-turn3-cameo-cleared.png`,
    `54-ch5-turn4-brigand2-spawn.png`.
  - Full Playwright harness suite now passes: **45/45**.
- **Chapter 4 event edge-case sweep (villages, trigger region, snag bridge):**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.4 Village2 visit recruits Lute and consumes region
    - Ch.4 Trigger region spawns `RevenantRein` group on turn-change
    - Ch.4 Snag death triggers bridge layer reveal (`show_layer;Snag`)
  - Added screenshots:
    `49-ch4-village2-recruits-lute.png`,
    `50-ch4-trigger-revenant-reinforcements.png`,
    `51-ch4-snag-bridge-layer-revealed.png`.
  - Full Playwright harness suite now passes: **42/42**.
- **Chapter 3 outro branch coverage (recruit-dependent transition):**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.3 outro branch with Neimi+Colm alive confirms Colm becomes `player`
      during outro before transition to Ch.4
    - Ch.3 outro branch with Colm dead still transitions cleanly to Ch.4
      without title-state fallback
  - Added screenshots:
    `47-ch3-outro-colm-player-before-ch4.png`,
    `48-ch3-outro-colm-dead-transition-ok.png`.
  - Full Playwright harness suite now passes: **39/39**.
- **Chapter 3 Colm flow coverage (spawn + recruitment):**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.3 `other_turn_change` event spawns Colm and moves him to chest room
    - Ch.3 Neimi->Colm talk recruits Colm to player team
  - Added screenshots:
    `45-ch3-colm-turn-event-spawn.png`,
    `46-ch3-neimi-recruits-colm.png`.
  - Full Playwright harness suite now passes: **37/37**.
- **Destructible village sweep (Ch.2 + Ch.5) + trigger compatibility fix:**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.2 `DestroyVillage1/2/3` -> `Ruin1/2/3` layer visibility + region removal
    - Ch.5 destructible village interactions (`DestroyVillage2/4`) -> `Ruin2/4`
  - Fixed region-trigger compatibility in `src/engine/states/game-states.ts`
    (menu and AI interaction paths): when `Destructible` trigger from
    `DestroyX` has no matching event, retry using sibling `X` region context.
  - Added screenshots:
    `43-ch2-destructible-villages-ruins.png`,
    `44-ch5-destructible-villages-ruins.png`.
  - Full Playwright harness suite now passes: **35/35**.
- **Chapter 3 full lock interaction sweep (all chest/door variants):**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - All remaining Ch.3 chests (`Chest2/3/4`) unlock + loot checks
    - Remaining Ch.3 doors (`Door2/3`) unlock + region removal checks
  - Hardened harness flow by reloading clean Ch.3 per lock interaction case to
    avoid cross-case turn-state contamination from finished action flags.
  - Added screenshots:
    `41-ch3-all-chests-unlocked.png`,
    `42-ch3-door2-door3-unlocked.png`.
  - Full Playwright harness suite now passes: **33/33**.
- **Chapter 3 unlock interaction coverage + can_unlock fix:**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.3 chest interaction gating + unlock + loot (`Javelin`)
    - Ch.3 door interaction gating + unlock region removal
  - Fixed `unit.can_unlock(region)` condition handling in
    `src/events/event-manager.ts` to support runtime `Map` components and
    `can_unlock` component expressions (including `region.nid.startswith(...)`).
  - Updated unlock consumption in `src/engine/states/game-states.ts` to treat
    `can_unlock` items as key items for use decrement/removal.
  - Added screenshots:
    `39-ch3-chest1-unlock-javelin.png`,
    `40-ch3-door1-unlock-opened.png`.
  - Full Playwright harness suite now passes: **31/31**.
- **Chapter interaction coverage expansion (villages + shops):**
  - Added chapter mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.2 Village1 Visit grants `Red_Gem` and consumes region
    - Ch.5 Village2 Visit grants `Armorslayer` and consumes region
    - Ch.5 Vendor and Armory region menu options appear on correct tiles
  - Added screenshots:
    `36-ch2-village1-visited-red-gem.png`,
    `37-ch5-village2-visited-armorslayer.png`,
    `38-ch5-vendor-armory-menu-options.png`.
  - Sacred Stones chapter suites (`Later Chapters` + `Chapter Mechanics`) now
    pass **15/15**.
- **Deeper Sacred Stones chapter sweep (Ch.2–Ch.5 mechanics):**
  - Added chapter mechanics tests in `tests/harness.spec.ts`:
    - Ch.3 seize objective transitions to Ch.4
    - Ch.4 turn-2 reinforcements (`Turn2Rein`) spawn
    - Ch.5 turn-2 and turn-8 brigand reinforcements spawn
    - Ch.5 Natasha→Joshua talk recruitment converts Joshua to player team
  - Fixed talk menu regression in `src/engine/states/game-states.ts` by passing
    `levelNid` into `getEventsForTrigger()` for `on_talk` checks.
  - Added screenshots:
    `32-ch3-seize-transition-ch4.png`, `33-ch4-turn2-reinforcements.png`,
    `34-ch5-turn2-turn8-reinforcements.png`, `35-ch5-natasha-recruits-joshua.png`.
  - Full Playwright harness suite now passes with expanded coverage: **26/26**.
- **Sacred Stones multi-chapter smoke coverage + harness state fix:**
  - Added chapter smoke tests for Ch.2–Ch.5 in `tests/harness.spec.ts`:
    clean-mode map load checks + non-clean intro progress checks.
  - Added screenshots for each chapter intro/map checkpoint:
    `30-ch{2..5}-clean-map.png`, `31-ch{2..5}-intro-progress.png`.
  - Fixed duplicate `EventState` stacking in `src/harness.ts` by removing
    redundant manual `change('event')` in `loadLevel()`.
  - Full harness suite now passes with expanded coverage: **22/22**.
- **Animation combat sprite-load race fix + regression test:**
  - Fixed startup race in `src/combat/animation-combat.ts`: `updateInit()` now
    gates transition to visible phases until both combatants have resolved
    `mainFrame` draw data, with a 1500ms fail-safe timeout.
  - Added Playwright regression in `tests/harness.spec.ts`:
    `Animation Combat Rendering › combat sprites resolve before visible
    animation phases (no stub boxes)`.
  - Captures `test-screenshots/26-animation-combat-no-stubs.png`.
  - Full harness suite now passes: **14/14**.
- **Harness + visual regression stabilization (Sacred Stones test run):**
  - Fixed harness boot regression in `main.ts`: project picker is now bypassed
    in `?harness=true` runs, defaulting to `default.ltproj` for deterministic
    automated tests.
  - Fixed flaky magic-sword regression assertion in `tests/harness.spec.ts`:
    test now verifies deterministic weapon-use consumption (`Light Brand` uses
    decremented) instead of requiring guaranteed HP damage on RNG-dependent hit.
  - Re-ran full harness suite after fixes: **13/13 passing**.
- **Seven bug fixes across combat, UI, events, and state management:**
  1. **Dialog over portrait:** Auto-sized dialog width to text content, ported
     Python's `get_desired_center()` mapping for portrait-relative positioning.
  2. **Combat animation speed:** Made `tickAnims` unconditional in top-level
     `update()` (matching Python), removed `Math.max(1, ticks)` from 5 call sites.
  3. **Blue highlight rectangle:** Added `highlight.clear()` to FreeState begin/end
     and TurnChangeState (matching Python's cleanup lifecycle).
  4. **Cursor loss after combat:** Added finished-unit guard to WeaponChoiceState,
     added `'repeat'` returns to all dead-unit early-exit paths for instant cascade.
  5. **Red rectangle during magic combat:** Cleared targets in TargetingState.end()
     to prevent stale draw under transparent CombatState.
  6. **Combat UI layout:** Fixed name tag size (80→66x16), centered name text,
     fixed HP bar height (56→40px), adjusted stat layout to fit.
  7. **Early reinforcements:** Changed event condition fallback from `true` to
     `false` in event-manager.ts, added error logging to JS fallback evaluator.
- **Combat animation platform/sprite positioning fix (two passes).** Fixed six
  bugs causing terrain pillars to move around and sprites to float during
  ranged/magic combat animations:
  - Computed `atRange = distance - 1` (matching Python) instead of passing raw
    Manhattan distance. Fixes melee getting ranged pan/poses/platforms.
  - Added `leftRangeOffset`, `rightRangeOffset`, `panOffset`, `totalShakeX`,
    `totalShakeY` to `AnimationCombatRenderState`. `drawBattleSprite` now passes
    per-side range offsets to `drawAnimFrame`, which applies them Python-faithfully:
    `spriteLeft = -totalShakeX + rangeOffset + panOffset`.
  - Negated shake X for sprites (`-totalShakeX`) matching Python's
    `shake = (-total_shake_x, total_shake_y)`. Combined screen + platform shake
    into `totalShakeX`/`totalShakeY` for both platforms and sprites.
  - **Pan logic overhaul:** Added phase-change pan in `updateBeginPhase()` so
    the camera pans to focus on each new attacker (matching Python's
    `set_up_combat_animation -> move_camera`). Split `pan()` into `panAway()`
    (simple toggle) and `panBack()` (looks at next strike to determine focus).
    Added `panAway` boolean to `BattleAnimation` with safety cleanup when a
    pose ends without issuing the return pan command.
  - Pan advancement now uses a separate frame accumulator for frame-rate
    independence (ticks at 60fps like Python regardless of browser refresh rate).
- **Level progression / chapter chaining.** Implemented full level-to-level
  transitions matching the Python engine's behavior:
  - `win_game` command now sets `_win_game` flag (deferred, not immediate)
  - `finishAndDequeue()` checks `_win_game` flag after each event, fires
    `LevelEnd` trigger for outro cutscenes, then calls `levelEnd()`
  - `levelEnd()` resolves next level via `_goto_level` game var override or
    sequential order (skipping debug levels), then async loads the next level
  - `cleanUpLevel()` on GameState persists player units across levels (heals
    HP, clears rescue state, resets turn flags, removes non-persistent units)
  - `loadLevel()` restores persistent units from previous level, placing them
    at positions defined in the new level's unit list
  - `set_next_chapter` event command overrides sequential progression
  - `lose_game` command sets `_lose_game` flag (deferred, returns to title)
  - Generic units set `persistent = false` (only unique units carry over)
  - Added `go_to_overworld` field to `LevelPrefab` type
  - Added `killUnit` and `triggerEvent` to test harness
  - Fixed timing bug where `.then()` callback ran before deferred state machine
    ops flushed, causing `1 Intro` event to be dequeued prematurely. Fix: null
    out `currentEvent` in `levelEnd()` before async load, defer
    `levelTransitionInProgress` reset to `begin()` instead of `.then()`
  - Ch.1 intro cutscene now verified: chapter_title + transition + speak all play
  - Three Playwright tests: cutscene verification + combat_end trigger + direct flag
  - All 12 tests pass (existing + new)
- **Magic sword / wind sword freeze fix.** Fixed `castSpell` in `animation-combat.ts`
  to check the item's `battle_cast_anim` component (e.g. "Gustblade", "Lightning",
  "Nosferatu") before falling back to the item NID. Without this, spell effects never
  spawned, causing the animation to loop forever waiting for `end_parent_loop` or
  `spell_hit`. Also implemented `magic_at_range` dynamic damage in `item-system.ts`
  (swaps STR→MAG and DEF→RES at distance > 1).
- **Multi-project support.** Fixed 3 hardcoded asset paths (base-surf, sprite-loader,
  cursor) to use configurable base URLs. Added `ResourceManager.getBaseUrl()` accessor.
  Separated engine-level shared assets (`/game-data/`) from project-level assets
  (`/game-data/{project}.ltproj/`).
- **Non-chunked data format support.** `loadChunked()` now falls back to loading
  single `game_data/{type}.json` array files when `.orderkeys` directories don't exist.
  `loadTilemaps()` now tries `tilemaps.json` bulk file before individual tilemap files.
- **EXP bar and level-up display overhaul.** Replaced placeholder canvas-primitive EXP
  bar and stat box with a faithful port of the original Python engine:
  - New `ExpBar` class using the original `expbar.png` sprite sheet (144x24 background,
    3x7 begin cap, 1x7 middle fill, 2x7 end cap). Iris fade in/out animation.
  - New `LevelUpScreen` class with scroll-in/out animation, sequential stat spark
    reveals, color-cycling underlines (sine wave blend), BMP font rendering, portrait.
  - CombatState now uses a 7-phase EXP state machine matching the original:
    `exp_init → exp_wait (466ms) → exp0 (1 frame/EXP) → exp100 (wrap) → exp_leave → level_up → level_screen`.
  - Added `playSfxLoop` / `stopSfx` to AudioManager for looping "Experience Gain" SFX.
  - Uses the original `level_screen.png` and `stat_underline.png` sprites.
  - Sound effects: "Experience Gain" (loop), "Level Up", "Level_Up_Level", "Stat Up".

---

## Remaining Work

### Multi-Project Compatibility (Active)

1. **Combat palette path fix** — Non-chunked palettes at `palette_data/combat_palettes.json`
   not found because engine looks one directory level up.
2. **URL encoding for resource NIDs** — Tilesets, portraits, icons, panoramas, and music
   with spaces/special characters in NIDs fail to load. Need `encodeURIComponent()` or
   `encodeURI()` on URL path segments.
3. **Animated title panoramas** — Projects with numbered frames (`title_background0.png`
   through `title_background32.png`) instead of single `title_background.png`.

### Still Missing (Lower Priority)

- Initiative bar rendering UI (visual bar showing unit order)
- Non-silent promotion choice UI (visual class selection)
- Supply menu state UI
- Aura propagation, charge/cooldown, conditional activation, proc skills
- Difficulty-selection UI wiring into the combat RNG mode
- Difficulty selection UI
- Roam AI for NPCs, shop/talk menu in roam mode
- Rescue icon, status effect icons, movement arrows on map
- Growth rates display, support list, weapon rank letters in info menu
- Base screen sub-menus (supports, codex, BEXP, sound room, achievements)
