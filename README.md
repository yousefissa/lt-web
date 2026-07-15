# Lex Talionis Web

1. Download [lt-maker](https://gitlab.com/rainlash/lt-maker), and put it in this folder.
2. Run `npm install`.
3. Run `npm run dev`.

## Fire Emblem level solver

The headless solver loads `.ltproj` data directly and reuses the web engine's
database, unit/item objects, terrain movement, pathfinding, AI controller,
combat formulas, and strike resolver. Scenario JSON controls the level, random
seed, RNG mode, selected team, unit levels/EXP, inventories, and scripted
level-specific spawns. The standard event adapter can also derive rout
objectives, intro unit/group state, turn reinforcements, and region-triggered
reinforcements from LT event data.

```bash
# Fast map/roster inspection
npm run solver -- inspect

# Run Chapter 4 with its event-derived rout objective
npm run solver -- run --scenario solver/scenarios/chapter-4.json

# Search policies and seeds in parallel, then save a replay
npm run solver -- solve --seed-range 0:255 --iterations 4000 --workers 4 \
  --solution-out solver/solutions/chapter-3.json \
  --html solver-output/chapter-3.html

# Deterministically replay a saved solution
npm run solver -- verify --solution solver/solutions/chapter-3.json
npm run solver -- verify --scenario solver/scenarios/chapter-4.json \
  --solution solver/solutions/chapter-4.json
```

The checked-in Chapter 3 solution uses seed `115` and clears in 6 turns with
zero player damage and zero deaths. This is the best route found by the current
search, not a proof of minimum turn count. The fixed default seed `3` incumbent
also clears in 6 turns with zero deaths and 19 damage. Create another scenario under
`solver/scenarios/` to change the party, level, equipment, events, or objective.

The checked-in Chapter 4 route uses the reusable standard event adapter and
seed `211`. It routs 22 enemies plus the Snag in 5 turns with zero deaths and
17 cumulative damage. The fixed seed `4` comparison also clears in 5 turns
with zero deaths and 22 damage. `--workers` parallelizes both policy candidates
and seed-range scans.

See [TESTING.md](./TESTING.md) for solver and browser regression commands.
