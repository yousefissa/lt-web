# Session Memory

- Harness mode must not block on project picker when `?harness=true` and no `?project=` is present.
  Default to `default.ltproj` (or first discovered project) for deterministic automated testing.
- In animation combat, cyan/red solid rectangles indicate the deliberate sprite stub fallback path
  (`draw.mainFrame` is missing) in `src/engine/states/game-states.ts`.
- Fixed by gating `AnimationCombat` init: `src/combat/animation-combat.ts` now waits until both
  sides resolve `mainFrame` before entering visible phases (`SPRITE_LOAD_WAIT_MS = 1500` fail-safe).
- Harness `loadLevel(clean=false)` must not manually push `event` after `free`; `FreeState` already
  auto-pushes pending level_start events. Double-pushing can stack EventState and cause chapter intro
  soft-lock/transient empty-top-state behavior in long cutscenes (seen in Ch.2/Ch.3).
- Talk menu discovery for level-scoped conversations must pass `levelNid` into
  `eventManager.getEventsForTrigger()`. Missing `levelNid` hides valid Talk options even when
  matching events exist (reproduced with Ch.5 Natasha/Joshua recruitment).
- For long village cutscenes in harness tests, use `BACK` input to enable EventState skip mode;
  relying on repeated `SELECT` can leave tests mid-event and make item assertions flaky.
- `evaluateCondition(unit.can_unlock(region))` must handle runtime item components stored as
  `Map<string, any>`, not just array-shaped components. Include `can_unlock` expression handling
  (e.g. `region.nid.startswith('Chest')` / `'Door'`) for correct Chest/Door menu gating.
- In multi-step interaction tests, prior actions can leave units with `finished=true`; either reset
  per-turn flags explicitly or reload the level cleanly between cases to avoid false negatives when
  forcing `menu` state.
- Destructible village data may be mixed between `DestroyVillageX` interaction regions and
  event conditions that match `VillageX`. Region-trigger code should retry with sibling region
  context when `Destructible` trigger fails on `Destroy*` region.
- Ch.3 Colm spawn event (`3_Turn2`) uses trigger `other_turn_change` with condition
  `game.turncount == 1` in this data set; harness tests should set both `turnCount` and
  `turncount` before triggering for deterministic behavior.
- Ch.3 outro validation should assert recruit branch behavior during the outro timeline
  (Colm becomes `player`) rather than after Ch.4 loads, since Ch.4 intro removes many units.
- Ch.4 Village2 recruitment (`change_team;Lute;player` + `add_unit;...;closest`) can leave Lute
  unplaced (`position == null`) in some deterministic harness setups; assert team conversion and
  region consumption as primary correctness checks.
- Ch.4 Turn3 cameo script intentionally removes `L'arachel`, `Dozla`, and `Rennac` after dialogue;
  regression checks should assert final `position == null` rather than persistent on-map presence.
- `ralph-loop` only runs when `PLAN.md` has unchecked `- [ ]` items; keep backlog items concise
  so prompt titles stay short and avoid Discord attachment fallback.
- Magic sword harness regression should assert deterministic execution signals (state resolution,
  weapon uses decrement) rather than RNG-dependent HP damage.
