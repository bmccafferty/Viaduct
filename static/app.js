/**
 * VIADUCT — Local-First Technical Knowledge, Outliner, Task & Link Engine
 * Frontend Application Controller
 */

const state = {
  today: "",
  notes: [],
  tags: [],
  counts: { notes: 0, open_tasks: 0, links: 0 },
  activeView: "daily", // 'daily' | 'editor' | 'tasks' | 'links' | 'graph'
  currentNote: null,
  currentDailyDate: "",
  editorMode: "split", // 'split' | 'edit' | 'preview'
  saveTimer: null,
  tasksData: [],
  taskFilterStatus: "open",
  taskFilterFolder: "",
  taskFilterPriority: "",
  taskFilterSearch: "",
  linksData: [],
  linkDomains: [],
  linkFilterCategory: "",
  linkFilterDomain: "",
  linkFilterSearch: "",
  reportMode: "121",
  reportStart: "",
  reportEnd: "",
  settings: {
    theme: "obsidian",
    editor_font_size: 13.5,
    default_editor_mode: "split",
    show_inspector: true,
    default_owner: "Tech Lead",
    default_env: "prod-k8s",
    default_tags: "cloud, ops",
    midweek_day: 3,
  },
  vaultDir: "",
  demoArchived: false,
  archivedCount: 0,
  dbSizeKb: 0,
  cmdSelectedIndex: 0,
  cmdResults: [],
};

// --- Utilities ---

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function apiGet(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost(url, data) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data || {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function normalizeSlug(text) {
  let s = String(text || "").trim();
  if (s.toLowerCase().endsWith(".md")) s = s.slice(0, -3);
  return s.toLowerCase().trim();
}

function findNoteByTarget(targetRaw) {
  const slug = normalizeSlug(targetRaw);
  return state.notes.find((n) => {
    const stem = n.path.split("/").pop().replace(/\.md$/i, "");
    return (
      normalizeSlug(n.title) === slug ||
      normalizeSlug(stem) === slug ||
      normalizeSlug(n.path) === slug
    );
  });
}

// --- Custom Technical Markdown & Outliner Renderer ---

function renderMarkdown(rawMd) {
  if (!rawMd) return "";

  // Strip YAML frontmatter from rendered body (shown in metadata bar instead)
  let body = rawMd.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
  const lines = body.split("\n");

  let html = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeLines = [];
  let listStack = []; // tracks indent levels for nested outliner <ul>
  let inTable = false;
  let tableRows = [];

  const closeListsTo = (targetDepth) => {
    while (listStack.length > targetDepth) {
      html.push("</ul>");
      listStack.pop();
    }
  };

  const flushTable = () => {
    if (!inTable || tableRows.length === 0) return;
    let tbl = "<table>";
    tableRows.forEach((r, idx) => {
      const cells = r
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      if (idx === 1 && cells.every((c) => /^[:\-]+$/.test(c))) {
        return; // separator row
      }
      const tag = idx === 0 ? "th" : "td";
      tbl +=
        "<tr>" +
        cells.map((c) => `<${tag}>${ renderInline(c) }</${tag}>`).join("") +
        "</tr>";
    });
    tbl += "</table>";
    html.push(tbl);
    inTable = false;
    tableRows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNum = i + 1 + (rawMd.split("\n").length - lines.length);

    // Code block toggle
    if (rawLine.trim().startsWith("```")) {
      closeListsTo(0);
      flushTable();
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = rawLine.trim().slice(3).trim() || "shell";
        codeLines = [];
      } else {
        const escapedCode = escapeHtml(codeLines.join("\n"));
        const encodedRaw = encodeURIComponent(codeLines.join("\n"));
        html.push(`
          <div class="code-block-wrapper">
            <div class="code-block-header">
              <span>${escapeHtml(codeLang.toUpperCase())}</span>
              <button class="copy-code-btn" data-code="${encodedRaw}">Copy Snippet</button>
            </div>
            <pre><code>${escapedCode}</code></pre>
          </div>
        `);
        inCodeBlock = false;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    // Table detection
    if (rawLine.trim().startsWith("|") && rawLine.trim().endsWith("|")) {
      closeListsTo(0);
      inTable = true;
      tableRows.push(rawLine);
      continue;
    } else if (inTable) {
      flushTable();
    }

    // Blank line
    if (!rawLine.trim()) {
      closeListsTo(0);
      continue;
    }

    // Headings
    const hMatch = rawLine.match(/^(#{1,4})\s+(.*)$/);
    if (hMatch) {
      closeListsTo(0);
      const level = hMatch[1].length;
      html.push(`<h${level}>${renderInline(hMatch[2])}</h${level}>`);
      continue;
    }

    // Outliner Bullets & Interactive Tasks
    const listMatch = rawLine.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const indentSpaces = listMatch[1].replace(/\t/g, "  ").length;
      const depth = Math.floor(indentSpaces / 2) + 1;
      const content = listMatch[2];

      while (listStack.length < depth) {
        html.push('<ul class="outliner-list">');
        listStack.push(listStack.length + 1);
      }
      closeListsTo(depth);

      // Check if task item: [ ], [x], [/], [-]
      const taskMatch = content.match(/^\[([ xX/\->])\]\s+(.*)$/);
      if (taskMatch) {
        const stateChar = taskMatch[1].toLowerCase();
        const isChecked = stateChar === "x";
        const isDoing = stateChar === "/";
        const taskBody = taskMatch[2];
        const statusPrefix = isDoing
          ? '<span class="prio-badge prio-med">DOING</span> '
          : "";
        html.push(`
          <li class="task-list-item">
            <input type="checkbox" class="task-checkbox" data-line="${lineNum}" ${
          isChecked ? "checked" : ""
        } />
            <span class="${isChecked ? "task-done-text" : ""}">${statusPrefix}${renderInline(
          taskBody
        )}</span>
          </li>
        `);
      } else {
        html.push(`<li>${renderInline(content)}</li>`);
      }
      continue;
    }

    closeListsTo(0);
    html.push(`<p>${renderInline(rawLine)}</p>`);
  }

  closeListsTo(0);
  flushTable();
  return html.join("\n");
}

function renderInline(text) {
  let s = escapeHtml(text);

  // Inline code `code`
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italic *text*
  s = s.replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>");

  // WikiLinks [[Target|Alias]] or [[Target]]
  s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    const label = alias || target;
    return `<a class="wikilink" data-wikilink="${target.trim()}">[[${label.trim()}]]</a>`;
  });

  // Markdown External Links [Label](https://...)
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a class="ext-link" href="$2" target="_blank" rel="noopener noreferrer">$1 ↗</a>'
  );

  // Priority badges !high, !med, !low
  s = s.replace(/!(high|med|low|p1|p2|p3)\b/gi, (m, p) => {
    const norm = p.toLowerCase();
    const cls =
      norm === "high" || norm === "p1"
        ? "prio-high"
        : norm === "med" || norm === "p2"
        ? "prio-med"
        : "prio-low";
    return `<span class="prio-badge ${cls}">!${norm}</span>`;
  });

  // Due dates @due(YYYY-MM-DD)
  s = s.replace(
    /@due\(([0-9]{4}-[0-9]{2}-[0-9]{2})\)/g,
    '<span class="due-badge">📅 $1</span>'
  );

  // Inline #tags
  s = s.replace(
    /(^|\s)#([a-zA-Z0-9_\-/]+)/g,
    '$1<span class="tag-chip" data-tag="$2">#$2</span>'
  );

  return s;
}

// --- Bootstrap & State Sync ---

async function refreshBootstrap() {
  const data = await apiGet("/api/bootstrap");
  state.today = data.today;
  state.notes = data.notes || [];
  state.tags = data.tags || [];
  state.counts = data.counts || { notes: 0, open_tasks: 0, links: 0, total_words: 0, backlinks: 0 };
  state.vaultDir = data.vault_dir || "";
  state.demoArchived = Boolean(data.demo_archived);
  state.archivedCount = data.archived_count || 0;
  state.dbSizeKb = data.db_size_kb || 0;
  if (data.settings) {
    state.settings = { ...state.settings, ...data.settings };
    applySettingsToUI();
  }

  document.getElementById("badge-tasks").textContent = state.counts.open_tasks;
  document.getElementById("badge-links").textContent = state.counts.links;
  document.getElementById("badge-notes").textContent = state.counts.notes;

  renderSidebarTrees();
  populateProjectDropdown();
}

function applySettingsToUI() {
  const s = state.settings;
  document.documentElement.setAttribute("data-theme", s.theme || "obsidian");

  const editor = document.getElementById("note-editor");
  const reportEditor = document.getElementById("report-editor");
  if (editor) editor.style.fontSize = `${s.editor_font_size || 13.5}px`;
  if (reportEditor) reportEditor.style.fontSize = `${s.editor_font_size || 13.5}px`;

  const splitContainer = document.getElementById("editor-split-container");
  if (splitContainer) {
    splitContainer.classList.toggle("hide-inspector", s.show_inspector === false);
  }
}

function renderSidebarTrees() {
  const byFolder = { projects: [], kb: [], daily: [], reports: [], templates: [] };
  state.notes.forEach((n) => {
    if (byFolder[n.folder]) byFolder[n.folder].push(n);
    else byFolder.projects.push(n);
  });

  // Sort daily & reports descending
  byFolder.daily.sort((a, b) => b.title.localeCompare(a.title));
  byFolder.reports.sort((a, b) => b.updated_at - a.updated_at);

  const renderTree = (containerId, items) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = items
      .map((n) => {
        const isActive = state.currentNote && state.currentNote.path === n.path;
        const badge = n.status ? `<span class="tree-item-meta">${escapeHtml(n.status)}</span>` : "";
        return `
          <div class="tree-item ${isActive ? "active" : ""}" data-note-path="${escapeHtml(n.path)}">
            <span class="tree-item-title">${escapeHtml(n.title)}</span>
            ${badge}
          </div>
        `;
      })
      .join("");
  };

  renderTree("tree-projects", byFolder.projects);
  renderTree("tree-kb", byFolder.kb);
  renderTree("tree-daily", byFolder.daily);
  renderTree("tree-reports", byFolder.reports);
  renderTree("tree-templates", byFolder.templates);

  // Tags
  const tagsEl = document.getElementById("sidebar-tags");
  tagsEl.innerHTML = state.tags
    .slice(0, 18)
    .map(
      (t) =>
        `<span class="tag-chip" data-tag="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)} (${t.count})</span>`
    )
    .join("");
}

function populateProjectDropdown() {
  const select = document.getElementById("select-central-task-project");
  if (!select) return;
  const projects = state.notes.filter((n) => n.folder === "projects");
  select.innerHTML =
    `<option value="">Link to Project (Optional)...</option>` +
    projects
      .map((p) => `<option value="${escapeHtml(p.title)}">[[${escapeHtml(p.title)}]]</option>`)
      .join("");
}

// --- Navigation & Views ---

function switchWorkspaceView(viewName) {
  state.activeView = viewName;

  document.querySelectorAll(".primary-nav .nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === viewName);
  });

  const editorView = document.getElementById("view-editor");
  const tasksView = document.getElementById("view-tasks");
  const linksView = document.getElementById("view-links");
  const reportsView = document.getElementById("view-reports");
  const graphView = document.getElementById("view-graph");
  const settingsView = document.getElementById("view-settings");
  const modeGroup = document.getElementById("editor-mode-group");

  editorView.classList.remove("active");
  tasksView.classList.remove("active");
  linksView.classList.remove("active");
  if (reportsView) reportsView.classList.remove("active");
  graphView.classList.remove("active");
  if (settingsView) settingsView.classList.remove("active");

  if (viewName === "daily" || viewName === "editor") {
    editorView.classList.add("active");
    modeGroup.classList.remove("hidden");
  } else {
    if (viewName === "tasks") {
      modeGroup.classList.add("hidden");
      tasksView.classList.add("active");
      document.getElementById("topbar-title").textContent = "Centralized Task Sheet";
      loadTasksDashboard();
    } else if (viewName === "links") {
      modeGroup.classList.add("hidden");
      linksView.classList.add("active");
      document.getElementById("topbar-title").textContent = "URL & Bookmark Registry";
      loadLinksDashboard();
    } else if (viewName === "reports") {
      modeGroup.classList.remove("hidden");
      reportsView.classList.add("active");
      document.getElementById("topbar-title").textContent = "1:1 & Weekly Digest";
      loadReportsDashboard();
    } else if (viewName === "graph") {
      modeGroup.classList.add("hidden");
      graphView.classList.add("active");
      document.getElementById("topbar-title").textContent = "Knowledge Topology Graph";
      loadGraphView();
    } else if (viewName === "settings") {
      modeGroup.classList.add("hidden");
      settingsView.classList.add("active");
      document.getElementById("topbar-title").textContent = "Settings & Vault Management";
      renderSettingsDashboard();
    }
  }
}

async function openDailyNote(dateStr) {
  const targetDate = dateStr || state.today || new Date().toISOString().slice(0, 10);
  state.currentDailyDate = targetDate;
  const payload = await apiGet(`/api/daily?date=${encodeURIComponent(targetDate)}`);
  switchWorkspaceView("daily");
  mountNoteIntoEditor(payload, true);

  // Carryover button visibility
  const carryBtn = document.getElementById("btn-carryover");
  const carryCount = document.getElementById("carryover-count");
  if (payload.carryover_available > 0 && targetDate === state.today) {
    carryCount.textContent = payload.carryover_available;
    carryBtn.classList.remove("hidden");
  } else {
    carryBtn.classList.add("hidden");
  }
  await refreshBootstrap();
}

async function openNoteByPath(relPath) {
  const payload = await apiGet(`/api/note?path=${encodeURIComponent(relPath)}`);
  const isDaily = payload.folder === "daily";
  if (isDaily) {
    state.currentDailyDate = payload.title;
  }
  switchWorkspaceView(isDaily ? "daily" : "editor");
  mountNoteIntoEditor(payload, isDaily);
}

function mountNoteIntoEditor(note, isDaily) {
  state.currentNote = note;

  // Update breadcrumbs
  document.querySelector(".crumb-folder").textContent = note.folder;
  document.getElementById("topbar-title").textContent = note.title;

  // Toggle Daily Banner
  const dailyBanner = document.getElementById("daily-banner");
  if (isDaily) {
    dailyBanner.classList.remove("hidden");
    document.getElementById("daily-date-picker").value = note.title;
  } else {
    dailyBanner.classList.add("hidden");
  }

  // Metadata banner
  const metaBanner = document.getElementById("meta-banner");
  const pills = [];
  if (note.status) pills.push(`<span class="meta-pill">Status: <strong>${escapeHtml(note.status)}</strong></span>`);
  if (note.env) pills.push(`<span class="meta-pill">Env: <strong>${escapeHtml(note.env)}</strong></span>`);
  if (note.owner) pills.push(`<span class="meta-pill">Lead: <strong>${escapeHtml(note.owner)}</strong></span>`);
  pills.push(`<span class="meta-pill">File: <strong>vault/${escapeHtml(note.path)}</strong></span>`);
  metaBanner.innerHTML = pills.join("");

  // Populate editor & preview
  const editor = document.getElementById("note-editor");
  editor.value = note.raw_content;
  updateLivePreviewAndInspector(note);
  renderSidebarTrees();
}

function updateLivePreviewAndInspector(note) {
  const raw = document.getElementById("note-editor").value;
  const preview = document.getElementById("note-preview");
  preview.innerHTML = renderMarkdown(raw);

  const words = (raw.match(/\w+/g) || []).length;
  document.getElementById("word-count-label").textContent = `${words} words`;

  if (!note) return;

  // Backlinks
  const blList = document.getElementById("list-backlinks");
  const backlinks = note.backlinks || [];
  document.getElementById("count-backlinks").textContent = backlinks.length;
  if (backlinks.length === 0) {
    blList.innerHTML = `<div class="pane-hint">No incoming [[WikiLinks]] yet.</div>`;
  } else {
    blList.innerHTML = backlinks
      .map(
        (b) => `
        <div class="backlink-card" data-note-path="${escapeHtml(b.source_path)}">
          <div class="backlink-source">
            <span>${escapeHtml(b.source_title)}</span>
            <span>L${b.line_num}</span>
          </div>
          <div class="backlink-snippet">${escapeHtml(b.context)}</div>
        </div>
      `
      )
      .join("");
  }

  // Unlinked Mentions
  const ulList = document.getElementById("list-unlinked");
  const unlinked = note.unlinked_mentions || [];
  document.getElementById("count-unlinked").textContent = unlinked.length;
  if (unlinked.length === 0) {
    ulList.innerHTML = `<div class="pane-hint">No unlinked mentions found.</div>`;
  } else {
    ulList.innerHTML = unlinked
      .map(
        (u) => `
        <div class="backlink-card" data-note-path="${escapeHtml(u.path)}">
          <div class="backlink-source"><span>${escapeHtml(u.title)}</span></div>
          <div class="backlink-snippet">${u.snippet}</div>
        </div>
      `
      )
      .join("");
  }

  // Tasks in this note
  const ntList = document.getElementById("list-note-tasks");
  const noteTasks = note.tasks || [];
  document.getElementById("count-note-tasks").textContent = noteTasks.length;
  if (noteTasks.length === 0) {
    ntList.innerHTML = `<div class="pane-hint">Type <code>- [ ] Task</code> to track items.</div>`;
  } else {
    ntList.innerHTML = noteTasks
      .map(
        (t) => `
        <div class="backlink-card">
          <div class="backlink-snippet ${t.state === "done" ? "task-done-text" : ""}">
            [${t.state === "done" ? "x" : t.state === "doing" ? "/" : " "}] ${escapeHtml(t.clean_text)}
          </div>
        </div>
      `
      )
      .join("");
  }

  // External Links in this note
  const nlList = document.getElementById("list-note-links");
  const extLinks = note.external_links || [];
  document.getElementById("count-note-links").textContent = extLinks.length;
  if (extLinks.length === 0) {
    nlList.innerHTML = `<div class="pane-hint">Paste any URL to auto-index.</div>`;
  } else {
    nlList.innerHTML = extLinks
      .map(
        (l) => `
        <div class="backlink-card">
          <a href="${escapeHtml(l.url)}" target="_blank" rel="noopener" class="ext-link" style="font-size:12px;font-weight:600;">
            ${escapeHtml(l.title)} ↗
          </a>
          <div class="backlink-snippet">${escapeHtml(l.domain)}</div>
        </div>
      `
      )
      .join("");
  }
}

// --- Auto-Save & Outliner Keyboard Ergonomics ---

function scheduleSave() {
  if (!state.currentNote) return;
  const indicator = document.getElementById("save-indicator");
  indicator.textContent = "Saving...";
  if (state.saveTimer) clearTimeout(state.saveTimer);

  state.saveTimer = setTimeout(async () => {
    const content = document.getElementById("note-editor").value;
    const res = await apiPost("/api/note/save", {
      path: state.currentNote.path,
      content,
    });
    if (res.ok && res.note) {
      state.currentNote = res.note;
      updateLivePreviewAndInspector(state.currentNote);
      indicator.textContent = "Saved to .md";
      refreshBootstrap();
    }
  }, 320);
}

function setupEditorErgonomics() {
  const editor = document.getElementById("note-editor");
  const popup = document.getElementById("wikilink-popup");

  editor.addEventListener("input", () => {
    // Immediate client-side preview render
    document.getElementById("note-preview").innerHTML = renderMarkdown(editor.value);
    checkWikiLinkAutocomplete(editor, popup);
    scheduleSave();
  });

  editor.addEventListener("keydown", (e) => {
    // Handle Tab / Shift+Tab for Outliner indentation
    if (e.key === "Tab") {
      e.preventDefault();
      const start = editor.selectionStart;
      const val = editor.value;
      const lineStart = val.lastIndexOf("\n", start - 1) + 1;
      if (e.shiftKey) {
        if (val.slice(lineStart, lineStart + 2) === "  ") {
          editor.value = val.slice(0, lineStart) + val.slice(lineStart + 2);
          editor.selectionStart = editor.selectionEnd = Math.max(lineStart, start - 2);
        }
      } else {
        editor.value = val.slice(0, lineStart) + "  " + val.slice(lineStart);
        editor.selectionStart = editor.selectionEnd = start + 2;
      }
      editor.dispatchEvent(new Event("input"));
      return;
    }

    // Handle Enter for automatic outliner bullet / task continuation
    if (e.key === "Enter" && popup.classList.contains("hidden")) {
      const start = editor.selectionStart;
      const val = editor.value;
      const lineStart = val.lastIndexOf("\n", start - 1) + 1;
      const currentLine = val.slice(lineStart, start);

      const taskMatch = currentLine.match(/^(\s*[-*+]\s+\[)[ xX/\->](\]\s+)(.*)$/);
      if (taskMatch) {
        e.preventDefault();
        if (!taskMatch[3].trim()) {
          // Empty task bullet: clear bullet on Enter
          editor.value = val.slice(0, lineStart) + "\n" + val.slice(start);
          editor.selectionStart = editor.selectionEnd = lineStart + 1;
        } else {
          const prefix = `\n${taskMatch[1]} ${taskMatch[2]}`;
          editor.value = val.slice(0, start) + prefix + val.slice(start);
          editor.selectionStart = editor.selectionEnd = start + prefix.length;
        }
        editor.dispatchEvent(new Event("input"));
        return;
      }

      const bulletMatch = currentLine.match(/^(\s*[-*+]\s+)(.*)$/);
      if (bulletMatch) {
        e.preventDefault();
        if (!bulletMatch[2].trim()) {
          editor.value = val.slice(0, lineStart) + "\n" + val.slice(start);
          editor.selectionStart = editor.selectionEnd = lineStart + 1;
        } else {
          const prefix = `\n${bulletMatch[1]}`;
          editor.value = val.slice(0, start) + prefix + val.slice(start);
          editor.selectionStart = editor.selectionEnd = start + prefix.length;
        }
        editor.dispatchEvent(new Event("input"));
      }
    }
  });
}

function checkWikiLinkAutocomplete(editor, popup) {
  const pos = editor.selectionStart;
  const textBefore = editor.value.slice(0, pos);
  const match = textBefore.match(/\[\[([^\[\]\n]*)$/);
  if (!match) {
    popup.classList.add("hidden");
    return;
  }

  const query = match[1].toLowerCase().trim();
  const candidates = state.notes
    .filter((n) => n.title.toLowerCase().includes(query) || n.path.toLowerCase().includes(query))
    .slice(0, 8);

  if (candidates.length === 0) {
    popup.classList.add("hidden");
    return;
  }

  popup.innerHTML = candidates
    .map(
      (c, i) => `
      <div class="autocomplete-item ${i === 0 ? "selected" : ""}" data-insert-title="${escapeHtml(
        c.title
      )}">
        <span>${escapeHtml(c.title)}</span>
        <span class="cmd-result-path">${escapeHtml(c.folder)}</span>
      </div>
    `
    )
    .join("");
  popup.classList.remove("hidden");

  popup.querySelectorAll(".autocomplete-item").forEach((item) => {
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const title = item.dataset.insertTitle;
      const replaceStart = pos - match[0].length;
      const after = editor.value.slice(pos);
      const insertion = `[[${title}]]`;
      editor.value = editor.value.slice(0, replaceStart) + insertion + after;
      editor.selectionStart = editor.selectionEnd = replaceStart + insertion.length;
      popup.classList.add("hidden");
      editor.dispatchEvent(new Event("input"));
    });
  });
}

// --- View 2: Centralized Cross-Note Task Sheet ---

async function loadTasksDashboard() {
  const data = await apiGet("/api/tasks");
  state.tasksData = data.tasks || [];
  renderTasksDashboard();
}

function renderTasksDashboard() {
  const tasks = state.tasksData;
  const openCount = tasks.filter((t) => t.state === "todo" || t.state === "doing").length;
  const doingCount = tasks.filter((t) => t.state === "doing").length;
  const highCount = tasks.filter(
    (t) => (t.state === "todo" || t.state === "doing") && t.priority === "high"
  ).length;
  const doneCount = tasks.filter((t) => t.state === "done").length;

  document.getElementById("task-kpis").innerHTML = `
    <div class="kpi-card"><div class="kpi-val">${openCount}</div><div class="kpi-label">Open Tasks</div></div>
    <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-amber)">${doingCount}</div><div class="kpi-label">In Progress [/]</div></div>
    <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-rose)">${highCount}</div><div class="kpi-label">High Priority (!high)</div></div>
    <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-emerald)">${doneCount}</div><div class="kpi-label">Completed [x]</div></div>
  `;

  const filtered = tasks.filter((t) => {
    if (state.taskFilterStatus === "open" && !(t.state === "todo" || t.state === "doing"))
      return false;
    if (state.taskFilterStatus === "doing" && t.state !== "doing") return false;
    if (state.taskFilterStatus === "done" && t.state !== "done") return false;
    if (state.taskFilterFolder && t.folder !== state.taskFilterFolder) return false;
    if (state.taskFilterPriority && t.priority !== state.taskFilterPriority) return false;
    if (state.taskFilterSearch) {
      const q = state.taskFilterSearch.toLowerCase();
      const hay = `${t.text} ${t.source_title} ${t.folder}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tbody = document.getElementById("tasks-table-body");
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:28px;">No matching tasks in vault.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((t) => {
      const prioClass =
        t.priority === "high"
          ? "prio-high"
          : t.priority === "med"
          ? "prio-med"
          : "prio-normal";
      return `
        <tr>
          <td>
            <select class="state-select" data-task-path="${escapeHtml(
              t.source_path
            )}" data-task-line="${t.line_num}">
              <option value="todo" ${t.state === "todo" ? "selected" : ""}>[ ] TODO</option>
              <option value="doing" ${t.state === "doing" ? "selected" : ""}>[/] DOING</option>
              <option value="done" ${t.state === "done" ? "selected" : ""}>[x] DONE</option>
            </select>
          </td>
          <td class="${t.state === "done" ? "task-done-text" : ""}">
            ${renderInline(t.clean_text)}
          </td>
          <td><span class="prio-badge ${prioClass}">${escapeHtml(t.priority)}</span></td>
          <td>
            ${
              t.due_date
                ? `<span class="due-badge">${escapeHtml(t.due_date)}</span>`
                : `<span class="pane-hint">—</span>`
            }
          </td>
          <td>
            <span class="source-note-pill" data-note-path="${escapeHtml(t.source_path)}">
              📄 ${escapeHtml(t.source_title)} : L${t.line_num}
            </span>
          </td>
        </tr>
      `;
    })
    .join("");
}

// --- View 3: Technical URL & Bookmark Registry ---

async function loadLinksDashboard() {
  const data = await apiGet("/api/links");
  state.linksData = data.links || [];
  state.linkDomains = data.domains || [];

  const domainSelect = document.getElementById("filter-link-domain");
  domainSelect.innerHTML =
    `<option value="">All Domains (${state.linkDomains.length})</option>` +
    state.linkDomains
      .map(
        (d) =>
          `<option value="${escapeHtml(d.domain)}" ${
            state.linkFilterDomain === d.domain ? "selected" : ""
          }>${escapeHtml(d.domain)} (${d.count})</option>`
      )
      .join("");

  renderLinksDashboard();
}

function renderLinksDashboard() {
  const links = state.linksData;
  const pinnedCount = links.filter((l) => l.is_pinned).length;

  document.getElementById("link-kpis").innerHTML = `
    <div class="kpi-card"><div class="kpi-val">${links.length}</div><div class="kpi-label">Captured Links</div></div>
    <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-emerald)">${state.linkDomains.length}</div><div class="kpi-label">Unique Domains</div></div>
    <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-amber)">${pinnedCount}</div><div class="kpi-label">Pinned Bookmarks</div></div>
  `;

  const filtered = links.filter((l) => {
    if (state.linkFilterCategory === "pinned" && !l.is_pinned) return false;
    if (
      state.linkFilterCategory &&
      state.linkFilterCategory !== "pinned" &&
      l.category !== state.linkFilterCategory
    )
      return false;
    if (state.linkFilterDomain && l.domain !== state.linkFilterDomain) return false;
    if (state.linkFilterSearch) {
      const q = state.linkFilterSearch.toLowerCase();
      const hay = `${l.title} ${l.url} ${l.domain} ${l.context} ${l.source_title}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const grid = document.getElementById("links-grid");
  if (filtered.length === 0) {
    grid.innerHTML = `<div style="color:var(--text-muted);padding:24px;">No links match the current filter.</div>`;
    return;
  }

  grid.innerHTML = filtered
    .map(
      (l) => `
      <div class="link-card">
        <div>
          <div class="link-card-top">
            <span class="link-domain-badge">${escapeHtml(l.domain)}</span>
            <div style="display:flex;gap:6px;align-items:center;">
              <span class="link-cat-badge">${escapeHtml(l.category)}</span>
              <button class="pin-btn ${l.is_pinned ? "pinned" : ""}" data-pin-url="${escapeHtml(
        l.url
      )}" data-pinned="${l.is_pinned ? "1" : "0"}" title="Pin Bookmark">★</button>
            </div>
          </div>
          <div style="margin:8px 0 4px;">
            <a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer" class="link-card-title">
              ${escapeHtml(l.title)} ↗
            </a>
          </div>
          <div class="link-card-url">${escapeHtml(l.url)}</div>
        </div>
        <div class="link-card-context">${renderInline(l.context)}</div>
        <div class="link-card-footer">
          <span class="source-note-pill" data-note-path="${escapeHtml(l.source_path)}">
            Found in: ${escapeHtml(l.source_title)} (L${l.line_num})
          </span>
          <div>
            ${(l.tags || [])
              .map((t) => `<span class="tag-chip" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`)
              .join(" ")}
          </div>
        </div>
      </div>
    `
    )
    .join("");
}

// --- View 4: 1:1 Sync & Weekly Wrap-Up Generator ---

function setMidWeekReviewDates() {
  // 7 days: Last target day to This target day (default: Wednesday = 3)
  const targetDay = Number(state.settings.midweek_day || 3);
  const now = new Date((state.today || new Date().toISOString().slice(0, 10)) + "T12:00:00");
  const day = now.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const diffToTarget = day === 0 ? targetDay - 7 : targetDay - day;
  const thisAnchor = new Date(now);
  thisAnchor.setDate(now.getDate() + diffToTarget);

  const lastAnchor = new Date(thisAnchor);
  lastAnchor.setDate(thisAnchor.getDate() - 7);

  state.reportStart = lastAnchor.toISOString().slice(0, 10);
  state.reportEnd = thisAnchor.toISOString().slice(0, 10);
  document.getElementById("report-start-date").value = state.reportStart;
  document.getElementById("report-end-date").value = state.reportEnd;
}

function setEndOfWeekReviewDates() {
  // Monday to Friday of current week
  const now = new Date((state.today || new Date().toISOString().slice(0, 10)) + "T12:00:00");
  const day = now.getDay(); // 0=Sun, 1=Mon...
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(now);
  mon.setDate(now.getDate() + diffToMon);

  const fri = new Date(mon);
  fri.setDate(mon.getDate() + 4);

  state.reportStart = mon.toISOString().slice(0, 10);
  state.reportEnd = fri.toISOString().slice(0, 10);
  document.getElementById("report-start-date").value = state.reportStart;
  document.getElementById("report-end-date").value = state.reportEnd;
}

function setReportPresetDays(daysBack) {
  const endDt = new Date((state.today || new Date().toISOString().slice(0, 10)) + "T12:00:00");
  const startDt = new Date(endDt);
  startDt.setDate(startDt.getDate() - daysBack);
  state.reportStart = startDt.toISOString().slice(0, 10);
  state.reportEnd = endDt.toISOString().slice(0, 10);
  document.getElementById("report-start-date").value = state.reportStart;
  document.getElementById("report-end-date").value = state.reportEnd;
}

async function loadReportsDashboard() {
  if (!state.reportStart || !state.reportEnd) {
    if (state.reportMode === "121") {
      setMidWeekReviewDates();
    } else {
      setEndOfWeekReviewDates();
    }
  }
  const qs = `mode=${encodeURIComponent(state.reportMode)}&start=${encodeURIComponent(
    state.reportStart
  )}&end=${encodeURIComponent(state.reportEnd)}`;
  const data = await apiGet(`/api/report?${qs}`);

  const stats = data.stats || {};
  document.getElementById("report-kpis").innerHTML = `
    <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-emerald)">${
      stats.completed_count || 0
    }</div><div class="kpi-label">Completed [x]</div></div>
    <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-amber)">${
      stats.in_progress_count || 0
    }</div><div class="kpi-label">In Progress [/]</div></div>
    <div class="kpi-card"><div class="kpi-val">${
      stats.days_logged || 0
    }</div><div class="kpi-label">Daily Logs</div></div>
    <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-cyan)">${
      stats.links_captured || 0
    }</div><div class="kpi-label">Links Logged</div></div>
  `;

  document.getElementById("report-range-label").textContent = `${data.start} → ${data.end}`;
  const reportEditor = document.getElementById("report-editor");
  reportEditor.value = data.markdown || "";
  document.getElementById("report-preview").innerHTML = renderMarkdown(reportEditor.value);
}

// --- View 5: Force-Directed Knowledge Topology Graph ---

let graphAnimFrame = null;

async function loadGraphView() {
  if (graphAnimFrame) {
    cancelAnimationFrame(graphAnimFrame);
    graphAnimFrame = null;
  }

  const data = await apiGet("/api/graph");
  const canvas = document.getElementById("graph-canvas");
  const ctx = canvas.getContext("2d");
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  const nodes = (data.nodes || []).map((n, i) => {
    const angle = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
    const radius = Math.min(canvas.width, canvas.height) * 0.28;
    return {
      ...n,
      x: canvas.width / 2 + Math.cos(angle) * radius,
      y: canvas.height / 2 + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      pinned: false,
    };
  });

  const nodeByPath = {};
  nodes.forEach((n) => (nodeByPath[n.path] = n));

  const edges = (data.edges || [])
    .map((e) => ({
      source: nodeByPath[e.source],
      target: nodeByPath[e.target],
    }))
    .filter((e) => e.source && e.target);

  // Camera pan & zoom state
  let panX = 0;
  let panY = 0;
  let scale = 1;

  // Interaction state
  let draggedNode = null;
  let hoveredNode = null;
  let isPanning = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;
  let totalDragDist = 0;
  let physicsActiveTicks = 220;

  function screenToWorld(sx, sy) {
    return {
      x: (sx - panX) / scale,
      y: (sy - panY) / scale,
    };
  }

  function findNodeAtScreen(sx, sy) {
    const w = screenToWorld(sx, sy);
    const hitRadius = 16 / scale;
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (Math.hypot(nodes[i].x - w.x, nodes[i].y - w.y) <= hitRadius) {
        return nodes[i];
      }
    }
    return null;
  }

  function updatePhysics() {
    if (physicsActiveTicks <= 0 && !draggedNode) return;
    if (!draggedNode) physicsActiveTicks--;

    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const distSq = dx * dx + dy * dy + 100;
        const force = 4200 / distSq;
        const fx = dx * force;
        const fy = dy * force;
        if (nodes[i] !== draggedNode && !nodes[i].pinned) {
          nodes[i].vx -= fx;
          nodes[i].vy -= fy;
        }
        if (nodes[j] !== draggedNode && !nodes[j].pinned) {
          nodes[j].vx += fx;
          nodes[j].vy += fy;
        }
      }
    }

    // Spring attraction along [[WikiLinks]]
    edges.forEach((e) => {
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 150) * 0.025;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (e.source !== draggedNode && !e.source.pinned) {
        e.source.vx += fx;
        e.source.vy += fy;
      }
      if (e.target !== draggedNode && !e.target.pinned) {
        e.target.vx -= fx;
        e.target.vy -= fy;
      }
    });

    // Center gravity & velocity integration
    nodes.forEach((n) => {
      if (n === draggedNode || n.pinned) {
        n.vx = 0;
        n.vy = 0;
        return;
      }
      n.vx += (canvas.width / 2 - n.x) * 0.009;
      n.vy += (canvas.height / 2 - n.y) * 0.009;
      n.x += n.vx * 0.4;
      n.y += n.vy * 0.4;
      n.vx *= 0.75;
      n.vy *= 0.75;
      if (!draggedNode && panX === 0 && panY === 0 && scale === 1) {
        n.x = Math.max(80, Math.min(canvas.width - 250, n.x));
        n.y = Math.max(80, Math.min(canvas.height - 60, n.y));
      }
    });
  }

  function drawGraph() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cs = getComputedStyle(document.documentElement);
    const colAccent = cs.getPropertyValue("--accent-cyan").trim() || "#c084fc";
    const colAmber = cs.getPropertyValue("--accent-amber").trim() || "#fbbf24";
    const colEmerald = cs.getPropertyValue("--accent-emerald").trim() || "#34d399";
    const colBg = cs.getPropertyValue("--bg-root").trim() || "#050507";
    const colText = cs.getPropertyValue("--text-primary").trim() || "#f8fafc";

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    const activeNode = draggedNode || hoveredNode;

    edges.forEach((e) => {
      const isHighlighted =
        activeNode && (e.source === activeNode || e.target === activeNode);
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.strokeStyle = colAccent;
      ctx.globalAlpha = isHighlighted ? 0.9 : activeNode ? 0.18 : 0.38;
      ctx.lineWidth = isHighlighted ? 2.4 : 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    });

    nodes.forEach((n) => {
      const isFocus = n === activeNode;
      ctx.beginPath();
      ctx.arc(n.x, n.y, isFocus ? 11.5 : 9, 0, Math.PI * 2);
      ctx.fillStyle =
        n.folder === "daily"
          ? colAmber
          : n.folder === "kb"
          ? colEmerald
          : colAccent;
      ctx.fill();
      ctx.strokeStyle = isFocus ? colText : colBg;
      ctx.lineWidth = isFocus ? 2.5 : 2;
      ctx.stroke();

      ctx.fillStyle = colText;
      ctx.font = `${isFocus ? "600 13px" : "12px"} -apple-system, Inter, sans-serif`;
      ctx.fillText(n.title, n.x + 14, n.y + 4);
    });

    ctx.restore();
  }

  function step() {
    if (state.activeView !== "graph") {
      graphAnimFrame = null;
      return;
    }
    updatePhysics();
    drawGraph();
    graphAnimFrame = requestAnimationFrame(step);
  }
  step();

  canvas.style.cursor = "grab";

  canvas.onmousedown = (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    dragStartX = mx;
    dragStartY = my;
    totalDragDist = 0;

    const hit = findNodeAtScreen(mx, my);
    if (hit) {
      draggedNode = hit;
      draggedNode.pinned = true;
      physicsActiveTicks = 120;
      canvas.style.cursor = "grabbing";
    } else {
      isPanning = true;
      panStartX = panX;
      panStartY = panY;
      canvas.style.cursor = "grabbing";
    }
  };

  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;

    if (draggedNode) {
      totalDragDist += Math.hypot(mx - dragStartX, my - dragStartY);
      dragStartX = mx;
      dragStartY = my;
      const w = screenToWorld(mx, my);
      draggedNode.x = w.x;
      draggedNode.y = w.y;
      physicsActiveTicks = 90;
      return;
    }

    if (isPanning) {
      const dx = mx - dragStartX;
      const dy = my - dragStartY;
      totalDragDist = Math.hypot(dx, dy);
      panX = panStartX + dx;
      panY = panStartY + dy;
      return;
    }

    const hit = findNodeAtScreen(mx, my);
    hoveredNode = hit;
    canvas.style.cursor = hit ? "pointer" : "grab";
  };

  const endInteraction = (e) => {
    if (draggedNode) {
      const clickedNode = draggedNode;
      draggedNode = null;
      if (totalDragDist < 5 && e && e.type === "mouseup") {
        clickedNode.pinned = false;
        openNoteByPath(clickedNode.path);
        return;
      }
      physicsActiveTicks = 80;
    }
    isPanning = false;
    canvas.style.cursor = hoveredNode ? "pointer" : "grab";
  };

  canvas.onmouseup = endInteraction;
  canvas.onmouseleave = endInteraction;

  canvas.onwheel = (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const nextScale = Math.max(0.35, Math.min(3.0, scale * zoomFactor));
    panX = mx - ((mx - panX) / scale) * nextScale;
    panY = my - ((my - panY) / scale) * nextScale;
    scale = nextScale;
  };

  const resetBtn = document.getElementById("btn-graph-reset");
  if (resetBtn) {
    resetBtn.onclick = () => {
      panX = 0;
      panY = 0;
      scale = 1;
      nodes.forEach((n) => (n.pinned = false));
      physicsActiveTicks = 140;
    };
  }
}

// --- View 6: Settings, Themes & Vault Management ---

function renderSettingsDashboard() {
  const s = state.settings;

  document.getElementById("settings-kpis").innerHTML = `
    <div class="kpi-card"><div class="kpi-val">${state.counts.notes || 0}</div><div class="kpi-label">Active Notes</div></div>
    <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-emerald)">${
      state.counts.total_words || 0
    }</div><div class="kpi-label">Indexed Words</div></div>
    <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-purple)">${
      state.counts.backlinks || 0
    }</div><div class="kpi-label">WikiLinks</div></div>
    <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-amber)">${
      state.dbSizeKb || 0
    } KB</div><div class="kpi-label">FTS5 Index DB</div></div>
  `;

  document.querySelectorAll("#theme-swatches .theme-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.themeChoice === (s.theme || "obsidian"));
  });

  document.getElementById("setting-default-mode").value = s.default_editor_mode || "split";
  document.getElementById("setting-font-size").value = String(s.editor_font_size || 13.5);
  document.getElementById("setting-show-inspector").checked = s.show_inspector !== false;
  document.getElementById("setting-default-owner").value = s.default_owner || "Tech Lead";
  document.getElementById("setting-default-env").value = s.default_env || "prod-k8s";
  document.getElementById("setting-default-tags").value = s.default_tags || "cloud, ops";
  document.getElementById("setting-midweek-day").value = String(s.midweek_day || 3);

  const archiveBtn = document.getElementById("btn-settings-archive-demo");
  const restoreBtn = document.getElementById("btn-settings-restore-demo");
  const demoLabel = document.getElementById("demo-status-label");

  if (state.demoArchived) {
    archiveBtn.classList.add("hidden");
    restoreBtn.classList.remove("hidden");
    demoLabel.innerHTML = `<strong>${state.archivedCount} demo notes</strong> are safely archived in <code>vault/_demo_archive/</code> (excluded from search & tasks).`;
  } else {
    archiveBtn.classList.remove("hidden");
    restoreBtn.classList.add("hidden");
    demoLabel.innerHTML = `Move starter demo notes into <code>vault/_demo_archive/</code> to start fresh (nothing is deleted; you can restore anytime).`;
  }

  document.getElementById("settings-vault-path").textContent = state.vaultDir;
}

async function persistSettings(partial = {}) {
  state.settings = {
    ...state.settings,
    default_editor_mode: document.getElementById("setting-default-mode").value,
    editor_font_size: parseFloat(document.getElementById("setting-font-size").value) || 13.5,
    show_inspector: document.getElementById("setting-show-inspector").checked,
    default_owner: document.getElementById("setting-default-owner").value.trim() || "Tech Lead",
    default_env: document.getElementById("setting-default-env").value.trim() || "prod-k8s",
    default_tags: document.getElementById("setting-default-tags").value.trim() || "cloud, ops",
    midweek_day: parseInt(document.getElementById("setting-midweek-day").value, 10) || 3,
    ...partial,
  };
  applySettingsToUI();
  await apiPost("/api/settings/save", state.settings);
}

// --- Command Palette & Instant FTS5 Search (⌘K) ---

function openCommandPalette(initialQuery = "") {
  const modal = document.getElementById("cmd-modal");
  const input = document.getElementById("cmd-search-input");
  modal.classList.remove("hidden");
  input.value = initialQuery;
  input.focus();
  runFtsSearch(initialQuery);
}

function closeCommandPalette() {
  document.getElementById("cmd-modal").classList.add("hidden");
}

async function runFtsSearch(query) {
  const data = await apiGet(`/api/search?q=${encodeURIComponent(query)}`);
  document.getElementById("search-latency").textContent = `${data.elapsed_ms} ms`;
  state.cmdResults = data.results || [];
  state.cmdSelectedIndex = 0;
  renderCmdResults();
}

function renderCmdResults() {
  const container = document.getElementById("cmd-results");
  if (state.cmdResults.length === 0) {
    container.innerHTML = `<div style="padding:18px;color:var(--text-muted);text-align:center;">No notes matched. Press Enter to create a new note with this title.</div>`;
    return;
  }

  container.innerHTML = state.cmdResults
    .map(
      (r, idx) => `
      <div class="cmd-result-item ${idx === state.cmdSelectedIndex ? "active" : ""}" data-note-path="${escapeHtml(
        r.path
      )}">
        <div class="cmd-result-top">
          <span class="cmd-result-title">${escapeHtml(r.title)}</span>
          <span class="cmd-result-path">vault/${escapeHtml(r.path)}</span>
        </div>
        <div class="cmd-result-snippet">${r.snippet || ""}</div>
      </div>
    `
    )
    .join("");
}

// --- Event Wiring ---

function bindEvents() {
  // Primary nav buttons
  document.getElementById("nav-daily").addEventListener("click", () => openDailyNote(state.today));
  document.getElementById("nav-tasks").addEventListener("click", () => switchWorkspaceView("tasks"));
  document.getElementById("nav-links").addEventListener("click", () => switchWorkspaceView("links"));
  document.getElementById("nav-reports").addEventListener("click", () => switchWorkspaceView("reports"));
  document.getElementById("nav-graph").addEventListener("click", () => switchWorkspaceView("graph"));
  document.getElementById("btn-jump-today").addEventListener("click", () => openDailyNote(state.today));

  // Global delegated click handlers
  document.body.addEventListener("click", async (e) => {
    const navBtn = e.target.closest(".primary-nav .nav-item[data-view]");
    if (navBtn) {
      const v = navBtn.dataset.view;
      if (v === "daily") openDailyNote(state.today);
      else switchWorkspaceView(v);
      return;
    }
    // Open note from sidebar, backlink, or task/link source pill
    const noteTrigger = e.target.closest("[data-note-path]");
    if (noteTrigger) {
      const p = noteTrigger.dataset.notePath;
      closeCommandPalette();
      openNoteByPath(p);
      return;
    }

    // WikiLink click inside rendered markdown
    const wl = e.target.closest(".wikilink");
    if (wl) {
      const target = wl.dataset.wikilink;
      const existing = findNoteByTarget(target);
      if (existing) {
        openNoteByPath(existing.path);
      } else {
        // Auto-create linked project/architecture note on click!
        const created = await apiPost("/api/note/create", {
          title: target,
          folder: "projects",
        });
        if (created.note) {
          await refreshBootstrap();
          openNoteByPath(created.note.path);
        }
      }
      return;
    }

    // Tag chip click -> open FTS search for #tag
    const tagChip = e.target.closest(".tag-chip");
    if (tagChip && tagChip.dataset.tag) {
      openCommandPalette(tagChip.dataset.tag);
      return;
    }

    // Copy code button
    const copyBtn = e.target.closest(".copy-code-btn");
    if (copyBtn) {
      const rawCode = decodeURIComponent(copyBtn.dataset.code || "");
      navigator.clipboard.writeText(rawCode);
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => (copyBtn.textContent = "Copy Snippet"), 1500);
      return;
    }

    // Task checkbox in live preview
    if (e.target.classList.contains("task-checkbox") && state.currentNote) {
      const lineNum = parseInt(e.target.dataset.line, 10);
      const newState = e.target.checked ? "done" : "todo";
      await apiPost("/api/tasks/toggle", {
        source_path: state.currentNote.path,
        line_num: lineNum,
        state: newState,
      });
      await openNoteByPath(state.currentNote.path);
      await refreshBootstrap();
      return;
    }

    // Pin/unpin link in Link Registry
    const pinBtn = e.target.closest(".pin-btn");
    if (pinBtn) {
      const url = pinBtn.dataset.pinUrl;
      const nowPinned = pinBtn.dataset.pinned !== "1";
      await apiPost("/api/links/pin", { url, is_pinned: nowPinned });
      loadLinksDashboard();
      return;
    }

    // Sidebar "+ NEW" folder buttons
    const createFolderBtn = e.target.closest("[data-create-folder]");
    if (createFolderBtn) {
      const folder = createFolderBtn.dataset.createFolder;
      document.getElementById("new-note-folder").value = folder;
      document.getElementById("new-note-modal").classList.remove("hidden");
      document.getElementById("new-note-title").focus();
      return;
    }
  });

  // Task state dropdown change in Central Task Sheet
  document.body.addEventListener("change", async (e) => {
    if (e.target.classList.contains("state-select")) {
      const sourcePath = e.target.dataset.taskPath;
      const lineNum = parseInt(e.target.dataset.taskLine, 10);
      const newState = e.target.value;
      await apiPost("/api/tasks/toggle", {
        source_path: sourcePath,
        line_num: lineNum,
        state: newState,
      });
      await loadTasksDashboard();
      await refreshBootstrap();
    }
  });

  // Editor mode switcher (Split / Editor / Reader)
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const container = document.getElementById("editor-split-container");
      container.className = `editor-split-container mode-${btn.dataset.mode}${
        state.settings.show_inspector === false ? " hide-inspector" : ""
      }`;
      const reportContainer = document.getElementById("report-split-container");
      if (reportContainer) {
        reportContainer.className = `editor-split-container report-split-container mode-${btn.dataset.mode}`;
      }
    });
  });

  // Daily Banner Controls
  document.getElementById("btn-prev-day").addEventListener("click", () => {
    const d = new Date(state.currentDailyDate + "T12:00:00");
    d.setDate(d.getDate() - 1);
    openDailyNote(d.toISOString().slice(0, 10));
  });
  document.getElementById("btn-next-day").addEventListener("click", () => {
    const d = new Date(state.currentDailyDate + "T12:00:00");
    d.setDate(d.getDate() + 1);
    openDailyNote(d.toISOString().slice(0, 10));
  });
  document.getElementById("btn-today-day").addEventListener("click", () => {
    openDailyNote(state.today);
  });
  document.getElementById("daily-date-picker").addEventListener("change", (e) => {
    if (e.target.value) openDailyNote(e.target.value);
  });

  // Roll over unfinished tasks from previous daily logs
  document.getElementById("btn-carryover").addEventListener("click", async () => {
    await apiPost("/api/tasks/carryover", { date: state.today });
    await openDailyNote(state.today);
  });

  // Quick editor helper buttons
  document.getElementById("btn-insert-timestamp").addEventListener("click", () => {
    const editor = document.getElementById("note-editor");
    const now = new Date().toTimeString().slice(0, 5);
    const snippet = `\n- **${now}** — `;
    editor.value += snippet;
    editor.focus();
    editor.selectionStart = editor.selectionEnd = editor.value.length;
    editor.dispatchEvent(new Event("input"));
  });

  document.getElementById("btn-insert-task-line").addEventListener("click", () => {
    const editor = document.getElementById("note-editor");
    editor.value += `\n- [ ] `;
    editor.focus();
    editor.selectionStart = editor.selectionEnd = editor.value.length;
    editor.dispatchEvent(new Event("input"));
  });

  document.getElementById("btn-insert-code").addEventListener("click", () => {
    const editor = document.getElementById("note-editor");
    editor.value += `\n\`\`\`bash\n\n\`\`\`\n`;
    editor.focus();
    editor.dispatchEvent(new Event("input"));
  });

  // Topbar quick actions
  document.getElementById("btn-quick-task").addEventListener("click", () => {
    switchWorkspaceView("tasks");
    document.getElementById("input-central-task-text").focus();
  });

  document.getElementById("btn-quick-bookmark").addEventListener("click", () => {
    switchWorkspaceView("links");
    document.getElementById("input-link-url").focus();
  });

  document.getElementById("btn-new-note").addEventListener("click", () => {
    document.getElementById("new-note-modal").classList.remove("hidden");
    document.getElementById("new-note-title").focus();
  });

  document.getElementById("close-new-note-modal").addEventListener("click", () => {
    document.getElementById("new-note-modal").classList.add("hidden");
  });
  document.getElementById("cancel-new-note").addEventListener("click", () => {
    document.getElementById("new-note-modal").classList.add("hidden");
  });

  document.getElementById("form-new-note").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("new-note-title").value.trim();
    const folder = document.getElementById("new-note-folder").value;
    if (!title) return;
    const res = await apiPost("/api/note/create", { title, folder });
    document.getElementById("new-note-modal").classList.add("hidden");
    document.getElementById("new-note-title").value = "";
    if (res.note) {
      await refreshBootstrap();
      openNoteByPath(res.note.path);
    }
  });

  // Delete note
  document.getElementById("btn-delete-note").addEventListener("click", async () => {
    if (!state.currentNote) return;
    if (!confirm(`Delete vault/${state.currentNote.path}?`)) return;
    await apiPost("/api/note/delete", { path: state.currentNote.path });
    await refreshBootstrap();
    openDailyNote(state.today);
  });

  // Central Task Sheet Add Form & Filters
  document.getElementById("form-central-task").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = document.getElementById("input-central-task-text").value.trim();
    const priority = document.getElementById("select-central-task-priority").value;
    const project = document.getElementById("select-central-task-project").value;
    const due_date = document.getElementById("input-central-task-due").value;
    if (!text) return;
    await apiPost("/api/tasks/add", {
      text,
      priority,
      project,
      due_date,
      date: state.today,
    });
    document.getElementById("input-central-task-text").value = "";
    await loadTasksDashboard();
    await refreshBootstrap();
  });

  document.querySelectorAll("#task-status-tabs .filter-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll("#task-status-tabs .filter-tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.taskFilterStatus = tab.dataset.status;
      renderTasksDashboard();
    });
  });

  document.getElementById("filter-task-folder").addEventListener("change", (e) => {
    state.taskFilterFolder = e.target.value;
    renderTasksDashboard();
  });
  document.getElementById("filter-task-priority").addEventListener("change", (e) => {
    state.taskFilterPriority = e.target.value;
    renderTasksDashboard();
  });
  document.getElementById("filter-task-search").addEventListener("input", (e) => {
    state.taskFilterSearch = e.target.value;
    renderTasksDashboard();
  });

  // Central Link Registry Add Form & Filters
  document.getElementById("form-central-link").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = document.getElementById("input-link-url").value.trim();
    const title = document.getElementById("input-link-title").value.trim();
    const notes = document.getElementById("input-link-notes").value.trim();
    const tags = document.getElementById("input-link-tags").value.trim();
    if (!url) return;
    await apiPost("/api/links/add", { url, title, notes, tags });
    document.getElementById("input-link-url").value = "";
    document.getElementById("input-link-title").value = "";
    document.getElementById("input-link-notes").value = "";
    document.getElementById("input-link-tags").value = "";
    await loadLinksDashboard();
    await refreshBootstrap();
  });

  document.querySelectorAll("#link-category-tabs .filter-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll("#link-category-tabs .filter-tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.linkFilterCategory = tab.dataset.cat;
      renderLinksDashboard();
    });
  });

  document.getElementById("filter-link-domain").addEventListener("change", (e) => {
    state.linkFilterDomain = e.target.value;
    renderLinksDashboard();
  });
  document.getElementById("filter-link-search").addEventListener("input", (e) => {
    state.linkFilterSearch = e.target.value;
    renderLinksDashboard();
  });

  // 1:1 & Weekly Digest Generator Controls
  document.querySelectorAll("#report-mode-tabs .filter-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll("#report-mode-tabs .filter-tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.reportMode = tab.dataset.mode;
      if (state.reportMode === "121") {
        setMidWeekReviewDates();
      } else {
        setEndOfWeekReviewDates();
      }
      loadReportsDashboard();
    });
  });

  document.getElementById("report-start-date").addEventListener("change", (e) => {
    state.reportStart = e.target.value;
    loadReportsDashboard();
  });

  document.getElementById("report-end-date").addEventListener("change", (e) => {
    state.reportEnd = e.target.value;
    loadReportsDashboard();
  });

  document.getElementById("report-editor").addEventListener("input", (e) => {
    document.getElementById("report-preview").innerHTML = renderMarkdown(e.target.value);
  });

  document.getElementById("btn-copy-report").addEventListener("click", (e) => {
    const md = document.getElementById("report-editor").value;
    navigator.clipboard.writeText(md);
    const btn = e.currentTarget;
    const orig = btn.textContent;
    btn.textContent = "✓ Copied to Clipboard";
    setTimeout(() => (btn.textContent = orig), 1800);
  });

  document.getElementById("btn-save-report").addEventListener("click", async () => {
    const mdBody = document.getElementById("report-editor").value;
    const label = state.reportMode === "121" ? "Mid Week Review" : "End of Week Review";
    const fileTitle = `${state.reportEnd} ${label}`;
    const relPath = `reports/${fileTitle}.md`;
    const fullContent = `---\ntitle: "${fileTitle}"\ntype: report\nstatus: ${state.reportMode}\ntags: [report, ${state.reportMode}]\n---\n\n${mdBody}`;
    const res = await apiPost("/api/note/save", {
      path: relPath,
      content: fullContent,
    });
    if (res.ok && res.note) {
      await refreshBootstrap();
      openNoteByPath(res.note.path);
    }
  });

  // Command Palette triggers & keyboard shortcuts
  document.getElementById("btn-cmd-palette").addEventListener("click", () => openCommandPalette(""));
  document.getElementById("sidebar-search-trigger").addEventListener("click", () =>
    openCommandPalette("")
  );
  document.getElementById("cmd-modal").addEventListener("click", (e) => {
    if (e.target.id === "cmd-modal") closeCommandPalette();
  });
  document.getElementById("cmd-search-input").addEventListener("input", (e) => {
    runFtsSearch(e.target.value);
  });

  document.getElementById("btn-reindex").addEventListener("click", async () => {
    await apiPost("/api/reindex", {});
    await refreshBootstrap();
  });

  document.getElementById("btn-open-settings").addEventListener("click", () => {
    switchWorkspaceView("settings");
  });

  document.querySelectorAll("#theme-swatches .theme-card").forEach((card) => {
    card.addEventListener("click", async () => {
      document
        .querySelectorAll("#theme-swatches .theme-card")
        .forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      await persistSettings({ theme: card.dataset.themeChoice });
    });
  });

  document.getElementById("setting-default-mode").addEventListener("change", async (e) => {
    const mode = e.target.value;
    document.querySelectorAll(".mode-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    const container = document.getElementById("editor-split-container");
    container.className = `editor-split-container mode-${mode}${
      state.settings.show_inspector === false ? " hide-inspector" : ""
    }`;
    await persistSettings({ default_editor_mode: mode });
  });

  document.getElementById("setting-font-size").addEventListener("change", () => persistSettings());
  document.getElementById("setting-show-inspector").addEventListener("change", () =>
    persistSettings()
  );
  document.getElementById("setting-midweek-day").addEventListener("change", async () => {
    await persistSettings();
    state.reportStart = "";
    state.reportEnd = "";
  });

  document.getElementById("btn-save-settings").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    await persistSettings();
    const orig = btn.textContent;
    btn.textContent = "✓ Preferences Saved";
    setTimeout(() => (btn.textContent = orig), 1600);
  });

  document.getElementById("btn-settings-archive-demo").addEventListener("click", async () => {
    if (
      !confirm(
        "Move current notes to vault/_demo_archive/ and start with a clean Daily Log for today? (Your templates/ folder will be kept, and you can restore anytime from Settings.)"
      )
    ) {
      return;
    }
    const res = await apiPost("/api/vault/archive-demo", {});
    if (res.ok) {
      await refreshBootstrap();
      renderSettingsDashboard();
    }
  });

  document.getElementById("btn-settings-restore-demo").addEventListener("click", async () => {
    const res = await apiPost("/api/vault/restore-demo", {});
    if (res.ok) {
      await refreshBootstrap();
      renderSettingsDashboard();
    }
  });

  document.getElementById("btn-settings-reindex").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.textContent = "Rebuilding...";
    await apiPost("/api/reindex", {});
    await refreshBootstrap();
    renderSettingsDashboard();
    btn.textContent = "✓ Index Rebuilt";
    setTimeout(() => (btn.textContent = "↻ Rebuild Index Now"), 1600);
  });

  document.getElementById("btn-settings-export").addEventListener("click", () => {
    window.open("/api/export", "_blank");
  });

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openCommandPalette("");
    } else if (e.key === "Escape") {
      closeCommandPalette();
      document.getElementById("new-note-modal").classList.add("hidden");
    }
  });
}

// --- Boot ---

window.addEventListener("DOMContentLoaded", async () => {
  setupEditorErgonomics();
  bindEvents();
  await refreshBootstrap();

  // Apply user's default editor mode on initial load
  const defMode = state.settings.default_editor_mode || "split";
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === defMode);
  });
  const splitContainer = document.getElementById("editor-split-container");
  splitContainer.className = `editor-split-container mode-${defMode}${
    state.settings.show_inspector === false ? " hide-inspector" : ""
  }`;

  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get("view");
  const noteParam = params.get("note");
  const dateParam = params.get("date");

  if (noteParam) {
    await openNoteByPath(noteParam);
  } else if (
    viewParam === "tasks" ||
    viewParam === "links" ||
    viewParam === "reports" ||
    viewParam === "graph" ||
    viewParam === "settings"
  ) {
    switchWorkspaceView(viewParam);
  } else {
    await openDailyNote(dateParam || state.today);
  }
});
