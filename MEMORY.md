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
- Magic sword harness regression should assert deterministic execution signals (state resolution,
  weapon uses decrement) rather than RNG-dependent HP damage.
