import express from 'express';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 9100;
// Working directory where server.js is started; we assume you run from health-dashboard/
const ROOT = path.resolve();

// Load config
const CONFIG_PATH = path.join(ROOT, 'config.json');
let services = {};
try {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  services = JSON.parse(raw);
} catch (err) {
  services = {
    tenantservice: { name: 'TenantService', url: process.env.TENANT_SERVICE_URL || 'http://oriso-platform-tenantservice.caritas.svc.cluster.local:8081/actuator/health' },
    userservice: { name: 'UserService', url: process.env.USER_SERVICE_URL || 'http://oriso-platform-userservice.caritas.svc.cluster.local:8082/actuator/health' },
    consultingtypeservice: { name: 'ConsultingTypeService', url: process.env.CONSULTING_TYPE_SERVICE_URL || 'http://oriso-platform-consultingtypeservice.caritas.svc.cluster.local:8083/actuator/health' },
    agencyservice: { name: 'AgencyService', url: process.env.AGENCY_SERVICE_URL || 'http://oriso-platform-agencyservice.caritas.svc.cluster.local:8084/actuator/health' },
    liveservice: { name: 'LiveService', url: 'http://localhost:8085/actuator/health' },
    statisticsservice: { name: 'StatisticsService', url: 'http://localhost:8086/actuator/health' },
    keycloak: { name: 'Keycloak', url: 'http://localhost:8080/health' },
    cobproxy: { name: 'Nginx Proxy', url: 'http://localhost:8089/service/tenant/access' }
  };
}

app.use(express.static(path.join(ROOT, 'public')));
app.use(express.json());

app.get('/api/services', (req, res) => {
  res.json(services);
});

app.get('/api/health/:key', (req, res) => {
  const key = req.params.key;
  const svc = services[key];
  if (!svc) return res.status(404).json({ error: 'Unknown service' });

  try {
    const url = new URL(svc.url);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    };

    const h = url.protocol === 'https:' ? https : http;
    const proxy = h.request(reqOpts, r => {
      let data = '';
      r.on('data', chunk => (data += chunk));
      r.on('end', () => {
        const status = r.statusCode || 500;
        res.status(status).type(r.headers['content-type'] || 'application/json').send(data);
      });
    });
    proxy.on('error', e => {
      res.status(502).json({ status: 'DOWN', error: e.message });
    });
    proxy.end();
  } catch (e) {
    res.status(500).json({ status: 'DOWN', error: e.message });
  }
});

// ------------------------------
// Cron: health checks every 60s
// ------------------------------
let cronRunId = 0;
const cronRuns = []; // keep last 10

function requestHealth(urlStr) {
  return new Promise(resolve => {
    try {
      const url = new URL(urlStr);
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      }, r => {
        let data = '';
        r.on('data', c => (data += c));
        r.on('end', () => {
          let up = false;
          if (r.statusCode && r.statusCode >= 200 && r.statusCode < 300) {
            try {
              const json = JSON.parse(data || '{}');
              up = (json.status === 'UP');
            } catch { up = true; }
          }
          resolve({ code: r.statusCode || 0, up });
        });
      });
      req.on('error', () => resolve({ code: 0, up: false }));
      req.end();
    } catch {
      resolve({ code: 0, up: false });
    }
  });
}

async function runCronCheck() {
  const timestamp = new Date().toISOString();
  const keys = Object.keys(services);
  const results = {};
  const checks = await Promise.all(keys.map(async key => {
    const svc = services[key];
    const r = await requestHealth(svc.url);
    results[key] = r.up ? 'UP' : 'DOWN';
    return r.up;
  }));
  const allUp = checks.every(Boolean);
  const entry = {
    id: ++cronRunId,
    timestamp,
    results,
    overall: allUp ? 'ALL_UP' : 'PARTIAL_DOWN'
  };
  cronRuns.unshift(entry);
  if (cronRuns.length > 10) cronRuns.pop();
  return entry;
}

// schedule every 60s
setInterval(runCronCheck, 60_000);

// trigger first run shortly after start
setTimeout(runCronCheck, 2_000);

// API to get last runs
app.get('/api/cron/runs', (req, res) => {
  res.json(cronRuns);
});

// API to trigger a run now
app.post('/api/cron/run', async (req, res) => {
  const entry = await runCronCheck();
  res.json(entry);
});

app.listen(PORT, () => {
  console.log(`Health dashboard listening on http://localhost:${PORT}`);
});

