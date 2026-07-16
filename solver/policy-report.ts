import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PolicyEvaluationReport, PolicySeedRun } from './types';
import { writeReplayHtml } from './visualize';

/** Write one aggregate report plus standalone representative replay pages. */
export async function writePolicyReportHtml(
  filename: string,
  report: PolicyEvaluationReport,
  requestedReplayDirectory?: string,
): Promise<void> {
  const resolved = path.resolve(filename);
  const replayDirectory = path.resolve(
    requestedReplayDirectory
      ?? path.join(path.dirname(resolved), `${path.basename(resolved, path.extname(resolved))}-replays`),
  );
  await mkdir(path.dirname(resolved), { recursive: true });
  await mkdir(replayDirectory, { recursive: true });

  const representatives = representativeRuns(report);
  const replayLinks: Array<{ label: string; seed: number; href: string }> = [];
  for (const representative of representatives) {
    if (!representative.run.result) continue;
    const replayFilename = path.join(
      replayDirectory,
      `${representative.label.toLowerCase().replaceAll(' ', '-')}-seed-${representative.run.seed}.html`,
    );
    await writeReplayHtml(replayFilename, representative.run.result);
    replayLinks.push({
      label: representative.label,
      seed: representative.run.seed,
      href: path.relative(path.dirname(resolved), replayFilename).split(path.sep).join('/'),
    });
  }

  const aggregate = report.aggregate;
  const rows = report.runs.map((run) => {
    const metrics = run.result?.metrics;
    return `<tr>
      <td>${run.index}</td><td>${run.seed}</td><td class="${run.status}">${escapeHtml(run.status)}</td>
      <td>${metrics?.playerDeaths ?? '—'}</td><td>${metrics?.damageTaken ?? '—'}</td>
      <td>${metrics?.turns ?? '—'}</td><td>${metrics?.actions ?? '—'}</td>
      <td>${run.error ? escapeHtml(run.error.split('\n')[0] ?? run.error) : ''}</td>
    </tr>`;
  }).join('\n');
  const replayList = replayLinks.length > 0
    ? `<ul>${replayLinks.map((item) => (
      `<li><a href="${escapeHtml(item.href)}">${escapeHtml(item.label)} — seed ${item.seed}</a></li>`
    )).join('')}</ul>`
    : '<p>No replayable representative was available.</p>';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(report.scenario)} global policy report</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;margin:0;background:#f5f6f8;color:#17191d}main{max-width:1120px;margin:auto;padding:32px}
h1,h2{line-height:1.15}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.card{background:white;border:1px solid #d9dde4;border-radius:10px;padding:14px}.value{font-size:24px;font-weight:700}
table{width:100%;border-collapse:collapse;background:white}th,td{border:1px solid #d9dde4;padding:7px 9px;text-align:right}th{text-align:right;background:#eef1f5}th:nth-child(3),td:nth-child(3),th:last-child,td:last-child{text-align:left}.clear{color:#08752d}.failed,.error{color:#b42318}code{overflow-wrap:anywhere}a{color:#0759b8}
</style></head><body><main>
<h1>${escapeHtml(report.scenario)}</h1>
<p>Deterministic seed-agnostic closed-loop policy on the immutable <strong>${report.manifestSplit}</strong> manifest. Every seed is shown; failures are not filtered. Score priority: failed clears, death-bearing seeds, total deaths, worst damage, CVaR-95 damage, mean damage, turns, actions.</p>
<div class="cards">
  ${card('Clears', `${aggregate.clears}/${aggregate.seeds}`)}
  ${card('Coverage', formatPercent(aggregate.solveCoverage))}
  ${card('Death seeds', String(aggregate.seedsWithDeaths))}
  ${card('Total deaths', String(aggregate.totalDeaths))}
  ${card('Worst damage', formatNumber(aggregate.worstDamage))}
  ${card('CVaR-95', formatNumber(aggregate.cvar95Damage))}
  ${card('Mean damage', formatNumber(aggregate.meanDamage))}
  ${card('Mean turns', formatNumber(aggregate.meanTurns))}
</div>
<h2>Identity</h2>
<p>Scenario <code>${report.scenarioFingerprint.instanceSha256}</code><br>Manifest <code>${report.manifestFingerprint}</code><br>Policy <code>${report.policyFingerprint}</code><br>Lexicographic score <code>[${report.score.map(formatNumber).join(', ')}]</code></p>
<h2>Representative replays</h2>${replayList}
<h2>Every evaluated seed</h2>
<table><thead><tr><th>#</th><th>Seed</th><th>Status</th><th>Deaths</th><th>Damage</th><th>Turns</th><th>Actions</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>
</main></body></html>`;
  await writeFile(resolved, html, 'utf8');
}

function representativeRuns(report: PolicyEvaluationReport): Array<{ label: string; run: PolicySeedRun }> {
  const requested: Array<[string, number | undefined]> = [
    ['Typical', report.representatives.typicalSeed],
    ['Worst successful', report.representatives.worstSuccessfulSeed],
    ['Failed', report.representatives.failedSeed],
  ];
  const seen = new Set<number>();
  return requested.flatMap(([label, seed]) => {
    if (seed === undefined || seen.has(seed)) return [];
    const run = report.runs.find((candidate) => candidate.seed === seed);
    if (!run) return [];
    seen.add(seed);
    return [{ label, run }];
  });
}

function card(label: string, value: string): string {
  return `<div class="card"><div>${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}
