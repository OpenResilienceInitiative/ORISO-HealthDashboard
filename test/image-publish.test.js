import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const readWorkflow = path => fs.readFileSync(new URL('../.github/' + path, import.meta.url), 'utf8');
const readHelper = name => fs.readFileSync(new URL('../scripts/ci/' + name, import.meta.url), 'utf8');
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
  assert.match(pr, /permissions:\s+contents: read/);
  assert.doesNotMatch(pr, /packages: write|github_token:/);
  assert.ok(release.includes(action));
  assert.doesNotMatch(release, /uses: docker\/build-push-action@/);
  assert.match(release, /image_tags: \$\{\{ env\.IMAGE \}\}/);
  assert.match(release, /image_labels: \|\s+org\.opencontainers\.image\.source=/);
  assert.ok(release.indexOf(action) < release.indexOf('git push origin'));
});

test('the single amd64 archive is scanned before registry login and published by its verified checksum', () => {
  const build = steps.findIndex(step => step.includes('uses: docker/build-push-action@'));
  const scanner = steps.findIndex(step => step.includes('uses: aquasecurity/setup-trivy@'));
  const scan = steps.findIndex(step => step.includes('scripts/ci/scan-image-archive.sh'));
  const login = steps.findIndex(step => step.includes('uses: docker/login-action@'));
  const publish = steps.findIndex(step => step.includes('scripts/ci/publish-image-archive.sh'));
  const archive = '${{ runner.temp }}/${{ inputs.image_name }}.tar';

  assert.equal(steps.filter(step => step.includes('uses: docker/build-push-action@')).length, 1);
  assert.ok(build >= 0 && build < scanner && scanner < scan && scan < login && login < publish);
  assert.match(steps[build], /platforms: linux\/amd64\s+push: false/);
  assert.ok(steps[build].includes(`outputs: type=oci,dest=${archive}`));
  assert.match(steps[build], /provenance: .*'mode=min'.*'mode=max'/);
  assert.ok(steps[build].includes('labels: ${{ inputs.image_labels || steps.meta.outputs.labels }}'));
  assert.match(steps[build], /cache-from: type=gha\s+cache-to: type=gha,mode=max/);
  assert.match(steps[scanner], /setup-trivy@[a-f0-9]{40}[\s\S]+version: v0\.70\.0/);
  assert.ok(steps[scan].includes(`IMAGE_ARCHIVE: ${archive}`));
  assert.ok(steps[scan].includes('"$IMAGE_ARCHIVE" linux/amd64 "$EXPECTED_DIGEST"'));
  assert.ok(steps[scan].includes('EXPECTED_DIGEST: ${{ steps.build.outputs.digest }}'));
  assert.doesNotMatch(steps[scan], /^\s*(if|continue-on-error):/m);
  assert.ok(steps[login].includes("if: ${{ inputs.push_to_ghcr == 'true' }}"));
  assert.ok(steps[publish].includes("if: ${{ inputs.push_to_ghcr == 'true' }}"));
  assert.ok(steps[publish].includes(`IMAGE_ARCHIVE: ${archive}`));
  assert.ok(steps[publish].includes('IMAGE_TAGS: ${{ inputs.image_tags || steps.meta.outputs.tags }}'));
  assert.ok(steps[publish].includes('EXPECTED_DIGEST: ${{ steps.build.outputs.digest }}'));
  assert.ok(steps[publish].includes('EXPECTED_ARCHIVE_SHA256: ${{ steps.scan.outputs.archive_sha256 }}'));
  assert.doesNotMatch(steps[publish], /always\(\)|continue-on-error:/);

  const scanScript = readHelper('scan-image-archive.sh');
  assert.match(scanScript, /manifest-digest "\$index"[\s\S]+--preserve-digests[\s\S]+trivy image/);
  assert.match(scanScript, /--exit-code 1 --ignore-unfixed/);
  assert.match(scanScript, /--vuln-type os,library --severity CRITICAL,HIGH/);

  const publishScript = readHelper('publish-image-archive.sh');
  assert.match(publishScript, /!= "\$expected_archive_sha256"[\s\S]+skopeo copy --all --preserve-digests/);
  assert.match(publishScript, /cat "\$digest_file"\)" != "\$expected_digest"/);
});

test('the pull request starts the scanned archive in an isolated container', () => {
  const pr = readWorkflow('workflows/ci-pull-request.yml');
  assert.ok(composite.includes('value: ${{ steps.scan.outputs.archive_sha256 }}'));
  assert.ok(pr.includes('EXPECTED_ARCHIVE_SHA256: ${{ steps.image.outputs.archive_sha256 }}'));
  assert.match(pr, /archive="\$RUNNER_TEMP\/health-dashboard\.tar"[\s\S]+sha256sum "\$archive"/);
  assert.match(pr, /!= "\$EXPECTED_ARCHIVE_SHA256"[\s\S]+copy[\s\S]+"oci-archive:\$archive" docker-daemon:health-dashboard:ci-scan/);
  assert.match(pr, /docker run --detach --network none health-dashboard:ci-scan/);
  assert.match(pr, /fetch\("http:\/\/127\.0\.0\.1:9100\/api\/services"\)/);
});
