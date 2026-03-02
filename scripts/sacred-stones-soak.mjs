#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const iterationsRaw = process.env.SOAK_ITERATIONS ?? '5';
const iterations = Number.parseInt(iterationsRaw, 10);
if (!Number.isFinite(iterations) || iterations <= 0) {
  console.error(`[soak] Invalid SOAK_ITERATIONS value: ${iterationsRaw}`);
  process.exit(1);
}

const grepPattern =
  process.env.SOAK_GREP ??
  'Sacred Stones Later Chapters|Sacred Stones Chapter Mechanics|Level Progression';
const workers = process.env.SOAK_WORKERS ?? '1';

console.log(`[soak] Starting Sacred Stones reliability soak (${iterations} iterations)`);
console.log(`[soak] grep: ${grepPattern}`);
console.log(`[soak] workers: ${workers}`);

for (let i = 1; i <= iterations; i++) {
  console.log(`\n[soak] Iteration ${i}/${iterations}`);
  const result = spawnSync(
    'npx',
    [
      'playwright',
      'test',
      'tests/harness.spec.ts',
      '--grep',
      grepPattern,
      '--workers',
      workers,
    ],
    {
      stdio: 'inherit',
      env: process.env,
    },
  );

  if (result.status !== 0) {
    console.error(`[soak] FAILED at iteration ${i}/${iterations}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\n[soak] PASS: ${iterations}/${iterations} iterations succeeded`);
