import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const dashboard = new URL('../server.js', import.meta.url);
const directory = path.dirname(fileURLToPath(dashboard));
const exec = promisify(execFile);

async function availablePort() {
  const listener = createHttpServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function issuerCertificate(t) {
  const fixture = await mkdtemp(path.join(directory, '.test-dashboard-tls-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const config = path.join(fixture, 'openssl.cnf');
  const cert = path.join(fixture, 'issuer.crt');
  const key = path.join(fixture, 'issuer.key');
  await writeFile(config, [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = fixture',
    'prompt = no',
    '[dn]',
    'CN = 127.0.0.1',
    '[fixture]',
    'subjectAltName = IP:127.0.0.1'
  ].join('\n'));
  await exec('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-config', config, '-out', cert, '-keyout', key
  ]);
  return { certPath: cert, cert: await readFile(cert), key: await readFile(key) };
}

async function startDashboard(t, env = {}) {
  const fixture = await mkdtemp(path.join(directory, '.test-dashboard-'));
  let child;
  let exited;
  t.after(async () => {
    if (child) {
      child.kill();
      await exited;
    }
    await rm(fixture, { recursive: true, force: true });
  });
  await symlink(path.join(directory, 'public'), path.join(fixture, 'public'), 'dir');
  await writeFile(path.join(fixture, 'config.json'), JSON.stringify({
    services: { fixture: { name: 'Fixture', url: 'http://127.0.0.1:1/internal' } }
  }));
  const port = await availablePort();
  child = spawn(process.execPath, [fileURLToPath(dashboard)], {
    cwd: fixture,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  exited = once(child, 'exit');
  const { promise, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(() => reject(new Error('Dashboard did not start')), 5000);
  try {
    child.stdout.once('data', () => resolve());
    child.once('exit', () => reject(new Error('Dashboard exited before starting')));
    await promise;
  } finally {
    clearTimeout(timer);
  }
  return (route, options) => fetch(`http://127.0.0.1:${port}${route}`, options);
}

test('unconfigured dashboard keeps public status and denies inventory', async t => {
  const get = await startDashboard(t);
  const response = await get('/api/services');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { fixture: { name: 'Fixture' } });
  assert.equal((await get('/api/helm-workloads')).status, 403);
  const session = await get('/api/operator-session');
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    login: null,
    authenticated: false,
    canViewHelmImages: false
  });
});


test('HTTP issuer stays closed even in tests with the private dashboard mode', async t => {
  const get = await startDashboard(t, {
    ORISO_PUBLIC_MODE: 'false',
    ORISO_DASHBOARD_OIDC_ISSUER: 'http://127.0.0.1:1/auth/realms/fixture',
    ORISO_DASHBOARD_OIDC_CLIENT_ID: 'health-dashboard'
  });
  assert.equal((await get('/api/helm-workloads')).status, 403);
  assert.deepEqual(await (await get('/api/operator-session')).json(), {
    login: null,
    authenticated: false,
    canViewHelmImages: false
  });
});

test('configured dashboard gates inventory on a verified dedicated client role only', async t => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const exported = await exportJWK(publicKey);
  const realm = '/auth/realms/fixture';
  const { certPath, cert, key } = await issuerCertificate(t);
  const keySet = createHttpsServer({ cert, key }, (req, res) => {
    if (req.url !== realm + '/protocol/openid-connect/certs') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [{ ...exported, kid: 'fixture-key', use: 'sig', alg: 'RS256' }] }));
  }).listen(0, '127.0.0.1');
  await once(keySet, 'listening');
  t.after(() => new Promise(resolve => keySet.close(resolve)));
  const url = `https://127.0.0.1:${keySet.address().port}`;
  const issuer = url + realm;
  const clientId = 'health-dashboard';
  const get = await startDashboard(t, {
    NODE_EXTRA_CA_CERTS: certPath,
    ORISO_DASHBOARD_OIDC_ISSUER: issuer,
    ORISO_DASHBOARD_OIDC_CLIENT_ID: clientId
  });

  const login = { url: url + '/auth', realm: 'fixture', clientId };
  const anonymous = { login, authenticated: false, canViewHelmImages: false };
  const allowed = { login, authenticated: true, canViewHelmImages: true };
  const claims = {
    iss: issuer,
    sub: 'fixture-operator',
    aud: clientId,
    azp: clientId,
    typ: 'Bearer',
    exp: Math.floor(Date.now() / 1000) + 120,
    resource_access: { [clientId]: { roles: ['view-helm-images'] } }
  };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .sign(privateKey);
  const as = bearer => ({ headers: { Authorization: 'Bearer ' + bearer } });
  const session = await get('/api/operator-session', as(token));
  assert.equal(session.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await session.json(), allowed);
  const inventory = await get('/api/helm-workloads', as(token));
  assert.equal(inventory.headers.get('Cache-Control'), 'private, no-store');
  // The authorized call reaches inventory handling, but this fixture has no Kubernetes API.
  assert.equal(inventory.status, 503);
  assert.deepEqual((await inventory.json()).workloads, []);
  assert.deepEqual(await (await get('/api/services', as(token))).json(), { fixture: { name: 'Fixture' } });
  const check = await (await get('/api/health/fixture', as(token))).json();
  assert.deepEqual(Object.keys(check).sort(), ['checkedAt', 'status']);
  assert.equal((await get('/api/quick-links', as(token))).status, 403);
  assert.equal((await get('/api/cron/run', { ...as(token), method: 'POST' })).status, 403);

  assert.deepEqual(await (await get('/api/operator-session')).json(), anonymous);
  assert.equal((await get('/api/helm-workloads')).status, 403);
  assert.equal((await get('/auth/callback')).status, 200);
  assert.equal((await get('/vendor/keycloak/keycloak.js')).status, 200);
  assert.equal((await get('/vendor/keycloak/deprecations.js')).status, 200);

  const wrongSigner = (await generateKeyPair('RS256')).privateKey;
  const invalidCases = [
    ['different issuer', { iss: 'https://other.example/auth/realms/fixture' }, privateKey, false],
    ['different audience', { aud: 'app' }, privateKey, false],
    ['different authorized party', { azp: 'app' }, privateKey, false],
    ['wrong token type', { typ: 'ID' }, privateKey, false],
    ['expired', { exp: 1 }, privateKey, false],
    ['missing expiration', { exp: undefined }, privateKey, false],
    ['wrong signature', {}, wrongSigner, false],
    ['realm role alone', {
      realm_access: { roles: ['view-helm-images'] },
      resource_access: {}
    }, privateKey, true],
    ['different client with this role', {
      resource_access: { app: { roles: ['view-helm-images'] } }
    }, privateKey, true],
    ['malformed roles claim', {
      resource_access: { [clientId]: { roles: 'view-helm-images' } }
    }, privateKey, true]
  ];
  for (const [label, changes, signer, authenticated] of invalidCases) {
    const bearer = await new SignJWT({ ...claims, ...changes })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .sign(signer);
    const result = await get('/api/operator-session', as(bearer));
    assert.deepEqual(await result.json(), { ...anonymous, authenticated }, label);
    assert.equal((await get('/api/helm-workloads', as(bearer))).status, 403, label);
  }
});
