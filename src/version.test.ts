import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from './index';
import { CORE_VERSION } from './core';
import { SDK_VERSION, SDK_LIBRARY } from './sdk';
import { BACKEND_VERSION } from './backend';
import { FRONTEND_VERSION } from './frontend';

/**
 * Version constants drifted once: the package reached 0.5.0 while the SDK still
 * stamped every event with `event-analyzer-sdk/0.1.0`, which makes "which
 * version sent this" unanswerable in production. This makes that drift a test
 * failure instead of a discovery.
 */
describe('version constants', () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
  ) as { version: string };

  it.each([
    ['VERSION', VERSION],
    ['CORE_VERSION', CORE_VERSION],
    ['SDK_VERSION', SDK_VERSION],
    ['BACKEND_VERSION', BACKEND_VERSION],
    ['FRONTEND_VERSION', FRONTEND_VERSION],
  ])('%s matches package.json', (_name, value) => {
    expect(value).toBe(pkg.version);
  });

  it('stamps the library tag every event carries', () => {
    expect(SDK_LIBRARY).toBe(`event-analyzer-sdk/${pkg.version}`);
  });
});
