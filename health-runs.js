const MAX_RUNS = 10;

export function createHealthRuns(check, toPublicStatus) {
  let nextRunId = 0;
  let latestCompletedRunId = 0;
  let latestStatus = {};
  const runs = [];

  async function run() {
    const id = ++nextRunId;
    const timestamp = new Date().toISOString();
    const readback = Object.entries(await check());
    const entry = {
      id,
      timestamp,
      results: Object.fromEntries(readback.map(([key, result]) => [key, result.up ? 'UP' : 'DOWN'])),
      overall: readback.every(([, result]) => result.up) ? 'ALL_UP' : 'PARTIAL_DOWN'
    };

    // A slower run that started earlier must not replace the current snapshot.
    if (id > latestCompletedRunId) {
      latestStatus = Object.fromEntries(readback.map(([key, result]) => [key, {
        status: toPublicStatus(result),
        checkedAt: timestamp
      }]));
      latestCompletedRunId = id;
    }

    runs.push(entry);
    runs.sort((a, b) => b.id - a.id);
    if (runs.length > MAX_RUNS) runs.pop();
    return entry;
  }

  return {
    run,
    getRuns: () => runs.slice(),
    getStatus: key => latestStatus[key]
  };
}
