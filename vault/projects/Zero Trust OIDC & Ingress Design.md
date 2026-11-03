---
title: "Zero Trust OIDC & Ingress Design"
type: project
status: review
env: prod-eu-west / istio-1.22
owner: Cloud Tech Lead
tags: [project, security, oidc, ingress, oauth2]
---

# Zero Trust OIDC & Ingress Design

End-to-end authentication and token propagation architecture connecting Microsoft Entra ID (Azure AD) -> NGINX Ingress / Istio Gateway -> `sas-logon-app` -> CAS & Compute servers.

## 🔐 Authentication Flow
1. **Edge TLS 1.3 Termination**: Azure Front Door + NGINX Ingress Controller with strict HSTS and WebSocket timeouts (`proxy-read-timeout: 3600s`).
2. **OIDC Federation**: `sas-logon-app` configured as OIDC Relying Party with PKCE and `groups` claim mapping to SAS Custom Groups (`SASAdministrators`, `CASHostAccountRequired`).
3. **Workload Identity**: Azure Workload Identityfederated service accounts for CAS S3/ADLSv2 data connectors.

## 📋 Action Items
- [ ] Configure `sas.logon.jwt` signing key rotation cronjob #security !med
- [x] Document SCIM 2.0 automated user provisioning pipeline from Entra ID #iam

## 🔗 References
- [SAS Viya 4 Authentication: OIDC with Azure AD](https://documentation.sas.com/doc/en/itopscdc/default/calauthmdl/n1oidcauthentication.htm) #docs #oidc
- Linked Architecture: [[SAS Viya 4 AKS Migration]]
