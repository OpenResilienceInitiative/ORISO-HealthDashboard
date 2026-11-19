import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const readWorkflow = path => fs.readFileSync(new URL('../.github/' + path, import.meta.url), 'utf8');
const composite = readWorkflow('actions/docker-build-push/action.yml');
const steps = composite.split(/^\s*- name: /m).slice(1);

test('every image publication uses the shared build and scan gate', () => {
  const branch = readWorkflow('workflows/ci-main.yml');
  const pr = readWorkflow('workflows/ci-pull-request.yml');
  const release = readWorkflow('workflows/release-image.yml');
  const action = 'uses: ./.github/actions/docker-build-push';

  assert.ok(branch.includes(action));
  assert.match(branch, /push_to_ghcr: true/);
  assert.ok(pr.includes(action));
  assert.match(pr, /push_to_ghcr: false/);
  assert.ok(release.includes(action));
  assert.doesNotMatch(release, /uses: docker\/build-push-action@/);
  assert.match(release, /image_tags: \$\{\{ env\.IMAGE \}\}/);
  assert.match(release, /image_labels: \|\s+org\.opencontainers\.image\.source=/);
  assert.ok(release.indexOf(action) < release.indexOf('git push origin'));
});

test('the local image is scanned for fixable high or critical vulnerabilities before a push', () => {
  const localBuild = steps.findIndex(step => step.includes('load: true'));
  const scan = steps.findIndex(step => step.includes('uses: aquasecurity/trivy-action@'));
  const publish = steps.findIndex(step => step.includes('push: ${{ inputs.push_to_ghcr }}'));

  assert.ok(localBuild >= 0 && localBuild < scan && scan < publish);
  assert.match(steps[localBuild], /push: false/);
  assert.match(steps[localBuild], /tags: \$\{\{ inputs\.image_name \}\}:ci-scan/);
  assert.match(steps[scan], /image-ref: \$\{\{ inputs\.image_name \}\}:ci-scan/);
  assert.match(steps[scan], /exit-code: '1'/);
  assert.match(steps[scan], /ignore-unfixed: true/);
  assert.match(steps[scan], /vuln-type: os,library/);
  assert.match(steps[scan], /severity: CRITICAL,HIGH/);
  assert.doesNotMatch(steps[scan], /^\s*(if|continue-on-error):/m);
  assert.doesNotMatch(steps[publish], /always\(\)|continue-on-error:/);
});
