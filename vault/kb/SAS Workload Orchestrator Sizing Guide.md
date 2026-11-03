---
title: "SAS Workload Orchestrator Sizing Guide"
type: kb
status: verified
env: prod / aks
owner: Cloud Tech Lead
tags: [kb, swo, compute, sizing, sas-viya]
---

# SAS Workload Orchestrator Sizing Guide

Reference guidelines for configuring **SAS Workload Orchestrator (SWO)** queues, dynamic Kubernetes pod autoscaling, and `sas-programming-environment` resource requests.

## 📐 Compute Pod Sizing Tiers

| Queue Tier | CPU Request / Limit | Memory Request / Limit | Ephemeral Scratch (`SASWORK`) | Target Workload |
| :--- | :--- | :--- | :--- | :--- |
| `interactive-default` | `2000m` / `4000m` | `8Gi` / `16Gi` | `50Gi` NVMe | SAS Studio analysts, ad-hoc SQL |
| `batch-heavy` | `8000m` / `16000m` | `32Gi` / `64Gi` | `250Gi` NVMe | Nightly ETL, risk aggregation |
| `ml-scoring` | `4000m` / `8000m` | `16Gi` / `32Gi` | `40Gi` NVMe | Model Studio pipeline execution |

## 💡 Best Practices
- Always co-locate `SASWORK` on local ephemeral NVMe rather than network NFS (`Azure NetApp Files`) to avoid metadata locking bottlenecks.
- Pair with [[CAS Memory & Disk Cache Runbook]] when tuning hybrid SPRE + CAS pipelines.
- See [SAS Viya 4 Workload Orchestrator Admin Docs](https://documentation.sas.com/doc/en/itopscdc/default/wlomanage/p0swlointro.htm) #docs #swo
