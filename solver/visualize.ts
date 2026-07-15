import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SolverResult } from './types';

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

export function renderReplayHtml(result: SolverResult): string {
  const data = safeJson(result);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(result.scenario)} — solver replay</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b1020; color: #e8edf8; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    .sub { color: #9eabc6; margin-bottom: 18px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit,minmax(120px,1fr)); gap: 10px; margin-bottom: 18px; }
    .metric { background: #151c31; border: 1px solid #26304c; border-radius: 10px; padding: 10px 12px; }
    .metric b { display: block; font-size: 20px; }
    .metric span { color: #9eabc6; font-size: 12px; }
    .layout { display: grid; grid-template-columns: minmax(520px, 1fr) minmax(280px, 360px); gap: 18px; align-items: start; }
    .panel { background: #11182a; border: 1px solid #26304c; border-radius: 12px; padding: 14px; }
    canvas { display: block; width: 100%; height: auto; image-rendering: pixelated; border-radius: 8px; background: #080c16; }
    .controls { display: grid; grid-template-columns: auto auto auto 1fr; gap: 8px; margin-top: 12px; align-items: center; }
    button { background: #253255; color: white; border: 1px solid #3a4a78; border-radius: 7px; padding: 7px 11px; cursor: pointer; }
    input[type=range] { width: 100%; }
    .action { min-height: 76px; padding: 12px; margin-top: 12px; border-radius: 8px; background: #19223a; }
    .phase { text-transform: uppercase; letter-spacing: .08em; font-size: 11px; color: #8fb2ff; }
    .action p { margin: 6px 0 0; line-height: 1.35; }
    .legend { display: flex; gap: 13px; flex-wrap: wrap; color: #aab4ca; font-size: 12px; margin-top: 10px; }
    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; }
    .roster { max-height: 590px; overflow: auto; }
    .unit { display: grid; grid-template-columns: 1fr auto; gap: 3px 8px; padding: 8px 2px; border-bottom: 1px solid #26304c; }
    .unit small { color: #97a4bf; }
    .hp { font-variant-numeric: tabular-nums; }
    .dead { opacity: .4; text-decoration: line-through; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <h1>${escapeHtml(result.scenario)}</h1>
  <div class="sub">Deterministic seed ${result.seed} · ${result.rngMode} · policy score [${result.score.join(', ')}]</div>
  <section class="metrics">
    <div class="metric"><b>${result.metrics.cleared ? 'Clear' : 'Failed'}</b><span>outcome</span></div>
    <div class="metric"><b>${result.metrics.turns}</b><span>turns</span></div>
    <div class="metric"><b>${result.metrics.damageTaken}</b><span>damage taken</span></div>
    <div class="metric"><b>${result.metrics.playerDeaths}</b><span>player deaths</span></div>
    <div class="metric"><b>${result.metrics.enemiesDefeated}</b><span>enemies defeated</span></div>
    <div class="metric"><b>${result.metrics.actions}</b><span>actions</span></div>
  </section>
  <section class="layout">
    <div class="panel">
      <canvas id="map"></canvas>
      <div class="controls">
        <button id="prev" aria-label="Previous step">◀</button>
        <button id="play" aria-label="Play replay">Play</button>
        <button id="next" aria-label="Next step">▶</button>
        <input id="scrub" type="range" min="0" max="${Math.max(0, result.replay.length - 1)}" value="0">
      </div>
      <div class="action"><span class="phase" id="phase"></span><p id="description"></p></div>
      <div class="legend">
        <span><i class="dot" style="background:#4f8cff"></i>Player</span>
        <span><i class="dot" style="background:#ef5350"></i>Enemy</span>
        <span><i class="dot" style="background:#54c785"></i>Other</span>
        <span><i class="dot" style="background:#f5c451"></i>Seize</span>
      </div>
    </div>
    <div class="panel roster" id="roster"></div>
  </section>
</main>
<script>
const result = ${data};
const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const cell = 32;
canvas.width = result.map.width * cell;
canvas.height = result.map.height * cell;
const terrainColor = name => {
  const n = name.toLowerCase();
  if (n.includes('wall') || n.includes('cliff')) return '#242a38';
  if (n.includes('throne') || n.includes('gate')) return '#7b6224';
  if (n.includes('forest') || n.includes('thicket')) return '#244b38';
  if (n.includes('water') || n.includes('river') || n.includes('sea')) return '#214b69';
  if (n.includes('pillar')) return '#4a4655';
  return '#705d43';
};
let index = 0;
let timer = null;
function render() {
  const step = result.replay[index];
  for (let y = 0; y < result.map.height; y++) for (let x = 0; x < result.map.width; x++) {
    const nid = result.map.terrain[y][x];
    ctx.fillStyle = terrainColor(result.map.terrainNames[nid] || nid);
    ctx.fillRect(x * cell, y * cell, cell, cell);
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.strokeRect(x * cell + .5, y * cell + .5, cell - 1, cell - 1);
  }
  if (result.map.seize) {
    const [x,y] = result.map.seize;
    ctx.fillStyle = 'rgba(245,196,81,.45)'; ctx.fillRect(x*cell,y*cell,cell,cell);
    ctx.strokeStyle = '#f5c451'; ctx.lineWidth = 2; ctx.strokeRect(x*cell+3,y*cell+3,cell-6,cell-6);
  }
  if (step.from && step.to) {
    ctx.strokeStyle = '#f8f9ff'; ctx.lineWidth = 3; ctx.beginPath();
    ctx.moveTo((step.from[0]+.5)*cell,(step.from[1]+.5)*cell);
    ctx.lineTo((step.to[0]+.5)*cell,(step.to[1]+.5)*cell); ctx.stroke();
  }
  for (const unit of step.units) {
    if (unit.dead || !unit.position) continue;
    const [x,y] = unit.position;
    const color = unit.team === 'player' ? '#4f8cff' : unit.team === 'enemy' ? '#ef5350' : '#54c785';
    ctx.beginPath(); ctx.fillStyle = color; ctx.arc((x+.5)*cell,(y+.5)*cell,cell*.36,0,Math.PI*2); ctx.fill();
    if (unit.nid === step.actor) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke(); }
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(unit.nid.slice(0,3), (x+.5)*cell, (y+.5)*cell);
  }
  document.getElementById('phase').textContent = 'Step ' + index + ' · Turn ' + step.turn + ' · ' + step.phase + ' phase';
  document.getElementById('description').textContent = step.description;
  document.getElementById('scrub').value = index;
  const roster = document.getElementById('roster'); roster.innerHTML = '';
  for (const unit of step.units.filter(u => u.team === 'player' || u.team === 'other')) {
    const row = document.createElement('div'); row.className = 'unit' + (unit.dead ? ' dead' : '');
    row.innerHTML = '<div><strong>' + unit.name + '</strong><br><small>' + unit.klass + ' · Lv ' + unit.level + '</small></div>' +
      '<div class="hp">' + unit.hp + '/' + unit.maxHp + '<br><small>' + (unit.position ? unit.position.join(',') : 'off map') + '</small></div>';
    roster.appendChild(row);
  }
}
function move(delta) { index = Math.max(0, Math.min(result.replay.length-1,index+delta)); render(); }
document.getElementById('prev').onclick = () => move(-1);
document.getElementById('next').onclick = () => move(1);
document.getElementById('scrub').oninput = event => { index = Number(event.target.value); render(); };
document.getElementById('play').onclick = event => {
  if (timer) { clearInterval(timer); timer = null; event.target.textContent = 'Play'; return; }
  event.target.textContent = 'Pause'; timer = setInterval(() => { if (index >= result.replay.length-1) { clearInterval(timer); timer=null; event.target.textContent='Play'; return; } move(1); }, 550);
};
render();
</script>
</body>
</html>`;
}

export async function writeReplayHtml(outputPath: string, result: SolverResult): Promise<void> {
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, renderReplayHtml(result), 'utf8');
}

export function renderReplayFragment(result: SolverResult): string {
  const compact = {
    map: result.map,
    metrics: result.metrics,
    seed: result.seed,
    rngMode: result.rngMode,
    steps: result.replay.map((step) => ({
      turn: step.turn,
      phase: step.phase,
      actor: step.actor,
      from: step.from,
      to: step.to,
      description: step.description,
      units: step.units.map((unit) => ({
        nid: unit.nid,
        team: unit.team,
        hp: unit.hp,
        maxHp: unit.maxHp,
        position: unit.position,
        dead: unit.dead,
      })),
    })),
  };
  const data = safeJson(compact);
  return `<div id="fe-level-three-replay">
  <div class="viz-grid fe-summary" aria-label="Solution summary">
    <div class="card viz-stat"><span class="text-muted">Damage taken</span><span class="viz-stat-value">${result.metrics.damageTaken}</span></div>
    <div class="card viz-stat"><span class="text-muted">Turns</span><span class="viz-stat-value">${result.metrics.turns}</span></div>
    <div class="card viz-stat"><span class="text-muted">Player deaths</span><span class="viz-stat-value">${result.metrics.playerDeaths}</span></div>
  </div>
  <canvas id="fe-replay-map" role="img" aria-label="Animated grid replay of the Chapter 3 solver route">Chapter 3 solver replay</canvas>
  <div class="viz-controls" aria-label="Replay controls">
    <button type="button" class="btn btn-ghost" id="fe-replay-prev" aria-label="Previous step">Previous</button>
    <button type="button" class="btn btn-primary" id="fe-replay-play" aria-pressed="false">Play</button>
    <button type="button" class="btn btn-ghost" id="fe-replay-next" aria-label="Next step">Next</button>
    <label class="form-label fe-scrub-label" for="fe-replay-scrub">Step <span id="fe-replay-step">0</span></label>
    <input class="form-range" id="fe-replay-scrub" type="range" min="0" max="${Math.max(0, result.replay.length - 1)}" value="0">
  </div>
  <div class="text-small" id="fe-replay-detail" aria-live="polite"></div>
  <div class="viz-row text-small text-muted fe-legend" aria-label="Unit legend">
    <span><i class="fe-key fe-player" aria-hidden="true"></i>Player</span>
    <span><i class="fe-key fe-enemy" aria-hidden="true"></i>Enemy</span>
    <span><i class="fe-key fe-other" aria-hidden="true"></i>Other</span>
    <span><i class="fe-key fe-seize" aria-hidden="true"></i>Seize tile</span>
  </div>
</div>
<style>
  #fe-level-three-replay { display: grid; gap: 0.75rem; width: 100%; color: var(--foreground); }
  #fe-level-three-replay .fe-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  #fe-level-three-replay .viz-stat { display: grid; gap: 0.2rem; }
  #fe-replay-map { display: block; width: 100%; height: auto; max-height: 38rem; background: var(--background); }
  #fe-level-three-replay .fe-scrub-label { margin-inline-start: auto; white-space: nowrap; }
  #fe-level-three-replay .form-range { flex: 1 1 14rem; }
  #fe-level-three-replay .fe-legend { justify-content: flex-start; gap: 1rem; }
  #fe-level-three-replay .fe-key { display: inline-block; width: 0.7rem; height: 0.7rem; margin-inline-end: 0.35rem; border-radius: 999px; background: var(--muted); }
  #fe-level-three-replay .fe-player { background: var(--viz-series-1); }
  #fe-level-three-replay .fe-enemy { background: var(--viz-series-5); }
  #fe-level-three-replay .fe-other { background: var(--viz-series-3); }
  #fe-level-three-replay .fe-seize { background: var(--viz-series-4); }
  @media (max-width: 480px) {
    #fe-level-three-replay .fe-summary { grid-template-columns: 1fr; }
    #fe-level-three-replay .fe-scrub-label { margin-inline-start: 0; }
  }
</style>
<script>
(() => {
  const root = document.getElementById('fe-level-three-replay');
  const canvas = document.getElementById('fe-replay-map');
  const ctx = canvas.getContext('2d');
  const data = ${data};
  const cell = 32;
  const color = name => {
    const probe = document.createElement('span');
    probe.style.color = 'var(' + name + ')';
    root.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  };
  const palette = {
    background: color('--background'), foreground: color('--foreground'), border: color('--border'),
    muted: color('--muted'), mutedForeground: color('--muted-foreground'),
    player: color('--viz-series-1'), water: color('--viz-series-2'), other: color('--viz-series-3'),
    seize: color('--viz-series-4'), enemy: color('--viz-series-5'), active: color('--viz-series-6'),
    primaryForeground: color('--primary-foreground')
  };
  canvas.width = data.map.width * cell;
  canvas.height = data.map.height * cell;
  let index = 0;
  let timer = null;
  const terrainStyle = name => {
    const terrain = name.toLowerCase();
    if (terrain.includes('wall') || terrain.includes('cliff')) return [palette.foreground, 0.2];
    if (terrain.includes('throne') || terrain.includes('gate')) return [palette.seize, 0.24];
    if (terrain.includes('forest') || terrain.includes('thicket')) return [palette.other, 0.15];
    if (terrain.includes('river') || terrain.includes('sea')) return [palette.water, 0.16];
    return [palette.mutedForeground, 0.08];
  };
  function render() {
    const step = data.steps[index];
    for (let y = 0; y < data.map.height; y++) for (let x = 0; x < data.map.width; x++) {
      const nid = data.map.terrain[y][x];
      const style = terrainStyle(data.map.terrainNames[nid] || nid);
      ctx.globalAlpha = style[1];
      ctx.fillStyle = style[0];
      ctx.fillRect(x * cell, y * cell, cell, cell);
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = palette.mutedForeground;
      ctx.lineWidth = 1;
      ctx.strokeRect(x * cell + 0.5, y * cell + 0.5, cell - 1, cell - 1);
      ctx.globalAlpha = 1;
    }
    if (data.map.seize) {
      const [x, y] = data.map.seize;
      ctx.globalAlpha = 0.55; ctx.fillStyle = palette.seize; ctx.fillRect(x * cell, y * cell, cell, cell); ctx.globalAlpha = 1;
    }
    if (step.from && step.to) {
      ctx.strokeStyle = palette.active; ctx.lineWidth = 3; ctx.beginPath();
      ctx.moveTo((step.from[0] + 0.5) * cell, (step.from[1] + 0.5) * cell);
      ctx.lineTo((step.to[0] + 0.5) * cell, (step.to[1] + 0.5) * cell); ctx.stroke();
    }
    for (const unit of step.units) {
      if (unit.dead || !unit.position) continue;
      const [x, y] = unit.position;
      ctx.fillStyle = unit.team === 'player' ? palette.player : unit.team === 'enemy' ? palette.enemy : palette.other;
      ctx.beginPath(); ctx.arc((x + 0.5) * cell, (y + 0.5) * cell, cell * 0.35, 0, Math.PI * 2); ctx.fill();
      if (unit.nid === step.actor) { ctx.strokeStyle = palette.active; ctx.lineWidth = 3; ctx.stroke(); }
      ctx.fillStyle = palette.primaryForeground; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '500 10px system-ui';
      ctx.fillText(unit.nid.slice(0, 3), (x + 0.5) * cell, (y + 0.5) * cell);
    }
    document.getElementById('fe-replay-step').textContent = index + ' / ' + (data.steps.length - 1);
    document.getElementById('fe-replay-scrub').value = index;
    document.getElementById('fe-replay-detail').textContent = 'Turn ' + step.turn + ' · ' + step.phase + ' phase · ' + step.description;
  }
  function move(delta) { index = Math.max(0, Math.min(data.steps.length - 1, index + delta)); render(); }
  document.getElementById('fe-replay-prev').addEventListener('click', () => move(-1));
  document.getElementById('fe-replay-next').addEventListener('click', () => move(1));
  document.getElementById('fe-replay-scrub').addEventListener('input', event => { index = Number(event.target.value); render(); });
  document.getElementById('fe-replay-play').addEventListener('click', event => {
    if (timer) { clearInterval(timer); timer = null; event.currentTarget.textContent = 'Play'; event.currentTarget.setAttribute('aria-pressed', 'false'); return; }
    event.currentTarget.textContent = 'Pause'; event.currentTarget.setAttribute('aria-pressed', 'true');
    timer = setInterval(() => {
      if (index >= data.steps.length - 1) { clearInterval(timer); timer = null; event.currentTarget.textContent = 'Play'; event.currentTarget.setAttribute('aria-pressed', 'false'); return; }
      move(1);
    }, 520);
  });
  render();
})();
</script>`;
}

export async function writeReplayFragment(outputPath: string, result: SolverResult): Promise<void> {
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, renderReplayFragment(result), 'utf8');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character] ?? character);
}
