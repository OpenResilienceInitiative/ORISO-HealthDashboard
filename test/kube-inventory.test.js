import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { requestKubeJson, runningImageDigests } from '../kube-inventory.js';

function simulateRequest(start, limits = {}) {
  const response = new EventEmitter();
  response.statusCode = 200;
  const request = new EventEmitter();
  request.end = () => queueMicrotask(start.bind(null, response));
  request.destroy = () => { request.destroyed = true; };
  let deliverResponse;
  const result = requestKubeJson({}, {
    timeoutMs: 200,
    maxBytes: 128,
    ...limits,
    request: (_options, onResponse) => {
      deliverResponse = () => onResponse(response);
      return request;
    }
  });
  return { request, result, deliverResponse: () => deliverResponse() };
}

test('inventory decodes UTF-8 across chunks at the byte limit', async () => {
  const body = Buffer.from('{"items":["Über"]}');
  const split = body.indexOf(Buffer.from('Ü')) + 1;
  const { result, request, deliverResponse } = simulateRequest(response => {
    deliverResponse();
    response.emit('data', body.subarray(0, split));
    response.emit('data', body.subarray(split));
    response.emit('end');
  }, { maxBytes: body.length });

  assert.deepEqual(await result, { items: ['Über'] });
  assert.equal(request.destroyed, undefined);
});

test('inventory stops collecting bytes at its response budget', async () => {
  const { result, request, deliverResponse } = simulateRequest(response => {
    deliverResponse();
    response.emit('data', Buffer.from('{"items":'));
    response.emit('data', Buffer.from('["Über"]}'));
  }, { maxBytes: 17 });

  await assert.rejects(result, { message: 'Kubernetes inventory response exceeded the size limit' });
  assert.equal(request.destroyed, true);
});

test('inventory deadline covers time spent waiting for headers', async () => {
  const { result, request } = simulateRequest(() => {}, { timeoutMs: 20 });
  await assert.rejects(result, { message: 'Kubernetes inventory request timed out' });
  assert.equal(request.destroyed, true);
});

test('an active response stream does not extend the inventory deadline', async t => {
  let responseInterval;
  t.after(() => clearInterval(responseInterval));
  const { result, request, deliverResponse } = simulateRequest(response => {
    deliverResponse();
    responseInterval = setInterval(() => response.emit('data', Buffer.from(' ')), 2);
  }, { timeoutMs: 45 });

  await assert.rejects(result, { message: 'Kubernetes inventory request timed out' });
  assert.equal(request.destroyed, true);
});

test('inventory HTTP errors are reported without the downstream body', async () => {
  const { result, request, deliverResponse } = simulateRequest(response => {
    response.statusCode = 403;
    deliverResponse();
    response.emit('data', Buffer.from('synthetic downstream diagnostic'));
    response.emit('end');
  });

  await assert.rejects(result, { message: 'Kubernetes API returned HTTP 403' });
  assert.equal(request.destroyed, true);
});

test('invalid JSON and interrupted streams have fixed inventory messages', async () => {
  const invalidJson = simulateRequest(response => {
    invalidJson.deliverResponse();
    response.emit('data', Buffer.from('synthetic downstream diagnostic'));
    response.emit('end');
  });
  const interrupted = simulateRequest(response => {
    interrupted.deliverResponse();
    response.emit('error', new Error('synthetic connection diagnostic'));
    response.emit('close');
  });

  await Promise.all([
    assert.rejects(invalidJson.result, { message: 'Kubernetes inventory response was invalid JSON' }),
    assert.rejects(interrupted.result, { message: 'Kubernetes inventory response was interrupted' })
  ]);
});

test('inventory deduplicates digests and skips pods without a running image', () => {
  const older = 'sha256:' + '0'.repeat(64);
  const newer = 'sha256:' + 'a'.repeat(64);
  const stopped = 'sha256:' + 'f'.repeat(64);

  assert.deepEqual(runningImageDigests([
    { imageID: 'registry.example/app@' + newer, state: { running: {} } },
    { imageID: 'containerd://' + newer.toUpperCase(), state: { running: {} } },
    { imageID: older, state: { running: {} } },
    { imageID: stopped, state: { terminated: {} } },
    { imageID: 'unknown', state: { waiting: {} } },
    { imageID: '' }
  ]), [older, newer]);
});
