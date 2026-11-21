import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const dashboard = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dashboardScript = dashboard.match(/<script>([\s\S]*?)<\/script>/)[1];

async function renderHelmInventory(container) {
  const details = {};
  const element = () => ({ style: {}, appendChild() {} });
  const inventory = {
    namespace: 'namespace',
    generatedAt: '2026-11-19T00:00:00Z',
    workloads: [{
      kind: 'Deployment',
      name: 'fixture-workload',
      containers: [container],
      pods: [{ ready: true }]
    }]
  };

  const context = vm.createContext({
    document: {
      getElementById: id => id === 'svc-details' ? details : element(),
      createElement: element
    },
    window: { location: { pathname: '/' } },
    fetch: path => path === '/api/services'
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, json: async () => inventory })
  });

  await vm.runInContext(dashboardScript + '\nshowHelmWorkloads();', context);
  return details.innerHTML;
}

const digest = 'sha256:' + 'a'.repeat(64);
const nextDigest = 'sha256:' + 'b'.repeat(64);
const container = {
  name: 'fixture-container',
  ready: true,
  runningImage: 'ghcr.io/example/app:v1',
  digest,
  packageUrl: 'https://github.com/example/app/pkgs/container/app/123',
  sourceBranch: 'dev',
  sourceBranchUrl: 'https://github.com/example/app/tree/dev',
  sourceBranchSource: 'GitHub package digest tag'
};

test('internal Helm inventory shows both digests during a mixed rollout', async () => {
  const output = await renderHelmInventory({
    ...container,
    runningDigests: [digest, nextDigest]
  });
  assert.match(output, /Mixed rollout/);
  assert.ok(output.includes(digest));
  assert.ok(output.includes(nextDigest));
  assert.match(output, /Representative Image/);
  assert.match(output, /Branch \(representative image\)/);
  assert.ok(output.includes('href="' + container.packageUrl + '"'));
});

test('internal Helm inventory keeps single-image and branch details', async () => {
  for (const fixture of [container, { ...container, runningDigests: [digest] }]) {
    const output = await renderHelmInventory(fixture);
    assert.doesNotMatch(output, /Mixed rollout/);
    assert.match(output, /Running Image/);
    assert.ok(output.includes(digest));
    assert.ok(output.includes('href="' + container.packageUrl + '"'));
    assert.ok(output.includes('href="' + container.sourceBranchUrl + '"'));
    assert.ok(output.includes(container.sourceBranchSource));
  }
});
