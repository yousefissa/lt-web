import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BenchmarkFingerprint, SolverScenario } from './types';

const FINGERPRINT_VERSION = 1 as const;

/** Bind a saved route to gameplay inputs, project data, RNG mode, and seed. */
export async function computeBenchmarkFingerprint(
  scenario: SolverScenario,
  projectPath: string,
  sourceRoot: string = process.cwd(),
): Promise<BenchmarkFingerprint> {
  const gameplayScenario = gameplayScenarioData(scenario);
  const scenarioSha256 = sha256(stableStringify(gameplayScenario));
  const projectDataSha256 = await hashProjectData(projectPath);
  const engineSourceSha256 = await hashEngineSource(sourceRoot);
  const instanceSha256 = sha256(
    `${FINGERPRINT_VERSION}:${scenarioSha256}:${projectDataSha256}:${engineSourceSha256}`,
  );
  return {
    version: FINGERPRINT_VERSION,
    scenarioSha256,
    projectDataSha256,
    engineSourceSha256,
    instanceSha256,
  };
}

export function benchmarkFingerprintsEqual(
  a: BenchmarkFingerprint | undefined,
  b: BenchmarkFingerprint,
): boolean {
  return !!a
    && a.version === b.version
    && a.scenarioSha256 === b.scenarioSha256
    && a.projectDataSha256 === b.projectDataSha256
    && a.engineSourceSha256 === b.engineSourceSha256
    && a.instanceSha256 === b.instanceSha256;
}

function gameplayScenarioData(scenario: SolverScenario): Omit<SolverScenario, 'name' | 'notes' | 'project'> {
  const { name: _name, notes: _notes, project: _project, ...gameplay } = scenario;
  return gameplay;
}

async function hashProjectData(projectPath: string): Promise<string> {
  const files = await listGameplayDataFiles(projectPath);
  const hash = createHash('sha256');
  for (const filename of files) {
    const relative = path.relative(projectPath, filename).split(path.sep).join('/');
    const contents = await readFile(filename);
    hash.update(`${relative.length}:${relative}:${contents.length}:`);
    hash.update(contents);
  }
  return hash.digest('hex');
}

async function hashEngineSource(sourceRoot: string): Promise<string> {
  const srcFiles = await listFiles(path.join(sourceRoot, 'src'), (name) => name.endsWith('.ts'));
  const solverFiles = [
    'event-adapter.ts',
    'project-loader.ts',
    'simulator.ts',
    'types.ts',
  ].map((name) => path.join(sourceRoot, 'solver', name));
  const files = [...srcFiles, ...solverFiles].sort();
  const hash = createHash('sha256');
  for (const filename of files) {
    const relative = path.relative(sourceRoot, filename).split(path.sep).join('/');
    const contents = await readFile(filename);
    hash.update(`${relative.length}:${relative}:${contents.length}:`);
    hash.update(contents);
  }
  return hash.digest('hex');
}

async function listGameplayDataFiles(root: string): Promise<string[]> {
  return listFiles(root, isGameplayDataFile);
}

async function listFiles(root: string, include: (name: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && include(entry.name)) files.push(filename);
    }
  }
  await visit(root);
  return files.sort();
}

function isGameplayDataFile(name: string): boolean {
  return name === '.orderkeys' || /\.(json|py|txt|csv|ltproj)$/i.test(name);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
