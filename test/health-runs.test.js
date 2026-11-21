import assert from 'node:assert/strict';
import test from 'node:test';

import { createHealthRuns } from '../health-runs.js';
import { publicStatus } from '../public-view.js';

function deferredCheck() {
  let finish;
  const result = new Promise(resolve => {
    finish = resolve;
  });
  return { result, finish };
}

test('overlapping runs keep their own result without publishing an older snapshot', async t => {
  const olderStart = '2026-11-21T01:00:00.000Z';
  const newerStart = '2026-11-21T01:00:01.000Z';
  let timestamp = olderStart;
  t.mock.method(Date.prototype, 'toISOString', () => timestamp);
  const olderCheck = deferredCheck();
  const newerCheck = deferredCheck();
  const checks = [olderCheck, newerCheck];
  let started = 0;
  const healthRuns = createHealthRuns(() => checks[started++].result, publicStatus);

  const olderRun = healthRuns.run();
  timestamp = newerStart;
  const newerRun = healthRuns.run();
  assert.equal(started, 2);
  assert.deepEqual(healthRuns.getRuns(), []);
  assert.equal(healthRuns.getStatus('userservice'), undefined);

  timestamp = '2026-11-21T01:00:02.000Z';
  newerCheck.finish({ userservice: { up: false, body: { status: 'DEGRADED' } } });
  const newer = await newerRun;
  assert.deepEqual(newer, {
    id: 2,
    timestamp: newerStart,
    results: { userservice: 'DOWN' },
    overall: 'PARTIAL_DOWN'
  });
  assert.deepEqual(healthRuns.getStatus('userservice'), { status: 'DEGRADED', checkedAt: newer.timestamp });

  timestamp = '2026-11-21T01:00:03.000Z';
  olderCheck.finish({ userservice: { up: true } });
  const older = await olderRun;
  assert.deepEqual(older, {
    id: 1,
    timestamp: olderStart,
    results: { userservice: 'UP' },
    overall: 'ALL_UP'
  });
  assert.deepEqual(healthRuns.getRuns(), [newer, older]);
  assert.deepEqual(healthRuns.getStatus('userservice'), { status: 'DEGRADED', checkedAt: newer.timestamp });
});

test('an older completion cannot evict any of the ten latest started runs from history', async () => {
  const olderCheck = deferredCheck();
  let started = 0;
  const up = { userservice: { up: true } };
  const healthRuns = createHealthRuns(() => ++started === 1 ? olderCheck.result : up, publicStatus);
  const olderRun = healthRuns.run();
  const newerRuns = [];
  for (let i = 0; i < 10; i++) {
    newerRuns.push(await healthRuns.run());
  }

  olderCheck.finish({ userservice: { up: false } });
  assert.equal((await olderRun).id, 1);
  assert.deepEqual(healthRuns.getRuns(), newerRuns.reverse());
  assert.deepEqual(healthRuns.getStatus('userservice'), { status: 'UP', checkedAt: newerRuns[0].timestamp });
});
