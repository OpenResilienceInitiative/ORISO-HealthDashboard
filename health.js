import http from 'node:http';
import https from 'node:https';


export const DEFAULT_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS || 5000);
const MAX_BODY_BYTES = 1_048_576;



export function checkService(service, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let url;
    try {
      url = new URL(service.url);
    } catch (error) {
      resolve({ up: false, code: 0, body: null, error: error.message });
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { accept: 'application/json' },
      },
      response => {
        let bodyText = '';
        let tooLarge = false;
        response.on('data', chunk => {
          bodyText += chunk;
          if (bodyText.length > MAX_BODY_BYTES) {
            tooLarge = true;
            request.destroy(new Error(`Health response exceeded ${MAX_BODY_BYTES} bytes`));
          }
        });
        response.on('end', () => {
          if (tooLarge) return;
          const code = response.statusCode || 0;
          let body = null;
          try {
            body = JSON.parse(bodyText);
          } catch {
            finish({
              up: false,
              code,
              body: null,
              error: 'Response is not a valid actuator JSON body',
            });
            return;
          }

          const up = code >= 200 && code < 300 && body?.status === 'UP';
          finish({
            up,
            code,
            body,
            error: up ? null : `Actuator reported ${body?.status || 'UNKNOWN'}`,
          });
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Health request timed out after ${timeoutMs}ms`));
    });
    request.on('error', error => {
      finish({ up: false, code: 0, body: null, error: error.message });
    });
    request.end();
  });
}


export async function checkCatalog(catalog, options) {
  const entries = await Promise.all(
    Object.entries(catalog).map(async ([key, service]) => [
      key,
      await checkService(service, options),
    ]),
  );
  return Object.fromEntries(entries);
}

