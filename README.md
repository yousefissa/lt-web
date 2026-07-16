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

# Evaluate one seed-agnostic policy on every immutable manifest seed
npm run solver -- evaluate-policy --scenario solver/scenarios/chapter-3.json \
  --seed-manifest solver/seed-manifests/chapter-3/train.json \
  --workers 4 --out solver-output/chapter-3-baseline-train.json

# Train only on train seeds and select checkpoints only on validation seeds
npm run solver -- train-policy --scenario solver/scenarios/chapter-3.json \
  --train-seeds solver/seed-manifests/chapter-3/train.json \
  --validation-seeds solver/seed-manifests/chapter-3/validation.json \
  --iterations 100 --workers 4 --out solver-output/chapter-3-policy.json

# Evaluate the selected policy once on the held-out test split
npm run solver -- verify-policy --scenario solver/scenarios/chapter-3.json \
  --test-seeds solver/seed-manifests/chapter-3/test.json \
  --policy solver-output/chapter-3-policy.json \
  --out solver-output/chapter-3-test.json --html solver-output/chapter-3-test.html

# Run fixed-seed planning for every seed and report solve coverage, not a best seed
npm run solver -- solve-seeds --scenario solver/scenarios/chapter-3.json \
  --seed-manifest solver/seed-manifests/chapter-3/test.json \
  --planner beam --max-nodes 30000 --out solver-output/chapter-3-coverage.json
```

The canonical Chapter 3 benchmark fixes seed `3` and clears in 7 turns with
zero deaths and zero damage. Create another scenario under `solver/scenarios/`
to change the party, level, equipment, events, or objective; its `seed` remains
part of that fixed problem instance.

The canonical Chapter 4 benchmark fixes seed `4`. It uses the reusable standard
event adapter and routs 22 enemies plus the Snag in 6 turns with zero deaths and
2 cumulative damage. Its explicit 49-action player plan uses 90 total actions,
visits both villages, and recruits Lute. A 26,044-node fixed-seed frontier
challenged the damage result without finding less than 2; this is best-found
evidence, not an optimality proof. `--workers` parallelizes policy
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
Joshua, and defeats Saar in 4 turns with zero deaths and 71 cumulative damage;
it also visits Village 2. The separate `chapter-5-all-content.json` stress
scenario requires all four villages plus Joshua and has a verified 10-turn,
1-death, 66-damage incumbent. The reusable interaction adapter derives visits,
talk recruitment, destructible villages, doors, and chests from LT events;
unlock actions enforce item/class conditions, consume uses, grant event rewards,
and apply terrain-layer changes.

Global-policy reports are a separate claim from those single-seed routes. The
checked-in Chapter 3–5 manifests contain 12 train, 6 validation, and 6 held-out
test seeds derived from the seed-neutral scenario/project/engine fingerprint,
split name, and index. The optimizer cannot choose, filter, reorder, or read a
seed. Its frozen observation contains only current tactical state and complete
legal actions; global reports retain every clear, failure, and error and score
failed clears, deaths, worst/CVaR-95/mean damage, turns, then actions.

The sealed held-out benchmark produced these exact global scores (lower is
better; tuple order is failed clears, death-bearing seeds, total deaths, worst
damage, CVaR-95 damage, mean damage, mean turns, mean actions):

| Chapter | Baseline test score | Selected-policy test score | Beam coverage |
|---|---|---|---|
| 3 | `[1,3,3,62,62,37.5,8.5,99.333]` | `[1,2,3,61,61,45,9.833,109.5]` | 4/6 |
| 4 | `[3,5,6,69,69,43,4.5,65.167]` | `[3,5,5,82,82,45.667,4,62.5]` | 5/6 |
| 5 | `[3,2,3,85,85,69.833,10,125.667]` | `[0,5,6,95,95,71.667,4,65.667]` | 3/6 |

The selected policies therefore clear 5/6, 3/6, and 6/6 held-out seeds for
Chapters 3–5. Beam coverage is a separate 3,000-node-per-seed best-found
diagnostic, not a global-policy result or infeasibility proof. Full aggregate
and per-seed JSON, HTML reports, and representative replays are under
`solver/results/global/`; frozen policies are under `solver/policies/`.

See [TESTING.md](./TESTING.md) for solver and browser regression commands.
