# lt-web: Lex Talionis Web Engine -- Development Plan

This document tracks what has been built, what is partially complete, and what
remains to bring the TypeScript web port to feature parity with the original
Lex Talionis Python/Pygame engine.

---

## Current State

**84 source files, ~44,400 lines of TypeScript.**
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

### Recent Changes

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
- RNG mode integration into combat solver
- Difficulty selection UI
- Roam AI for NPCs, shop/talk menu in roam mode
- Rescue icon, status effect icons, movement arrows on map
- Growth rates display, support list, weapon rank letters in info menu
- Base screen sub-menus (supports, codex, BEXP, sound room, achievements)
