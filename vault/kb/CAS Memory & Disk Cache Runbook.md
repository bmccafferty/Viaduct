---
title: "CAS Memory & Disk Cache Runbook"
type: kb
status: verified
env: all-viya-envs
owner: Cloud Tech Lead
tags: [runbook, cas, sas-viya, troubleshooting, memory]
---

# CAS Memory & Disk Cache Runbook

Standard operating procedure for diagnosing SAS Cloud Analytic Services (CAS) memory pressure, `CAS_DISK_CACHE` saturation, and worker node OOMKills in [[SAS Viya 4 AKS Migration]].

## 🚨 Symptoms
- CAS action fails with `ERROR: The TCP/IP sockWrite call failed. The system error is 'Broken pipe'`.
- Kubernetes event `OOMKilled` on container `sas-cas-server` (Exit Code `137`).
- High disk I/O wait (`iowait > 35%`) on CAS worker nodes.

## 🔍 Rapid Diagnostic Commands

### 1. Inspect CAS Backing Store & Cache Mount Utilization
```bash
# Check CAS_DISK_CACHE usage across all CAS pods in namespace
kubectl get pods -n viya-prod -l app.kubernetes.io/name=sas-cas-server -o name | \
  xargs -I {} kubectl exec -n viya-prod {} -c sas-cas-server -- df -h /cas/cache
```

### 2. Query Active CAS Session Memory Consumption
```bash
# List top memory-consuming CAS sessions via sas-viya CLI
sas-viya cas sessions list --server cas-shared-default --output fulljson | \
  jq '.items[] | {name: .name, user: .owner, state: .state}'
```

### 3. Kustomize Patch for Dedicated Ephemeral NVMe Cache
Ensure `cas-manage-cpu-and-memory.yaml` sets `CAS_VIRTUAL_PROTO` and mounts the local NVMe RAID volume:
```yaml
apiVersion: builtin
kind: PatchTransformer
metadata:
  name: cas-nvme-cache-mount
patch: |-
  - op: add
    path: /spec/controllerTemplate/spec/containers/0/env/-
    value:
      name: CAS_DISK_CACHE
      value: /cas/cache
target:
  kind: CASDeployment
  name: .*
```

## 🔗 Related Notes & Dashboards
- [Grafana CAS Memory & Cache IOPS Dashboard](https://grafana.internal.sas.cloud/d/cas-mem-02/cas-memory-and-cache-iops) #observability #grafana
- Referenced by [[SAS Viya 4 AKS Migration]] and [[SAS Workload Orchestrator Sizing Guide]].
