/**
 * main.ts — Bootstrap and main loop for the Lex Talionis web engine.
 *
 * The canvas fills the entire screen. The viewport (in game pixels) is
 * dynamic based on screen aspect ratio and zoom level. Touch controls
 * are tap-to-select, drag-to-pan, pinch-to-zoom.
 */

import { FRAMETIME, updateAnimationCounters } from './engine/constants';
import { viewport } from './engine/viewport';
import { Surface } from './engine/surface';
import { InputManager } from './engine/input';
import { ResourceManager } from './data/resource-manager';
import { Database } from './data/database';
import { AudioManager } from './audio/audio-manager';
import { initGameState, game } from './engine/game-state';
import { setActionGameRef } from './engine/action';
import { initIcons } from './ui/icons';
import { initBaseSurf } from './ui/base-surf';
import { setMenuAudioManager } from './ui/menu';
import { initFonts } from './rendering/bmp-font';
import { initSpriteLoader } from './combat/sprite-loader';
import { loadExpDisplaySprites } from './ui/exp-display';
import {
  setGameRef,
  TitleState,
  TitleMainState,
  LevelSelectState,
  OptionMenuState,
  FreeState,
  MoveState,
  MenuState,
  ItemUseState,
  TradeState,
  RescueState,
  DropState,
  WeaponChoiceState,
  TargetingState,
  CombatState,
  AIState,
  TurnChangeState,
  PhaseChangeState,
  MovementState,
  EventState,
  ShopState,
  InfoMenuState,
  setInfoMenuGameRef,
  InitiativeUpkeepState,
} from './engine/states/game-states';
import {
  PrepMainState,
  PrepPickUnitsState,
  PrepMapState,
  setPrepGameRef,
} from './engine/states/prep-state';
import {
  BaseMainState,
  BaseConvosState,
  setBaseGameRef,
} from './engine/states/base-state';
import {
  SettingsMenuState,
  setSettingsGameRef,
} from './engine/states/settings-state';
import {
  MinimapState,
  setMinimapGameRef,
} from './engine/states/minimap-state';
import {
  VictoryState,
  setVictoryGameRef,
} from './engine/states/victory-state';
import {
  GameOverState,
  setGameOverGameRef,
} from './engine/states/game-over-state';
import {
  CreditState,
  setCreditGameRef,
} from './engine/states/credit-state';
import {
  TurnwheelState,
  setTurnwheelGameRef,
} from './engine/states/turnwheel-state';
import {
  OverworldFreeState,
  OverworldMovementState,
  OverworldLevelTransitionState,
  setOverworldGameRef,
} from './engine/states/overworld-state';
import {
  FreeRoamState,
  FreeRoamRationalizeState,
  setRoamGameRef,
} from './engine/states/roam-state';
import { setQueryEngineGameRef } from './engine/query-engine';
import { setEquationGameRef } from './combat/combat-calcs';
import { initPersistentSystems } from './engine/records';
import {
  SaveMenuState,
  LoadMenuState,
  setSaveLoadGameRef,
} from './engine/states/save-load-state';
import {
  registerServiceWorker,
  requestPersistentStorage,
  setupInstallPrompt,
  setupConnectivityTracking,
  onUpdateAvailable,
} from './pwa';
import { AssetBundle, installBundleFetchInterceptor, installBundleImageInterceptor } from './data/asset-bundle';
import { initNativePlatform, onAppPause, onAppResume } from './native';
import { PerfMonitor } from './engine/perf-monitor';
import { SurfacePool } from './engine/surface-pool';
import { installHarness } from './harness';

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

interface DisplayInfo {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/**
 * Resize the display canvas to match the screen and recalculate viewport.
 */
function applySize(display: DisplayInfo): void {
  const screenW = window.innerWidth;
  const screenH = window.innerHeight;

  viewport.recalculate(screenW, screenH);

  // Physical canvas = viewport game pixels * renderScale
  display.canvas.width = Math.round(viewport.width * viewport.renderScale);
  display.canvas.height = Math.round(viewport.height * viewport.renderScale);
  display.canvas.style.width = `${screenW}px`;
  display.canvas.style.height = `${screenH}px`;
  display.ctx.imageSmoothingEnabled = false;
}

// ---------------------------------------------------------------------------
// Loading / error screens
// ---------------------------------------------------------------------------

function drawLoadingScreen(ctx: CanvasRenderingContext2D, message: string): void {
  const s = viewport.renderScale;
  const w = viewport.width;
  const h = viewport.height;
  ctx.fillStyle = '#101020';
  ctx.fillRect(0, 0, Math.round(w * s), Math.round(h * s));

  ctx.font = `${Math.round(12 * s)}px monospace`;
  ctx.fillStyle = '#aaaacc';
  ctx.textBaseline = 'top';

  const textWidth = ctx.measureText(message).width;
  ctx.fillText(
    message,
    Math.floor((w * s - textWidth) / 2),
    Math.floor(h * s / 2) - Math.round(4 * s),
  );
}

function drawErrorScreen(ctx: CanvasRenderingContext2D, error: string): void {
  const s = viewport.renderScale;
  const w = viewport.width;
  const h = viewport.height;
  ctx.fillStyle = '#200808';
  ctx.fillRect(0, 0, Math.round(w * s), Math.round(h * s));

  ctx.font = `${Math.round(12 * s)}px monospace`;
  ctx.textBaseline = 'top';

  ctx.fillStyle = '#ff6666';
  ctx.fillText('Error', Math.round(8 * s), Math.round(8 * s));

  ctx.fillStyle = '#ccaaaa';
  const charW = ctx.measureText('M').width;
  const maxChars = Math.floor((w * s - 16 * s) / charW);
  const lines: string[] = [];
  let remaining = error;
  while (remaining.length > 0) {
    lines.push(remaining.substring(0, maxChars));
    remaining = remaining.substring(maxChars);
  }
  for (let i = 0; i < lines.length && i < 14; i++) {
    ctx.fillText(lines[i], Math.round(8 * s), Math.round((24 + i * 14) * s));
  }
}

// ---------------------------------------------------------------------------
// Audio initialisation on first user interaction
// ---------------------------------------------------------------------------

function setupAudioInit(audioManager: AudioManager): void {
  const initAudio = () => {
    audioManager.init();
    window.removeEventListener('click', initAudio);
    window.removeEventListener('keydown', initAudio);
    window.removeEventListener('touchstart', initAudio);
  };
  window.addEventListener('click', initAudio, { once: true });
  window.addEventListener('keydown', initAudio, { once: true });
  window.addEventListener('touchstart', initAudio, { once: true });
}

// ---------------------------------------------------------------------------
// Project selection screen
// ---------------------------------------------------------------------------

/** Compile-time constant injected by Vite — list of .ltproj directory names. */
declare const __AVAILABLE_PROJECTS__: string[];

/**
 * Show a project selection screen. The list is baked in at build time via
 * Vite's `define` (no runtime API call needed).
 * If only one project exists, it is auto-selected.
 */
function showProjectPicker(): Promise<string> {
  const projects: string[] = __AVAILABLE_PROJECTS__;

  if (projects.length === 0) return Promise.resolve('default.ltproj');
  if (projects.length === 1) return Promise.resolve(projects[0]);

  // Build a simple DOM-based picker overlay
  return new Promise<string>((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 9999;
      background: #101020; display: flex; flex-direction: column;
      align-items: center; justify-content: center; font-family: monospace;
    `;

    const title = document.createElement('div');
    title.textContent = 'Select Project';
    title.style.cssText = 'color: #aaaacc; font-size: 24px; margin-bottom: 32px;';
    overlay.appendChild(title);

    for (const proj of projects) {
      const btn = document.createElement('button');
      // Display name: strip .ltproj suffix, replace underscores with spaces
      const displayName = proj.replace(/\.ltproj$/, '').replace(/_/g, ' ');
      btn.textContent = displayName;
      btn.style.cssText = `
        background: #1a1a30; color: #ccccee; border: 1px solid #333355;
        padding: 12px 32px; margin: 6px; font-size: 16px; font-family: monospace;
        cursor: pointer; border-radius: 4px; min-width: 240px; text-align: center;
      `;
      btn.addEventListener('mouseenter', () => {
        btn.style.background = '#2a2a50';
        btn.style.borderColor = '#5555aa';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = '#1a1a30';
        btn.style.borderColor = '#333355';
      });
      btn.addEventListener('click', () => {
        overlay.remove();
        resolve(proj);
      });
      overlay.appendChild(btn);
    }

    document.body.appendChild(overlay);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    throw new Error('Could not find #game-canvas element');
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not get 2D rendering context');
  }

  const display: DisplayInfo = { canvas, ctx };

  // Initial viewport calculation
  applySize(display);

  // --- Determine project URL ---
  const params = new URLSearchParams(window.location.search);
  const harnessMode = params.get('harness') === 'true';
  const harnessLevel = params.get('level') ?? 'DEBUG';
  const harnessClean = params.get('clean') !== 'false'; // default: skip events
  let projectPath = params.get('project');

  // If no project specified:
  // - Harness mode defaults to default.ltproj for deterministic tests.
  // - Normal mode shows the project picker and redirects with ?project= param.
  if (!projectPath) {
    if (harnessMode) {
      const projects: string[] = __AVAILABLE_PROJECTS__;
      const hasDefault = projects.includes('default.ltproj');
      projectPath = hasDefault ? 'default.ltproj' : (projects[0] ?? 'default.ltproj');
      console.info(`[Harness] No project specified. Using ${projectPath}`);
    } else {
      const chosen = await showProjectPicker();
      const url = new URL(window.location.href);
      url.searchParams.set('project', chosen);
      window.location.href = url.toString();
      return;
    }
  }

  drawLoadingScreen(ctx, 'Loading...');
  const baseUrl = `/game-data/${projectPath}`;
  const useBundle = params.get('bundle') !== 'false'; // opt-out with ?bundle=false

  // In harness mode, force zoom so viewport matches GBA resolution (240x160).
  // With tilesAcross=10 and Playwright viewport 480x320:
  //   cssScale = 320/(10*16) = 2.0, width = 480/2 = 240, height = 320/2 = 160
  if (harnessMode) {
    viewport.setZoom(10);
    applySize(display);
  }

  // --- Try loading asset bundle (single zip instead of hundreds of requests) ---
  if (useBundle) {
    const bundleUrl = `/bundles/${projectPath}.zip`;
    try {
      const bundle = new AssetBundle();
      await bundle.load(bundleUrl, (progress) => {
        drawLoadingScreen(ctx, progress.message);
      });
      // Install interceptors so ResourceManager reads from the bundle
      installBundleFetchInterceptor(bundle, baseUrl);
      installBundleImageInterceptor(bundle, baseUrl);
      console.info(`[Bundle] Loaded ${bundle.fileCount} files from ${bundleUrl}`);
    } catch {
      // Bundle not available — fall through to individual HTTP requests
      console.info('[Bundle] No asset bundle found, using individual requests');
    }
  }

  // --- Load game data ---
  const resources = new ResourceManager(baseUrl);
  const db = new Database();

  try {
    drawLoadingScreen(ctx, 'Loading database...');
    await db.load(resources);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Failed to load database:', msg);
    drawErrorScreen(ctx, `DB load failed: ${msg}`);
    return;
  }

  // --- Icons, Fonts & UI resources ---
  initIcons(baseUrl);
  // Engine-level shared assets (sprites/menus, platforms) live at /game-data/,
  // not inside the .ltproj directory.
  const engineBaseUrl = '/game-data';
  initBaseSurf(engineBaseUrl);
  initSpriteLoader(engineBaseUrl);
  // Load bitmap fonts (async, text rendering falls back to Canvas until ready)
  initFonts(baseUrl);
  // Load EXP display sprites (async, falls back to canvas primitives until ready)
  loadExpDisplaySprites();

  // --- Audio ---
  const audioManager = new AudioManager(baseUrl);
  setupAudioInit(audioManager);

  // --- GameState ---
  drawLoadingScreen(ctx, 'Initializing...');
  const gameState = initGameState(db, resources, audioManager);
  setActionGameRef(() => gameState);
  setGameRef(gameState);
  setInfoMenuGameRef(gameState);
  setMenuAudioManager(audioManager);
  setPrepGameRef(gameState);
  setBaseGameRef(gameState);
  setSettingsGameRef(gameState);
  setMinimapGameRef(gameState);
  setVictoryGameRef(gameState);
  setGameOverGameRef(gameState);
  setCreditGameRef(gameState);
  setTurnwheelGameRef(gameState);
  setOverworldGameRef(gameState);
  setRoamGameRef(gameState);
  setQueryEngineGameRef(() => gameState);
  setEquationGameRef(() => gameState);
  setSaveLoadGameRef(gameState);

  // Initialize persistent systems (cross-save records and achievements)
  const gameNid = db.getConstant('game_nid', 'default') as string;
  initPersistentSystems(gameNid);

  // --- Register states ---
  const states = [
    new TitleState(),
    new TitleMainState(),
    new LevelSelectState(),
    new OptionMenuState(),
    new FreeState(),
    new MoveState(),
    new MenuState(),
    new ItemUseState(),
    new TradeState(),
    new RescueState(),
    new DropState(),
    new WeaponChoiceState(),
    new TargetingState(),
    new CombatState(),
    new AIState(),
    new TurnChangeState(),
    new InitiativeUpkeepState(),
    new PhaseChangeState(),
    new MovementState(),
    new EventState(),
    new ShopState(),
    new InfoMenuState(),
    new PrepMainState(),
    new PrepPickUnitsState(),
    new PrepMapState(),
    new BaseMainState(),
    new BaseConvosState(),
    new SettingsMenuState(),
    new MinimapState(),
    new VictoryState(),
    new GameOverState(),
    new CreditState(),
    new TurnwheelState(),
    new OverworldFreeState(),
    new OverworldMovementState(),
    new OverworldLevelTransitionState(),
    new FreeRoamState(),
    new FreeRoamRationalizeState(),
    new SaveMenuState(),
    new LoadMenuState(),
  ];
  for (const state of states) {
    gameState.state.register(state);
  }

  // --- Push initial state (level is loaded via LevelSelectState) ---
  gameState.state.change('title');

  // --- Input ---
  const inputManager = new InputManager(canvas);
  inputManager.setDisplayScale(viewport.cssScale);
  gameState.input = inputManager;

  // --- Game surface (dynamic size) ---
  let gameSurface = new Surface(viewport.width, viewport.height, viewport.renderScale);
  let lastViewW = viewport.width;
  let lastViewH = viewport.height;

  /** Recreate surface if viewport changed. */
  function refreshSurface(): void {
    if (viewport.width !== lastViewW || viewport.height !== lastViewH) {
      gameSurface = new Surface(viewport.width, viewport.height, viewport.renderScale);
      lastViewW = viewport.width;
      lastViewH = viewport.height;
    }
  }

  // Handle window resize
  window.addEventListener('resize', () => {
    applySize(display);
    inputManager.setDisplayScale(viewport.cssScale);
    refreshSurface();
  });

  // --- Harness mode: skip rAF loop, expose programmatic API ---
  if (harnessMode) {
    installHarness(gameState, gameSurface, display.canvas, display.ctx);
    // Expose game reference for advanced test manipulation
    (window as any).__gameRef = gameState;
    // Load the requested level directly
    try {
      const h = (window as any).__harness;
      if (harnessClean) {
        await h.loadLevelClean(harnessLevel);
      } else {
        await h.loadLevel(harnessLevel);
      }
      console.info(`[Harness] Level "${harnessLevel}" loaded (clean=${harnessClean}). Use window.__harness to drive the game.`);
    } catch (err) {
      console.error('[Harness] Failed to load level:', err);
      (window as any).__harness.ready = false;
    }
    // Don't start the rAF loop -- Playwright will drive frames via __harness.stepFrames()
    return;
  }

  // --- Game loop ---
  let lastTimestamp = 0;

  // F3 toggles performance overlay, F4 toggles profiling session
  let profilingSession = false;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F3') {
      e.preventDefault();
      PerfMonitor.toggle();
    }
    if (e.key === 'F4') {
      e.preventDefault();
      if (!profilingSession) {
        PerfMonitor.startProfiling();
        profilingSession = true;
        console.info('[Perf] Press F4 again to stop and export the profiling report');
      } else {
        const report = PerfMonitor.stopProfiling();
        profilingSession = false;
        // Log summary to console
        console.info('[Perf] === Profiling Report ===');
        console.info(`  Duration: ${report.durationSec.toFixed(1)}s, ${report.totalFrames} frames`);
        console.info(`  Avg FPS: ${report.avgFps.toFixed(1)}, Min FPS: ${report.minFps.toFixed(0)}`);
        console.info(`  Frame time: avg=${report.avgFrameTimeMs.toFixed(1)}ms, p95=${report.p95FrameTimeMs.toFixed(1)}ms, p99=${report.p99FrameTimeMs.toFixed(1)}ms, peak=${report.peakFrameTimeMs.toFixed(1)}ms`);
        console.info(`  Dropped frames: ${report.droppedFrames} (${(report.droppedFrames / report.totalFrames * 100).toFixed(1)}%)`);
        console.info(`  Memory peak: ${report.memory.peakMb.toFixed(0)}MB`);
        console.info('[Perf] Full report: __PerfMonitor.exportReport()');
        // Also store as downloadable JSON
        console.info('[Perf] Report object:', report);
      }
    }
  });

  function gameLoop(timestamp: number): void {
    PerfMonitor.beginFrame();

    const rawDelta = lastTimestamp === 0 ? FRAMETIME : timestamp - lastTimestamp;
    const deltaMs = Math.min(rawDelta, FRAMETIME * 3);
    lastTimestamp = timestamp;

    // Store real frame delta on game state for time-based animations
    game.frameDeltaMs = deltaMs;

    // --- Process input ---
    const event = inputManager.processInput(deltaMs);

    // --- Apply pinch-to-zoom ---
    if (inputManager.zoomDelta !== 0) {
      viewport.zoom(inputManager.zoomDelta);
      applySize(display);
      inputManager.setDisplayScale(viewport.cssScale);
      refreshSurface();
    }

    // --- Apply touch-drag camera panning ---
    if (inputManager.cameraPanDeltaX !== 0 || inputManager.cameraPanDeltaY !== 0) {
      const panScale = viewport.cssScale || 1;
      game.camera.pan(
        inputManager.cameraPanDeltaX / panScale,
        inputManager.cameraPanDeltaY / panScale,
      );
    }

    // --- Clear ---
    gameSurface.clear();

    // --- State machine update ---
    PerfMonitor.beginUpdate();
    let repeat = true;
    let iterations = 0;
    const maxIterations = 10;

    while (repeat && iterations < maxIterations) {
      const inputForThisIteration = iterations === 0 ? event : null;
      // Clear transient input signals on repeat iterations so stale
      // justPressed/mouseClick events don't get consumed by multiple
      // states during the repeat chain (prevents double-pop bugs).
      if (iterations > 0) {
        inputManager.clearFrameEvents();
      }
      const [, shouldRepeat] = game.state.update(inputForThisIteration, gameSurface);
      repeat = shouldRepeat;
      iterations++;
    }
    PerfMonitor.endUpdate();

    // --- Animations ---
    updateAnimationCounters();

    // --- Movement ---
    game.movementSystem.update(deltaMs);

    // --- Blit to display ---
    PerfMonitor.beginDraw();
    display.ctx.imageSmoothingEnabled = false;
    display.ctx.clearRect(0, 0, display.canvas.width, display.canvas.height);
    display.ctx.drawImage(gameSurface.canvas, 0, 0);

    // --- HUD overlay (fixed screen-space, not affected by zoom) ---
    game.hud.drawScreen(display.ctx, window.innerWidth, window.innerHeight, game.db);
    PerfMonitor.endDraw();

    // --- Performance overlay (screen-space, on top of everything) ---
    // Sync perf overlay with the in-game settings (display_fps)
    const fpsSettingVal = game.gameVars?.get('_setting_display_fps');
    if (fpsSettingVal !== undefined) {
      PerfMonitor.setEnabled(fpsSettingVal === 1 || fpsSettingVal === true);
    }
    PerfMonitor.draw(display.ctx, display.canvas.width, display.canvas.height);

    // --- End of frame ---
    PerfMonitor.endFrame();
    inputManager.endFrame();
    audioManager.resume();

    requestAnimationFrame(gameLoop);
  }

  requestAnimationFrame(gameLoop);

  // --- Native platform (Capacitor / TWA / Wake Lock) ---
  initNativePlatform();
  onAppPause(() => {
    // Pause audio when the app is backgrounded
    audioManager.suspendContext();
  });
  onAppResume(() => {
    // Resume audio when the app comes back
    audioManager.resume();
  });

  // --- PWA: install prompt + connectivity + service worker ---
  setupInstallPrompt();
  setupConnectivityTracking();
  onUpdateAvailable((apply) => {
    // Log update availability; the game can check and apply via settings menu
    console.info('[PWA] Update available — call apply() to reload with new version');
    // Store the apply function on the game state so the settings/title screen can use it
    game.gameVars.set('_pwa_update_available', true);
    game.gameVars.set('_pwa_apply_update', apply as any);
  });
  registerServiceWorker().then((reg) => {
    if (reg) {
      // Request persistent storage so the browser won't evict cached game data
      requestPersistentStorage().then((granted) => {
        if (granted) {
          console.info('[PWA] Persistent storage granted');
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      canvas.width = 240;
      canvas.height = 160;
      ctx.fillStyle = '#200808';
      ctx.fillRect(0, 0, 240, 160);
      ctx.font = '12px monospace';
      ctx.fillStyle = '#ff6666';
      ctx.fillText('Fatal error — see console', 8, 80);
    }
  }
});
