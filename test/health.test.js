import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';

import { checkService } from '../health.js';


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


function catalog() {
  const raw = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  return raw.services;
}


// Mirrors the health-dashboard ConfigMap in ORISO-Helm, which overrides this
// file at deploy time. The two disagreeing is what produced a dashboard
// pointing at names that do not resolve, so they are pinned together here.
// Verified in ns caritas on 2026-07-26: all four answer {"status":"UP"}.
const DEPLOYED_ENDPOINTS = {
  TenantService: 'http://tenantservice.caritas.svc.cluster.local:8081/actuator/health',
  UserService: 'http://userservice.caritas.svc.cluster.local:8080/actuator/health',
  ConsultingTypeService: 'http://consultingtypeservice.caritas.svc.cluster.local:8080/actuator/health',
  AgencyService: 'http://agencyservice.caritas.svc.cluster.local:8080/actuator/health'
};


test('the catalog matches the Service names the chart deploys', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(catalog()).map(([key, service]) => [key, service.url])),
    DEPLOYED_ENDPOINTS
  );
});


test('no service is probed under a hostname that does not exist', () => {
  // `oriso-<service>` was the shipped default and is NXDOMAIN in the cluster;
  // the deployed Services are unprefixed or carry the release prefix.
  for (const service of Object.values(catalog())) {
    const { hostname } = new URL(service.url);
    assert.equal(
      /^oriso-(tenant|user|agency|consultingtype)service\./.test(hostname),
      false,
      `${hostname} does not resolve in the cluster`
    );
  }
});


test('quick links survive alongside the service catalog', () => {
  // config.json carries both sections since #28; readConfig() falls back to
  // treating the whole file as the service map, so losing the wrapper would
  // silently turn the quick links into services.
  const raw = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.ok(raw.services, 'config.json must keep the services wrapper');
  assert.ok(Array.isArray(raw.quickLinks) && raw.quickLinks.length > 0);
});


test('the dashboard no longer ships fabricated stack versions', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.equal(server.includes('/api/stack-versions'), false);
  assert.equal(server.includes("springBoot: '4.0.1'"), false);
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
    }
  );
});


test('HTTP 200 with a non-health body is DOWN', async () => {
  // The previous cron check did `catch { up = true }`, so a proxy error page
  // served with HTTP 200 was reported as healthy.
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
    }
  );
});


test('an actuator reporting DOWN is DOWN even with HTTP 200', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'DOWN' }));
    },
    async baseUrl => {
      const result = await checkService({ name: 'Degraded', url: `${baseUrl}/actuator/health` });
      assert.equal(result.up, false);
      assert.match(result.error, /DOWN/);
    }
  );
});


test('a hung service is bounded by the configured timeout', async () => {
  await withServer(
    () => {},
    async baseUrl => {
      const startedAt = Date.now();
      const result = await checkService(
        { name: 'Hung', url: `${baseUrl}/actuator/health` },
        { timeoutMs: 30 }
      );
      assert.equal(result.up, false);
      assert.match(result.error, /timed out/i);
      assert.ok(Date.now() - startedAt < 500);
    }
  );
});


test('a refused connection is DOWN rather than an unhandled rejection', async () => {
  const result = await checkService({
    name: 'Gone',
    url: 'http://127.0.0.1:1/actuator/health'
  });
  assert.equal(result.up, false);
  assert.equal(result.code, 0);
});
