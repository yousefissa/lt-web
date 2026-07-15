import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Database } from '../src/data/database';
import { ResourceManager } from '../src/data/resource-manager';

export class FileResourceManager extends ResourceManager {
  readonly rootPath: string;
  private fileJsonCache: Map<string, unknown>;

  constructor(rootPath: string) {
    super(rootPath);
    this.rootPath = path.resolve(rootPath);
    this.fileJsonCache = new Map();
  }

  override async loadJson<T>(relativePath: string): Promise<T> {
    const normalized = relativePath.split('/').join(path.sep);
    const absolutePath = path.resolve(this.rootPath, normalized);
    const expectedPrefix = this.rootPath.endsWith(path.sep)
      ? this.rootPath
      : `${this.rootPath}${path.sep}`;
    if (absolutePath !== this.rootPath && !absolutePath.startsWith(expectedPrefix)) {
      throw new Error(`Refusing to read outside project root: ${relativePath}`);
    }

    const cached = this.fileJsonCache.get(absolutePath);
    if (cached !== undefined) return cached as T;

    const raw = await readFile(absolutePath, 'utf8');
    const data = JSON.parse(raw) as T;
    this.fileJsonCache.set(absolutePath, data);
    return data;
  }

  override async tryLoadJson<T>(relativePath: string): Promise<T | null> {
    try {
      return await this.loadJson<T>(relativePath);
    } catch {
      return null;
    }
  }

  override async tryLoadJsonSilent<T>(relativePath: string): Promise<T | null> {
    return this.tryLoadJson<T>(relativePath);
  }
}

export interface LoadedSolverProject {
  db: Database;
  resources: FileResourceManager;
  projectPath: string;
}

export async function loadSolverProject(projectPath: string): Promise<LoadedSolverProject> {
  const resolved = path.resolve(projectPath);
  const resources = new FileResourceManager(resolved);
  const db = new Database();
  await db.load(resources);
  return { db, resources, projectPath: resolved };
}
