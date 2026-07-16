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

# Search policies against the scenario's fixed seed, then save a replay
npm run solver -- solve --iterations 4000 --workers 4 \
  --solution-out solver/solutions/chapter-3.json \
  --html solver-output/chapter-3.html

# Search explicit legal action routes with cloneable states and a transposition cache
npm run solver -- plan --scenario solver/scenarios/chapter-4.json \
  --solution solver/solutions/chapter-4.json --beam-width 72 \
  --branch-limit 24 --max-nodes 80000 \
  --solution-out solver/solutions/chapter-4.json

# Ask an exhaustive fixed-seed feasibility question (within the supported model)
npm run solver -- prove --scenario solver/scenarios/chapter-4.json \
  --solution solver/solutions/chapter-4.json \
  --max-deaths 0 --max-damage 21 --max-nodes 1000000

# Deterministically replay a saved solution
npm run solver -- verify --solution solver/solutions/chapter-3.json
npm run solver -- verify --scenario solver/scenarios/chapter-4.json \
  --solution solver/solutions/chapter-4.json
npm run solver -- verify --scenario solver/scenarios/chapter-5.json \
  --solution solver/solutions/chapter-5.json
```

The canonical Chapter 3 benchmark fixes seed `3` and clears in 6 turns with
zero deaths and 19 damage. Create another scenario under `solver/scenarios/`
to change the party, level, equipment, events, or objective; its `seed` remains
part of that fixed problem instance.

The canonical Chapter 4 benchmark fixes seed `4`. It uses the reusable standard
event adapter and routs 22 enemies plus the Snag in 5 turns with zero deaths and
22 cumulative damage. Its explicit 45-action player plan uses 82 total actions,
down from the 83-action greedy incumbent. Two 80,000-node fixed-seed beam
configurations challenged the damage result without finding less than 22; this
is best-found evidence, not an optimality proof. `--workers` parallelizes policy
candidates without changing the gameplay RNG stream.

Seed-range scanning is deliberately excluded from benchmark results. The CLI
requires `--allow-seed-search` alongside `--seed-range` and labels that path as
non-benchmark diagnostic work.

Saved benchmark solutions are fingerprinted over the gameplay scenario,
project data, engine source, and solver transition files. `verify`, `plan`
continuation, and `--prefix` reject stale artifacts instead of accepting a
matching seed from a different roster, ruleset, or project revision.

The planner uses exact RNG-bearing future-state hashes with Pareto dominance
over deaths, cumulative damage, and actions. `prove` never turns a node-limited
search into a claim: it reports `found`, exhaustive `infeasible`, or `unknown`
when the node budget ends.

The canonical Chapter 5 benchmark fixes seed `5`, requires Natasha to recruit
Joshua, and defeats Saar in 4 turns with zero deaths and 53 cumulative damage;
it also visits Village 2. The separate `chapter-5-all-content.json` stress
scenario requires all four villages plus Joshua and has a verified 5-turn,
1-death, 66-damage incumbent. The reusable interaction adapter derives visits,
talk recruitment, destructible villages, doors, and chests from LT events;
unlock actions enforce item/class conditions, consume uses, grant event rewards,
and apply terrain-layer changes.

See [TESTING.md](./TESTING.md) for solver and browser regression commands.
