import express from 'express';
import fs from 'fs';
import path from 'path';
import { checkCatalog, checkService, stackSnapshot } from './health.js';

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
    TenantService: { name: 'TenantService', url: process.env.TENANT_SERVICE_URL || 'http://oriso-platform-tenantservice.caritas.svc.cluster.local:8080/actuator/health' },
    UserService: { name: 'UserService', url: process.env.USER_SERVICE_URL || 'http://oriso-platform-userservice.caritas.svc.cluster.local:8080/actuator/health' },
    ConsultingTypeService: { name: 'ConsultingTypeService', url: process.env.CONSULTING_TYPE_SERVICE_URL || 'http://oriso-platform-consultingtypeservice.caritas.svc.cluster.local:8080/actuator/health' },
    AgencyService: { name: 'AgencyService', url: process.env.AGENCY_SERVICE_URL || 'http://oriso-platform-agencyservice.caritas.svc.cluster.local:8080/actuator/health' }
  };
}

app.use(express.static(path.join(ROOT, 'public')));
app.use(express.json());

app.get('/api/services', (req, res) => {
  res.json(services);
});

app.get('/api/health/:key', async (req, res) => {
  const key = req.params.key;
  const svc = services[key];
  if (!svc) return res.status(404).json({ error: 'Unknown service' });

  const result = await checkService(svc);
  latestResults[key] = result;
  if (result.up) return res.json(result.body);
  return res.status(502).json({
    status: 'DOWN',
    upstreamStatus: result.body?.status || null,
    httpCode: result.code,
    error: result.error,
  });
});

// ------------------------------
// Cron: health checks every 60s
// ------------------------------
let cronRunId = 0;
const cronRuns = []; // keep last 10
let latestResults = {};

async function runCronCheck() {
  const timestamp = new Date().toISOString();
  latestResults = await checkCatalog(services);
  const results = Object.fromEntries(
    Object.entries(latestResults).map(([key, result]) => [key, result.up ? 'UP' : 'DOWN']),
  );
  const allUp = Object.values(latestResults).every(result => result.up);
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

// API to get stack versions (up versions) for all backend services
// Returns hardcoded "up versions" as reported by the services
app.get('/api/stack-versions', async (req, res) => {
  latestResults = await checkCatalog(services);
  res.json(stackSnapshot(services, latestResults));
});

app.listen(PORT, () => {
  console.log(`Health dashboard listening on http://localhost:${PORT}`);
});
