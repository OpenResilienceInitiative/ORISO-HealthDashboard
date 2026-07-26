import express from 'express';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 9100;
const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS || 5000);
// Working directory where server.js is started; we assume you run from health-dashboard/
const ROOT = path.resolve();
const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const KUBE_TOKEN_PATH = process.env.KUBERNETES_TOKEN_PATH || path.join(SERVICE_ACCOUNT_DIR, 'token');
const KUBE_CA_PATH = process.env.KUBERNETES_CA_PATH || path.join(SERVICE_ACCOUNT_DIR, 'ca.crt');
const KUBE_NAMESPACE_PATH = process.env.KUBERNETES_NAMESPACE_PATH || path.join(SERVICE_ACCOUNT_DIR, 'namespace');
const KUBE_API_HOST = process.env.KUBERNETES_SERVICE_HOST;
const KUBE_API_PORT = process.env.KUBERNETES_SERVICE_PORT || '443';
const HELM_RELEASES = (process.env.ORISO_HELM_RELEASES || process.env.ORISO_HELM_RELEASE || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const WORKLOAD_KINDS = [
  { kind: 'Deployment', resource: 'deployments' },
  { kind: 'StatefulSet', resource: 'statefulsets' },
  { kind: 'DaemonSet', resource: 'daemonsets' }
];

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function currentNamespace() {
  return process.env.ORISO_HELM_NAMESPACE ||
    process.env.KUBERNETES_NAMESPACE ||
    readFileIfExists(KUBE_NAMESPACE_PATH) ||
    'caritas';
}

function parseDigest(imageID) {
  if (!imageID) return '';
  const digestMatch = imageID.match(/@(sha256:[a-f0-9]+)/i);
  if (digestMatch) return digestMatch[1];

  const idMatch = imageID.match(/(?:^|:\/\/)(sha256:[a-f0-9]+)/i);
  if (idMatch) return idMatch[1];

  return imageID;
}

function imageTag(image) {
  if (!image || image.includes('@')) return '';
  const slashIndex = image.lastIndexOf('/');
  const colonIndex = image.lastIndexOf(':');
  if (colonIndex <= slashIndex) return '';
  return image.slice(colonIndex + 1);
}

function normalizeBranchTag(tag) {
  if (!tag) return '';
  if (tag === 'latest') return 'main';
  if (['main', 'dev', 'pre-dev'].includes(tag)) return tag;
  if (/^(release|feature|hotfix|bugfix|chore|fix|codex|agent)[.-]/.test(tag)) return tag;
  return '';
}

function firstValue(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

function inferSourceBranch(workload, containerImage, runningImage) {
  const labels = workload.metadata?.labels || {};
  const annotations = workload.metadata?.annotations || {};
  const explicitBranch = firstValue(
    labels['app.kubernetes.io/source-branch'],
    labels['oriso.org/source-branch'],
    labels['git.branch'],
    annotations['app.kubernetes.io/source-branch'],
    annotations['oriso.org/source-branch'],
    annotations['git.branch'],
    annotations['github.com/source-branch']
  );

  if (explicitBranch) {
    return { branch: explicitBranch, source: 'workload metadata' };
  }

  const tagBranch = normalizeBranchTag(imageTag(runningImage) || imageTag(containerImage));
  if (tagBranch) {
    return { branch: tagBranch, source: 'image tag' };
  }

  return { branch: '', source: '' };
}

function labelsMatchSelector(labels = {}, selector = {}) {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function podMatchesWorkloadSelector(pod, selector = {}) {
  if (Object.keys(selector).length === 0) return false;
  return labelsMatchSelector(pod.metadata?.labels || {}, selector);
}

function helmReleaseAllowed(labels = {}) {
  if (labels['app.kubernetes.io/managed-by'] !== 'Helm') return false;
  if (HELM_RELEASES.length === 0) return true;
  return HELM_RELEASES.includes(labels['app.kubernetes.io/instance']);
}

function kubeRequest(apiPath) {
  return new Promise((resolve, reject) => {
    if (!KUBE_API_HOST) {
      reject(new Error('Kubernetes API is not available outside the cluster'));
      return;
    }

    const token = readFileIfExists(KUBE_TOKEN_PATH);
    if (!token) {
      reject(new Error('Kubernetes service account token is not available'));
      return;
    }

    const requestOptions = {
      hostname: KUBE_API_HOST,
      port: KUBE_API_PORT,
      path: apiPath,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      }
    };

    const ca = readFileIfExists(KUBE_CA_PATH);
    if (ca) requestOptions.ca = ca;

    const req = https.request(requestOptions, response => {
      let data = '';
      response.on('data', chunk => (data += chunk));
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Kubernetes API returned HTTP ${response.statusCode}: ${data}`));
          return;
        }

        try {
          resolve(JSON.parse(data || '{}'));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function containerRowsForWorkload(workload, pods) {
  const selector = workload.spec?.selector?.matchLabels || {};
  const podTemplate = workload.spec?.template?.spec || {};
  const containers = [
    ...(podTemplate.initContainers || []).map(container => ({ ...container, init: true })),
    ...(podTemplate.containers || []).map(container => ({ ...container, init: false }))
  ];
  const matchedPods = pods.filter(pod => podMatchesWorkloadSelector(pod, selector));

  return containers.map(container => {
    const statuses = matchedPods.flatMap(pod => [
      ...(pod.status?.initContainerStatuses || []),
      ...(pod.status?.containerStatuses || [])
    ]).filter(status => status.name === container.name);
    const runningStatus = statuses.find(status => status.imageID) || statuses[0] || {};
    const digest = parseDigest(runningStatus.imageID);
    const runningImage = runningStatus.image || container.image || '';
    const { branch, source } = inferSourceBranch(workload, container.image || '', runningImage);

    return {
      name: container.name,
      type: container.init ? 'init' : 'app',
      image: container.image || runningImage,
      runningImage,
      imageID: runningStatus.imageID || '',
      digest,
      sourceBranch: branch,
      sourceBranchSource: source,
      ready: runningStatus.ready === true,
      restartCount: runningStatus.restartCount ?? 0
    };
  }).filter(container => container.image || container.runningImage || container.imageID);
}

async function getHelmWorkloads() {
  const namespace = currentNamespace();
  const labelSelector = encodeURIComponent('app.kubernetes.io/managed-by=Helm');
  const [podsResponse, ...workloadResponses] = await Promise.all([
    kubeRequest(`/api/v1/namespaces/${namespace}/pods`),
    ...WORKLOAD_KINDS.map(({ resource }) =>
      kubeRequest(`/apis/apps/v1/namespaces/${namespace}/${resource}?labelSelector=${labelSelector}`)
    )
  ]);
  const pods = podsResponse.items || [];

  const workloads = workloadResponses.flatMap((response, index) => {
    const { kind } = WORKLOAD_KINDS[index];
    return (response.items || [])
      .filter(workload => helmReleaseAllowed(workload.metadata?.labels || {}))
      .map(workload => {
        const matchedPods = pods.filter(pod =>
          podMatchesWorkloadSelector(pod, workload.spec?.selector?.matchLabels || {})
        );

        return {
          kind,
          name: workload.metadata?.name || '',
          namespace,
          helmRelease: workload.metadata?.labels?.['app.kubernetes.io/instance'] || '',
          chart: workload.metadata?.labels?.['helm.sh/chart'] || '',
          desiredReplicas: workload.spec?.replicas ?? workload.status?.desiredNumberScheduled ?? null,
          readyReplicas: workload.status?.readyReplicas ?? workload.status?.numberReady ?? 0,
          availableReplicas: workload.status?.availableReplicas ?? workload.status?.numberAvailable ?? 0,
          pods: matchedPods.map(pod => ({
            name: pod.metadata?.name || '',
            phase: pod.status?.phase || '',
            ready: (pod.status?.containerStatuses || []).length > 0 &&
              (pod.status?.containerStatuses || []).every(status => status.ready === true)
          })),
          containers: containerRowsForWorkload(workload, matchedPods)
        };
      });
  });

  workloads.sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));

  return {
    namespace,
    releaseFilter: HELM_RELEASES,
    count: workloads.length,
    generatedAt: new Date().toISOString(),
    workloads
  };
}

// Load config
const CONFIG_PATH = path.join(ROOT, 'config.json');
let services = {};
let quickLinks = [];
const defaultQuickLinks = [
  { label: 'Frontend', url: process.env.FRONTEND_URL || '' },
  { label: 'Admin Panel', url: process.env.ADMIN_URL || '' },
  { label: 'Keycloak', url: process.env.KEYCLOAK_URL || '' },
  { label: 'Signoz', url: process.env.SIGNOZ_URL || '' }
].filter(link => link.url);

function readConfig(rawConfig) {
  if (rawConfig.services) {
    return {
      services: rawConfig.services,
      quickLinks: Array.isArray(rawConfig.quickLinks) ? rawConfig.quickLinks : defaultQuickLinks
    };
  }

  return {
    services: rawConfig,
    quickLinks: defaultQuickLinks
  };
}

try {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = readConfig(JSON.parse(raw));
  services = config.services;
  quickLinks = config.quickLinks;
} catch (err) {
  services = {
    tenantservice: { name: 'TenantService', url: process.env.TENANT_SERVICE_URL || 'http://oriso-tenantservice.caritas.svc.cluster.local:8081/actuator/health' },
    userservice: { name: 'UserService', url: process.env.USER_SERVICE_URL || 'http://oriso-userservice.caritas.svc.cluster.local:8082/actuator/health' },
    consultingtypeservice: { name: 'ConsultingTypeService', url: process.env.CONSULTING_TYPE_SERVICE_URL || 'http://oriso-consultingtypeservice.caritas.svc.cluster.local:8083/actuator/health' },
    agencyservice: { name: 'AgencyService', url: process.env.AGENCY_SERVICE_URL || 'http://oriso-agencyservice.caritas.svc.cluster.local:8084/actuator/health' },
    liveservice: { name: 'LiveService', url: 'http://localhost:8085/actuator/health' },
    statisticsservice: { name: 'StatisticsService', url: 'http://localhost:8086/actuator/health' },
    keycloak: { name: 'Keycloak', url: 'http://localhost:8080/health' },
    cobproxy: { name: 'Nginx Proxy', url: 'http://localhost:8089/service/tenant/access' }
  };
  quickLinks = defaultQuickLinks;
}

app.use(express.static(path.join(ROOT, 'public')));
app.use(express.json());

app.get('/api/services', (req, res) => {
  res.json(services);
});

app.get('/api/quick-links', (req, res) => {
  res.json(quickLinks);
});

app.get('/api/health/:key', (req, res) => {
  const key = req.params.key;
  const svc = services[key];
  if (!svc) return res.status(404).json({ error: 'Unknown service' });

  try {
    let completed = false;
    const sendFailure = (status, error) => {
      if (completed) return;
      completed = true;
      res.status(status).json({ status: 'DOWN', error, url: svc.url });
    };
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
        if (completed) return;
        completed = true;
        const status = r.statusCode || 500;
        res.status(status).type(r.headers['content-type'] || 'application/json').send(data);
      });
    });
    proxy.setTimeout(HEALTH_CHECK_TIMEOUT_MS, () => {
      proxy.destroy();
      sendFailure(504, `Health check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`);
    });
    proxy.on('error', e => {
      sendFailure(502, e.message);
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
      req.setTimeout(HEALTH_CHECK_TIMEOUT_MS, () => {
        req.destroy();
        resolve({ code: 504, up: false });
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

app.get('/api/helm-workloads', async (req, res) => {
  try {
    res.json(await getHelmWorkloads());
  } catch (err) {
    res.status(503).json({
      namespace: currentNamespace(),
      releaseFilter: HELM_RELEASES,
      count: 0,
      generatedAt: new Date().toISOString(),
      workloads: [],
      error: err.message
    });
  }
});

// API to trigger a run now
app.post('/api/cron/run', async (req, res) => {
  const entry = await runCronCheck();
  res.json(entry);
});

// API to get stack versions (up versions) for all backend services
// Returns hardcoded "up versions" as reported by the services
app.get('/api/stack-versions', (req, res) => {
  // Hardcoded "up versions" - these are the reported versions from the services
  const versions = {
    'UserService': {
      name: 'UserService',
      java: '21',
      springBoot: '4.0.1',
      spring: '6.2.0',
      status: 'available'
    },
    'AgencyService': {
      name: 'AgencyService',
      java: '21',
      springBoot: '4.0.1',
      spring: '6.2.0',
      status: 'available'
    },
    'ConsultingTypeService': {
      name: 'ConsultingTypeService',
      java: '21',
      springBoot: '4.0.1',
      spring: '6.2.0',
      status: 'available'
    },
    'TenantService': {
      name: 'TenantService',
      java: '21',
      springBoot: '4.0.1',
      spring: '6.2.0',
      status: 'available'
    }
  };

  res.json(versions);
});

app.listen(PORT, () => {
  console.log(`Health dashboard listening on http://localhost:${PORT}`);
});
