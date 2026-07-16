export interface EngineParityItem {
  nid: string;
  uses: number;
}

export interface EngineParityUnit {
  nid: string;
  team: string;
  klass: string;
  level: number;
  exp: number;
  hp: number;
  maxHp: number;
  position: [number, number] | null;
  dead: boolean;
  hasAttacked: boolean;
  hasMoved: boolean;
  hasTraded: boolean;
  finished: boolean;
  items: EngineParityItem[];
}

/** Renderer-independent action-boundary state shared by solver and harness. */
export interface EngineParityState {
  turn: number;
  phase: string | null;
  rngState: number | null;
  units: EngineParityUnit[];
  activeRegions: string[];
  visibleLayers: string[];
}

export interface ParityDifference {
  path: string;
  expected: unknown;
  actual: unknown;
}

/** Return field-level differences suitable for a failing differential replay. */
export function diffParityStates(
  expected: EngineParityState,
  actual: EngineParityState,
): ParityDifference[] {
  const differences: ParityDifference[] = [];
  compareValue(expected, actual, '', differences);
  return differences;
}

function compareValue(
  expected: unknown,
  actual: unknown,
  path: string,
  differences: ParityDifference[],
): void {
  if (Object.is(expected, actual)) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      differences.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
    }
    for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
      compareValue(expected[index], actual[index], `${path}[${index}]`, differences);
    }
    return;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of Array.from(keys).sort()) {
      compareValue(expected[key], actual[key], path ? `${path}.${key}` : key, differences);
    }
    return;
  }
  differences.push({ path: path || '<root>', expected, actual });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
