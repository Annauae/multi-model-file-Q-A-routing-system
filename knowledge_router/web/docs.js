let docsLoaded = false;
let docsScrollObserver = null;

function slugifyHeading(text) {
  const base = (text || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]/g, "");
  return base || `sec-${Math.random().toString(36).slice(2, 7)}`;
}

function addHeadingIds(container) {
  const used = new Set();
  container.querySelectorAll("h2, h3").forEach((h) => {
    let id = slugifyHeading(h.textContent);
    while (used.has(id)) id = `${id}-${used.size}`;
    used.add(id);
    h.id = id;
  });
}

function buildDocsToc(bodyEl, tocEl) {
  if (!bodyEl || !tocEl) return;
  const headings = bodyEl.querySelectorAll("h2, h3");
  if (!headings.length) {
    tocEl.innerHTML = '<div class="docsTocTitle">目录</div><p class="docsTocEmpty muted">暂无目录</p>';
    return;
  }
  let html = '<div class="docsTocTitle">目录</div><ul class="docsTocList">';
  headings.forEach((h) => {
    const cls = h.tagName === "H3" ? "docsTocItem docsTocH3" : "docsTocItem docsTocH2";
    html += `<li class="${cls}"><a href="#${escapeHtml(h.id)}" data-toc-id="${escapeHtml(h.id)}">${escapeHtml(h.textContent)}</a></li>`;
  });
  html += "</ul>";
  tocEl.innerHTML = html;

  tocEl.querySelectorAll("a[data-toc-id]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = bodyEl.querySelector(`#${CSS.escape(a.dataset.tocId)}`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        tocEl.querySelectorAll("a.active").forEach((el) => el.classList.remove("active"));
        a.classList.add("active");
      }
    });
  });
}

function setupDocsScrollSpy(bodyEl, tocEl) {
  if (docsScrollObserver) docsScrollObserver.disconnect();
  const links = Array.from(tocEl.querySelectorAll("a[data-toc-id]"));
  if (!links.length) return;

  const headingMap = new Map();
  links.forEach((a) => {
    const el = bodyEl.querySelector(`#${CSS.escape(a.dataset.tocId)}`);
    if (el) headingMap.set(el, a);
  });

  docsScrollObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (!visible.length) return;
      const activeLink = headingMap.get(visible[0].target);
      if (!activeLink) return;
      links.forEach((l) => l.classList.toggle("active", l === activeLink));
    },
    { root: bodyEl, rootMargin: "-10% 0px -70% 0px", threshold: [0, 0.25, 0.5, 1] }
  );

  headingMap.forEach((_link, heading) => docsScrollObserver.observe(heading));
}

async function loadDocsContent() {
  if (docsLoaded) return;
  const body = $("#docsBody");
  const toc = $("#docsToc");
  if (!body) return;
  try {
    const resp = await fetch("/static/manual.md");
    if (!resp.ok) throw new Error("无法加载手册");
    const md = await resp.text();
    const html = typeof marked !== "undefined" ? marked.parse(md) : md;
    body.innerHTML =
      typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(html) : html;
    addHeadingIds(body);
    buildDocsToc(body, toc);
    setupDocsScrollSpy(body, toc);
    docsLoaded = true;
  } catch (e) {
    body.innerHTML = `<p class="muted">加载失败：${escapeHtml(e.message)}</p>`;
    if (toc) toc.innerHTML = "";
  }
}

function openDocsModal() {
  const overlay = $("#docsOverlay");
  if (!overlay) return;
  loadDocsContent();
  overlay.classList.remove("hidden");
}

function closeDocsModal() {
  $("#docsOverlay")?.classList.add("hidden");
}

document.addEventListener("DOMContentLoaded", () => {
  $("#docsOpenBtn")?.addEventListener("click", openDocsModal);
  $("#docsCloseBtn")?.addEventListener("click", closeDocsModal);
  $("#docsOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "docsOverlay") closeDocsModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#docsOverlay")?.classList.contains("hidden")) {
      closeDocsModal();
    }
  });
});
