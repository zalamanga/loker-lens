import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ApplicationQueue } from '../lib/board-store.mjs';
import { createBoard } from '../lib/board.mjs';
import { collectDaily } from '../lib/daily.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: { query: { type: 'string' }, location: { type: 'string' }, config: { type: 'string' } } });
let board; let ownedService;
try {
  let config = values;
  if (values.config) {
    if (values.query !== undefined || values.location !== undefined) throw new Error('Pilih --config atau --query/--location.');
    config = JSON.parse(await readFile(path.resolve(values.config), 'utf8'));
  }
  const query = typeof config.query === 'string' ? config.query.trim() : '';
  const location = config.location === undefined ? '' : config.location;
  if (!query || query.length > 120 || typeof location !== 'string' || location.length > 100) throw new Error('Isi --query (maksimal 120 karakter) dan lokasi opsional (maksimal 100).');
  const queue = new ApplicationQueue({ filename: path.join(root, '.data/board/applications.sqlite') });
  try { board = createBoard({ queue, apiURL: 'http://127.0.0.1:8131/' }); }
  catch (error) { queue.close(); throw error; }
  if (board.status().quota.remaining > 0) {
    let reachable = false;
    try { const response = await fetch('http://127.0.0.1:8131/health', { signal: AbortSignal.timeout(2000), redirect: 'error' }); reachable = response.ok; await response.body?.cancel(); }
    catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
    if (!reachable) {
      const python = path.join(root, '.local/jobstreet-service/venv/Scripts/python.exe');
      await readFile(path.join(root, '.local/jobstreet-service/dependencies.sha256'));
      const temp = path.join(root, '.local/tmp'); await mkdir(temp, { recursive: true });
      ownedService = spawn(python, ['-I', '-X', `pycache_prefix=${path.join(root, '.local/jobstreet-service/pycache')}`, path.join(root, 'scripts/jobstreet-service.py')], {
        windowsHide: true, stdio: 'ignore', env: { ...process.env, TEMP: temp, TMP: temp },
      });
      let launchError;
      ownedService.once('error', error => { launchError = error; });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await delay(250);
        if (launchError || ownedService.exitCode !== null) throw new Error('Layanan JobStreet gagal dimulai. Periksa scripts/Start-JobStreet.ps1.');
        try { const response = await fetch('http://127.0.0.1:8131/health', { signal: AbortSignal.timeout(1000), redirect: 'error' }); reachable = response.ok; await response.body?.cancel(); if (reachable) break; } catch {}
      }
      if (!reachable) throw new Error('Layanan JobStreet tidak siap. Jalankan scripts/Start-JobStreet.ps1 -SetupOnly dahulu.');
    }
  }
  console.log(JSON.stringify(await collectDaily({ board, query, location }), null, 2));
} catch (error) {
  console.error(error.code ? `${error.code}: ${error.message}` : error.message);
  process.exitCode = 1;
} finally {
  board?.close();
  if (ownedService && ownedService.exitCode === null) ownedService.kill();
}
