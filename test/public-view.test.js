import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { isPublicMode, publicHealth, publicServices, publicStatus } from '../public-view.js';


test('public mode is on unless explicitly disabled', () => {
  assert.equal(isPublicMode({}), true);
  assert.equal(isPublicMode({ ORISO_PUBLIC_MODE: 'true' }), true);
  assert.equal(isPublicMode({ ORISO_PUBLIC_MODE: 'FALSE' }), false);
});


test('public services expose display names only, no URLs', () => {
  const shaped = publicServices({
    userservice: { name: 'UserService', url: 'http://userservice.caritas.svc.cluster.local:8080/actuator/health' },
    nameless: { url: 'http://internal:1/health' }
  });
  assert.deepEqual(shaped, { userservice: { name: 'UserService' }, nameless: { name: 'nameless' } });
  assert.equal(JSON.stringify(shaped).includes('http'), false);
});


test('public status collapses check results to UP, DEGRADED or DOWN', () => {
  assert.equal(publicStatus({ up: true, body: { status: 'UP' } }), 'UP');
  assert.equal(publicStatus({ up: false, body: { status: 'DEGRADED' } }), 'DEGRADED');
  assert.equal(publicStatus({ up: false, code: 0, body: null, error: 'connect ECONNREFUSED 10.0.0.1:8080' }), 'DOWN');
  assert.equal(publicStatus(undefined), 'UNKNOWN');
});


test('public health carries no url, error, httpCode or actuator body', () => {
  assert.deepEqual(publicHealth(undefined), { status: 'UNKNOWN', checkedAt: null });
  const shaped = publicHealth({ status: 'DOWN', checkedAt: '2026-11-13T10:00:00.000Z' });
  assert.deepEqual(Object.keys(shaped).sort(), ['checkedAt', 'status']);
});


test('operator-only endpoints are refused in public mode', () => {
  // Guards the wiring in server.js: each of these must short-circuit to 403
  // before doing any work when PUBLIC_MODE is on.
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  for (const route of ["app.get('/api/quick-links'", "app.get('/api/helm-workloads'", "app.post('/api/cron/run'"]) {
    const start = server.indexOf(route);
    assert.notEqual(start, -1, `${route} is missing`);
    const handler = server.slice(start, server.indexOf('\n});', start));
    assert.match(handler, /if \(PUBLIC_MODE\) return res\.status\(403\)/, `${route} is not gated`);
  }
});
