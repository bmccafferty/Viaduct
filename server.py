#!/usr/bin/env python3
"""
VIADUCT — Local-First Technical Knowledge, Outliner, Task & Link Indexing Engine
Designed for Cloud Technical Leads & Systems Architects.

All notes live on disk as pure Markdown (.md) files inside ./vault/
SQLite + FTS5 (.viaduct/index.db) provides <5ms full-text search, backlinks,
cross-daily task aggregation, and URL bookmark tracking with zero plugins required.
"""

import os
import re
import json
import time
import sqlite3
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
VAULT_DIR = BASE_DIR / "vault"
INDEX_DIR = BASE_DIR / ".viaduct"
DB_PATH = INDEX_DIR / "index.db"
STATIC_DIR = BASE_DIR / "static"

PORT = int(os.environ.get("VIADUCT_PORT", 8420))

# Regex patterns for Markdown knowledge extraction
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]")
TAG_RE = re.compile(r"(?:^|\s)#([a-zA-Z0-9_\-/]+)")
TASK_RE = re.compile(r"^(\s*)(?:[-*+]|\d+\.)\s+\[([ xX/\->])\]\s+(.*)$")
MD_LINK_RE = re.compile(r"(?<!!)\[([^\]]+)\]\((https?://[^\s\)]+)\)")
BARE_URL_RE = re.compile(r"(?<!\()(?<!\[)(https?://[^\s\)\]>\"'`]+)")
PRIORITY_RE = re.compile(r"!(high|med|low|p1|p2|p3)\b", re.IGNORECASE)
DUE_DATE_RE = re.compile(r"@due\(([0-9]{4}-[0-9]{2}-[0-9]{2})\)|📅\s*([0-9]{4}-[0-9]{2}-[0-9]{2})")
INLINE_TAG_RE = re.compile(r"#([a-zA-Z0-9_\-/]+)")


def ensure_dirs():
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    for sub in ["daily", "projects", "kb", "reports", "templates"]:
        (VAULT_DIR / sub).mkdir(parents=True, exist_ok=True)
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)


def get_db():
    conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def init_db():
    conn = get_db()
    with conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS notes (
            path TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            folder TEXT NOT NULL,
            note_type TEXT NOT NULL,
            status TEXT DEFAULT '',
            env TEXT DEFAULT '',
            owner TEXT DEFAULT '',
            updated_at REAL NOT NULL,
            created_at REAL NOT NULL,
            word_count INTEGER DEFAULT 0,
            raw_content TEXT NOT NULL,
            frontmatter_json TEXT DEFAULT '{}'
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            path UNINDEXED,
            title,
            body,
            tags,
            tokenize='porter unicode61'
        );

        CREATE TABLE IF NOT EXISTS backlinks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT NOT NULL,
            source_title TEXT NOT NULL,
            target_slug TEXT NOT NULL,
            line_num INTEGER NOT NULL,
            context TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks(target_slug);
        CREATE INDEX IF NOT EXISTS idx_backlinks_source ON backlinks(source_path);

        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT NOT NULL,
            source_title TEXT NOT NULL,
            folder TEXT NOT NULL,
            line_num INTEGER NOT NULL,
            state TEXT NOT NULL,
            text TEXT NOT NULL,
            clean_text TEXT NOT NULL,
            priority TEXT DEFAULT 'normal',
            due_date TEXT DEFAULT '',
            tags_json TEXT DEFAULT '[]',
            project_links_json TEXT DEFAULT '[]',
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
        CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source_path);

        CREATE TABLE IF NOT EXISTS links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL,
            domain TEXT NOT NULL,
            title TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_title TEXT NOT NULL,
            line_num INTEGER NOT NULL,
            context TEXT NOT NULL,
            tags_json TEXT DEFAULT '[]',
            category TEXT DEFAULT 'doc',
            is_pinned INTEGER DEFAULT 0,
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_links_domain ON links(domain);
        CREATE INDEX IF NOT EXISTS idx_links_url ON links(url);

        CREATE TABLE IF NOT EXISTS saved_bookmarks (
            url TEXT PRIMARY KEY,
            custom_title TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            is_pinned INTEGER DEFAULT 0,
            category TEXT DEFAULT '',
            created_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tags (
            tag TEXT NOT NULL,
            source_path TEXT NOT NULL,
            line_num INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(tag);
        """)
    conn.close()


def normalize_slug(text: str) -> str:
    """Normalize a note title or filename for case-insensitive wikilink matching."""
    s = text.strip()
    if s.lower().endswith(".md"):
        s = s[:-3]
    # Take basename if path-like, though we also check full path
    return s.lower().strip()


def parse_frontmatter(content: str):
    meta = {}
    body = content
    m = FRONTMATTER_RE.match(content)
    if m:
        raw_fm = m.group(1)
        body = content[m.end():]
        for line in raw_fm.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                k = k.strip().lower()
                v = v.strip().strip("\"'")
                if v.startswith("[") and v.endswith("]"):
                    items = [x.strip().strip("\"'") for x in v[1:-1].split(",") if x.strip()]
                    meta[k] = items
                else:
                    meta[k] = v
    return meta, body


def classify_url(url: str, title: str, context: str) -> str:
    combined = f"{url} {title} {context}".lower()
    if any(k in combined for k in ["grafana", "prometheus", "datadog", "cloudwatch", "azure monitor", "metrics", "dashboard", "alert"]):
        return "observability"
    if any(k in combined for k in ["github.com", "gitlab.com", "bitbucket", "pull/", "commit", "repo"]):
        return "repo"
    if any(k in combined for k in ["jira", "ServiceNow", "linear", "ticket", "incident", "inc-", " sas-", " RFC"]):
        return "ticket"
    if any(k in combined for k in ["runbook", "playbook", "troubleshooting", "triage", "oncall", "viya"]):
        return "runbook"
    if any(k in combined for k in ["aws.amazon", "learn.microsoft", "cloud.google", "kubernetes.io", "terraform.io", "documentation.sas.com", "docs."]):
        return "docs"
    return "reference"


def index_single_note(conn, rel_path: str):
    full_path = VAULT_DIR / rel_path
    if not full_path.exists() or not full_path.is_file():
        remove_note_from_index(conn, rel_path)
        return

    try:
        raw_content = full_path.read_text(encoding="utf-8")
    except Exception:
        return

    stat = full_path.stat()
    updated_at = stat.st_mtime
    created_at = getattr(stat, "st_birthtime", stat.st_ctime)

    meta, body = parse_frontmatter(raw_content)
    parts = Path(rel_path).parts
    folder = parts[0] if len(parts) > 1 else "root"
    stem = Path(rel_path).stem

    # Determine title
    title = meta.get("title", "")
    if not title:
        for line in body.splitlines():
            s = line.strip()
            if s.startswith("# "):
                title = s[2:].strip()
                break
    if not title:
        title = stem

    note_type = meta.get("type", folder if folder in ("daily", "projects", "kb", "templates") else "note")
    status = meta.get("status", "")
    env = meta.get("env", meta.get("environment", ""))
    owner = meta.get("owner", "")
    words = len(re.findall(r"\w+", body))

    # Clear existing relational rows for this file
    conn.execute("DELETE FROM notes WHERE path = ?", (rel_path,))
    conn.execute("DELETE FROM notes_fts WHERE path = ?", (rel_path,))
    conn.execute("DELETE FROM backlinks WHERE source_path = ?", (rel_path,))
    conn.execute("DELETE FROM tasks WHERE source_path = ?", (rel_path,))
    conn.execute("DELETE FROM links WHERE source_path = ?", (rel_path,))
    conn.execute("DELETE FROM tags WHERE source_path = ?", (rel_path,))

    all_tags = set()
    if isinstance(meta.get("tags"), list):
        for t in meta["tags"]:
            all_tags.add(t.lstrip("#"))
    elif isinstance(meta.get("tags"), str) and meta.get("tags"):
        for t in re.split(r"[,\s]+", meta["tags"]):
            if t.strip():
                all_tags.add(t.strip().lstrip("#"))

    lines = raw_content.splitlines()
    in_code_block = False

    # Load saved bookmark overrides
    saved_bm = {}
    for row in conn.execute("SELECT url, custom_title, is_pinned, category FROM saved_bookmarks"):
        saved_bm[row["url"]] = dict(row)

    for idx, line in enumerate(lines, start=1):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue

        # 1. Extract Tags
        for tm in TAG_RE.finditer(line):
            tag_val = tm.group(1)
            all_tags.add(tag_val)
            conn.execute(
                "INSERT INTO tags (tag, source_path, line_num) VALUES (?, ?, ?)",
                (tag_val, rel_path, idx)
            )

        # 2. Extract Wikilinks [[Target|Alias]]
        for wm in WIKILINK_RE.finditer(line):
            target_raw = wm.group(1).strip()
            target_slug = normalize_slug(target_raw)
            context_clean = stripped
            if context_clean.startswith("- ") or context_clean.startswith("* "):
                context_clean = context_clean[2:].strip()
            conn.execute(
                """INSERT INTO backlinks (source_path, source_title, target_slug, line_num, context)
                   VALUES (?, ?, ?, ?, ?)""",
                (rel_path, title, target_slug, idx, context_clean[:240])
            )

        # 3. Extract Tasks: - [ ] , - [x] , - [/] (doing), - [-] (cancelled)
        tm = TASK_RE.match(line)
        if tm and folder != "templates":
            raw_state = tm.group(2).lower()
            task_text = tm.group(3).strip()
            state_map = {
                " ": "todo",
                "x": "done",
                "/": "doing",
                "-": "cancelled",
                ">": "todo"
            }
            state = state_map.get(raw_state, "todo")

            # Priority
            prio = "normal"
            pm = PRIORITY_RE.search(task_text)
            if pm:
                p_str = pm.group(1).lower()
                if p_str in ("high", "p1"):
                    prio = "high"
                elif p_str in ("med", "p2"):
                    prio = "med"
                elif p_str in ("low", "p3"):
                    prio = "low"

            # Due date
            due = ""
            dm = DUE_DATE_RE.search(task_text)
            if dm:
                due = dm.group(1) or dm.group(2) or ""
            elif folder == "daily" and re.match(r"^\d{4}-\d{2}-\d{2}$", stem):
                # Default context date is the daily note date if not explicitly set
                due = stem

            task_tags = [m.group(1) for m in INLINE_TAG_RE.finditer(task_text)]
            proj_links = [m.group(1).strip() for m in WIKILINK_RE.finditer(task_text)]

            # Clean display text
            clean = PRIORITY_RE.sub("", task_text)
            clean = DUE_DATE_RE.sub("", clean).strip()

            conn.execute(
                """INSERT INTO tasks (
                    source_path, source_title, folder, line_num, state, text, clean_text,
                    priority, due_date, tags_json, project_links_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    rel_path, title, folder, idx, state, task_text, clean,
                    prio, due, json.dumps(task_tags), json.dumps(proj_links), updated_at
                )
            )

        # 4. Extract External Links (Markdown links + Bare URLs)
        found_urls_on_line = set()
        line_tags = [m.group(1) for m in INLINE_TAG_RE.finditer(line)]

        for lm in MD_LINK_RE.finditer(line):
            link_title = lm.group(1).strip()
            url = lm.group(2).strip()
            found_urls_on_line.add(url)
            parsed = urllib.parse.urlparse(url)
            domain = parsed.netloc.lower()
            if domain.startswith("www."):
                domain = domain[4:]

            bm = saved_bm.get(url, {})
            final_title = bm.get("custom_title") or link_title or domain
            cat = bm.get("category") or classify_url(url, final_title, stripped)
            is_pinned = bm.get("is_pinned", 0)

            conn.execute(
                """INSERT INTO links (
                    url, domain, title, source_path, source_title, line_num,
                    context, tags_json, category, is_pinned, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    url, domain, final_title, rel_path, title, idx,
                    stripped[:240], json.dumps(line_tags), cat, is_pinned, updated_at
                )
            )

        for bm_match in BARE_URL_RE.finditer(line):
            url = bm_match.group(1).strip().rstrip(".,;:")
            if url in found_urls_on_line:
                continue
            found_urls_on_line.add(url)
            parsed = urllib.parse.urlparse(url)
            domain = parsed.netloc.lower()
            if domain.startswith("www."):
                domain = domain[4:]

            bm = saved_bm.get(url, {})
            final_title = bm.get("custom_title") or url
            cat = bm.get("category") or classify_url(url, final_title, stripped)
            is_pinned = bm.get("is_pinned", 0)

            conn.execute(
                """INSERT INTO links (
                    url, domain, title, source_path, source_title, line_num,
                    context, tags_json, category, is_pinned, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    url, domain, final_title, rel_path, title, idx,
                    stripped[:240], json.dumps(line_tags), cat, is_pinned, updated_at
                )
            )

    conn.execute(
        """INSERT INTO notes (
            path, title, folder, note_type, status, env, owner,
            updated_at, created_at, word_count, raw_content, frontmatter_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            rel_path, title, folder, note_type, status, env, owner,
            updated_at, created_at, words, raw_content, json.dumps(meta)
        )
    )

    tags_str = " ".join(sorted(all_tags))
    conn.execute(
        "INSERT INTO notes_fts (path, title, body, tags) VALUES (?, ?, ?, ?)",
        (rel_path, title, body, tags_str)
    )


def remove_note_from_index(conn, rel_path: str):
    conn.execute("DELETE FROM notes WHERE path = ?", (rel_path,))
    conn.execute("DELETE FROM notes_fts WHERE path = ?", (rel_path,))
    conn.execute("DELETE FROM backlinks WHERE source_path = ?", (rel_path,))
    conn.execute("DELETE FROM tasks WHERE source_path = ?", (rel_path,))
    conn.execute("DELETE FROM links WHERE source_path = ?", (rel_path,))
    conn.execute("DELETE FROM tags WHERE source_path = ?", (rel_path,))


def full_reindex():
    conn = get_db()
    with conn:
        for rel_path_obj in VAULT_DIR.rglob("*.md"):
            if any(p.startswith(".") for p in rel_path_obj.parts):
                continue
            rel_path = rel_path_obj.relative_to(VAULT_DIR).as_posix()
            index_single_note(conn, rel_path)
    conn.close()


def toggle_task_in_file(rel_path: str, line_num: int, new_state: str):
    full_path = VAULT_DIR / rel_path
    if not full_path.exists():
        return False, "File not found"

    lines = full_path.read_text(encoding="utf-8").splitlines(keepends=True)
    if line_num < 1 or line_num > len(lines):
        return False, "Line number out of range"

    char_map = {
        "todo": " ",
        "done": "x",
        "doing": "/",
        "cancelled": "-"
    }
    box_char = char_map.get(new_state, " ")

    target_line = lines[line_num - 1]
    updated_line = re.sub(
        r"^(\s*(?:[-*+]|\d+\.)\s+\[)[ xX/\->](\])",
        rf"\g<1>{box_char}\g<2>",
        target_line
    )
    lines[line_num - 1] = updated_line
    full_path.write_text("".join(lines), encoding="utf-8")

    conn = get_db()
    with conn:
        index_single_note(conn, rel_path)
    conn.close()
    return True, "Updated"


def append_to_daily_note(date_str: str, section_header: str, bullet_line: str):
    rel_path = f"daily/{date_str}.md"
    full_path = VAULT_DIR / rel_path
    if not full_path.exists():
        create_daily_note_if_missing(date_str)

    content = full_path.read_text(encoding="utf-8")
    lines = content.splitlines()

    # Find section header
    target_idx = -1
    for i, line in enumerate(lines):
        if line.strip().lower().startswith(section_header.lower()):
            target_idx = i
            break

    if target_idx != -1:
        # Find end of section (next ## header or EOF)
        insert_at = len(lines)
        for j in range(target_idx + 1, len(lines)):
            if lines[j].strip().startswith("## "):
                insert_at = j
                break
        # Backtrack over empty lines
        while insert_at > target_idx + 1 and not lines[insert_at - 1].strip():
            insert_at -= 1
        lines.insert(insert_at, bullet_line)
    else:
        lines.append("")
        lines.append(section_header)
        lines.append(bullet_line)

    full_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    conn = get_db()
    with conn:
        index_single_note(conn, rel_path)
    conn.close()
    return rel_path


def create_daily_note_if_missing(date_str: str) -> str:
    rel_path = f"daily/{date_str}.md"
    full_path = VAULT_DIR / rel_path
    if full_path.exists():
        return rel_path

    # Check if yesterday had unfinished tasks to offer carry-over info or clean template
    template = f"""---
title: "{date_str}"
type: daily
tags: [daily-log, cloud]
---

# {date_str} — Daily Log

## 🎯 Focus & Tasks
- [ ] Review cluster health & alerts #ops !med

## 🛠 Work Log & Outliner
- **09:00** — Standup & Architecture Sync
  - Checked active deployments and resource watermarks

## 🔗 Bookmarks & Captured Links
- 
"""
    full_path.parent.mkdir(parents=True, exist_ok=True)
    full_path.write_text(template, encoding="utf-8")
    conn = get_db()
    with conn:
        index_single_note(conn, rel_path)
    conn.close()
    return rel_path


def seed_starter_vault_if_empty():
    existing = list(VAULT_DIR.rglob("*.md"))
    if existing:
        return

    today = datetime.now().strftime("%Y-%m-%d")
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    two_days_ago = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d")

    files = {
        f"daily/{today}.md": f"""---
title: "{today}"
type: daily
tags: [daily-log, sas-cloud, viya4]
---

# {today} — Daily Log

## 🎯 Focus & Tasks
- [ ] Validate CAS SMP/MPP nodepool autoscaling rules on AKS for [[SAS Viya 4 AKS Migration]] #sas-viya #aks !high @due({today})
- [/] Benchmark PostgreSQL CrunchyData HA failover latency under synthetic load [[CrunchyData Postgres HA Upgrade]] #postgres #ha !high @due({today})
- [ ] Approve Terraform PR for Azure NetApp Files RWX storage class tuning [[SAS Viya 4 AKS Migration]] #terraform #storage !med
- [x] Rotate SAS Container Runtime (SCR) ACR pull credentials in prod-eu-west #security #aks !low

## 🛠 Work Log & Outliner
- **09:15** — **Architecture Triage: CAS Controller OOM Investigation**
  - Observed memory spikes on `sas-cas-server-default-controller` during concurrent `PROC LOGISTIC` batch runs in `prod-us-east`.
  - Root cause: `CAS_DISK_CACHE` was falling back to ephemeral OS disk instead of dedicated NVMe scratch mount (`/cas/cache`).
  - Linked runbook: [[CAS Memory & Disk Cache Runbook]]
  - Updated Kustomize patch in repo: [viya4-iac-azure PR #418](https://github.com/sascommunities/viya4-iac-azure/pull/418) #iac #kustomize
- **11:30** — **Customer Cloud Readiness Review (Global Banking Tenant)**
  - Walked through ingress TLS termination with [[Zero Trust OIDC & Ingress Design]].
  - Confirmed Azure Front Door WAF policies allow WebSocket upgrades for SAS StudioV (`wss://`).
  - Reference doc: [SAS Viya 4 Ingress Controller Configuration](https://documentation.sas.com/doc/en/itopscdc/default/itopsag/n12345ingress.htm) #docs #ingress
- **14:45** — **Observability & FinOps Check**
  - Reviewed node utilization dashboard: [Grafana SAS Viya Cluster Overview](https://grafana.internal.sas.cloud/d/viya-aks-01/sas-viya-cluster-overview) #observability #grafana
  - Spot instance eviction rate on `stat-compute` pool stayed below 1.2% this week.

## 🔗 Bookmarks & Captured Links
- [SAS Viya 4 Operations: Tuning CAS Server Resources](https://documentation.sas.com/doc/en/itopscdc/default/dplyml0phy0dkr/n0casresources.htm) — Official guidance on `CAS_VIRTUAL_PROTO` and backing store mounts #sas-viya #cas
- [Kubernetes 1.30 Topology Spread Constraints Docs](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/) — Ensuring CAS workers spread across AZs cleanly #k8s #scheduling
""",

        f"daily/{yesterday}.md": f"""---
title: "{yesterday}"
type: daily
tags: [daily-log, sas-cloud]
---

# {yesterday} — Daily Log

## 🎯 Focus & Tasks
- [ ] Draft ADR-014 for multi-region disaster recovery RTO/RPO targets [[SAS Viya 4 AKS Migration]] #adr #dr !high @due({today})
- [ ] Audit Istio mTLS PeerAuthentication strict mode exceptions in `sas-microanalytic-score` [[Zero Trust OIDC & Ingress Design]] #security #istio !med
- [x] Fix Prometheus scrape timeout on `sas-rabbitmq-server` exporter endpoints #observability #prometheus !med
- [x] Sync with Storage Engineering on Azure NetApp Files 4TiB volume quota increase #storage #azure

## 🛠 Work Log & Outliner
- **10:00** — **CrunchyData PGO v5.5 Upgrade Dry Run**
  - Tested pgBackRest delta restore on staging cluster (`stg-viya-02`) for [[CrunchyData Postgres HA Upgrade]].
  - Recovery of 380GB SharedServices DB completed in **11m 42s**.
  - Captured metrics in [Datadog Postgres Failover Notebook](https://app.datadoghq.com/notebook/1049281/viya-crunchy-ha-drill) #postgres #datadog
- **15:20** — **SAS Workload Orchestrator Queue Starvation Fix**
  - Adjusted `maxJobs` and preemption priority for `interactive-studio` queue vs `batch-scoring` queue.
  - documented findings in [[SAS Workload Orchestrator Sizing Guide]].

## 🔗 Bookmarks & Captured Links
- [CrunchyData PGO v5 High Availability Architecture](https://access.crunchydata.com/documentation/postgres-operator/latest/architecture/high-availability) — Patroni leader election & etcd lease tuning #postgres #docs
- [Azure AKS Ephemeral OS Disks & NVMe Temp Storage](https://learn.microsoft.com/en-us/azure/aks/cluster-configuration#ephemeral-os) — Critical for high-throughput `CAS_DISK_CACHE` #azure #aks
""",

        f"daily/{two_days_ago}.md": f"""---
title: "{two_days_ago}"
type: daily
tags: [daily-log, sas-cloud]
---

# {two_days_ago} — Daily Log

## 🎯 Focus & Tasks
- [ ] Build Kustomize transformer generator for customer-specific OIDC claim mappings [[Zero Trust OIDC & Ingress Design]] #kustomize #auth !low
- [x] Provision `Standard_E32ds_v5` node pool with taint `workload.sas.com/class=cas:NoSchedule` [[SAS Viya 4 AKS Migration]] #aks #terraform !high
- [x] Publish post-mortem for INC-8841 (CoreDNS UDP conntrack exhaustion) [[CAS Memory & Disk Cache Runbook]] #incident #dns

## 🛠 Work Log & Outliner
- **09:30** — **CoreDNS Conntrack Tuning on AKS**
  - Enabled `NodeLocal DNSCache` daemonset across all 24 compute nodes.
  - DNS P99 lookup latency dropped from `48ms` to `1.1ms`.
  - Incident ticket: [JIRA CLOUD-9412: CoreDNS Intermittent Timeouts](https://jira.internal.sas.cloud/browse/CLOUD-9412) #ticket #k8s
""",

        "projects/SAS Viya 4 AKS Migration.md": f"""---
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
- [ ] Finalize multi-AZ zone-redundant storage snapshot schedule for `sas-commonfiles` #storage !high @due({today})
- [/] Load test 150 concurrent SAS Studio sessions + 40 parallel CAS actions #perf !high
- [ ] Complete security sign-off on [[Zero Trust OIDC & Ingress Design]] with InfoSec #security !med
- [x] Deploy baseline IaC using [sas-viya4-iac-azure](https://github.com/sassoftware/viya4-iac-azure) #terraform

## 🔗 Key Project Resources
- [SAS Viya 4 Deployment GitHub Repository](https://github.com/sassoftware/viya4-deployment) — Official Ansible & Kustomize deployment assets #repo #sas-viya
- [Azure NetApp Files Performance Benchmarks for EDA/HPC](https://learn.microsoft.com/en-us/azure/azure-netapp-files/performance-benchmarks-linux) — Mount options `nconnect=8` validation #azure #storage
- Related Runbooks: [[CAS Memory & Disk Cache Runbook]], [[SAS Workload Orchestrator Sizing Guide]], [[CrunchyData Postgres HA Upgrade]]
""",

        "projects/CrunchyData Postgres HA Upgrade.md": """---
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
""",

        "projects/Zero Trust OIDC & Ingress Design.md": """---
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
""",

        "kb/CAS Memory & Disk Cache Runbook.md": """---
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
kubectl get pods -n viya-prod -l app.kubernetes.io/name=sas-cas-server -o name | \\
  xargs -I {} kubectl exec -n viya-prod {} -c sas-cas-server -- df -h /cas/cache
```

### 2. Query Active CAS Session Memory Consumption
```bash
# List top memory-consuming CAS sessions via sas-viya CLI
sas-viya cas sessions list --server cas-shared-default --output fulljson | \\
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
""",

        "kb/SAS Workload Orchestrator Sizing Guide.md": """---
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
""",

        "templates/ADR Template.md": """---
title: "ADR-000: Architecture Decision Title"
type: kb
status: draft
env: global
owner: Cloud Tech Lead
tags: [adr, architecture, sas-cloud]
---

# ADR-000: Architecture Decision Title

## Context & Problem Statement
Describe the cloud architectural challenge, constraints (latency, high availability, FinOps cost, security compliance), and why a decision is needed now.

## Considered Options
1. **Option A** — Cloud-native managed service
2. **Option B** — Self-managed Kubernetes operator

## Decision Outcome
Chosen option: **Option A**, because...

## Consequences & Action Items
- [ ] Update Terraform module in [[SAS Viya 4 AKS Migration]] #terraform !med
"""
    }

    for rel, content in files.items():
        p = VAULT_DIR / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")


class ViaductHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, format, *args):
        # Quiet clean logging
        pass

    def send_json(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/bootstrap":
            return self.handle_bootstrap()
        elif path == "/api/note":
            note_path = qs.get("path", [""])[0]
            return self.handle_get_note(note_path)
        elif path == "/api/daily":
            date_str = qs.get("date", [datetime.now().strftime("%Y-%m-%d")])[0]
            return self.handle_get_daily(date_str)
        elif path == "/api/search":
            q = qs.get("q", [""])[0]
            tag = qs.get("tag", [""])[0]
            folder = qs.get("folder", [""])[0]
            return self.handle_search(q, tag, folder)
        elif path == "/api/tasks":
            return self.handle_get_tasks(qs)
        elif path == "/api/links":
            return self.handle_get_links(qs)
        elif path == "/api/graph":
            return self.handle_get_graph()
        elif path == "/api/report":
            return self.handle_get_report(qs)
        elif path == "/api/export":
            return self.handle_export()

        # Serve static frontend
        if path == "/" or path == "":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.read_json_body()

        if path == "/api/note/save":
            return self.handle_save_note(body)
        elif path == "/api/note/create":
            return self.handle_create_note(body)
        elif path == "/api/note/delete":
            return self.handle_delete_note(body)
        elif path == "/api/tasks/toggle":
            return self.handle_toggle_task(body)
        elif path == "/api/tasks/add":
            return self.handle_add_task(body)
        elif path == "/api/tasks/carryover":
            return self.handle_carryover_tasks(body)
        elif path == "/api/links/add":
            return self.handle_add_link(body)
        elif path == "/api/links/pin":
            return self.handle_pin_link(body)
        elif path == "/api/reindex":
            full_reindex()
            return self.send_json({"ok": True})

        return self.send_json({"error": "Not found"}, 404)

    # --- API Handlers ---

    def handle_bootstrap(self):
        conn = get_db()
        notes = [
            dict(r) for r in conn.execute(
                """SELECT path, title, folder, note_type, status, env, owner,
                          updated_at, created_at, word_count, frontmatter_json
                   FROM notes ORDER BY folder ASC, updated_at DESC"""
            )
        ]
        for n in notes:
            try:
                n["frontmatter"] = json.loads(n.pop("frontmatter_json", "{}"))
            except Exception:
                n["frontmatter"] = {}

        # Counts for sidebar badges
        open_tasks_count = conn.execute(
            "SELECT COUNT(*) AS c FROM tasks WHERE state IN ('todo', 'doing')"
        ).fetchone()["c"]

        links_count = conn.execute(
            "SELECT COUNT(DISTINCT url) AS c FROM links"
        ).fetchone()["c"]

        tags_rows = conn.execute(
            "SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY count DESC, tag ASC"
        ).fetchall()

        today_str = datetime.now().strftime("%Y-%m-%d")
        conn.close()

        return self.send_json({
            "today": today_str,
            "vault_dir": str(VAULT_DIR),
            "notes": notes,
            "counts": {
                "notes": len(notes),
                "open_tasks": open_tasks_count,
                "links": links_count
            },
            "tags": [dict(r) for r in tags_rows]
        })

    def get_note_payload(self, conn, rel_path: str):
        row = conn.execute("SELECT * FROM notes WHERE path = ?", (rel_path,)).fetchone()
        if not row:
            return None
        note = dict(row)
        note["frontmatter"] = json.loads(note.pop("frontmatter_json", "{}"))

        # Compute incoming backlinks (explicit [[Title]] or [[stem]])
        stem_slug = normalize_slug(Path(rel_path).stem)
        title_slug = normalize_slug(note["title"])
        path_slug = normalize_slug(rel_path)

        backlinks = [
            dict(r) for r in conn.execute(
                """SELECT DISTINCT source_path, source_title, line_num, context
                   FROM backlinks
                   WHERE target_slug IN (?, ?, ?) AND source_path != ?
                   ORDER BY source_path ASC, line_num ASC""",
                (stem_slug, title_slug, path_slug, rel_path)
            )
        ]

        # Compute unlinked mentions (notes that mention this note's title in FTS but don't link to it)
        linked_sources = {b["source_path"] for b in backlinks}
        linked_sources.add(rel_path)
        unlinked = []
        if len(note["title"]) >= 4 and not re.match(r"^\d{4}-\d{2}-\d{2}$", note["title"]):
            safe_q = '"' + note["title"].replace('"', '""') + '"'
            try:
                fts_rows = conn.execute(
                    """SELECT path, title, snippet(notes_fts, 2, '<mark>', '</mark>', '…', 18) as snippet
                       FROM notes_fts WHERE notes_fts MATCH ? LIMIT 10""",
                    (safe_q,)
                ).fetchall()
                for fr in fts_rows:
                    if fr["path"] not in linked_sources:
                        unlinked.append(dict(fr))
            except Exception:
                pass

        # Outgoing wikilinks
        outgoing_raw = conn.execute(
            "SELECT target_slug, line_num, context FROM backlinks WHERE source_path = ?",
            (rel_path,)
        ).fetchall()

        # Tasks in this note
        note_tasks = [
            dict(r) for r in conn.execute(
                "SELECT * FROM tasks WHERE source_path = ? ORDER BY line_num ASC",
                (rel_path,)
            )
        ]

        # External links in this note
        note_links = [
            dict(r) for r in conn.execute(
                "SELECT * FROM links WHERE source_path = ? ORDER BY line_num ASC",
                (rel_path,)
            )
        ]

        note["backlinks"] = backlinks
        note["unlinked_mentions"] = unlinked
        note["outgoing_links"] = [dict(r) for r in outgoing_raw]
        note["tasks"] = note_tasks
        note["external_links"] = note_links
        return note

    def handle_get_note(self, rel_path: str):
        if not rel_path:
            return self.send_json({"error": "Missing path"}, 400)
        conn = get_db()
        payload = self.get_note_payload(conn, rel_path)
        conn.close()
        if not payload:
            return self.send_json({"error": "Note not found"}, 404)
        return self.send_json(payload)

    def handle_get_daily(self, date_str: str):
        rel_path = create_daily_note_if_missing(date_str)
        conn = get_db()
        payload = self.get_note_payload(conn, rel_path)

        # Also fetch recent daily notes for the timeline navigator
        recent_dailies = [
            dict(r) for r in conn.execute(
                """SELECT n.path, n.title,
                          (SELECT COUNT(*) FROM tasks t WHERE t.source_path = n.path AND t.state IN ('todo','doing')) AS open_tasks,
                          (SELECT COUNT(*) FROM tasks t WHERE t.source_path = n.path AND t.state = 'done') AS done_tasks
                   FROM notes n
                   WHERE n.folder = 'daily'
                   ORDER BY n.title DESC LIMIT 30"""
            )
        ]
        # Count unfinished tasks from previous daily notes that can be carried over
        overdue_carryover = conn.execute(
            """SELECT COUNT(*) AS c FROM tasks
               WHERE folder = 'daily' AND source_path != ? AND state IN ('todo', 'doing')""",
            (rel_path,)
        ).fetchone()["c"]

        conn.close()
        payload["recent_dailies"] = recent_dailies
        payload["carryover_available"] = overdue_carryover
        return self.send_json(payload)

    def handle_save_note(self, body: dict):
        rel_path = body.get("path", "").strip()
        content = body.get("content", "")
        if not rel_path or ".." in rel_path:
            return self.send_json({"error": "Invalid path"}, 400)

        full_path = VAULT_DIR / rel_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content, encoding="utf-8")

        conn = get_db()
        with conn:
            index_single_note(conn, rel_path)
        payload = self.get_note_payload(conn, rel_path)
        conn.close()
        return self.send_json({"ok": True, "note": payload})

    def handle_create_note(self, body: dict):
        title = body.get("title", "").strip()
        folder = body.get("folder", "projects").strip()
        template_type = body.get("template", "default")
        if not title:
            return self.send_json({"error": "Title is required"}, 400)

        safe_name = re.sub(r'[<>:"/\\|?*]', "-", title)
        if not safe_name.endswith(".md"):
            safe_name += ".md"
        rel_path = f"{folder}/{safe_name}" if folder and folder != "root" else safe_name
        full_path = VAULT_DIR / rel_path

        if full_path.exists():
            conn = get_db()
            payload = self.get_note_payload(conn, rel_path)
            conn.close()
            return self.send_json({"ok": True, "note": payload, "existed": True})

        today = datetime.now().strftime("%Y-%m-%d")
        if folder == "projects" or template_type == "project":
            content = f"""---
title: "{title}"
type: project
status: active
env: prod-k8s
owner: Tech Lead
tags: [project, cloud]
---

# {title}

## 🏗 Architecture & Objective
- Outline the system scope, target SLA/SLO, and cloud dependencies.

## 📋 Project Tasks & Milestones
- [ ] Define infrastructure & sizing requirements #architecture !high @due({today})
- [ ] Link operational runbooks and observability dashboards #ops !med

## 🔗 Key Links & Documentation
- 
"""
        elif folder == "kb" or template_type == "runbook":
            content = f"""---
title: "{title}"
type: kb
status: verified
env: prod
owner: Tech Lead
tags: [runbook, kb, ops]
---

# {title}

## 🚨 Symptoms & Context
- Describe the alert, error code, or operational scenario.

## 🔍 Diagnostic & Remediation Steps
```bash
# Check pod status and logs
kubectl get pods -A
```

## 🔗 Related Projects & Docs
- 
"""
        else:
            content = f"""---
title: "{title}"
type: {folder}
tags: [notes]
---

# {title}

- 
"""

        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content, encoding="utf-8")

        conn = get_db()
        with conn:
            index_single_note(conn, rel_path)
        payload = self.get_note_payload(conn, rel_path)
        conn.close()
        return self.send_json({"ok": True, "note": payload})

    def handle_delete_note(self, body: dict):
        rel_path = body.get("path", "").strip()
        if not rel_path or ".." in rel_path:
            return self.send_json({"error": "Invalid path"}, 400)
        full_path = VAULT_DIR / rel_path
        if full_path.exists():
            full_path.unlink()
        conn = get_db()
        with conn:
            remove_note_from_index(conn, rel_path)
        conn.close()
        return self.send_json({"ok": True})

    def handle_search(self, q: str, tag: str, folder: str):
        t0 = time.perf_counter()
        conn = get_db()
        results = []

        q = q.strip()
        if q:
            # Build safe FTS5 query with prefix matching
            tokens = re.findall(r"[a-zA-Z0-9_\-]+", q)
            if tokens:
                fts_query = " AND ".join(f'"{t}"*' for t in tokens)
                sql = """
                    SELECT n.path, n.title, n.folder, n.note_type, n.status, n.env, n.updated_at,
                           snippet(notes_fts, 2, '<mark>', '</mark>', '…', 24) AS snippet,
                           bm25(notes_fts, 0.0, 10.0, 1.0, 5.0) AS rank
                    FROM notes_fts
                    JOIN notes n ON n.path = notes_fts.path
                    WHERE notes_fts MATCH ?
                """
                params = [fts_query]
                if folder:
                    sql += " AND n.folder = ?"
                    params.append(folder)
                if tag:
                    sql += " AND EXISTS (SELECT 1 FROM tags tg WHERE tg.source_path = n.path AND tg.tag = ?)"
                    params.append(tag)
                sql += " ORDER BY rank LIMIT 40"
                try:
                    rows = conn.execute(sql, params).fetchall()
                    results = [dict(r) for r in rows]
                except Exception:
                    pass

            # Fallback substring search if FTS had 0 matches (e.g. symbols)
            if not results:
                like_q = f"%{q}%"
                rows = conn.execute(
                    """SELECT path, title, folder, note_type, status, env, updated_at,
                              substr(raw_content, 1, 200) AS snippet
                       FROM notes
                       WHERE (title LIKE ? OR raw_content LIKE ?)
                       ORDER BY updated_at DESC LIMIT 30""",
                    (like_q, like_q)
                ).fetchall()
                results = [dict(r) for r in rows]
        else:
            sql = "SELECT path, title, folder, note_type, status, env, updated_at, substr(raw_content, 1, 180) AS snippet FROM notes WHERE 1=1"
            params = []
            if folder:
                sql += " AND folder = ?"
                params.append(folder)
            if tag:
                sql += " AND EXISTS (SELECT 1 FROM tags tg WHERE tg.source_path = notes.path AND tg.tag = ?)"
                params.append(tag)
            sql += " ORDER BY updated_at DESC LIMIT 40"
            results = [dict(r) for r in conn.execute(sql, params).fetchall()]

        elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)
        conn.close()
        return self.send_json({
            "query": q,
            "elapsed_ms": elapsed_ms,
            "results": results
        })

    def handle_get_tasks(self, qs: dict):
        conn = get_db()
        rows = conn.execute(
            """SELECT * FROM tasks
               ORDER BY
                 CASE state WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                 CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                 due_date ASC,
                 source_path DESC,
                 line_num ASC"""
        ).fetchall()
        tasks = []
        for r in rows:
            d = dict(r)
            d["tags"] = json.loads(d.pop("tags_json", "[]"))
            d["project_links"] = json.loads(d.pop("project_links_json", "[]"))
            tasks.append(d)
        conn.close()
        return self.send_json({
            "today": datetime.now().strftime("%Y-%m-%d"),
            "tasks": tasks
        })

    def handle_toggle_task(self, body: dict):
        rel_path = body.get("source_path", "")
        line_num = int(body.get("line_num", 0))
        new_state = body.get("state", "done")
        ok, msg = toggle_task_in_file(rel_path, line_num, new_state)
        if not ok:
            return self.send_json({"error": msg}, 400)
        return self.send_json({"ok": True})

    def handle_add_task(self, body: dict):
        text = body.get("text", "").strip()
        if not text:
            return self.send_json({"error": "Task text required"}, 400)
        priority = body.get("priority", "").strip()
        due_date = body.get("due_date", "").strip()
        project = body.get("project", "").strip()
        target_date = body.get("date", datetime.now().strftime("%Y-%m-%d")).strip()

        parts = [f"- [ ] {text}"]
        if project and f"[[{project}]]" not in text:
            parts.append(f"[[{project}]]")
        if priority in ("high", "med", "low") and f"!{priority}" not in text:
            parts.append(f"!{priority}")
        if due_date and f"@due({due_date})" not in text:
            parts.append(f"@due({due_date})")

        bullet = " ".join(parts)
        rel_path = append_to_daily_note(target_date, "## 🎯 Focus & Tasks", bullet)
        return self.send_json({"ok": True, "path": rel_path})

    def handle_carryover_tasks(self, body: dict):
        target_date = body.get("date", datetime.now().strftime("%Y-%m-%d")).strip()
        target_rel_path = create_daily_note_if_missing(target_date)

        conn = get_db()
        unfinished = conn.execute(
            """SELECT source_path, line_num, text, state FROM tasks
               WHERE folder = 'daily' AND source_path != ? AND state IN ('todo', 'doing')
               ORDER BY source_path ASC, line_num ASC""",
            (target_rel_path,)
        ).fetchall()
        conn.close()

        if not unfinished:
            return self.send_json({"ok": True, "moved": 0})

        moved_count = 0
        for row in unfinished:
            src_path = row["source_path"]
            line_num = row["line_num"]
            task_text = row["text"]
            # Mark original as forwarded [>]
            toggle_task_in_file(src_path, line_num, ">")
            # Append to today's note
            box = "/" if row["state"] == "doing" else " "
            append_to_daily_note(target_date, "## 🎯 Focus & Tasks", f"- [{box}] {task_text}")
            moved_count += 1

        return self.send_json({"ok": True, "moved": moved_count})

    def handle_get_links(self, qs: dict):
        conn = get_db()
        rows = conn.execute(
            """SELECT * FROM links
               ORDER BY is_pinned DESC, updated_at DESC, id DESC"""
        ).fetchall()
        links = []
        for r in rows:
            d = dict(r)
            d["tags"] = json.loads(d.pop("tags_json", "[]"))
            links.append(d)

        domains = [
            dict(r) for r in conn.execute(
                "SELECT domain, COUNT(*) AS count FROM links GROUP BY domain ORDER BY count DESC"
            )
        ]
        categories = [
            dict(r) for r in conn.execute(
                "SELECT category, COUNT(*) AS count FROM links GROUP BY category ORDER BY count DESC"
            )
        ]
        conn.close()
        return self.send_json({
            "links": links,
            "domains": domains,
            "categories": categories
        })

    def handle_add_link(self, body: dict):
        url = body.get("url", "").strip()
        title = body.get("title", "").strip()
        notes = body.get("notes", "").strip()
        tags = body.get("tags", "").strip()
        category = body.get("category", "").strip()
        date_str = datetime.now().strftime("%Y-%m-%d")

        if not url:
            return self.send_json({"error": "URL required"}, 400)
        if not url.startswith("http://") and not url.startswith("https://"):
            url = "https://" + url

        if not title:
            parsed = urllib.parse.urlparse(url)
            title = parsed.netloc or url

        # Save metadata in saved_bookmarks
        conn = get_db()
        with conn:
            conn.execute(
                """INSERT INTO saved_bookmarks (url, custom_title, notes, is_pinned, category, created_at)
                   VALUES (?, ?, ?, 0, ?, ?)
                   ON CONFLICT(url) DO UPDATE SET
                     custom_title=excluded.custom_title,
                     notes=excluded.notes,
                     category=excluded.category""",
                (url, title, notes, category, time.time())
            )
        conn.close()

        # Also log to today's daily note so it stays 100% local-first in Markdown!
        tag_str = ""
        if tags:
            tag_tokens = [t.strip() if t.strip().startswith("#") else f"#{t.strip()}" for t in re.split(r"[,\s]+", tags) if t.strip()]
            tag_str = " " + " ".join(tag_tokens)

        desc_str = f" — {notes}" if notes else ""
        bullet = f"- [{title}]({url}){desc_str}{tag_str}"
        rel_path = append_to_daily_note(date_str, "## 🔗 Bookmarks & Captured Links", bullet)
        return self.send_json({"ok": True, "path": rel_path})

    def handle_pin_link(self, body: dict):
        url = body.get("url", "").strip()
        pinned = 1 if body.get("is_pinned") else 0
        conn = get_db()
        with conn:
            conn.execute(
                """INSERT INTO saved_bookmarks (url, is_pinned, created_at)
                   VALUES (?, ?, ?)
                   ON CONFLICT(url) DO UPDATE SET is_pinned=excluded.is_pinned""",
                (url, pinned, time.time())
            )
            conn.execute("UPDATE links SET is_pinned = ? WHERE url = ?", (pinned, url))
        conn.close()
        return self.send_json({"ok": True})

    def handle_get_graph(self):
        conn = get_db()
        notes = [
            dict(r) for r in conn.execute(
                "SELECT path, title, folder, note_type, word_count FROM notes"
            )
        ]
        slug_to_path = {}
        for n in notes:
            slug_to_path[normalize_slug(n["title"])] = n["path"]
            slug_to_path[normalize_slug(Path(n["path"]).stem)] = n["path"]
            slug_to_path[normalize_slug(n["path"])] = n["path"]

        edges = []
        seen_edges = set()
        for row in conn.execute("SELECT source_path, target_slug FROM backlinks"):
            src = row["source_path"]
            tgt = slug_to_path.get(row["target_slug"])
            if tgt and src != tgt:
                pair = tuple(sorted([src, tgt]))
                if pair not in seen_edges:
                    seen_edges.add(pair)
                    edges.append({"source": src, "target": tgt})
        conn.close()
        return self.send_json({"nodes": notes, "edges": edges})

    def handle_export(self):
        conn = get_db()
        notes = [dict(r) for r in conn.execute("SELECT * FROM notes")]
        conn.close()
        return self.send_json({"exported_at": datetime.now().isoformat(), "notes": notes})

    def handle_get_report(self, qs: dict):
        today_dt = datetime.now()
        default_end = today_dt.strftime("%Y-%m-%d")
        default_start = (today_dt - timedelta(days=6)).strftime("%Y-%m-%d")

        start_date = qs.get("start", [default_start])[0].strip() or default_start
        end_date = qs.get("end", [default_end])[0].strip() or default_end
        mode = qs.get("mode", ["121"])[0].strip()  # '121' or 'friday'

        conn = get_db()
        # 1. Fetch daily notes in [start_date, end_date]
        daily_rows = conn.execute(
            """SELECT path, title, raw_content FROM notes
               WHERE folder = 'daily' AND title >= ? AND title <= ?
               ORDER BY title DESC""",
            (start_date, end_date)
        ).fetchall()

        daily_paths = {r["path"] for r in daily_rows}

        # Extract work log outliner entries from daily notes
        work_logs_by_day = []
        for r in daily_rows:
            day_title = r["title"]
            lines = r["raw_content"].splitlines()
            in_work_section = False
            entries = []
            for line in lines:
                s = line.strip()
                if s.startswith("## "):
                    if "work log" in s.lower() or "outliner" in s.lower():
                        in_work_section = True
                    else:
                        in_work_section = False
                    continue
                if in_work_section and s and (s.startswith("-") or s.startswith("*")):
                    if not TASK_RE.match(line):
                        entries.append(line)
            if entries:
                work_logs_by_day.append({"date": day_title, "lines": entries})

        # 2. Fetch tasks across the vault
        all_tasks = []
        for tr in conn.execute("SELECT * FROM tasks ORDER BY priority ASC, source_path DESC, line_num ASC"):
            td = dict(tr)
            td["tags"] = json.loads(td.pop("tags_json", "[]"))
            td["project_links"] = json.loads(td.pop("project_links_json", "[]"))
            all_tasks.append(td)

        # Completed tasks: in daily notes within range OR project/kb tasks completed
        completed_tasks = [
            t for t in all_tasks
            if t["state"] == "done" and (
                t["source_path"] in daily_paths or
                (t["due_date"] and start_date <= t["due_date"] <= end_date) or
                t["folder"] != "daily"
            )
        ]
        in_progress_tasks = [t for t in all_tasks if t["state"] == "doing"]
        high_open_tasks = [
            t for t in all_tasks
            if t["state"] == "todo" and t["priority"] in ("high", "med")
        ]

        # 3. Captured links from daily notes in range
        links_rows = conn.execute(
            """SELECT url, domain, title, source_title, category
               FROM links
               WHERE (folder_check IS NULL OR 1=1) AND source_title >= ? AND source_title <= ?
               ORDER BY id DESC""",
            (start_date, end_date)
        ).fetchall() if False else conn.execute(
            """SELECT url, domain, title, source_path, source_title, category
               FROM links ORDER BY updated_at DESC"""
        ).fetchall()

        period_links = [
            dict(r) for r in links_rows
            if r["source_path"] in daily_paths
        ]

        # 4. Active projects referenced in range
        projects_touched = {}
        for t in (completed_tasks + in_progress_tasks + high_open_tasks):
            for pl in t["project_links"]:
                projects_touched.setdefault(pl, {"done": 0, "open": 0})
                if t["state"] == "done":
                    projects_touched[pl]["done"] += 1
                else:
                    projects_touched[pl]["open"] += 1

        conn.close()

        # Build Markdown Document
        md = []
        if mode == "121":
            md.append(f"# 🤝 Manager 1:1 Sync & Status ({start_date} → {end_date})")
            md.append("")
            md.append("## 🏆 Key Wins & Shipped Deliverables")
            if completed_tasks:
                for t in completed_tasks:
                    md.append(f"- ✅ {t['clean_text']} *(from `{t['source_title']}`)*")
            else:
                md.append("- *No completed tasks recorded in this date window.*")

            md.append("")
            md.append("## 🚀 Currently In Progress (`[/]`)")
            if in_progress_tasks:
                for t in in_progress_tasks:
                    md.append(f"- [/] **{t['clean_text']}** *(Source: {t['source_title']})*")
            else:
                md.append("- *No tasks currently marked `[/]` in progress.*")

            md.append("")
            md.append("## 🎯 Top Priorities & Next Up")
            if high_open_tasks:
                for t in high_open_tasks[:8]:
                    prio_tag = f"`!{t['priority'].upper()}` " if t["priority"] in ("high", "med") else ""
                    md.append(f"- [ ] {prio_tag}{t['clean_text']} *(Source: {t['source_title']})*")
            else:
                md.append("- *All high/medium priority tasks cleared.*")

            md.append("")
            md.append("## 💬 1:1 Discussion Topics / Decisions / Escalations")
            md.append("- **Architecture & Delivery**: ")
            md.append("- **Risks / Blockers**: ")
            md.append("- **Team / Resourcing**: ")

            md.append("")
            md.append("## 🛠 Engineering Work Log Highlights")
            if work_logs_by_day:
                for day in work_logs_by_day:
                    md.append(f"### 📅 {day['date']}")
                    for l in day["lines"]:
                        md.append(l)
            else:
                md.append("- *No daily work log bullets in this period.*")

        else:
            # Friday "What I Have Done" Weekly Wrap-Up
            md.append(f"# 📋 Weekly Wrap-Up: What I Did ({start_date} → {end_date})")
            md.append("")
            md.append(f"**Summary**: Completed **{len(completed_tasks)}** tasks, progressed **{len(in_progress_tasks)}** active workstreams, and logged **{len(period_links)}** technical references across **{len(daily_rows)}** daily logs.")
            md.append("")
            md.append("## ✅ Completed This Week")
            if completed_tasks:
                for t in completed_tasks:
                    md.append(f"- ✅ {t['clean_text']} *(from `{t['source_title']}`)*")
            else:
                md.append("- *No completed tasks in this range.*")

            md.append("")
            md.append("## 🛠 Chronological Daily Work Log")
            if work_logs_by_day:
                for day in work_logs_by_day:
                    md.append(f"### 📅 {day['date']}")
                    for l in day["lines"]:
                        md.append(l)
            else:
                md.append("- *No work log entries in this range.*")

            md.append("")
            md.append("## 🔄 Carrying Into Next Week")
            for t in (in_progress_tasks + high_open_tasks[:6]):
                box = "/" if t["state"] == "doing" else " "
                md.append(f"- [{box}] {t['clean_text']} *(from `{t['source_title']}`)*")

            if period_links:
                md.append("")
                md.append("## 🔗 Key Docs, PRs & Dashboards Referenced")
                for lk in period_links:
                    md.append(f"- [{lk['title']}]({lk['url']}) — `{lk['domain']}` *({lk['source_title']})*")

        markdown_text = "\n".join(md)
        return self.send_json({
            "start": start_date,
            "end": end_date,
            "mode": mode,
            "stats": {
                "days_logged": len(daily_rows),
                "completed_count": len(completed_tasks),
                "in_progress_count": len(in_progress_tasks),
                "links_captured": len(period_links),
                "projects_touched": len(projects_touched)
            },
            "markdown": markdown_text
        })


def run_server():
    ensure_dirs()
    init_db()
    seed_starter_vault_if_empty()
    full_reindex()

    server = ThreadingHTTPServer(("127.0.0.1", PORT), ViaductHandler)
    print(f"Viaduct running at http://127.0.0.1:{PORT}")
    print(f"Local Markdown Vault: {VAULT_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Viaduct...")
        server.server_close()


if __name__ == "__main__":
    run_server()
