# Health Dashboard - Quick Deployment Guide

## 🚀 5-Minute Setup

### Step 1: Build Docker Image
```bash
cd /home/caritas/Desktop/online-beratung/caritas-workspace/ORISO-HealthDashboard
docker build -t caritas-health-dashboard:latest .
```

### Step 2: Import to k3s
```bash
sudo k3s ctr images import <(docker save caritas-health-dashboard:latest)
```

### Step 3: Create Kubernetes Deployment
Create `kubernetes-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: health-dashboard
  namespace: caritas
  labels:
    app: health-dashboard
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
        - name: NODE_ENV
          value: "production"
        ports:
        - containerPort: 9001
          name: http
        resources:
          limits:
            cpu: "200m"
            memory: "128Mi"
          requests:
            cpu: "100m"
            memory: "64Mi"
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
  type: ClusterIP
```

### Step 4: Deploy
```bash
kubectl apply -f kubernetes-deployment.yaml
```

### Step 5: Verify
```bash
# Check pod is running
kubectl get pods -n caritas | grep health-dashboard

# Check logs
kubectl logs -n caritas -l app=health-dashboard

# Test access
curl http://localhost:9001
```

### Step 6: Access Dashboard
Open in browser: **http://91.99.219.182:9001**

## 🔧 Configuration

### Edit Services to Monitor
```bash
# Edit config.json
vi config.json

# Rebuild Docker image
docker build -t caritas-health-dashboard:latest .
sudo k3s ctr images import <(docker save caritas-health-dashboard:latest)

# Restart pod
kubectl delete pod -n caritas -l app=health-dashboard
```

### Change Port
```bash
# Edit deployment
kubectl edit deployment health-dashboard -n caritas

# Change PORT environment variable
# Or update kubernetes-deployment.yaml and apply
```

## ✅ Verification Checklist

- [ ] Docker image built successfully
- [ ] Image imported to k3s
- [ ] Kubernetes deployment created
- [ ] Pod is Running
- [ ] Service is accessible on port 9001
- [ ] Dashboard loads in browser
- [ ] All services show status (UP/DOWN)
- [ ] Health checks running every 60 seconds

## 🚨 Troubleshooting

### Pod Not Starting
```bash
kubectl describe pod -n caritas -l app=health-dashboard
kubectl logs -n caritas -l app=health-dashboard
```

### Dashboard Shows No Services
1. Check config.json exists in Docker image
2. Verify service URLs are correct
3. Check logs for errors

### Services Show as DOWN
1. Verify services are actually running: `kubectl get pods -n caritas`
2. Check service ports match config.json
3. Test manually: `curl http://localhost:8081/actuator/health`

## 📊 Production Checklist

- [ ] Configured to monitor all ORISO services
- [ ] Resource limits set appropriately
- [ ] Nginx proxy configured for external access
- [ ] Health check interval appropriate (60s default)
- [ ] Dashboard accessible from monitoring team

## 🔄 Updates

To update dashboard:
```bash
# 1. Make changes
# 2. Rebuild image
docker build -t caritas-health-dashboard:latest .

# 3. Import to k3s
sudo k3s ctr images import <(docker save caritas-health-dashboard:latest)

# 4. Restart pod
kubectl delete pod -n caritas -l app=health-dashboard
```

---

**Default Port:** 9001  
**Access URL:** http://91.99.219.182:9001  
**Namespace:** caritas

