import https from 'node:https';

const KUBE_INVENTORY_TIMEOUT_MS = 10_000;
const KUBE_INVENTORY_MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MESSAGE = 'Kubernetes inventory request timed out';

export class KubernetesInventoryError extends Error {}

export function requestKubeJson(options, {
  request = https.request,
  timeoutMs = KUBE_INVENTORY_TIMEOUT_MS,
  maxBytes = KUBE_INVENTORY_MAX_BYTES
} = {}) {
  return new Promise((resolve, reject) => {
    let req;
    let settled = false;
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => fail(TIMEOUT_MESSAGE), timeoutMs);

    function finish(callback, value) {
      settled = true;
      clearTimeout(timer);
      callback(value);
    }

    function fail(message) {
      if (settled) return;
      finish(reject, new KubernetesInventoryError(message));
      req?.destroy();
    }

    try {
      req = request(options, response => {
        const interrupted = () => fail('Kubernetes inventory response was interrupted');
        response.on('error', interrupted);
        response.on('close', interrupted);

        const status = response.statusCode;
        if (!Number.isInteger(status) || status < 200 || status >= 300) {
          fail(Number.isInteger(status)
            ? `Kubernetes API returned HTTP ${status}`
            : 'Kubernetes inventory response had no HTTP status');
          return;
        }

        const chunks = [];
        let bytesReceived = 0;
        response.on('data', chunk => {
          if (settled) return;
          bytesReceived += chunk.length;
          if (bytesReceived > maxBytes) {
            fail('Kubernetes inventory response exceeded the size limit');
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          if (performance.now() >= deadline) {
            fail(TIMEOUT_MESSAGE);
            return;
          }
          let inventory;
          try {
            inventory = JSON.parse(Buffer.concat(chunks, bytesReceived).toString('utf8') || '{}');
          } catch {
            fail('Kubernetes inventory response was invalid JSON');
            return;
          }
          if (performance.now() >= deadline) {
            fail(TIMEOUT_MESSAGE);
            return;
          }
          finish(resolve, inventory);
        });
      });
      req.on('error', () => fail('Kubernetes inventory request failed'));
      req.end();
    } catch {
      fail('Kubernetes inventory request failed');
    }
  });
}

export function parseDigest(imageID) {
  if (!imageID) return '';
  const digestMatch = imageID.match(/@(sha256:[a-f0-9]+)/i);
  if (digestMatch) return digestMatch[1];

  const idMatch = imageID.match(/(?:^|:\/\/)(sha256:[a-f0-9]+)/i);
  if (idMatch) return idMatch[1];

  return imageID;
}

export function runningImageDigests(statuses) {
  const digests = statuses
    .filter(status => status.state?.running)
    .map(status => parseDigest(status.imageID).toLowerCase())
    .filter(digest => /^sha256:[a-f0-9]{64}$/.test(digest));
  return [...new Set(digests)].sort();
}
