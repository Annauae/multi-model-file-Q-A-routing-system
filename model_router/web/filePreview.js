const filePanels = new Map();

function assetPreviewUrl(sourceFile, ref) {
  const r = (ref || "").trim();
  if (!r) return "";
  if (isSafeHttpUrl(r)) return r;
  if (sourceFile) {
    return `/preview-asset?source=${encodeURIComponent(sourceFile)}&ref=${encodeURIComponent(r)}`;
  }
  if (r.startsWith("files/")) {
    return `/preview-image?file=${encodeURIComponent(r)}`;
  }
  if (r.startsWith("assets/")) {
    return `/preview-image?file=${encodeURIComponent(`files/${r}`)}`;
  }
  return r;
}

function isVideoUrl(url) {
  if (VIDEO_EXTS.test(url)) return true;
  try {
    const u = new URL(url);
    return VIDEO_EXTS.test(u.pathname);
  } catch (e) {
    return false;
  }
}

function youtubeEmbedUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.replace("/", "");
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (u.hostname.includes("youtube.com")) {
      const id = u.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (u.hostname.includes("bilibili.com")) {
      const m = u.pathname.match(/\/video\/(BV[\w]+)/i);
      if (m) return `https://player.bilibili.com/player.html?bvid=${m[1]}&high_quality=1`;
    }
  } catch (e) {
    return null;
  }
  return null;
}

function resolveMdHref(href, sourceFile) {
  const h = (href || "").trim();
  if (!h) return h;
  if (isSafeHttpUrl(h)) return h;
  return assetPreviewUrl(sourceFile, h);
}

function renderMarkdownPreview(md, sourceFile) {
  if (typeof marked === "undefined") {
    return `<div class="empty">marked.js 未加载</div>`;
  }

  const renderer = new marked.Renderer();
  renderer.image = (href, title, text) => {
    const resolved = resolveMdHref(href, sourceFile);
    const alt = escapeHtml(text || title || "");
    if (isVideoUrl(href) || isVideoUrl(resolved)) {
      const src = escapeHtml(resolved);
      return `<video controls preload="metadata" src="${src}">${alt}</video>`;
    }
    const src = escapeHtml(resolved);
    return `<img loading="lazy" alt="${alt}" src="${src}" onerror="this.alt='加载失败: ${src}'" />`;
  };
  renderer.link = (href, title, text) => {
    const h = (href || "").trim();
    const label = escapeHtml(text || title || h);
    if (isSafeHttpUrl(h)) {
      if (isVideoUrl(h)) {
        return `<video controls preload="metadata" src="${escapeHtml(h)}">${label}</video>`;
      }
      const embed = youtubeEmbedUrl(h);
      if (embed) {
        return `<iframe loading="lazy" src="${escapeHtml(embed)}" allowfullscreen title="${label}"></iframe>`;
      }
      return `<a href="${escapeHtml(h)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    const resolved = resolveMdHref(h, sourceFile);
    if (isVideoUrl(h) || isVideoUrl(resolved)) {
      return `<video controls preload="metadata" src="${escapeHtml(resolved)}">${label}</video>`;
    }
    return `<a href="${escapeHtml(resolved)}" target="_blank" rel="noreferrer">${label}</a>`;
  };

  marked.setOptions({ renderer, gfm: true, breaks: true });
  const rawHtml = marked.parse(md || "");
  if (typeof DOMPurify !== "undefined") {
    return DOMPurify.sanitize(rawHtml, {
      ADD_TAGS: ["video", "iframe", "source"],
      ADD_ATTR: ["controls", "preload", "allowfullscreen", "loading", "onerror"],
    });
  }
  return rawHtml;
}

function initFilePanel(name, cfg) {
  filePanels.set(name, {
    select: cfg.select,
    preview: cfg.preview,
    source: cfg.source,
    previewBtn: cfg.previewBtn,
    sourceBtn: cfg.sourceBtn,
    onError: cfg.onError || (() => {}),
    mode: "preview",
    path: "",
    raw: "",
  });
}

function _panel(name) {
  const p = filePanels.get(name);
  if (!p) throw new Error(`file panel not initialized: ${name}`);
  return p;
}

function setFileViewMode(panelName, mode) {
  const p = _panel(panelName);
  p.mode = mode;
  const previewBtn = $(p.previewBtn);
  const sourceBtn = $(p.sourceBtn);
  previewBtn?.classList.toggle("primary", mode === "preview");
  previewBtn?.classList.toggle("ghost", mode !== "preview");
  sourceBtn?.classList.toggle("primary", mode === "source");
  sourceBtn?.classList.toggle("ghost", mode !== "source");
  $(p.preview)?.classList.toggle("hidden", mode !== "preview");
  $(p.source)?.classList.toggle("hidden", mode !== "source");
  if (mode === "preview") renderCurrentFilePreview(panelName);
}

function renderCurrentFilePreview(panelName) {
  const p = _panel(panelName);
  const preview = $(p.preview);
  if (!preview) return;
  if (!p.raw) {
    preview.innerHTML = `<div class="empty">请选择文件</div>`;
    return;
  }
  if (!p.path.toLowerCase().endsWith(".md")) {
    preview.innerHTML = `<pre class="fileSource">${escapeHtml(p.raw.slice(0, 120000))}</pre>`;
    return;
  }
  preview.innerHTML = renderMarkdownPreview(p.raw, p.path);
}

async function loadSelectedFile(panelName, path) {
  if (!path) return;
  const p = _panel(panelName);
  p.path = path;
  const preview = $(p.preview);
  const source = $(p.source);
  if (preview) preview.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    const r = await fetch(`/files/raw?file=${encodeURIComponent(path)}`);
    const txt = await r.text();
    let data = null;
    try {
      data = JSON.parse(txt);
    } catch (e) {
      throw new Error(txt);
    }
    if (!r.ok) throw new Error(data?.detail || txt);
    p.raw = data.text || "";
    if (source) source.textContent = p.raw;
    setFileViewMode(panelName, p.mode);
  } catch (e) {
    p.raw = "";
    if (preview) preview.innerHTML = `<div class="empty">加载失败：${escapeHtml(e?.message || e)}</div>`;
    if (source) source.textContent = "";
  }
}

async function loadAgentFilesList(panelName) {
  const p = _panel(panelName);
  const sel = $(p.select);
  if (!sel) return;
  const prev = sel.value;
  try {
    const r = await fetch("/agents/files");
    const data = await r.json();
    if (!r.ok) throw new Error(data?.detail || "加载失败");
    const files = data.files || [];
    sel.innerHTML =
      `<option value="">选择文件…</option>` +
      files.map((f) => `<option value="${escapeHtml(f.path)}">${escapeHtml(f.label)}</option>`).join("");
    const keep = prev && files.some((f) => f.path === prev) ? prev : files[0]?.path || "";
    sel.value = keep;
    if (keep) {
      await loadSelectedFile(panelName, keep);
    } else {
      p.path = "";
      p.raw = "";
      const preview = $(p.preview);
      const source = $(p.source);
      if (preview) preview.innerHTML = `<div class="empty">暂无文件</div>`;
      if (source) source.textContent = "";
    }
  } catch (e) {
    sel.innerHTML = `<option value="">加载失败</option>`;
    p.onError(`加载文件列表失败: ${e?.message || e}`);
  }
}

function bindFilePanel(panelName) {
  const p = _panel(panelName);
  $(p.select)?.addEventListener("change", (e) => {
    loadSelectedFile(panelName, e.target.value);
  });
  $(p.previewBtn)?.addEventListener("click", () => setFileViewMode(panelName, "preview"));
  $(p.sourceBtn)?.addEventListener("click", () => setFileViewMode(panelName, "source"));
}
