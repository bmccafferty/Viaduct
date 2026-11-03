---
title: "SAS Viya 4 AKS Migration"
type: project
status: active
env: prod-us-east / aks-1.30
owner: Cloud Tech Lead
tags: [project, sas-viya, aks, azure, architecture]
---

# SAS Viya 4 AKS Migration

Enterprise cloud migration of legacy multi-machine SAS 9.4 & Viya 3.5 workloads onto cloud-native **SAS Viya 4 (2024.09 LTS)** running on Azure Kubernetes Service (AKS).

## 🏗 Target Node Pool Topology

| Node Pool | VM SKU | Taint (`workload.sas.com/class`) | Scaling | Storage Backing |
| :--- | :--- | :--- | :--- | :--- |
| `system` | `Standard_D8s_v5` | *(none)* | 3–6 nodes | Managed Premium SSD |
| `stateful` | `Standard_E16ds_v5` | `stateful:NoSchedule` | 4–8 nodes | Azure Disk CSI (ZRS) |
| `stateless` | `Standard_D16ds_v5` | `stateless:NoSchedule` | 4–16 nodes | Ephemeral OS Disk |
| `cas` | `Standard_E64ds_v5` | `cas:NoSchedule` | 4–12 nodes | Local NVMe (`/cas/cache`) + ANF |
| `compute` | `Standard_E32ds_v5` | `compute:NoSchedule` | 2–24 nodes | ANF NFSv4.1 (`rsize=262144`) |

## 📋 Project Milestones & Open Deliverables
- [ ] Finalize multi-AZ zone-redundant storage snapshot schedule for `sas-commonfiles` #storage !high @due(2026-11-01)
- [/] Load test 150 concurrent SAS Studio sessions + 40 parallel CAS actions #perf !high
- [ ] Complete security sign-off on [[Zero Trust OIDC & Ingress Design]] with InfoSec #security !med
- [x] Deploy baseline IaC using [sas-viya4-iac-azure](https://github.com/sassoftware/viya4-iac-azure) #terraform

## 🔗 Key Project Resources
- [SAS Viya 4 Deployment GitHub Repository](https://github.com/sassoftware/viya4-deployment) — Official Ansible & Kustomize deployment assets #repo #sas-viya
- [Azure NetApp Files Performance Benchmarks for EDA/HPC](https://learn.microsoft.com/en-us/azure/azure-netapp-files/performance-benchmarks-linux) — Mount options `nconnect=8` validation #azure #storage
- Related Runbooks: [[CAS Memory & Disk Cache Runbook]], [[SAS Workload Orchestrator Sizing Guide]], [[CrunchyData Postgres HA Upgrade]]
