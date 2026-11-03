---
title: "CrunchyData Postgres HA Upgrade"
type: project
status: active
env: prod-global / pgo-5.5
owner: Cloud Tech Lead
tags: [project, postgres, ha, crunchydata, sas-viya]
---

# CrunchyData Postgres HA Upgrade

Upgrading internal SAS Infrastructure Data Server (PostgreSQL 14 -> 16) managed by CrunchyData Postgres Operator (PGO) with zero-downtime Patroni switchover.

## ⚙️ Patroni & pgBouncer Configuration
```yaml
apiVersion: postgres-operator.crunchydata.com/v1beta1
kind: PostgresCluster
metadata:
  name: sas-crunchy-platform-postgres
spec:
  postgresVersion: 16
  instances:
    - name: pgha1
      replicas: 3
      dataVolumeClaimSpec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 512Gi
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
```

## 📋 Cutover Checklist
- [ ] Verify `pg_stat_statements` and `auto_explain` shared_preload_libraries in staging #postgres !med
- [ ] Test automated pgBackRest S3/Azure Blob repo retention policy (14 days full, 7 days WAL) #backup !high
- [x] Validate SAS Logon Manager & Credentials service reconnect behavior during 4s Patroni failover [[SAS Viya 4 AKS Migration]] #ha

## 🔗 Key Links
- [CrunchyData PGO Upgrade Documentation](https://access.crunchydata.com/documentation/postgres-operator/latest/guides/major-postgres-version-upgrade) #docs #postgres
