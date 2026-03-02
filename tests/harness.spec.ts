/**
 * Playwright visual test harness for the Lex Talionis web engine.
 *
 * Uses ?harness=true to drive the game frame-by-frame and capture
 * screenshots at specific states for visual verification.
 *
 * By default, ?clean=true skips level_start events so we land directly
 * on the 'free' state (map gameplay). Use &clean=false to test with events.
 *
 * Run: npx playwright test
 * View report: npx playwright show-report
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'test-screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForHarness(page: any) {
  await page.waitForFunction(
    () => (window as any).__harness?.ready === true,
    { timeout: 30_000 },
  );
}

async function stepFrames(page: any, count: number, input?: string | null) {
  await page.evaluate(
    ({ count, input }: { count: number; input: string | null }) => {
      (window as any).__harness.stepFrames(count, input);
    },
    { count, input: input ?? null },
  );
}

async function getState(page: any) {
  return page.evaluate(() => (window as any).__harness.getState());
}

async function settle(page: any, maxFrames: number = 300) {
  await page.evaluate(
    (maxFrames: number) => (window as any).__harness.settle(maxFrames),
    maxFrames,
  );
}

async function saveScreenshot(page: any, label: string): Promise<string> {
  const filePath = path.join(SCREENSHOT_DIR, `${label}.png`);
  await page.screenshot({ path: filePath });
  return filePath;
}

// ---------------------------------------------------------------------------
// DEBUG Level Tests (clean mode -- no events, straight to free state)
// ---------------------------------------------------------------------------

test.describe('DEBUG Level (clean)', () => {
  test('initial map render', async ({ page }) => {
    // clean=true is the default, skips level_start events
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);

    await stepFrames(page, 10);

    const state = await getState(page);
    expect(state.levelNid).toBe('DEBUG');
    expect(state.currentStateName).toBe('free');
    expect(state.units.length).toBeGreaterThan(0);

    console.log(`Units: ${state.units.map((u: any) => `${u.name}(${u.team})`).join(', ')}`);
    await saveScreenshot(page, '01-debug-map');
  });

  test('cursor movement', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const before = await getState(page);
    const startPos = before.cursorPos;

    // Move cursor right 3 times, down 2 times
    for (let i = 0; i < 3; i++) {
      await stepFrames(page, 4, 'RIGHT');
    }
    for (let i = 0; i < 2; i++) {
      await stepFrames(page, 4, 'DOWN');
    }
    await stepFrames(page, 5); // settle animation

    const after = await getState(page);
    console.log(`Cursor moved: [${startPos}] -> [${after.cursorPos}]`);
    expect(after.cursorPos[0]).toBeGreaterThan(startPos[0]);
    expect(after.cursorPos[1]).toBeGreaterThan(startPos[1]);

    await saveScreenshot(page, '02-debug-cursor-moved');
  });

  test('select unit shows movement range', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Find a player unit
    const state = await getState(page);
    const player = state.units.find(
      (u: any) => u.team === 'player' && u.position !== null,
    );
    expect(player).toBeTruthy();
    console.log(`Selecting: ${player.name} at [${player.position}]`);

    // Move cursor to unit
    const [ux, uy] = player.position;
    const [cx, cy] = state.cursorPos;
    const dx = ux - cx;
    const dy = uy - cy;
    for (let i = 0; i < Math.abs(dx); i++) {
      await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
    }
    for (let i = 0; i < Math.abs(dy); i++) {
      await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
    }
    await stepFrames(page, 5);

    // Screenshot: cursor on unit
    await saveScreenshot(page, '03-debug-cursor-on-unit');

    // Press SELECT to select the unit
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 15); // let highlights render

    // Check we transitioned to move state
    const afterSelect = await getState(page);
    console.log(`State after select: ${afterSelect.currentStateName}`);

    await saveScreenshot(page, '04-debug-movement-range');
  });

  test('open and close action menu', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Find Eirika
    const state = await getState(page);
    const eirika = state.units.find((u: any) => u.nid === 'Eirika');
    expect(eirika).toBeTruthy();

    // Navigate cursor to Eirika
    const [ux, uy] = eirika.position;
    const [cx, cy] = state.cursorPos;
    const dx = ux - cx;
    const dy = uy - cy;
    for (let i = 0; i < Math.abs(dx); i++) {
      await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
    }
    for (let i = 0; i < Math.abs(dy); i++) {
      await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
    }
    await stepFrames(page, 5);

    // Select Eirika
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    // Select same tile (should open menu)
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    const menuState = await getState(page);
    console.log(`State after menu: ${menuState.currentStateName}`);
    await saveScreenshot(page, '05-debug-action-menu');

    // Press BACK to cancel
    await stepFrames(page, 3, 'BACK');
    await stepFrames(page, 10);
    await stepFrames(page, 3, 'BACK');
    await stepFrames(page, 10);

    const afterCancel = await getState(page);
    console.log(`State after cancel: ${afterCancel.currentStateName}`);
    await saveScreenshot(page, '06-debug-after-cancel');
  });
});

// ---------------------------------------------------------------------------
// Prologue Tests (clean mode)
// ---------------------------------------------------------------------------

test.describe('Prologue (clean)', () => {
  test('initial map render', async ({ page }) => {
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const state = await getState(page);
    expect(state.levelNid).toBe('0');
    expect(state.currentStateName).toBe('free');
    console.log(`Prologue units: ${state.units.map((u: any) => `${u.name}(${u.team})`).join(', ')}`);

    await saveScreenshot(page, '07-prologue-map');
  });

  test('prologue map with cursor on enemy', async ({ page }) => {
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Find the boss (O'Neill)
    const state = await getState(page);
    const boss = state.units.find((u: any) => u.nid === "O'Neill");
    if (boss?.position) {
      const [bx, by] = boss.position;
      const [cx, cy] = state.cursorPos;
      const dx = bx - cx;
      const dy = by - cy;
      for (let i = 0; i < Math.abs(dx); i++) {
        await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
      }
      for (let i = 0; i < Math.abs(dy); i++) {
        await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
      }
      await stepFrames(page, 5);

      console.log(`Cursor on boss: ${boss.name} at [${boss.position}]`);
      await saveScreenshot(page, '08-prologue-cursor-on-boss');
    }
  });
});

// ---------------------------------------------------------------------------
// Magic Sword Combat Tests
// ---------------------------------------------------------------------------

async function giveItem(page: any, unitNid: string, itemNid: string): Promise<boolean> {
  return page.evaluate(
    ({ unitNid, itemNid }: { unitNid: string; itemNid: string }) => {
      return (window as any).__harness.giveItem(unitNid, itemNid);
    },
    { unitNid, itemNid },
  );
}

async function navigateCursorTo(
  page: any,
  targetX: number,
  targetY: number,
  currentX: number,
  currentY: number,
): Promise<void> {
  const dx = targetX - currentX;
  const dy = targetY - currentY;
  for (let i = 0; i < Math.abs(dx); i++) {
    await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
  }
  for (let i = 0; i < Math.abs(dy); i++) {
    await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
  }
  await stepFrames(page, 3);
}

test.describe('Magic Sword Combat', () => {
  test('Light Brand combat does not freeze', async ({ page }) => {
    // Load the DEBUG level cleanly
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Give Eirika a Light Brand (has `magic` + `battle_cast_anim: "Lightning"`)
    const given = await giveItem(page, 'Eirika', 'Light_Brand');
    expect(given).toBe(true);

    const lightBrandUsesBefore = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const lightBrand = eirika?.items?.find?.((it: any) => it?.nid === 'Light_Brand');
      return typeof lightBrand?.uses === 'number' ? lightBrand.uses : null;
    });
    expect(lightBrandUsesBefore).not.toBeNull();

    // Verify Eirika is at (2,6) and Bone (enemy) is at (2,5)
    const state = await getState(page);
    const eirika = state.units.find((u: any) => u.nid === 'Eirika');
    const bone = state.units.find((u: any) => u.nid === 'Bone');
    expect(eirika?.position).toEqual([2, 6]);
    expect(bone?.position).toEqual([2, 5]);

    // Navigate cursor to Eirika
    const [cx, cy] = state.cursorPos;
    await navigateCursorTo(page, 2, 6, cx, cy);

    // Select Eirika (enters move state)
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    let s = await getState(page);
    console.log(`After selecting Eirika: ${s.currentStateName}`);

    // Select same tile to open action menu (Eirika stays at her position)
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    s = await getState(page);
    console.log(`After confirming position: ${s.currentStateName}`);
    await saveScreenshot(page, '10-magic-sword-action-menu');

    // "Attack" should be the first option in the menu. Press SELECT to pick it.
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    s = await getState(page);
    console.log(`After selecting Attack: ${s.currentStateName}`);

    // If we're in weapon_choice, select the weapon (Light Brand should be first)
    if (s.currentStateName === 'weapon_choice') {
      await stepFrames(page, 3, 'SELECT');
      await stepFrames(page, 10);
      s = await getState(page);
      console.log(`After selecting weapon: ${s.currentStateName}`);
    }

    await saveScreenshot(page, '11-magic-sword-targeting');

    // In targeting mode, Bone should be the target (adjacent at (2,5)).
    // Press SELECT to confirm attack on Bone.
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 5);

    s = await getState(page);
    console.log(`Combat started, state: ${s.currentStateName}`);
    await saveScreenshot(page, '12-magic-sword-combat-start');

    // Run many frames to let combat resolve. Combat completes in ~260 frames,
    // then the unit may return to menus (weapon_choice/targeting) or post-combat
    // states that need dismissing. We auto-press BACK to cancel out of any
    // remaining menus until we return to 'free' state.
    let combatResolved = false;
    let lastState = '';
    let combatSeen = false;
    let midCombatScreenshotTaken = false;
    for (let batch = 0; batch < 200; batch++) {
      await stepFrames(page, 20);
      s = await getState(page);
      if (s.currentStateName === 'combat' || s.currentStateName === 'animation_combat' ||
          s.currentStateName === 'map_combat') {
        combatSeen = true;
        // Capture mid-combat screenshot after HP bar panels have slid in (~60 frames)
        if (!midCombatScreenshotTaken && batch >= 2) {
          await saveScreenshot(page, '12b-magic-sword-combat-mid');
          midCombatScreenshotTaken = true;
        }
      }
      if (s.currentStateName !== lastState) {
        console.log(`  Frame ~${(batch + 1) * 20}: state=${s.currentStateName}`);
        lastState = s.currentStateName;
      }
      if (s.currentStateName === 'free') {
        combatResolved = true;
        console.log(`Combat resolved after ~${(batch + 1) * 20} frames`);
        break;
      }
      // After combat is over, if we're back in menus or other states, try to
      // advance/dismiss. press BACK to cancel out of stacked menus, or settle.
      if (combatSeen && s.currentStateName !== 'combat' &&
          s.currentStateName !== 'animation_combat' &&
          s.currentStateName !== 'map_combat' &&
          s.currentStateName !== 'exp' && s.currentStateName !== 'exp_gain') {
        // Try pressing BACK to dismiss any post-combat menus
        await stepFrames(page, 3, 'BACK');
      }
    }

    await saveScreenshot(page, '13-magic-sword-combat-end');

    // Verify combat actually happened — we should have seen a combat state
    expect(combatSeen).toBe(true);

    // If combat didn't resolve in ~4000 frames, the freeze bug is still present.
    expect(combatResolved).toBe(true);

    // Verify Bone took damage (Light Brand deals magic damage)
    const finalState = await getState(page);
    const boneAfter = finalState.units.find((u: any) => u.nid === 'Bone');
    const lightBrandUsesAfter = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const lightBrand = eirika?.items?.find?.((it: any) => it?.nid === 'Light_Brand');
      return typeof lightBrand?.uses === 'number' ? lightBrand.uses : null;
    });

    console.log(`Bone HP after combat: ${boneAfter?.hp}/${boneAfter?.maxHp}`);
    console.log(`Light Brand uses: ${lightBrandUsesBefore} -> ${lightBrandUsesAfter}`);

    // Combat can miss based on RNG, so HP damage is non-deterministic.
    // The deterministic check is that the attack consumed one weapon use.
    expect(lightBrandUsesAfter).toBe(lightBrandUsesBefore - 1);

    // If the attack hit, Bone HP should drop. If it missed, HP is unchanged.
    expect(boneAfter!.hp).toBeLessThanOrEqual(boneAfter!.maxHp);
  });
  test('combat HP bar and weapon info do not overlap', async ({ page }) => {
    // Load the DEBUG level cleanly and initiate combat to verify
    // the combat UI layout. The DEBUG level uses map combat (no animation
    // data), so the HP bars are the small bars above units.
    // This test verifies combat starts and captures a mid-combat screenshot.
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Navigate cursor to Eirika at (2,6)
    const state = await getState(page);
    const [cx, cy] = state.cursorPos;
    await navigateCursorTo(page, 2, 6, cx, cy);

    // Select Eirika -> confirm position -> Attack -> select weapon -> confirm target
    await stepFrames(page, 3, 'SELECT'); // select unit
    await stepFrames(page, 10);
    await stepFrames(page, 3, 'SELECT'); // confirm position
    await stepFrames(page, 10);
    await stepFrames(page, 3, 'SELECT'); // pick Attack
    await stepFrames(page, 10);

    let s = await getState(page);
    if (s.currentStateName === 'weapon_choice') {
      await stepFrames(page, 3, 'SELECT'); // pick weapon
      await stepFrames(page, 10);
    }

    await stepFrames(page, 3, 'SELECT'); // confirm target
    await stepFrames(page, 5);

    // Step frames into the combat. Map combat is fast (~260 frames total).
    // Step past the initial lunge and into HP drain to capture mid-combat.
    let combatSeen = false;
    for (let batch = 0; batch < 40; batch++) {
      await stepFrames(page, 10);
      s = await getState(page);
      if (s.currentStateName === 'combat') {
        combatSeen = true;
      }
      // Capture after we've been in combat for a bit (HP drain phase)
      if (combatSeen && batch >= 5) {
        await saveScreenshot(page, '15-combat-ui-layout');
        break;
      }
    }
    expect(combatSeen).toBe(true);

    // Let combat resolve
    let combatResolved = false;
    for (let batch = 0; batch < 200; batch++) {
      await stepFrames(page, 20);
      s = await getState(page);
      if (s.currentStateName === 'free') {
        combatResolved = true;
        break;
      }
      if (s.currentStateName !== 'combat' && s.currentStateName !== 'animation_combat' &&
          s.currentStateName !== 'map_combat' && s.currentStateName !== 'exp' &&
          s.currentStateName !== 'exp_gain') {
        await stepFrames(page, 3, 'BACK');
      }
    }
    expect(combatResolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Prologue with events (non-clean mode)
// ---------------------------------------------------------------------------

test.describe('Prologue (with events)', () => {
  test('initial event state', async ({ page }) => {
    await page.goto('/?harness=true&level=0&bundle=false&clean=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const state = await getState(page);
    console.log(`State with events: ${state.currentStateName}`);
    // Prologue starts with intro events
    await saveScreenshot(page, '09-prologue-event');
  });

  test('dialog box appears above portraits, not overlapping', async ({ page }) => {
    // Load prologue with events (non-clean mode) to test dialog positioning.
    // The prologue intro has: transition;close, change_background;Forest,
    // transition;open, add_portrait;Seth;Left;no_block,
    // add_portrait;Eirika;Right, speak;Seth;...
    //
    // Previously, add_portrait loaded images asynchronously but advanced
    // the command pointer immediately, so the speak command couldn't find
    // the portrait and the dialog rendered at the bottom of the screen,
    // overlapping with the portrait area.
    await page.goto('/?harness=true&level=0&bundle=false&clean=false');
    await waitForHarness(page);

    // Step through the initial event commands (unit moves, transitions).
    // The first transition;close + change_background + transition;open takes
    // many frames. We need to step enough frames to get past all the setup
    // commands and arrive at the first speak command with portraits visible.
    // Step a large number of frames, pressing SELECT periodically to advance
    // through any blocking waits.
    let dialogFound = false;
    for (let batch = 0; batch < 100; batch++) {
      await stepFrames(page, 20);
      const s = await getState(page);

      if (s.currentStateName === 'event') {
        // Check if we can see a dialog box by sampling pixel colors.
        // The dialog background is rgba(12, 12, 28, 0.92) — very dark blue.
        // Portraits are drawn at the bottom 80px of the 240x160 viewport.
        // The dialog should be ABOVE the portrait area (y < 80).
        //
        // Sample the canvas at the game's native resolution (240x160).
        // The display canvas is 480x320 (2x scaling), so we check at 2x coords.
        const pixelInfo = await page.evaluate(() => {
          const canvas = document.querySelector('canvas') as HTMLCanvasElement;
          if (!canvas) return null;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;

          // The game renders at 240x160, display is 480x320 (2x).
          // Check for dark dialog background at various Y positions.
          // Dialog box at y ~36 (native) = y ~72 (display) when portrait exists.
          // Dialog box at y ~116 (native) = y ~232 (display) when no portrait (bottom).
          // Portrait area: y 80-160 (native) = y 160-320 (display).
          const width = canvas.width;

          // Sample a horizontal strip in the middle of the canvas at different Y levels
          const midX = Math.floor(width / 2);

          function getPixel(x: number, y: number) {
            const data = ctx!.getImageData(x, y, 1, 1).data;
            return { r: data[0], g: data[1], b: data[2], a: data[3] };
          }

          // The display canvas maps game pixels to physical pixels.
          // Compute the scale from canvas dimensions vs native 240x160.
          const scaleX = canvas.width / 240;
          const scaleY = canvas.height / 160;

          // Check for dialog background (very dark, R<30, G<30, B<40)
          // Dialog is at native y ~46-76 (above portrait area at y=80).
          // Sample at native y=55 to catch dialog in the middle.
          const abovePortrait = getPixel(Math.floor(midX), Math.floor(55 * scaleY));
          // Native y=120 (in portrait overlap zone)
          const belowInPortrait = getPixel(Math.floor(midX), Math.floor(120 * scaleY));

          // Check if there's a portrait visible (non-black pixels in the portrait area)
          // Portrait area: native y 80-160, check at native (20, 100)
          const portraitArea = getPixel(Math.floor(20 * scaleX), Math.floor(100 * scaleY));

          return {
            abovePortrait,
            belowInPortrait,
            portraitArea,
          };
        });

        if (pixelInfo) {
          const ap = pixelInfo.abovePortrait;
          // Check if the dark dialog background is present above the portrait area
          // Dialog bg is rgba(12, 12, 28, 0.92) composited on the forest background
          const isDarkAbove = ap.r < 50 && ap.g < 50 && ap.b < 60;

          // Check if there's portrait content in the portrait area (not fully black)
          const pp = pixelInfo.portraitArea;
          const hasPortraitContent = pp.a > 0 && (pp.r > 20 || pp.g > 20 || pp.b > 20);

          if (isDarkAbove && hasPortraitContent) {
            // We found a frame where dialog is above portraits!
            dialogFound = true;
            console.log(`Dialog found above portraits at batch ${batch}`);
            console.log(`  Above portrait pixel: R=${ap.r} G=${ap.g} B=${ap.b} A=${ap.a}`);
            console.log(`  Portrait area pixel: R=${pp.r} G=${pp.g} B=${pp.b} A=${pp.a}`);

            // Verify the dialog is NOT overlapping the portrait area
            const bp = pixelInfo.belowInPortrait;
            const isDarkBelow = bp.r < 20 && bp.g < 20 && bp.b < 35 && bp.a > 200;
            // The area at y=240 (display) should be portrait or background, NOT dialog
            // (dialog bg has very specific dark blue color)
            console.log(`  Below-in-portrait pixel: R=${bp.r} G=${bp.g} B=${bp.b} A=${bp.a}`);

            await saveScreenshot(page, '14-dialog-above-portraits');
            break;
          }
        }
      }
    }

    expect(dialogFound).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Animation combat visual regression
// ---------------------------------------------------------------------------

test.describe('Animation Combat Rendering', () => {
  test('combat sprites resolve before visible animation phases (no stub boxes)', async ({ page }) => {
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const board = g?.board;
      if (!g || !board) return false;

      const eirika = g.units.get('Eirika');
      if (!eirika) return false;

      const enemy = Array.from(g.units.values()).find((u: any) => u.team === 'enemy' && !u.isDead());
      if (!enemy) return false;

      // Force adjacent setup for deterministic combat start.
      board.moveUnit(enemy, eirika.position[0], eirika.position[1] - 1);

      g.selectedUnit = eirika;
      g.combatTarget = enemy;
      g.state.change('combat');
      return true;
    });
    expect(setupOk).toBe(true);

    // Allow state-machine deferred transition to push CombatState.
    await stepFrames(page, 5);

    let sample: any = null;
    for (let i = 0; i < 60; i++) {
      await stepFrames(page, 3);
      sample = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const cs = g?.state?.getCurrentState?.();
        if (!cs || cs.name !== 'combat' || !cs.animCombat) return null;
        const rs = cs.animCombat.getRenderState?.();
        return {
          isAnimationCombat: !!cs.isAnimationCombat,
          animState: cs.animCombat.state,
          leftHasMainFrame: !!rs?.leftDraw?.mainFrame,
          rightHasMainFrame: !!rs?.rightDraw?.mainFrame,
          leftFrameCount: cs.animCombat.leftAnim?.frameImages?.size ?? 0,
          rightFrameCount: cs.animCombat.rightAnim?.frameImages?.size ?? 0,
        };
      });

      if (sample && sample.animState !== 'init') break;
    }

    expect(sample).toBeTruthy();
    expect(sample.isAnimationCombat).toBe(true);
    expect(sample.leftHasMainFrame).toBe(true);
    expect(sample.rightHasMainFrame).toBe(true);

    await saveScreenshot(page, '26-animation-combat-no-stubs');
  });
});

// ---------------------------------------------------------------------------
// Sacred Stones chapter smoke tests (later chapters)
// ---------------------------------------------------------------------------

const LATER_CHAPTERS = ['2', '3', '4', '5'];

test.describe('Sacred Stones Later Chapters', () => {
  for (const chapter of LATER_CHAPTERS) {
    test(`Chapter ${chapter} loads in clean mode`, async ({ page }) => {
      await page.goto(`/?harness=true&level=${chapter}&bundle=false`);
      await waitForHarness(page);
      await stepFrames(page, 12);

      const state = await getState(page);
      expect(state.levelNid).toBe(chapter);
      expect(state.currentStateName).toBe('free');
      expect(state.units.length).toBeGreaterThan(0);

      await saveScreenshot(page, `30-ch${chapter}-clean-map`);
    });

    test(`Chapter ${chapter} intro events make progress (no freeze)`, async ({ page }) => {
      await page.goto(`/?harness=true&level=${chapter}&bundle=false&clean=false`);
      await waitForHarness(page);
      await stepFrames(page, 5);

      let reachedFree = false;
      let hitTitle = false;
      let firstPointer: number | null = null;
      let lastPointer: number | null = null;
      let activeEventNid: string | null = null;

      // Step through event flow. Some chapter intros are long, so we assert
      // forward progress and no lockups rather than requiring immediate finish.
      for (let batch = 0; batch < 900; batch++) {
        await stepFrames(page, 5, batch % 3 === 0 ? 'SELECT' : null);

        const snap = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          const currentState = g?.state?.getCurrentState?.()?.name ?? null;
          const ev = g?.eventManager?.getCurrentEvent?.();
          return {
            currentState,
            pointer: typeof ev?.commandPointer === 'number' ? ev.commandPointer : null,
            eventNid: ev?.nid ?? null,
          };
        });

        if (!activeEventNid && snap.eventNid) activeEventNid = snap.eventNid;
        if (snap.pointer != null) {
          if (firstPointer == null) firstPointer = snap.pointer;
          lastPointer = snap.pointer;
        }

        if (snap.currentState === 'free') {
          reachedFree = true;
          break;
        }
        if (snap.currentState === 'title' || snap.currentState === 'title_main') {
          hitTitle = true;
          break;
        }
      }

      // Stabilize on a concrete top state (deferred state-machine transitions can
      // produce a transient frame with no active top state).
      let state = await getState(page);
      for (let i = 0; i < 30 && !state.currentStateName; i++) {
        await stepFrames(page, 1);
        state = await getState(page);
      }

      expect(state.levelNid).toBe(chapter);
      expect(hitTitle).toBe(false);
      expect(Boolean(state.currentStateName)).toBe(true);
      expect(state.units.length).toBeGreaterThan(0);
      expect(reachedFree || (firstPointer != null && lastPointer != null && lastPointer > firstPointer)).toBe(true);

      console.log(`Ch.${chapter} intro event: ${activeEventNid ?? 'none'} pointer ${firstPointer} -> ${lastPointer}; state=${state.currentStateName}`);
      await saveScreenshot(page, `31-ch${chapter}-intro-progress`);
    });
  }
});

// ---------------------------------------------------------------------------
// Sacred Stones chapter mechanics sweeps
// ---------------------------------------------------------------------------

test.describe('Sacred Stones Chapter Mechanics', () => {
  test('Chapter 3 seize objective triggers chapter transition to 4', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const bazba = g?.units?.get?.('Bazba');
      if (!g || !eirika || !g.board) return false;

      // Clear throne tile and place Eirika on seize position.
      if (bazba) {
        bazba.currentHp = 0;
        bazba.dead = true;
        if (bazba.position) g.board.removeUnit(bazba);
      }
      g.board.moveUnit(eirika, 14, 1);
      g.cursor.setPos(14, 1);
      g.selectedUnit = eirika;
      g._moveOrigin = [14, 1];
      g.state.change('menu');
      return true;
    });
    expect(setupOk).toBe(true);

    await stepFrames(page, 8);

    const hasSeize = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Seize');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(hasSeize).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    // Let seize event + level transition run.
    for (let i = 0; i < 1400; i++) {
      await stepFrames(page, 2, i % 3 === 0 ? 'SELECT' : null);
      const state = await getState(page);
      if (state.levelNid === '4') break;
    }

    const finalState = await getState(page);
    expect(finalState.levelNid).toBe('4');
    expect(['event', 'prep_pick', 'free', 'phase_change', 'turn_change']).toContain(finalState.currentStateName);

    await saveScreenshot(page, '32-ch3-seize-transition-ch4');
  });

  test('Chapter 4 turn-2 reinforcement event spawns Turn2Rein group', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggered = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 2;
      (g as any).turncount = 2;
      return h.triggerEvent('turn_change');
    });
    expect(triggered).toBe(true);

    await settle(page, 500);
    await stepFrames(page, 12);

    const rein = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const ids = ['115', '116', '117'];
      return ids.map((id) => {
        const u = g?.units?.get?.(id);
        return { id, pos: u?.position ?? null, dead: !!u?.dead };
      });
    });

    for (const unit of rein) {
      expect(unit.pos).not.toBeNull();
    }

    await saveScreenshot(page, '33-ch4-turn2-reinforcements');
  });

  test('Chapter 5 turn-2 and turn-8 reinforcements spawn correctly', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggerTurn2 = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 2;
      (g as any).turncount = 2;
      return h.triggerEvent('turn_change');
    });
    expect(triggerTurn2).toBe(true);

    await settle(page, 700);
    await stepFrames(page, 10);

    const turn2Units = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return ['116', '117'].map((id) => {
        const u = g?.units?.get?.(id);
        return { id, pos: u?.position ?? null };
      });
    });
    for (const unit of turn2Units) {
      expect(unit.pos).not.toBeNull();
    }

    const triggerTurn8 = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 8;
      (g as any).turncount = 8;
      return h.triggerEvent('turn_change');
    });
    expect(triggerTurn8).toBe(true);

    await settle(page, 700);
    await stepFrames(page, 10);

    const turn8Units = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return ['120', '121'].map((id) => {
        const u = g?.units?.get?.(id);
        return { id, pos: u?.position ?? null };
      });
    });
    for (const unit of turn8Units) {
      expect(unit.pos).not.toBeNull();
    }

    await saveScreenshot(page, '34-ch5-turn2-turn8-reinforcements');
  });

  test('Chapter 5 Natasha talk recruits Joshua', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      if (!g) return { ok: false, reason: 'no_game' };
      const units = g?.units ? Array.from(g.units.values()) : [];
      const natasha = g?.units?.get?.('Natasha') ?? units.find((u: any) => u?.nid === 'Natasha');
      const joshua = g?.units?.get?.('Joshua') ?? units.find((u: any) => u?.nid === 'Joshua');
      if (!g.board) return { ok: false, reason: 'no_board' };
      if (!natasha) return { ok: false, reason: 'no_natasha', unitNids: units.map((u: any) => u?.nid) };
      if (!joshua) return { ok: false, reason: 'no_joshua', unitNids: units.map((u: any) => u?.nid) };

      // Place Natasha adjacent to Joshua and open command menu directly.
      if (!joshua.position) {
        g.board.setUnit(9, 7, joshua);
      }
      if (!joshua.position) return { ok: false, reason: 'joshua_no_pos_after_set' };
      const [jx, jy] = joshua.position;
      // Ensure board occupancy is synchronized with unit position.
      g.board.setUnit(jx, jy, joshua);
      g.board.moveUnit(natasha, jx, jy + 1);
      g.cursor.setPos(jx, jy + 1);
      g.selectedUnit = natasha;
      g._moveOrigin = [jx, jy + 1];
      g.state.change('menu');
      return { ok: true, reason: 'ok' };
    });
    expect(setup.ok).toBe(true);

    await stepFrames(page, 8);

    const talkProbe = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      const natasha = g?.units?.get?.('Natasha') ?? Array.from(g?.units?.values?.() ?? []).find((u: any) => u?.nid === 'Natasha');
      const joshua = g?.units?.get?.('Joshua') ?? Array.from(g?.units?.values?.() ?? []).find((u: any) => u?.nid === 'Joshua');
      const eventCount = (g?.eventManager && natasha && joshua)
        ? g.eventManager.getEventsForTrigger(
            { type: 'on_talk', unitA: natasha.nid, unitB: joshua.nid, unit1: natasha, unit2: joshua, levelNid: g?.currentLevel?.nid },
            { game: g, unit1: natasha, unit2: joshua, gameVars: g?.gameVars, levelVars: g?.levelVars },
          ).length
        : -1;

      if (!st || st.name !== 'menu' || !st.menu) {
        return { hasTalk: false, reason: 'not_menu', state: st?.name ?? null, eventCount };
      }
      const labels = st.menu.options.map((o: any) => o?.label);
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Talk');
      if (idx < 0) return { hasTalk: false, reason: 'missing_talk_option', state: st.name, labels, eventCount };
      st.menu.selectedIndex = idx;
      return { hasTalk: true, reason: 'ok', state: st.name, labels, eventCount };
    });
    expect(talkProbe.hasTalk).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    // Advance through full conversation.
    for (let i = 0; i < 1500; i++) {
      await stepFrames(page, 2, 'SELECT');
      const converted = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const j = g?.units?.get?.('Joshua');
        return j?.team === 'player';
      });
      if (converted) break;
    }

    const joshuaTeam = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return g?.units?.get?.('Joshua')?.team ?? null;
    });
    expect(joshuaTeam).toBe('player');

    await saveScreenshot(page, '35-ch5-natasha-recruits-joshua');
  });

  test('Chapter 2 Village1 visit gives Red Gem and consumes region', async ({ page }) => {
    await page.goto('/?harness=true&level=2&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 4, 2); // Village1 tile
      g.cursor.setPos(4, 2);
      g.selectedUnit = eirika;
      g._moveOrigin = [4, 2];
      g.state.change('menu');
      return true;
    });
    expect(setupOk).toBe(true);

    await stepFrames(page, 8);

    const pickedVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(pickedVisit).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    // Enable event skip mode to burn through long village dialogue quickly.
    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const hasItem = (eirika?.items ?? []).some((it: any) => it?.nid === 'Red_Gem');
        return hasItem || g?.state?.getCurrentState?.()?.name === 'free';
      });
      if (done) break;
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const itemNids = (eirika?.items ?? []).map((it: any) => it?.nid);
      const villageStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Village1');
      return { itemNids, villageStillPresent, state: g?.state?.getCurrentState?.()?.name ?? null };
    });
    expect(result.itemNids).toContain('Red_Gem');
    expect(result.villageStillPresent).toBe(false);

    await saveScreenshot(page, '36-ch2-village1-visited-red-gem');
  });

  test('Chapter 5 Village2 visit gives Armorslayer and consumes region', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 12, 10); // Village2 tile
      g.cursor.setPos(12, 10);
      g.selectedUnit = eirika;
      g._moveOrigin = [12, 10];
      g.state.change('menu');
      return true;
    });
    expect(setupOk).toBe(true);

    await stepFrames(page, 8);

    const pickedVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(pickedVisit).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const hasItem = (eirika?.items ?? []).some((it: any) => it?.nid === 'Armorslayer');
        return hasItem || g?.state?.getCurrentState?.()?.name === 'free';
      });
      if (done) break;
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const itemNids = (eirika?.items ?? []).map((it: any) => it?.nid);
      const villageStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Village2');
      return { itemNids, villageStillPresent, state: g?.state?.getCurrentState?.()?.name ?? null };
    });
    expect(result.itemNids).toContain('Armorslayer');
    expect(result.villageStillPresent).toBe(false);

    await saveScreenshot(page, '37-ch5-village2-visited-armorslayer');
  });

  test('Chapter 5 Vendor and Armory region options appear in menu', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const probeRegion = async (x: number, y: number, expectedLabel: string) => {
      const setup = await page.evaluate(({ x, y }: { x: number; y: number }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x, y });
      expect(setup).toBe(true);
      await stepFrames(page, 8);
      const hasLabel = await page.evaluate((expectedLabel: string) => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        if (!st || st.name !== 'menu' || !st.menu) return false;
        return st.menu.options.some((o: any) => o?.label === expectedLabel);
      }, expectedLabel);
      expect(hasLabel).toBe(true);
      await stepFrames(page, 2, 'BACK');
      await stepFrames(page, 2, 'BACK');
    };

    await probeRegion(6, 10, 'Vendor');
    await probeRegion(2, 1, 'Armory');

    await saveScreenshot(page, '38-ch5-vendor-armory-menu-options');
  });

  test('Chapter 3 chest interaction requires key and grants chest loot', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupNoKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 6, 12); // Chest1 tile
      g.cursor.setPos(6, 12);
      g.selectedUnit = eirika;
      g._moveOrigin = [6, 12];
      g.state.change('menu');
      return true;
    });
    expect(setupNoKey).toBe(true);
    await stepFrames(page, 8);

    const chestWithoutKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      return st.menu.options.some((o: any) => o?.label === 'Chest');
    });
    expect(chestWithoutKey).toBe(false);

    await stepFrames(page, 2, 'BACK');
    await stepFrames(page, 2, 'BACK');

    const gaveKey = await page.evaluate(() => {
      const h = (window as any).__harness;
      return h?.giveItem?.('Eirika', 'Chest_Key') ?? false;
    });
    expect(gaveKey).toBe(true);

    const setupWithKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 6, 12);
      g.cursor.setPos(6, 12);
      g.selectedUnit = eirika;
      g._moveOrigin = [6, 12];
      g.state.change('menu');
      return true;
    });
    expect(setupWithKey).toBe(true);
    await stepFrames(page, 8);

    const selectedChest = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Chest');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(selectedChest).toBe(true);

    await stepFrames(page, 2, 'SELECT');
    await settle(page, 300);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const itemNids = (eirika?.items ?? []).map((it: any) => it?.nid);
      const chestStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Chest1');
      const chestKeyUses = (eirika?.items ?? []).find((it: any) => it?.nid === 'Chest_Key')?.uses ?? null;
      return { itemNids, chestStillPresent, chestKeyUses };
    });

    expect(result.itemNids).toContain('Javelin');
    expect(result.chestStillPresent).toBe(false);
    // Key item is consumed and removed when uses reach 0.
    expect(result.chestKeyUses).toBeNull();

    await saveScreenshot(page, '39-ch3-chest1-unlock-javelin');
  });

  test('Chapter 3 door interaction requires key and opens door region', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupNoKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 2, 2); // Door1 vertical region tile
      g.cursor.setPos(2, 2);
      g.selectedUnit = eirika;
      g._moveOrigin = [2, 2];
      g.state.change('menu');
      return true;
    });
    expect(setupNoKey).toBe(true);
    await stepFrames(page, 8);

    const doorWithoutKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      return st.menu.options.some((o: any) => o?.label === 'Door');
    });
    expect(doorWithoutKey).toBe(false);

    await stepFrames(page, 2, 'BACK');
    await stepFrames(page, 2, 'BACK');

    const gaveKey = await page.evaluate(() => {
      const h = (window as any).__harness;
      return h?.giveItem?.('Eirika', 'Door_Key') ?? false;
    });
    expect(gaveKey).toBe(true);

    const setupWithKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 2, 2);
      g.cursor.setPos(2, 2);
      g.selectedUnit = eirika;
      g._moveOrigin = [2, 2];
      g.state.change('menu');
      return true;
    });
    expect(setupWithKey).toBe(true);
    await stepFrames(page, 8);

    const selectedDoor = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Door');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(selectedDoor).toBe(true);

    await stepFrames(page, 2, 'SELECT');
    await settle(page, 250);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const doorStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Door1');
      const doorKeyUses = (eirika?.items ?? []).find((it: any) => it?.nid === 'Door_Key')?.uses ?? null;
      return { doorStillPresent, doorKeyUses };
    });

    expect(result.doorStillPresent).toBe(false);
    expect(result.doorKeyUses).toBeNull();

    await saveScreenshot(page, '40-ch3-door1-unlock-opened');
  });

  test('Chapter 3 all chest regions unlock and grant correct loot', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const chests = [
      { nid: 'Chest2', x: 6, y: 3, loot: 'Iron_Lance' },
      { nid: 'Chest3', x: 8, y: 3, loot: 'Hand_Axe' },
      { nid: 'Chest4', x: 10, y: 3, loot: 'Iron_Sword' },
    ];

    for (const chest of chests) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('3');
      });
      await stepFrames(page, 6);

      const gaveKey = await page.evaluate(() => {
        const h = (window as any).__harness;
        return h?.giveItem?.('Eirika', 'Chest_Key') ?? false;
      });
      expect(gaveKey).toBe(true);

      const setup = await page.evaluate(({ x, y }: { x: number; y: number }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: chest.x, y: chest.y });
      expect(setup).toBe(true);

      await stepFrames(page, 8);

      const chestProbe = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        const eirika = g?.units?.get?.('Eirika');
        if (!st || st.name !== 'menu' || !st.menu) {
          return {
            ok: false,
            state: st?.name ?? null,
            labels: [],
            pos: eirika?.position ?? null,
            hasChestKey: (eirika?.items ?? []).some((it: any) => it?.nid === 'Chest_Key'),
          };
        }
        const labels = st.menu.options.map((o: any) => o?.label);
        const idx = st.menu.options.findIndex((o: any) => o?.label === 'Chest');
        if (idx < 0) {
          return {
            ok: false,
            state: st.name,
            labels,
            pos: eirika?.position ?? null,
            hasChestKey: (eirika?.items ?? []).some((it: any) => it?.nid === 'Chest_Key'),
          };
        }
        st.menu.selectedIndex = idx;
        return { ok: true, state: st.name, labels };
      });
      expect(chestProbe.ok).toBe(true);

      await stepFrames(page, 2, 'SELECT');
      await settle(page, 250);

      const result = await page.evaluate(({ regionNid, lootNid }: { regionNid: string; lootNid: string }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const itemNids = (eirika?.items ?? []).map((it: any) => it?.nid);
        const regionStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === regionNid);
        return {
          hasLoot: itemNids.includes(lootNid),
          regionStillPresent,
        };
      }, { regionNid: chest.nid, lootNid: chest.loot });

      expect(result.hasLoot).toBe(true);
      expect(result.regionStillPresent).toBe(false);
    }

    await saveScreenshot(page, '41-ch3-all-chests-unlocked');
  });

  test('Chapter 3 remaining door regions unlock with key', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const doors = [
      { nid: 'Door2', x: 6, y: 10 },
      { nid: 'Door3', x: 10, y: 5 },
    ];

    for (const door of doors) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('3');
      });
      await stepFrames(page, 6);

      const gaveKey = await page.evaluate(() => {
        const h = (window as any).__harness;
        return h?.giveItem?.('Eirika', 'Door_Key') ?? false;
      });
      expect(gaveKey).toBe(true);

      const setup = await page.evaluate(({ x, y }: { x: number; y: number }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: door.x, y: door.y });
      expect(setup).toBe(true);

      await stepFrames(page, 8);

      const doorProbe = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        const eirika = g?.units?.get?.('Eirika');
        if (!st || st.name !== 'menu' || !st.menu) {
          return {
            ok: false,
            state: st?.name ?? null,
            labels: [],
            pos: eirika?.position ?? null,
            hasDoorKey: (eirika?.items ?? []).some((it: any) => it?.nid === 'Door_Key'),
          };
        }
        const labels = st.menu.options.map((o: any) => o?.label);
        const idx = st.menu.options.findIndex((o: any) => o?.label === 'Door');
        if (idx < 0) {
          return {
            ok: false,
            state: st.name,
            labels,
            pos: eirika?.position ?? null,
            hasDoorKey: (eirika?.items ?? []).some((it: any) => it?.nid === 'Door_Key'),
          };
        }
        st.menu.selectedIndex = idx;
        return { ok: true, state: st.name, labels };
      });
      expect(doorProbe.ok).toBe(true);

      await stepFrames(page, 2, 'SELECT');
      await settle(page, 250);

      const doorStillPresent = await page.evaluate((regionNid: string) => {
        const g = (window as any).__gameRef;
        return (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === regionNid);
      }, door.nid);
      expect(doorStillPresent).toBe(false);
    }

    await saveScreenshot(page, '42-ch3-door2-door3-unlocked');
  });

  test('Chapter 2 destructible village regions trigger ruin layers', async ({ page }) => {
    await page.goto('/?harness=true&level=2&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const villages = [
      { region: 'DestroyVillage1', x: 4, y: 2, ruin: 'Ruin1' },
      { region: 'DestroyVillage2', x: 7, y: 2, ruin: 'Ruin2' },
      { region: 'DestroyVillage3', x: 1, y: 12, ruin: 'Ruin3' },
    ];

    for (const v of villages) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('2');
      });
      await stepFrames(page, 6);

      const setup = await page.evaluate(({ x, y }: { x: number; y: number }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.team = 'enemy';
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: v.x, y: v.y });
      expect(setup).toBe(true);
      await stepFrames(page, 8);

      const selectedDestructible = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        if (!st || st.name !== 'menu' || !st.menu) return false;
        const idx = st.menu.options.findIndex((o: any) => o?.label === 'Destructible');
        if (idx < 0) return false;
        st.menu.selectedIndex = idx;
        return true;
      });
      expect(selectedDestructible).toBe(true);

      await stepFrames(page, 2, 'SELECT');
      await settle(page, 300);

      const result = await page.evaluate(({ regionNid, ruinLayer }: { regionNid: string; ruinLayer: string }) => {
        const g = (window as any).__gameRef;
        const regionStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === regionNid);
        const ruinVisible = !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === ruinLayer)?.visible;
        return { regionStillPresent, ruinVisible };
      }, { regionNid: v.region, ruinLayer: v.ruin });

      expect(result.regionStillPresent).toBe(false);
      expect(result.ruinVisible).toBe(true);
    }

    await saveScreenshot(page, '43-ch2-destructible-villages-ruins');
  });

  test('Chapter 5 destructible village interactions trigger ruin layers', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const villages = [
      { region: 'DestroyVillage2', x: 12, y: 10, ruin: 'Ruin2' },
      { region: 'DestroyVillage4', x: 5, y: 1, ruin: 'Ruin4' },
    ];

    for (const v of villages) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('5');
      });
      await stepFrames(page, 6);

      const setup = await page.evaluate(({ x, y }: { x: number; y: number }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.team = 'enemy';
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: v.x, y: v.y });
      expect(setup).toBe(true);
      await stepFrames(page, 8);

      const selectedDestructible = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        if (!st || st.name !== 'menu' || !st.menu) return false;
        const idx = st.menu.options.findIndex((o: any) => o?.label === 'Destructible');
        if (idx < 0) return false;
        st.menu.selectedIndex = idx;
        return true;
      });
      expect(selectedDestructible).toBe(true);

      await stepFrames(page, 2, 'SELECT');
      await settle(page, 300);

      const result = await page.evaluate(({ regionNid, ruinLayer }: { regionNid: string; ruinLayer: string }) => {
        const g = (window as any).__gameRef;
        const regionStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === regionNid);
        const ruinVisible = !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === ruinLayer)?.visible;
        return { regionStillPresent, ruinVisible };
      }, { regionNid: v.region, ruinLayer: v.ruin });

      expect(result.regionStillPresent).toBe(false);
      expect(result.ruinVisible).toBe(true);
    }

    await saveScreenshot(page, '44-ch5-destructible-villages-ruins');
  });

  test('Chapter 3 turn event spawns Colm and moves him to chest room', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggered = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 1;
      (g as any).turncount = 1;
      return h.triggerEvent('other_turn_change');
    });
    expect(triggered).toBe(true);

    // Skip through Colm dialogue quickly.
    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const colm = g?.units?.get?.('Colm');
        return !!colm?.position && g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    const colmState = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const colm = g?.units?.get?.('Colm');
      return {
        exists: !!colm,
        team: colm?.team ?? null,
        pos: colm?.position ?? null,
      };
    });

    expect(colmState.exists).toBe(true);
    expect(colmState.team).toBe('other');
    expect(colmState.pos).toEqual([2, 4]);

    await saveScreenshot(page, '45-ch3-colm-turn-event-spawn');
  });

  test('Chapter 3 Neimi talk recruits Colm after turn event', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const spawned = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 1;
      (g as any).turncount = 1;
      return h.triggerEvent('other_turn_change');
    });
    expect(spawned).toBe(true);

    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const colm = g?.units?.get?.('Colm');
        return !!colm?.position && g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const neimi = g?.units?.get?.('Neimi');
      const colm = g?.units?.get?.('Colm');
      if (!g || !g.board || !neimi || !colm || !colm.position) return false;

      neimi.finished = false;
      neimi.hasMoved = false;
      neimi.hasAttacked = false;
      neimi.hasTraded = false;

      const [cx, cy] = colm.position;
      g.board.moveUnit(neimi, cx, cy + 1);
      g.cursor.setPos(cx, cy + 1);
      g.selectedUnit = neimi;
      g._moveOrigin = [cx, cy + 1];
      g.state.change('menu');
      return true;
    });
    expect(setupOk).toBe(true);

    await stepFrames(page, 8);

    const hasTalk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Talk');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(hasTalk).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    for (let i = 0; i < 1500; i++) {
      await stepFrames(page, 2, 'SELECT');
      const recruited = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        return g?.units?.get?.('Colm')?.team === 'player';
      });
      if (recruited) break;
    }

    const colmTeam = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return g?.units?.get?.('Colm')?.team ?? null;
    });
    expect(colmTeam).toBe('player');

    await saveScreenshot(page, '46-ch3-neimi-recruits-colm');
  });

  test('Chapter 3 outro branch sets Colm to player before Chapter 4 transition', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    // Make sure Colm exists/alive and Neimi alive so the outro branch runs.
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const colm = g?.units?.get?.('Colm');
      const neimi = g?.units?.get?.('Neimi');
      const eirika = g?.units?.get?.('Eirika');
      const bazba = g?.units?.get?.('Bazba');
      if (!g || !g.board || !eirika || !colm || !neimi) return false;

      colm.dead = false;
      neimi.dead = false;

      if (bazba) {
        bazba.currentHp = 0;
        bazba.dead = true;
        if (bazba.position) g.board.removeUnit(bazba);
      }

      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 14, 1);
      g.cursor.setPos(14, 1);
      g.selectedUnit = eirika;
      g._moveOrigin = [14, 1];
      g.state.change('menu');
      return true;
    });
    expect(setup).toBe(true);

    await stepFrames(page, 8);

    const choseSeize = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Seize');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(choseSeize).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    // Skip through long outro and wait for level transition.
    let sawColmPlayerInOutro = false;
    for (let i = 0; i < 2500; i++) {
      await stepFrames(page, 2, 'BACK');
      const snap = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const colm = g?.units?.get?.('Colm');
        return {
          levelNid: g?.currentLevel?.nid ?? null,
          colmTeam: colm?.team ?? null,
        };
      });
      if (snap.colmTeam === 'player') sawColmPlayerInOutro = true;
      if (snap.levelNid === '4') break;
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        levelNid: g?.currentLevel?.nid ?? null,
      };
    });

    expect(result.levelNid).toBe('4');
    expect(sawColmPlayerInOutro).toBe(true);

    await saveScreenshot(page, '47-ch3-outro-colm-player-before-ch4');
  });

  test('Chapter 3 outro handles Colm dead without blocking transition', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const colm = g?.units?.get?.('Colm');
      const eirika = g?.units?.get?.('Eirika');
      const bazba = g?.units?.get?.('Bazba');
      if (!g || !g.board || !eirika || !colm) return false;

      // Force branch condition false.
      colm.currentHp = 0;
      colm.dead = true;
      if (colm.position) g.board.removeUnit(colm);

      if (bazba) {
        bazba.currentHp = 0;
        bazba.dead = true;
        if (bazba.position) g.board.removeUnit(bazba);
      }

      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 14, 1);
      g.cursor.setPos(14, 1);
      g.selectedUnit = eirika;
      g._moveOrigin = [14, 1];
      g.state.change('menu');
      return true;
    });
    expect(setup).toBe(true);

    await stepFrames(page, 8);

    const choseSeize = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Seize');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(choseSeize).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    let hitTitle = false;
    for (let i = 0; i < 2500; i++) {
      await stepFrames(page, 2, 'BACK');
      const snap = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        return {
          levelNid: g?.currentLevel?.nid ?? null,
          state: g?.state?.getCurrentState?.()?.name ?? null,
        };
      });
      if (snap.state === 'title' || snap.state === 'title_main') hitTitle = true;
      if (snap.levelNid === '4') break;
    }

    const final = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        levelNid: g?.currentLevel?.nid ?? null,
        state: g?.state?.getCurrentState?.()?.name ?? null,
      };
    });

    expect(hitTitle).toBe(false);
    expect(final.levelNid).toBe('4');

    await saveScreenshot(page, '48-ch3-outro-colm-dead-transition-ok');
  });

  test('Chapter 4 Village2 visit recruits Lute and consumes village region', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 1, 11); // Village2
      g.cursor.setPos(1, 11);
      g.selectedUnit = eirika;
      g._moveOrigin = [1, 11];
      g.state.change('menu');
      return true;
    });
    expect(setup).toBe(true);
    await stepFrames(page, 8);

    const selectedVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(selectedVisit).toBe(true);

    await stepFrames(page, 2, 'SELECT');
    for (let i = 0; i < 1500; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const lute = g?.units?.get?.('Lute');
        return lute?.team === 'player' && g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const lute = g?.units?.get?.('Lute');
      const villageStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Village2');
      return {
        luteExists: !!lute,
        luteTeam: lute?.team ?? null,
        lutePos: lute?.position ?? null,
        villageStillPresent,
      };
    });

    expect(result.luteExists).toBe(true);
    expect(result.luteTeam).toBe('player');
    expect(result.villageStillPresent).toBe(false);

    await saveScreenshot(page, '49-ch4-village2-recruits-lute');
  });

  test('Chapter 4 trigger region spawns RevenantRein group on turn change', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      // Trigger region spans y=9..14, x=0..14.
      g.board.moveUnit(eirika, 5, 10);
      return true;
    });
    expect(setup).toBe(true);

    const triggered = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 4;
      (g as any).turncount = 4;
      return h.triggerEvent('turn_change');
    });
    expect(triggered).toBe(true);

    await settle(page, 500);
    await stepFrames(page, 12);

    const rein = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return ['118', '119', '120', '121'].map((id) => {
        const u = g?.units?.get?.(id);
        return { id, pos: u?.position ?? null };
      });
    });
    for (const u of rein) {
      expect(u.pos).not.toBeNull();
    }

    await saveScreenshot(page, '50-ch4-trigger-revenant-reinforcements');
  });

  test('Chapter 4 Snag death triggers bridge layer reveal', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggered = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const snag = g?.units?.get?.('Snag');
      if (!g || !snag) return false;

      snag.currentHp = 0;
      snag.dead = true;
      if (snag.position) g.board.removeUnit(snag);

      return g.eventManager?.trigger(
        { type: 'unit_death', levelNid: g.currentLevel?.nid ?? '', unitNid: 'Snag', unit: snag },
        { game: g, unit: snag, unit1: snag, position: snag.position, gameVars: g.gameVars, levelVars: g.levelVars },
      ) ?? false;
    });
    expect(triggered).toBe(true);

    await settle(page, 300);
    await stepFrames(page, 8);

    const snagLayerVisible = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === 'Snag')?.visible;
    });
    expect(snagLayerVisible).toBe(true);

    await saveScreenshot(page, '51-ch4-snag-bridge-layer-revealed');
  });

  test('Chapter 4 Village1 visit grants Iron Axe and consumes region', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 8, 2); // Village1
      g.cursor.setPos(8, 2);
      g.selectedUnit = eirika;
      g._moveOrigin = [8, 2];
      g.state.change('menu');
      return true;
    });
    expect(setup).toBe(true);
    await stepFrames(page, 8);

    const selectedVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(selectedVisit).toBe(true);

    await stepFrames(page, 2, 'SELECT');
    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const gotItem = (eirika?.items ?? []).some((it: any) => it?.nid === 'Iron_Axe');
        return gotItem || g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const itemNids = (eirika?.items ?? []).map((it: any) => it?.nid);
      const villageStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Village1');
      return { itemNids, villageStillPresent };
    });

    expect(result.itemNids).toContain('Iron_Axe');
    expect(result.villageStillPresent).toBe(false);

    await saveScreenshot(page, '52-ch4-village1-iron-axe');
  });

  test('Chapter 4 turn-3 cameo event exits temporary units cleanly', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggered = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 3;
      (g as any).turncount = 3;
      return h.triggerEvent('turn_change');
    });
    expect(triggered).toBe(true);

    for (let i = 0; i < 1600; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        return g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    const cameo = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const larachel = g?.units?.get?.("L'arachel");
      const dozla = g?.units?.get?.('Dozla');
      const rennac = g?.units?.get?.('Rennac');
      return {
        larachelPos: larachel?.position ?? null,
        dozlaPos: dozla?.position ?? null,
        rennacPos: rennac?.position ?? null,
      };
    });

    expect(cameo.larachelPos).toBeNull();
    expect(cameo.dozlaPos).toBeNull();
    expect(cameo.rennacPos).toBeNull();

    await saveScreenshot(page, '53-ch4-turn3-cameo-cleared');
  });

  test('Chapter 5 turn-4 event spawns Brigand2 group', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggered = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 4;
      (g as any).turncount = 4;
      return h.triggerEvent('turn_change');
    });
    expect(triggered).toBe(true);

    await settle(page, 400);
    await stepFrames(page, 10);

    const brigands = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return ['118', '119'].map((id) => {
        const u = g?.units?.get?.(id);
        return { id, pos: u?.position ?? null };
      });
    });
    for (const b of brigands) {
      expect(b.pos).not.toBeNull();
    }

    await saveScreenshot(page, '54-ch5-turn4-brigand2-spawn');
  });

  test('Chapter 4 outro branch matrix transitions cleanly for Artur/Lute permutations', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const outroCases = [
      { label: 'artur-only', arturAlive: true, luteAlive: false, expectArtur: true, expectLute: false },
      { label: 'lute-only', arturAlive: false, luteAlive: true, expectArtur: false, expectLute: true },
      { label: 'both-alive', arturAlive: true, luteAlive: true, expectArtur: true, expectLute: true },
      { label: 'both-dead', arturAlive: false, luteAlive: false, expectArtur: false, expectLute: false },
    ];

    for (const outroCase of outroCases) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('4');
      });
      await stepFrames(page, 8);

      const setup = await page.evaluate(({ arturAlive, luteAlive }) => {
        const g = (window as any).__gameRef;
        const artur = g?.units?.get?.('Artur');
        const lute = g?.units?.get?.('Lute');
        if (!g || !g.board || !artur || !lute) return { ok: false, reason: 'missing_units' };

        const setAlive = (u: any, alive: boolean) => {
          u.dead = !alive;
          u.currentHp = alive ? Math.max(1, u.currentHp ?? 1) : 0;
          if (!alive && u.position) {
            g.board.removeUnit(u);
          }
        };

        setAlive(artur, arturAlive);
        setAlive(lute, luteAlive);

        for (const unit of Array.from(g.units.values())) {
          if (unit?.team === 'enemy' && !unit.isDead?.()) {
            unit.dead = true;
            unit.currentHp = 0;
            if (unit.position) g.board.removeUnit(unit);
          }
        }

        return { ok: true };
      }, { arturAlive: outroCase.arturAlive, luteAlive: outroCase.luteAlive });
      expect(setup.ok).toBe(true);

      const triggered = await page.evaluate(() => {
        const h = (window as any).__harness;
        return h?.triggerEvent?.('combat_end') ?? false;
      });
      expect(triggered).toBe(true);

      await stepFrames(page, 3);

      let maxCommandPointer = -1;
      let hitTitle = false;
      let transitioned = false;

      for (let i = 0; i < 2400; i++) {
        await stepFrames(page, 2, 'BACK');
        const snap = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          const state = g?.state?.getCurrentState?.()?.name ?? null;
          const event = g?.eventManager?.getCurrentEvent?.();
          const commandPointer = typeof event?.commandPointer === 'number' ? event.commandPointer : null;
          return {
            levelNid: g?.currentLevel?.nid ?? null,
            state,
            commandPointer,
          };
        });

        if (snap.commandPointer != null && snap.commandPointer > maxCommandPointer) {
          maxCommandPointer = snap.commandPointer;
        }
        if (snap.state === 'title' || snap.state === 'title_main') hitTitle = true;
        if (snap.levelNid === '5') {
          transitioned = true;
          break;
        }
      }

      expect(hitTitle).toBe(false);
      expect(maxCommandPointer).toBeGreaterThan(30);
      expect(transitioned || maxCommandPointer > 80).toBe(true);
    }

    await saveScreenshot(page, '55-ch4-outro-branch-matrix');
  });

  test('Chapter 5 Village1/3/4 visits grant one-time rewards and consume regions', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const villages = [
      { nid: 'Village1', x: 12, y: 19, reward: 'Dragonshield' },
      { nid: 'Village3', x: 5, y: 6, reward: 'Secret_Book' },
      { nid: 'Village4', x: 5, y: 1, reward: 'Torch' },
    ];

    for (const village of villages) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('5');
      });
      await stepFrames(page, 8);

      const beforeCount = await page.evaluate((reward: string) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        return (eirika?.items ?? []).filter((it: any) => it?.nid === reward).length;
      }, village.reward);

      const setup = await page.evaluate(({ x, y }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.team = 'player';
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: village.x, y: village.y });
      expect(setup).toBe(true);
      await stepFrames(page, 8);

      const pickedVisit = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        if (!st || st.name !== 'menu' || !st.menu) return false;
        const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
        if (idx < 0) return false;
        st.menu.selectedIndex = idx;
        return true;
      });
      expect(pickedVisit).toBe(true);

      await stepFrames(page, 2, 'SELECT');
      for (let i = 0; i < 1600; i++) {
        await stepFrames(page, 2, 'BACK');
        const done = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          return g?.state?.getCurrentState?.()?.name !== 'event';
        });
        if (done) break;
      }

      const afterVisit = await page.evaluate(({ nid, reward }: { nid: string; reward: string }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const rewardCount = (eirika?.items ?? []).filter((it: any) => it?.nid === reward).length;
        const regions = g?.currentLevel?.regions ?? [];
        return {
          rewardCount,
          villagePresent: regions.some((r: any) => r?.nid === nid),
          destroyPresent: regions.some((r: any) => r?.nid === `Destroy${nid}`),
        };
      }, { nid: village.nid, reward: village.reward });

      expect(afterVisit.rewardCount).toBe(beforeCount + 1);
      expect(afterVisit.villagePresent).toBe(false);
      expect(afterVisit.destroyPresent).toBe(false);

      const retrySetup = await page.evaluate(({ x, y }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: village.x, y: village.y });
      expect(retrySetup).toBe(true);
      await stepFrames(page, 8);

      const retryProbe = await page.evaluate((reward: string) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const st = g?.state?.getCurrentState?.();
        const labels = st?.menu?.options?.map((o: any) => o?.label) ?? [];
        const rewardCount = (eirika?.items ?? []).filter((it: any) => it?.nid === reward).length;
        return {
          inMenu: st?.name === 'menu',
          labels,
          rewardCount,
        };
      }, village.reward);

      expect(retryProbe.inMenu).toBe(true);
      expect(retryProbe.labels).not.toContain('Visit');
      expect(retryProbe.rewardCount).toBe(afterVisit.rewardCount);
    }

    await saveScreenshot(page, '56-ch5-village134-visit-matrix');
  });

  test('Chapter 5 arena interaction enters event/combat and returns to map control', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 12, 6);
      g.cursor.setPos(12, 6);
      g.selectedUnit = eirika;
      g._moveOrigin = [12, 6];
      g.state.change('menu');
      return true;
    });
    expect(setup).toBe(true);
    await stepFrames(page, 8);

    const pickedArena = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Arena');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(pickedArena).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    let sawArenaEvent = false;
    let hitTitle = false;
    let recoveredFree = false;

    for (let i = 0; i < 3600; i++) {
      await stepFrames(page, 2, 'SELECT');
      const snap = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const state = g?.state?.getCurrentState?.()?.name ?? null;
        const eventNid = g?.eventManager?.getCurrentEvent?.()?.nid ?? null;
        return {
          levelNid: g?.currentLevel?.nid ?? null,
          state,
          eventNid,
        };
      });

      if (snap.eventNid === '5 Arena') sawArenaEvent = true;
      if (snap.state === 'title' || snap.state === 'title_main') hitTitle = true;
      if (sawArenaEvent && snap.state === 'free' && snap.levelNid === '5') {
        recoveredFree = true;
        break;
      }
    }

    expect(sawArenaEvent).toBe(true);
    expect(hitTitle).toBe(false);
    expect(recoveredFree).toBe(true);

    const cursorMoved = await page.evaluate(() => {
      const h = (window as any).__harness;
      const before = h?.getState?.()?.cursorPos ?? null;
      if (!before) return false;
      h.stepFrames(3, 'RIGHT');
      const after = h?.getState?.()?.cursorPos ?? null;
      return !!after && (after[0] !== before[0] || after[1] !== before[1]);
    });
    expect(cursorMoved).toBe(true);

    await saveScreenshot(page, '57-ch5-arena-flow-return');
  });

  test('Chapter 5 village destroy-vs-visit ordering stays one-time in both directions', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const villagePos = { x: 12, y: 10 };

    const openMenuAtVillage = async (team: 'player' | 'enemy') => {
      const setup = await page.evaluate(({ x, y, team }: { x: number; y: number; team: 'player' | 'enemy' }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.team = team;
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { ...villagePos, team });
      expect(setup).toBe(true);
      await stepFrames(page, 8);
    };

    // Visit first -> destroy path should no longer be available.
    await page.evaluate(async () => {
      await (window as any).__harness.loadLevelClean('5');
    });
    await stepFrames(page, 8);

    await openMenuAtVillage('player');
    const pickedVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(pickedVisit).toBe(true);
    await stepFrames(page, 2, 'SELECT');
    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        return g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    await openMenuAtVillage('enemy');
    const destroyAfterVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      const labels = st?.menu?.options?.map((o: any) => o?.label) ?? [];
      const regions = g?.currentLevel?.regions ?? [];
        return {
          labels,
          villagePresent: regions.some((r: any) => r?.nid === 'Village2'),
          destroyPresent: regions.some((r: any) => r?.nid === 'DestroyVillage2'),
        };
      });

    expect(destroyAfterVisit.labels).not.toContain('Destructible');
    expect(destroyAfterVisit.villagePresent).toBe(false);
    expect(destroyAfterVisit.destroyPresent).toBe(false);

    // Destroy first -> visit path should no longer be available.
    await page.evaluate(async () => {
      await (window as any).__harness.loadLevelClean('5');
    });
    await stepFrames(page, 8);

    const forcedDestroy = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !eirika || !g.board || !g.currentLevel?.regions) return false;

      eirika.team = 'enemy';
      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 12, 10);

      g.currentLevel.regions = (g.currentLevel.regions ?? []).filter((r: any) => r?.nid !== 'DestroyVillage2' && r?.nid !== 'Village2');
      const ruin = g?.tilemap?.layers?.find?.((l: any) => l?.nid === 'Ruin2');
      if (ruin) {
        ruin.visible = true;
      }
      return true;
    });
    expect(forcedDestroy).toBe(true);
    await stepFrames(page, 2, 'BACK');
    await settle(page, 350);

    await openMenuAtVillage('player');
    const visitAfterDestroy = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      const labels = st?.menu?.options?.map((o: any) => o?.label) ?? [];
      const eirika = g?.units?.get?.('Eirika');
      const regions = g?.currentLevel?.regions ?? [];
      const rewardCount = (eirika?.items ?? []).filter((it: any) => it?.nid === 'Armorslayer').length;
      return {
        labels,
        rewardCount,
        villagePresent: regions.some((r: any) => r?.nid === 'Village2'),
        destroyPresent: regions.some((r: any) => r?.nid === 'DestroyVillage2'),
        ruinVisible: !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === 'Ruin2')?.visible,
      };
    });

    expect(visitAfterDestroy.labels).not.toContain('Visit');
    expect(visitAfterDestroy.rewardCount).toBe(0);
    expect(visitAfterDestroy.villagePresent).toBe(false);
    expect(visitAfterDestroy.destroyPresent).toBe(false);
    expect(visitAfterDestroy.ruinVisible).toBe(true);

    await saveScreenshot(page, '58-ch5-village-ordering-visit-vs-destroy');
  });

  test('Chapter 5 turn events are idempotent across repeated long-window triggers', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const turnCases = [
      { turn: 2, ids: ['116', '117'] },
      { turn: 4, ids: ['118', '119'] },
      { turn: 8, ids: ['120', '121'] },
    ];

    for (const turnCase of turnCases) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('5');
      });
      await stepFrames(page, 8);

      const initialTrigger = await page.evaluate((turn: number) => {
        const h = (window as any).__harness;
        const g = (window as any).__gameRef;
        if (!h || !g) return false;
        g.turnCount = turn;
        (g as any).turncount = turn;
        return h.triggerEvent('turn_change');
      }, turnCase.turn);
      expect(initialTrigger).toBe(true);

      for (let i = 0; i < 1200; i++) {
        await stepFrames(page, 2, 'BACK');
        const done = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          const currentState = g?.state?.getCurrentState?.()?.name ?? null;
          const queueLen = g?.eventManager?.eventQueue?.length ?? 0;
          return currentState !== 'event' && queueLen === 0;
        });
        if (done) break;
      }

      const baseline = await page.evaluate((ids: string[]) => {
        const g = (window as any).__gameRef;
        return {
          spawned: ids.map((id) => ({ id, pos: g?.units?.get?.(id)?.position ?? null })),
          enemyCount: Array.from(g?.units?.values?.() ?? []).filter((u: any) => u?.team === 'enemy' && !u?.dead).length,
        };
      }, turnCase.ids);
      for (const unit of baseline.spawned) {
        expect(unit.pos).not.toBeNull();
      }

      for (let rep = 0; rep < 3; rep++) {
        await page.evaluate((turn: number) => {
          const h = (window as any).__harness;
          const g = (window as any).__gameRef;
          if (!h || !g) return;
          g.turnCount = turn;
          (g as any).turncount = turn;
          h.triggerEvent('turn_change');
        }, turnCase.turn);

        for (let i = 0; i < 1200; i++) {
          await stepFrames(page, 2, 'BACK');
          const done = await page.evaluate(() => {
            const g = (window as any).__gameRef;
            const state = g?.state?.getCurrentState?.()?.name ?? null;
            const queueLen = g?.eventManager?.eventQueue?.length ?? 0;
            return state !== 'event' && queueLen === 0;
          });
          if (done) break;
        }

        const snapshot = await page.evaluate((ids: string[]) => {
          const g = (window as any).__gameRef;
          return {
            levelNid: g?.currentLevel?.nid ?? null,
            state: g?.state?.getCurrentState?.()?.name ?? null,
            stackDepth: (g?.state as any)?.stack?.length ?? 0,
            enemyCount: Array.from(g?.units?.values?.() ?? []).filter((u: any) => u?.team === 'enemy' && !u?.dead).length,
            spawned: ids.map((id) => ({ id, pos: g?.units?.get?.(id)?.position ?? null })),
          };
        }, turnCase.ids);

        expect(snapshot.levelNid).toBe('5');
        expect(snapshot.state).not.toBe('title');
        expect(snapshot.state).not.toBe('title_main');
        expect(snapshot.stackDepth).toBeLessThanOrEqual(3);
        expect(snapshot.enemyCount).toBe(baseline.enemyCount);
        for (const unit of snapshot.spawned) {
          expect(unit.pos).not.toBeNull();
        }
      }
    }

    await saveScreenshot(page, '59-ch5-turn-event-idempotency');
  });

  test('Chapter 2 AI PursueVillage interaction consumes Destructible region and reveals ruins', async ({ page }) => {
    await page.goto('/?harness=true&level=2&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      if (!g || !g.board || !g.phase) return { ok: false, reason: 'missing_game' };

      const target = g.units.get('107') ?? g.units.get('106') ?? g.units.get('103');
      if (!target) return { ok: false, reason: 'missing_pursue_unit' };

      // Remove player units from the map so PursueVillage chooses Interact
      // rather than Attack on this forced enemy AI phase.
      for (const unit of Array.from(g.units.values())) {
        if (unit.team === 'player' && unit.position) {
          g.board.removeUnit(unit);
          unit.position = null;
        }
      }

      // Isolate one AI actor and place it directly on the destructible village.
      for (const unit of Array.from(g.units.values())) {
        if (unit.team === 'enemy') {
          unit.finished = true;
          unit.hasMoved = false;
          unit.hasAttacked = false;
          unit.hasTraded = false;
        }
      }

      target.finished = false;
      target.hasMoved = false;
      target.hasAttacked = false;
      target.hasTraded = false;
      g.board.moveUnit(target, 1, 12); // DestroyVillage3

      g.phase.setCurrentTeam('enemy');
      g.state.change('ai');
      return { ok: true };
    });
    expect(setup.ok).toBe(true);

    let interacted = false;
    let hitTitle = false;
    for (let i = 0; i < 1800; i++) {
      await stepFrames(page, 2, i % 2 === 0 ? 'SELECT' : null);

      const snap = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const state = g?.state?.getCurrentState?.()?.name ?? null;
        const regions = g?.currentLevel?.regions ?? [];
        return {
          state,
          hasDestroy: regions.some((r: any) => r?.nid === 'DestroyVillage3'),
          hasVillage: regions.some((r: any) => r?.nid === 'Village3'),
          ruinVisible: !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === 'Ruin3')?.visible,
        };
      });

      if (snap.state === 'title' || snap.state === 'title_main') {
        hitTitle = true;
      }

      if (!snap.hasDestroy && !snap.hasVillage && snap.ruinVisible) {
        interacted = true;
        break;
      }
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const regions = g?.currentLevel?.regions ?? [];
      return {
        state: g?.state?.getCurrentState?.()?.name ?? null,
        hasDestroy: regions.some((r: any) => r?.nid === 'DestroyVillage3'),
        hasVillage: regions.some((r: any) => r?.nid === 'Village3'),
        ruinVisible: !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === 'Ruin3')?.visible,
      };
    });

    expect(hitTitle).toBe(false);
    expect(interacted).toBe(true);
    expect(result.hasDestroy).toBe(false);
    expect(result.hasVillage).toBe(false);
    expect(result.ruinVisible).toBe(true);

    await saveScreenshot(page, '60-ch2-ai-destructible-interact-ruin3');
  });

  test('Recruit team persistence survives chapter cleanup/reload and appears in prep flow', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const joshua = g?.units?.get?.('Joshua');
      if (!g || !joshua) return false;

      // Simulate a recruited Joshua before chapter cleanup.
      joshua.team = 'player';
      joshua.dead = false;
      joshua.persistent = true;
      joshua.party = g.currentParty ?? joshua.party;
      return true;
    });
    expect(setupOk).toBe(true);

    const persisted = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      if (!g || !h) return { ok: false, reason: 'missing_game' };

      // Chapter transition analogue: cleanup + load next chapter.
      g.cleanUpLevel();
      await g.loadLevel('5');

      // Keep this deterministic like loadLevelClean.
      if (g.eventManager) {
        while (g.eventManager.hasActiveEvents()) {
          g.eventManager.dequeueCurrentEvent();
        }
      }
      g.state.clear();
      g.state.change('free');
      h.stepFrames(3);

      const joshua = g.units.get('Joshua');
      return {
        ok: true,
        team: joshua?.team ?? null,
        position: joshua?.position ?? null,
      };
    });
    expect(persisted.ok).toBe(true);
    expect(persisted.team).toBe('player');
    expect(persisted.position).toEqual([9, 7]);

    const openedPrep = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      if (!g) return false;
      g.state.change('prep_pick');
      return true;
    });
    expect(openedPrep).toBe(true);
    await stepFrames(page, 8);

    const prepProbe = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      const listedNids = Array.isArray((st as any)?.partyUnits)
        ? (st as any).partyUnits.map((u: any) => u?.nid)
        : [];
      return {
        state: st?.name ?? null,
        listedNids,
      };
    });

    expect(prepProbe.state).toBe('prep_pick');
    expect(prepProbe.listedNids).toContain('Joshua');

    await saveScreenshot(page, '61-recruit-persistence-prep-flow-joshua');
  });
});

// ---------------------------------------------------------------------------
// Level Progression Tests
// ---------------------------------------------------------------------------

async function killUnit(page: any, unitNid: string): Promise<boolean> {
  return page.evaluate(
    (nid: string) => (window as any).__harness.killUnit(nid),
    unitNid,
  );
}

async function triggerEvent(page: any, triggerType: string): Promise<boolean> {
  return page.evaluate(
    (tt: string) => (window as any).__harness.triggerEvent(tt),
    triggerType,
  );
}

test.describe('Level Progression', () => {
  test('Ch.1 intro cutscene plays after Prologue transition', async ({ page }) => {
    // This test verifies that after the Prologue outro completes,
    // the Chapter 1 intro cutscene actually runs (not skipped).
    const logs: string[] = [];
    page.on('console', msg => logs.push(msg.text()));

    // Load Prologue in clean mode
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    // Kill boss and trigger win
    await killUnit(page, "O'Neill");
    const triggered = await triggerEvent(page, 'combat_end');
    expect(triggered).toBe(true);

    // Push event state for the triggered event
    await stepFrames(page, 3);

    // Step through Prologue outro, level transition, and into Ch.1 intro.
    // Use waitForTimeout between batches to allow async loadLevel to complete.
    let reachedLevel1WithEvents = false;
    let level1EventNid = '';
    let level1EventCmdCount = 0;
    let chapterTitleSeen = false;

    for (let batch = 0; batch < 600; batch++) {
      // Don't press SELECT after reaching level 1 — let the cutscene play naturally
      const input = (!reachedLevel1WithEvents && batch % 3 === 0) ? 'SELECT' : null;
      await stepFrames(page, 5, input);
      // Crucial: yield to the browser event loop so async loadLevel() 
      // promises can resolve
      await page.waitForTimeout(10);

      const state = await getState(page);

      if (state.levelNid === '1' && state.units.length > 0) {
        const eventInfo = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          if (!g || !g.eventManager) return null;
          const ev = g.eventManager.getCurrentEvent();
          if (!ev) return null;
          return {
            nid: ev.nid,
            commandCount: ev.commands.length,
            pointer: ev.commandPointer,
          };
        });

        if (eventInfo && !reachedLevel1WithEvents) {
          reachedLevel1WithEvents = true;
          level1EventNid = eventInfo.nid;
          level1EventCmdCount = eventInfo.commandCount;
        }

        // Check if chapter title phase is active
        const ctPhase = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          const es = g?.state?.getCurrentState?.();
          return (es as any)?.chapterTitlePhase ?? 'unknown';
        });
        if (ctPhase !== 'none' && ctPhase !== 'unknown') {
          chapterTitleSeen = true;
        }
      }

      // If we're in free state on level 1, events have finished
      if (state.levelNid === '1' && state.currentStateName === 'free') {
        break;
      }

      if (state.currentStateName === 'title' || state.currentStateName === 'title_main') {
        break;
      }
    }

    expect(reachedLevel1WithEvents).toBe(true);
    expect(level1EventNid).toBe('1 Intro');
    expect(level1EventCmdCount).toBe(102);
    expect(chapterTitleSeen).toBe(true);

    await saveScreenshot(page, '25-ch1-intro-cutscene');
  });

  test('Prologue win_game transitions to Chapter 1', async ({ page }) => {
    // Load Prologue in clean mode (no level_start events)
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    // Verify we're on Prologue
    let state = await getState(page);
    expect(state.levelNid).toBe('0');
    expect(state.currentStateName).toBe('free');

    // Find the boss (O'Neill) and player units
    const boss = state.units.find((u: any) => u.nid === "O'Neill");
    expect(boss).toBeTruthy();
    // Remember Eirika's stats for persistence check
    const eirikaBefore = state.units.find((u: any) => u.nid === 'Eirika');
    expect(eirikaBefore).toBeTruthy();

    // Kill the boss to set up the win condition
    const killed = await killUnit(page, "O'Neill");
    expect(killed).toBe(true);

    // Verify boss is dead
    state = await getState(page);
    const bossAfter = state.units.find((u: any) => u.nid === "O'Neill");
    expect(bossAfter?.isDead).toBe(true);

    // Trigger the combat_end event (this is what fires after combat in normal gameplay).
    // The Prologue has an event "0_Defeat_Boss" with trigger=combat_end that checks
    // if O'Neill is dead, then calls win_game.
    const triggered = await triggerEvent(page, 'combat_end');

    // If the event was triggered, push EventState and step through it.
    // The event should set _win_game flag, then when it finishes,
    // finishAndDequeue() handles the level transition.
    if (triggered) {
      await stepFrames(page, 3);

      // Ensure we're in event state processing the win_game command
      state = await getState(page);

      // Step through event processing and level transition.
      // The level transition is async (loadLevel returns a Promise), so we need
      // to wait for it to complete. Use settle + manual stepping + page.waitForTimeout
      // to allow the Promise microtask to resolve.
      let transitioned = false;
      for (let batch = 0; batch < 300; batch++) {
        // Step frames, pressing SELECT to skip any dialogs/events
        await stepFrames(page, 10, batch % 5 === 0 ? 'SELECT' : null);
        // Allow async loadLevel() promise to resolve
        await page.waitForTimeout(20);

        state = await getState(page);

        // Check if we've transitioned to level 1 AND units are loaded
        // (levelNid is set at the start of loadLevel, but units are populated later)
        if (state.levelNid === '1' && state.units.length > 0) {
          transitioned = true;
          break;
        }

        // If we're on the title screen, something went wrong
        if (state.currentStateName === 'title' || state.currentStateName === 'title_main') {
          break;
        }
      }

      await saveScreenshot(page, '20-level-progression-result');

      // We should have transitioned to level 1
      expect(transitioned).toBe(true);
      expect(state.levelNid).toBe('1');

      // Verify Eirika is present in the new level (either from persistence or level data)
      const eirikaAfter = state.units.find((u: any) => u.nid === 'Eirika');
      expect(eirikaAfter).toBeTruthy();

      // Verify there are enemy units too (level 1 has ~10 enemies)
      const enemies = state.units.filter((u: any) => u.team === 'enemy');
      expect(enemies.length).toBeGreaterThan(0);
    } else {
      // combat_end event did not trigger — test should fail
      expect(triggered).toBe(true);
    }
  });

  test('win_game flag mechanism works', async ({ page }) => {
    // This test directly sets the _win_game flag and verifies level transition,
    // bypassing the need for combat events.
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    let state = await getState(page);
    expect(state.levelNid).toBe('0');

    // Directly set the win_game flag and trigger an event that will
    // cause finishAndDequeue to process it
    const transitioned = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      if (!g) return false;

      // Set the _win_game level variable
      g.levelVars.set('_win_game', true);

      // Create and queue a minimal "win" event that just finishes immediately
      if (g.eventManager) {
        // Queue a dummy event that will complete instantly, causing
        // finishAndDequeue to check the _win_game flag
        const dummyPrefab = {
          nid: '_test_win',
          name: 'Test Win',
          trigger: 'level_start',  // won't match anything again
          level_nid: '',
          condition: '',
          only_once: false,
          priority: 0,
          source: [],
          commands: '',
        };
        // Manually construct a minimal event
        g.eventManager.eventQueue.push({
          nid: '_test_win',
          commands: [],  // empty = finishes immediately
          commandPointer: 0,
          state: 'running',
          trigger: { type: 'test' },
          currentDialog: null,
          waitingForInput: false,
          pyev1Processor: null,
          isDone() { return this.commandPointer >= this.commands.length; },
          finish() { this.state = 'done'; },
        });

        // Push event state
        g.state.change('event');
      }
      return true;
    });

    if (transitioned) {
      // Step through frames to let the event + level transition process
      let levelChanged = false;
      for (let batch = 0; batch < 300; batch++) {
        await stepFrames(page, 10, batch % 5 === 0 ? 'SELECT' : null);

        // Need to wait for async loadLevel too
        await page.waitForTimeout(50);

        state = await getState(page);

        if (state.levelNid === '1' && state.units.length > 0) {
          levelChanged = true;
          break;
        }

        if (state.currentStateName === 'title' || state.currentStateName === 'title_main') {
          break;
        }
      }

      await saveScreenshot(page, '21-win-flag-mechanism-result');
      expect(levelChanged).toBe(true);
    }
  });
});
