import { validateSnapshot } from '../public/model.mjs';
import { matchContent } from './jobs.mjs';
import { Problem } from './errors.mjs';
import { LIMITS } from './config.mjs';

export function snapshotDecoder(mode) {
  return (bytes) => {
    try {
      if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.cacheBytes) throw new TypeError('Cache size invalid.');
      const value = validateSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), mode);
      for (const job of value.jobs) {
        const matches = matchContent([job.title, job.summary, job.content.text].join(' '));
        if (JSON.stringify(matches) !== JSON.stringify(job.matches)) throw new TypeError('Derived matches differ.');
      }
      return value;
    } catch (error) { throw new Problem('cache_schema', 'Snapshot cache tidak sesuai versi, asal atau batas aplikasi.', 503, { cause: error }); }
  };
}
