export async function collectDaily({ board, query, location = '' }) {
  const initial = board.status();
  const already = new Set(initial.queue.map(job => `${job.provider}:${job.jobId}`));
  let added = 0; let skipped = 0; let pages = 0;
  while (pages < 5 && board.status().quota.remaining > 0) {
    const result = await board.search({ provider: 'jobstreet', query, location, page: pages + 1 });
    pages += 1;
    for (const job of result.jobs) {
      const key = `${job.provider}:${job.jobId}`;
      if (already.has(key)) { skipped += 1; continue; }
      if (board.status().quota.remaining <= 0) break;
      try { board.add(job); already.add(key); added += 1; }
      catch (error) { if (error.code === 'quota') break; throw error; }
    }
    if (!result.hasMore) break;
  }
  return { day: board.status().quota.day, added, duplicatesSkipped: skipped, pagesRead: pages, quota: board.status().quota, applicationsSent: 0 };
}
