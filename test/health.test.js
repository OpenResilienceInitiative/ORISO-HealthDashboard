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


test('service catalog points at the deployed Helm service names and ports', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    Object.values(catalog).map(service => service.url).sort(),
    [
      'http://oriso-platform-agencyservice.caritas.svc.cluster.local:8080/actuator/health',
      'http://oriso-platform-consultingtypeservice.caritas.svc.cluster.local:8080/actuator/health',
      'http://oriso-platform-tenantservice.caritas.svc.cluster.local:8080/actuator/health',
      'http://oriso-platform-userservice.caritas.svc.cluster.local:8080/actuator/health',
    ],
  );
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
