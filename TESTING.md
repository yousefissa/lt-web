# Testing

Visual testing harness for the Lex Talionis web engine using Playwright.

Since most bugs in this engine are visual (rendering glitches, sprite issues,
tile misalignment), the test strategy uses **browser-based screenshot capture**
rather than unit tests on pure logic.

---

## Quick Start

```bash
# Install Playwright (one-time)
npm install
npx playwright install chromium

# Run all visual tests
npx playwright test

# Run Sacred Stones reliability soak loop (defaults to 5 iterations)
npm run test:ss:soak

# Custom soak loop size / filter
SOAK_ITERATIONS=20 SOAK_GREP="Sacred Stones Chapter Mechanics|Level Progression" npm run test:ss:soak

# Run with visible browser (useful for debugging)
npx playwright test --headed

# Run a specific test
npx playwright test -g "cursor movement"

# View HTML report after a run
npx playwright show-report
```

Screenshots are saved to `test-screenshots/`.

---

## How It Works

### The Harness (`src/harness.ts`)

When the game is loaded with `?harness=true`, the normal `requestAnimationFrame`
game loop is **replaced** with a programmatic API exposed on `window.__harness`:

| Method | Description |
|--------|-------------|
| `stepFrames(n, input?)` | Advance N frames, optionally injecting an input on the first frame |
| `screenshot()` | Capture the canvas as a PNG data URL |
| `getState()` | Get a snapshot of game state (units, cursor, current state name) |
| `injectInput(button)` | Queue an input for the next `stepFrames` call |
| `loadLevel(nid)` | Load a level with events (level_start triggers normally) |
| `loadLevelClean(nid)` | Load a level, skip all events, go straight to `free` state |
| `settle(maxFrames)` | Auto-advance through events/menus until reaching `free` state |
| `giveItem(unitNid, itemNid)` | Give a DB item to a unit (returns `true` on success). Item is inserted at front of inventory so it becomes equipped. |
| `setSeed(seed)` | Install a deterministic gameplay RNG stream for combat and level-ups |
| `clearSeed()` | Restore normal `Math.random`-backed gameplay randomness |
| `getSeedState()` | Read the current deterministic RNG state, or `null` when unseeded |

### Headless Solver Tests

The solver test suite covers seeded RNG, deterministic Chapter 3 and Chapter 4
clears, exact checkpoint cloning, legal action application, explicit plan replay,
fixed-seed beam search, standard event derivation, magic-damage parity, and
parallel diagnostic seed-search equivalence through the real database,
pathfinding, enemy AI, and combat systems:

```bash
npm run solver:test
npm run solver:typecheck
npm run solver -- verify --solution solver/solutions/chapter-3.json
npm run solver -- verify --scenario solver/scenarios/chapter-4.json \
  --solution solver/solutions/chapter-4.json
npm run solver -- verify --scenario solver/scenarios/chapter-5.json \
  --solution solver/solutions/chapter-5.json
```

Project-backed integration tests are skipped when `lt-maker/default.ltproj` is
not available. Policy searches can use multiple worker threads while keeping
the scenario seed fixed:

```bash
npm run solver -- solve --scenario solver/scenarios/chapter-4.json \
  --iterations 1000 --workers 4
npm run solver -- plan --scenario solver/scenarios/chapter-4.json \
  --solution solver/solutions/chapter-4.json --beam-width 32 \
  --branch-limit 12 --max-nodes 30000
```

`plan` never scans gameplay seeds. It branches over validated player actions,
restores exact RNG-bearing checkpoints, rejects transpositions by a canonical
state digest, and verifies saved routes by replaying the explicit action list.
`--max-deaths 0` prunes a search to survival routes, while `--prefix FILE`
continues from a validated turn-stamped action prefix without changing RNG.
Interaction coverage derives Chapter 5 visits/Natasha→Joshua/destructible
villages and Chapter 3 chest/door rules, including lockpick use and rewards.

### Sacred Stones Reliability Soak

`npm run test:ss:soak` runs a repeated Playwright pass over Sacred Stones-heavy
suites and fails on the first non-deterministic regression.

- Defaults: `SOAK_ITERATIONS=5`, `SOAK_WORKERS=1`
- Default grep:
  `Sacred Stones Later Chapters|Sacred Stones Chapter Mechanics|Level Progression`
- Override with env vars to expand/target specific suites.

### URL Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `harness` | `false` | Enable the test harness (set to `true`) |
| `level` | `DEBUG` | Level NID to load (`0`=Prologue, `1`=Ch.1, ..., `DEBUG`) |
| `clean` | `true` | Skip `level_start` events (go straight to map gameplay) |
| `bundle` | `true` | Use asset bundle (set to `false` for dev) |

### Example: Manual Browser Testing

Start the dev server and open a harness URL:

```bash
npm run dev
# Then open: http://localhost:5173/?harness=true&level=0&bundle=false
```

In the browser console:

```js
// Step 10 frames
__harness.stepFrames(10)

// Move cursor right
__harness.stepFrames(5, 'RIGHT')

// Select
__harness.stepFrames(5, 'SELECT')

// Take a screenshot (returns data URL)
await __harness.screenshot()

// Check game state
__harness.getState()

// Reproduce combat and level-up rolls
__harness.setSeed(115)
__harness.getSeedState()

// Auto-advance through events
__harness.settle(500)
```

Valid input buttons: `UP`, `DOWN`, `LEFT`, `RIGHT`, `SELECT`, `BACK`, `INFO`, `AUX`, `START`

---

## Test Structure

Tests live in `tests/harness.spec.ts`:

```
tests/
  harness.spec.ts    -- Playwright test scenarios
test-screenshots/    -- Captured PNGs (not committed)
playwright.config.ts -- Playwright config (uses Vite dev server)
```

### Current Test Scenarios

**DEBUG Level (clean mode)**
- Initial map render
- Cursor movement
- Unit selection + movement range highlights
- Action menu open/close

**Prologue (clean mode)**
- Initial map render
- Cursor navigation to boss unit

**Magic Sword Combat**
- Give Eirika a Light Brand (magic sword with `battle_cast_anim`), attack adjacent enemy, verify combat resolves without freezing and damage is dealt

**Prologue (with events)**
- Event state rendering (intro cutscene)

---

## Adding New Tests

```typescript
test('my new scenario', async ({ page }) => {
  // Load a level in clean mode (no events)
  await page.goto('/?harness=true&level=0&bundle=false');
  await waitForHarness(page);

  // Step frames to render
  await stepFrames(page, 10);

  // Move cursor
  await stepFrames(page, 5, 'RIGHT');

  // Check state
  const state = await getState(page);
  expect(state.currentStateName).toBe('free');

  // Save screenshot
  await saveScreenshot(page, 'my-scenario');
});
```

### Testing Combat and Gameplay

To test combat scenarios (e.g. verifying a weapon type doesn't freeze), use
`giveItem` to equip units with specific weapons, then drive the UI through
the combat flow:

```typescript
test('magic sword combat works', async ({ page }) => {
  await page.goto('/?harness=true&level=DEBUG&bundle=false');
  await waitForHarness(page);
  await stepFrames(page, 5);

  // Give Eirika a Light Brand (magic sword with battle_cast_anim)
  const given = await giveItem(page, 'Eirika', 'Light_Brand');
  expect(given).toBe(true);

  // Navigate to Eirika at (2,6), Bone (enemy) is adjacent at (2,5)
  await navigateCursorTo(page, 2, 6, ...state.cursorPos);

  // SELECT unit -> move state -> SELECT same tile -> menu
  // -> SELECT "Attack" -> weapon_choice -> SELECT weapon -> targeting
  // -> SELECT target -> combat
  await stepFrames(page, 3, 'SELECT');  // select unit
  await stepFrames(page, 10);
  await stepFrames(page, 3, 'SELECT');  // confirm position
  await stepFrames(page, 10);
  await stepFrames(page, 3, 'SELECT');  // pick "Attack"
  await stepFrames(page, 10);
  await stepFrames(page, 3, 'SELECT');  // pick weapon (if weapon_choice)
  await stepFrames(page, 10);
  await stepFrames(page, 3, 'SELECT');  // confirm target

  // Run frames until combat resolves, pressing BACK to dismiss post-combat menus
  for (let batch = 0; batch < 200; batch++) {
    await stepFrames(page, 20);
    const s = await getState(page);
    if (s.currentStateName === 'free') break;
    // After combat ends, BACK dismisses leftover menus
    await stepFrames(page, 3, 'BACK');
  }
});
```

**Key state flow for combat:** `free → move → menu → weapon_choice → targeting → combat → (post-combat) → free`

The DEBUG level has these useful adjacencies for combat testing:
- **Eirika (player, 2,6)** is adjacent to **Bone (enemy, 2,5)** — immediate melee combat
- **Seth (player, 5,4)** has MOV 8 and can reach most enemies in one turn
- **Generic Shaman (player, 4,6)** has Flux/Luna (magic weapons) for testing spell combat

### Tips

- Use `clean` mode (default) to skip events and test map rendering directly
- Use `clean=false` when testing event rendering / cutscenes
- `settle()` auto-presses SELECT through events/menus -- use it to skip intros
- The DEBUG level is small (7 units) and fast to load -- ideal for quick iteration
- Screenshots are full-page captures at 480x320 (2x the GBA resolution)
- Use `giveItem` to test specific weapons — item NIDs match filenames in `lt-maker/default.ltproj/game_data/items/` (e.g. `Light_Brand`, `Wind_Sword`, `Runesword`)
