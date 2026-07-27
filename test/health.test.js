import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';

import { checkService, stackSnapshot } from '../health.js';


async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}


// Each backend Service publishes actuator on its own port; there is no shared
// 8080. Verified against PreDev (ns caritas) on 2026-07-26 by reading back
// /actuator/health from inside the cluster. Port 8080 times out on all four.
const DEPLOYED_ENDPOINTS = {
  AgencyService: 'http://oriso-platform-agencyservice.caritas.svc.cluster.local:8084/actuator/health',
  ConsultingTypeService:
    'http://oriso-platform-consultingtypeservice.caritas.svc.cluster.local:8083/actuator/health',
  TenantService: 'http://oriso-platform-tenantservice.caritas.svc.cluster.local:8081/actuator/health',
  UserService: 'http://oriso-platform-userservice.caritas.svc.cluster.local:8082/actuator/health',
};


test('service catalog points at the deployed Helm service names and ports', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const catalog = config.services;
  assert.deepEqual(
    Object.fromEntries(Object.entries(catalog).map(([key, service]) => [key, service.url])),
    DEPLOYED_ENDPOINTS,
  );
});


test('no backend is probed on a port that serves nothing', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const catalog = config.services;
  const ports = Object.values(catalog).map(service => new URL(service.url).port);

  // A single repeated port is the signature of the 8080 regression: every
  // backend answers on a distinct port, so duplicates mean at least one is wrong.
  assert.equal(new Set(ports).size, ports.length, `ports must be distinct, got ${ports}`);
  assert.equal(ports.includes('8080'), false, 'no backend actuator is served on 8080');
});


test('dashboard UI does not hardcode stack versions or stale service endpoints', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal(html.includes('19.2.3'), false);
  assert.equal(html.includes('http://oriso-userservice.caritas.svc.cluster.local'), false);
  assert.equal(html.includes('http://oriso-agencyservice.caritas.svc.cluster.local'), false);
});


test('a service is UP only for a successful actuator JSON body', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'UP', components: { db: { status: 'UP' } } }));
    },
    async baseUrl => {
      const result = await checkService({ name: 'Healthy', url: `${baseUrl}/actuator/health` });
      assert.equal(result.up, true);
      assert.equal(result.code, 200);
      assert.equal(result.body.status, 'UP');
    },
  );
});


test('HTTP 200 with a non-health body is DOWN', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>temporary error page</html>');
    },
    async baseUrl => {
      const result = await checkService({ name: 'Misleading', url: `${baseUrl}/actuator/health` });
      assert.equal(result.up, false);
      assert.equal(result.code, 200);
      assert.match(result.error, /valid actuator/i);
    },
  );
});


test('a hung service is bounded by the configured timeout', async () => {
  await withServer(
    () => {},
    async baseUrl => {
      const startedAt = Date.now();
      const result = await checkService(
        { name: 'Hung', url: `${baseUrl}/actuator/health` },
        { timeoutMs: 30 },
      );
      assert.equal(result.up, false);
      assert.match(result.error, /timed out/i);
      assert.ok(Date.now() - startedAt < 500);
    },
  );
});


test('stack status is derived from current health evidence', () => {
  const catalog = {
    UserService: { name: 'UserService', url: 'http://user/actuator/health' },
    AgencyService: { name: 'AgencyService', url: 'http://agency/actuator/health' },
  };
  const snapshot = stackSnapshot(catalog, {
    UserService: { up: true, code: 200, body: { status: 'UP' } },
    AgencyService: { up: false, code: 503, body: { status: 'DOWN' } },
  });

  assert.equal(snapshot.UserService.status, 'available');
  assert.equal(snapshot.AgencyService.status, 'unavailable');
  assert.equal(snapshot.UserService.java, null);
  assert.equal(snapshot.UserService.springBoot, null);
  assert.equal(snapshot.UserService.spring, null);
  assert.equal(snapshot.UserService.evidence, 'live-health-readback');
});
