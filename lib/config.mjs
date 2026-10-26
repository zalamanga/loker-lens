import path from 'node:path';
import { Problem } from './errors.mjs';

export const LIMITS = Object.freeze({
  sourceBodyBytes: 4 * 1024 * 1024,
  sourceTotalBytes: 32 * 1024 * 1024,
  cacheBytes: 16 * 1024 * 1024,
  termsPerKind: 2000,
  jobs: 4000,
  sourceRequestMs: 20_000,
  syncMs: 60_000,
  cacheFreshMs: 30 * 60_000,
  pageSize: 100,
});

function integer(env, key, fallback, minimum, maximum) {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
    throw new Problem('configuration', `${key} harus berupa bilangan bulat ${minimum} sampai ${maximum}.`, 503);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Problem('configuration', `${key} harus berupa bilangan bulat ${minimum} sampai ${maximum}.`, 503);
  }
  return value;
}

export function readConfiguration(root, env = process.env) {
  const mode = env.LOKER_MODE ?? 'demo';
  if (!['demo', 'live'].includes(mode)) throw new Problem('configuration', 'LOKER_MODE hanya menerima demo atau live.', 503);
  const dataRoot = env.LOKER_DATA_DIR === undefined ? path.join(root, '.data', mode) : env.LOKER_DATA_DIR;
  if (typeof dataRoot !== 'string' || !dataRoot || !path.isAbsolute(dataRoot) || dataRoot.includes('\0')) {
    throw new Problem('configuration', 'LOKER_DATA_DIR harus berupa lokasi absolut yang valid.', 503);
  }
  return Object.freeze({
    mode,
    port: integer(env, 'PORT', 3000, 1, 65535),
    maxPages: integer(env, 'MAX_PAGES', 40, 1, 40),
    lookbackMonths: integer(env, 'LOOKBACK_MONTHS', 2, 1, 12),
    dataRoot: path.resolve(dataRoot),
  });
}
