# ORISO Health Dashboard

## Overview
Real-time health monitoring dashboard for all Online Beratung microservices. Provides a beautiful web interface to monitor service status, response times, and historical health data.

## Features
- ✅ **Real-time Monitoring** - Checks services every 60 seconds
- ✅ **Beautiful UI** - Modern dark-themed dashboard
- ✅ **Service Details** - View detailed health information for each service
- ✅ **Historical Data** - Tracks last 10 health check runs
- ✅ **Manual Refresh** - Trigger health checks on demand
- ✅ **API Proxy** - Proxies health check requests to avoid CORS issues

## Quick Start

### Local Development
```bash
cd /home/caritas/Desktop/online-beratung/caritas-workspace/ORISO-HealthDashboard
npm install
npm start
```

Open http://localhost:9100

### Production Build
```bash
docker build -t caritas-health-dashboard:latest .
sudo k3s ctr images import <(docker save caritas-health-dashboard:latest)
kubectl apply -f kubernetes-deployment.yaml
```

## Configuration

### Service Configuration
Edit `config.json` to configure which services to monitor:

```json
{
  "TenantService": {
    "name": "TenantService",
    "url": "http://localhost:8081/actuator/health"
  },
  "UserService": {
    "name": "UserService",
    "url": "http://localhost:8082/actuator/health"
  },
  "ConsultingTypeService": {
    "name": "ConsultingTypeService",
    "url": "http://localhost:8083/actuator/health"
  },
  "AgencyService": {
    "name": "AgencyService",
    "url": "http://localhost:8084/actuator/health"
  },
  "VideoService": {
    "name": "VideoService",
    "url": "http://localhost:8090/actuator/health"
  }
}
```

### Environment Variables
```bash
# Port (default: 9100)
PORT=9100
```

## API Endpoints

### GET /api/services
Returns list of all configured services.

**Response:**
```json
{
  "TenantService": {
    "name": "TenantService",
    "url": "http://localhost:8081/actuator/health"
  }
}
```

### GET /api/health/:key
Proxies health check request to the specified service.

**Example:** `/api/health/TenantService`

**Response:**
```json
{
  "status": "UP",
  "components": {
    "db": {
      "status": "UP",
      "details": {
        "database": "MariaDB",
        "validationQuery": "isValid()"
      }
    }
  }
}
```

### GET /api/cron/runs
Returns last 10 automated health check runs.

**Response:**
```json
[
  {
    "id": 42,
    "timestamp": "2025-10-31T19:30:00.000Z",
    "results": {
      "TenantService": "UP",
      "UserService": "UP",
      "AgencyService": "UP"
    },
    "overall": "ALL_UP"
  }
]
```

### POST /api/cron/run
Triggers an immediate health check of all services.

**Response:**
```json
{
  "id": 43,
  "timestamp": "2025-10-31T19:31:00.000Z",
  "results": {
    "TenantService": "UP",
    "UserService": "DOWN",
    "AgencyService": "UP"
  },
  "overall": "PARTIAL_DOWN"
}
```

## Architecture

### Tech Stack
- **Backend:** Node.js + Express
- **Frontend:** Vanilla JavaScript (no framework)
- **Styling:** Custom CSS (dark theme)
- **Health Checks:** HTTP requests to `/actuator/health` endpoints

### How It Works
1. Dashboard loads list of services from `/api/services`
2. Frontend displays services in sidebar
3. Every 60 seconds, backend performs health checks on all services
4. Results are stored in memory (last 10 runs)
5. Frontend polls `/api/cron/runs` to show historical data
6. User can click services to see detailed health information
7. Backend proxies requests to avoid CORS issues

## Kubernetes Deployment

### Deployment File
Create `kubernetes-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: health-dashboard
  namespace: caritas
spec:
  replicas: 1
  selector:
    matchLabels:
      app: health-dashboard
  template:
    metadata:
      labels:
        app: health-dashboard
    spec:
      hostNetwork: true
      containers:
      - name: health-dashboard
        image: caritas-health-dashboard:latest
        imagePullPolicy: Never
        env:
        - name: PORT
          value: "9001"
        ports:
        - containerPort: 9001
          name: http
---
apiVersion: v1
kind: Service
metadata:
  name: health-dashboard
  namespace: caritas
spec:
  selector:
    app: health-dashboard
  ports:
  - port: 9001
    targetPort: 9001
    name: http
```

### Deploy
```bash
kubectl apply -f kubernetes-deployment.yaml
```

### Access
- **Internal:** http://health-dashboard.caritas.svc.cluster.local:9001
- **External:** http://91.99.219.182:9001 (configure Nginx proxy)

## Service URLs

### Localhost (with hostNetwork: true)
```json
{
  "TenantService": "http://localhost:8081/actuator/health",
  "UserService": "http://localhost:8082/actuator/health",
  "ConsultingTypeService": "http://localhost:8083/actuator/health",
  "AgencyService": "http://localhost:8084/actuator/health"
}
```

### Kubernetes Service Discovery
```json
{
  "TenantService": "http://tenantservice.caritas.svc.cluster.local:8081/actuator/health",
  "UserService": "http://userservice.caritas.svc.cluster.local:8082/actuator/health",
  "ConsultingTypeService": "http://consultingtypeservice.caritas.svc.cluster.local:8083/actuator/health",
  "AgencyService": "http://agencyservice.caritas.svc.cluster.local:8084/actuator/health"
}
```

## Dashboard UI

### Features
- **Sidebar Navigation** - List of all services with status indicators
- **Service Details** - Click any service to view detailed health information
- **Real-time Status** - Green (UP) / Red (DOWN) indicators
- **Response Data** - Full JSON response from health endpoints
- **Historical Runs** - View last 10 automated health checks

### Status Indicators
- 🟢 **Green Dot** - Service is UP
- 🔴 **Red Dot** - Service is DOWN or unreachable

## Monitoring Services

### Supported Health Endpoints
The dashboard supports any service exposing:
- `/actuator/health` (Spring Boot Actuator)
- `/health` (Generic health endpoint)
- Custom health endpoints returning JSON

### Adding New Services
1. Edit `config.json`
2. Add new service entry with name and URL
3. Restart dashboard
4. Service will appear in sidebar

Example:
```json
{
  "VideoService": {
    "name": "Video Call Service",
    "url": "http://localhost:8090/actuator/health"
  }
}
```

## Troubleshooting

### Dashboard Not Loading
```bash
# Check if pod is running
kubectl get pods -n caritas | grep health-dashboard

# Check logs
kubectl logs -n caritas -l app=health-dashboard
```

### Service Showing as DOWN
1. Check if service pod is running
2. Verify service URL in `config.json`
3. Test health endpoint manually: `curl http://localhost:8081/actuator/health`
4. Check for network/firewall issues

### CORS Errors
Dashboard uses backend proxy to avoid CORS issues. If you see CORS errors:
1. Ensure you're accessing dashboard through `/api/health/:key` endpoint
2. Check browser console for specific errors
3. Verify service allows requests from dashboard origin

## Development

### File Structure
```
ORISO-HealthDashboard/
├── package.json          # Node.js dependencies
├── server.js             # Express server
├── config.json           # Service configuration
├── Dockerfile            # Docker image
├── public/
│   └── index.html        # Dashboard UI
└── kubernetes-deployment.yaml
```

### Running Locally
```bash
npm install
node server.js
# Open http://localhost:9100
```

### Building Docker Image
```bash
docker build -t caritas-health-dashboard:latest .
```

### Environment Variables
- `PORT` - Server port (default: 9100)
- `NODE_ENV` - Environment (development/production)

## Integration with Other Tools

### With SignOZ
Health dashboard can be monitored by SignOZ for alerting:
- Monitor dashboard uptime
- Track service health metrics
- Alert on service failures

### With Nginx
Configure Nginx to proxy health dashboard:
```nginx
location /health/ {
    proxy_pass http://health-dashboard.caritas.svc.cluster.local:9001/;
}
```

## Important Notes
- **Memory Storage** - Health check history is stored in memory (cleared on restart)
- **60s Interval** - Automated checks run every 60 seconds
- **No Authentication** - Dashboard has no built-in auth (secure via Nginx/network)
- **Kubernetes-Aware** - Can use Kubernetes service discovery
- **Lightweight** - Minimal dependencies, fast startup

## Access Information
- **Default Port:** 9100 (configurable)
- **Production Port:** 9001
- **URL Pattern:** http://<server>:<port>
- **Current Access:** http://91.99.219.182:9001/

## Health Check Format
Services must return JSON with `status` field:

```json
{
  "status": "UP" or "DOWN",
  "components": {
    "db": { "status": "UP" },
    "diskSpace": { "status": "UP" }
  }
}
```

## Performance
- **Response Time:** < 50ms per service
- **Memory Usage:** ~ 50MB
- **CPU Usage:** Minimal (< 1%)
- **Concurrent Checks:** All services checked in parallel

---

**Status:** Production Ready ✅  
**Port:** 9001  
**Access:** http://91.99.219.182:9001/

