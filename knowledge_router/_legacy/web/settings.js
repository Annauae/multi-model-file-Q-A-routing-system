let modelsConfig = {};
let matchProfiles = [];
let defaultProfileId = "default";
let settingsNavObserver = null;
let promptDefaults = {};
let promptPreviewTopK = 5;
let confidenceQuestionsSection = "";

const SLOT_ORDER = ["import", "pdf_vlm"];

function keyInputHtml(className, apiKey) {
  const key = apiKey || "";
  const maskedVal = key ? "..." : "";
  return `<span class="keyInputWrap">
        <input class="settingsInput ${className} keyInput" type="text" data-field="api_key" data-real-key="${escapeHtml(key)}" value="${escapeHtml(maskedVal)}" placeholder="可留空（Ollama 无需 Key）" autocomplete="off" readonly />
        <button type="button" class="btn btnXs ghost keyToggle">显示</button>
      </span>`;
}

function enableThinkingValue(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "";
}

function enableThinkingSelectHtml(className, value) {
  const v = enableThinkingValue(value);
  return `<label class="fieldLabel">思考模式
    <select class="settingsInput ${className}" data-field="enable_thinking">
      <option value="" ${v === "" ? "selected" : ""}>默认</option>
      <option value="false" ${v === "false" ? "selected" : ""}>关闭（Ollama 本地推荐）</option>
      <option value="true" ${v === "true" ? "selected" : ""}>开启</option>
    </select>
  </label>`;
}

function parseEnableThinkingField(val) {
  if (val === "" || val == null) return null;
  return val === "true" || val === true;
}

function renderSlotForm(key, cfg) {
  const label = cfg?.label || key;
  return `<div class="slotCard" data-slot="${escapeHtml(key)}">
    <label class="fieldLabel">接口地址<input class="settingsInput slot-api" data-field="api_base_url" value="${escapeHtml(cfg?.api_base_url || "")}" placeholder="云端或本机 Ollama 地址" /></label>
    <label class="fieldLabel">密钥 ${keyInputHtml("slot-api", cfg?.api_key)}</label>
    <label class="fieldLabel">模型名称<input class="settingsInput slot-api" data-field="model" value="${escapeHtml(cfg?.model || "")}" placeholder="填写模型名称" /></label>
    ${enableThinkingSelectHtml("slot-api", cfg?.enable_thinking)}
    <label class="fieldLabel">Max Tokens<input class="settingsInput slot-api" type="number" data-field="max_tokens" value="${cfg?.max_tokens ?? 4096}" /></label>
    <label class="fieldLabel">Temperature<input class="settingsInput slot-api" type="number" step="0.1" data-field="temperature" value="${cfg?.temperature ?? 0}" /></label>
    <p class="muted slotMeta">${escapeHtml(label)}</p>
  </div>`;
}

function renderProfileCard(p, isDefault) {
  return `<div class="profileCard" data-profile-id="${escapeHtml(p.id)}">
    <div class="profileCardHead">
      <label class="fieldLabel profileNameField">模型名称<input class="settingsInput profileName profile-field" data-field="name" value="${escapeHtml(p.name || p.id)}" placeholder="例如：Ollama qwen3:8b" /></label>
      <label class="fieldCheck"><input type="radio" name="defaultProfile" class="profileDefault" value="${escapeHtml(p.id)}" ${isDefault ? "checked" : ""} /> 默认</label>
      <button type="button" class="btn btnXs ghost profileDelBtn">删除</button>
    </div>
    <label class="fieldLabel">接口地址<input class="settingsInput profile-field" data-field="api_base_url" value="${escapeHtml(p.api_base_url || "")}" placeholder="云端或本机 Ollama 地址" /></label>
    <label class="fieldLabel">密钥 ${keyInputHtml("profile-field", p.api_key)}</label>
    <label class="fieldLabel">模型名称<input class="settingsInput profile-field" data-field="model" value="${escapeHtml(p.model || "")}" placeholder="填写模型名称" /></label>
    ${enableThinkingSelectHtml("profile-field", p.enable_thinking)}
    <label class="fieldLabel">Max Tokens<input class="settingsInput profile-field" type="number" data-field="max_tokens" value="${p.max_tokens ?? 4096}" /></label>
    <label class="fieldLabel">Temperature<input class="settingsInput profile-field" type="number" step="0.1" data-field="temperature" value="${p.temperature ?? 0}" /></label>
    <input type="hidden" class="profile-field" data-field="id" value="${escapeHtml(p.id)}" />
  </div>`;
}

function readKeyInputValue(input) {
  if (!input) return "";
  if (input.readOnly) return input.dataset.realKey || "";
  return input.value;
}

function setKeyInputMasked(input, masked) {
  const btn = input.closest(".keyInputWrap")?.querySelector(".keyToggle");
  if (masked) {
    if (!input.readOnly) input.dataset.realKey = input.value;
    const key = input.dataset.realKey || "";
    input.value = key ? "..." : "";
    input.readOnly = true;
    input.classList.add("keyMasked");
    if (btn) btn.textContent = "显示";
  } else {
    input.value = input.dataset.realKey || "";
    input.readOnly = false;
    input.classList.remove("keyMasked");
    if (btn) btn.textContent = "隐藏";
  }
}

function renderMatchProfiles() {
  const list = $("#matchProfilesList");
  if (!list) return;
  list.innerHTML = matchProfiles
    .map((p) => renderProfileCard(p, p.id === defaultProfileId))
    .join("");
  bindKeyToggles();
  list.querySelectorAll(".profileDelBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".profileCard");
      const pid = card?.dataset.profileId;
      if (!pid) return;
      if (matchProfiles.length <= 1) return showToast("至少保留一个配置", "error");
      matchProfiles = matchProfiles.filter((p) => p.id !== pid);
      if (defaultProfileId === pid) defaultProfileId = matchProfiles[0]?.id || "";
      renderMatchProfiles();
    });
  });
}

function renderAllSlotForms(slots) {
  SLOT_ORDER.forEach((key) => {
    const inner = $(`.slotFormInner[data-slot="${key}"]`);
    if (inner) inner.innerHTML = renderSlotForm(key, slots?.[key] || {});
  });
  bindKeyToggles();
}

function bindKeyToggles() {
  $$(".keyToggle").forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  $$(".keyToggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = btn.closest(".keyInputWrap")?.querySelector(".keyInput");
      if (!input) return;
      setKeyInputMasked(input, !input.readOnly);
    });
  });
  $$(".keyInput[data-field='api_key']").forEach((input) => {
    input.addEventListener("input", () => {
      if (!input.readOnly) input.dataset.realKey = input.value;
    });
  });
}

function collectModelsPatch() {
  const patch = {};
  $$(".slotCard[data-slot]").forEach((card) => {
    const slot = card.dataset.slot;
    patch[slot] = {};
    card.querySelectorAll(".slot-api").forEach((inp) => {
      const field = inp.dataset.field;
      let val = inp.tagName === "SELECT" ? inp.value : inp.value;
      if (field === "api_key") val = readKeyInputValue(inp);
      else if (field === "max_tokens") val = Number(val);
      else if (field === "temperature") val = Number(val);
      else if (field === "enable_thinking") val = parseEnableThinkingField(val);
      patch[slot][field] = val;
    });
  });
  return patch;
}

function collectProfilesPayload() {
  const profiles = [];
  $$(".profileCard").forEach((card) => {
    const row = {};
    card.querySelectorAll(".profile-field").forEach((inp) => {
      const field = inp.dataset.field;
      let val = inp.tagName === "SELECT" ? inp.value : inp.value;
      if (field === "api_key") val = readKeyInputValue(inp);
      else if (field === "max_tokens") val = Number(val);
      else if (field === "temperature") val = Number(val);
      else if (field === "enable_thinking") val = parseEnableThinkingField(val);
      row[field] = val;
    });
    row.id = row.id || card.dataset.profileId;
    profiles.push(row);
  });
  const defaultRadio = document.querySelector('input[name="defaultProfile"]:checked');
  return { profiles, default_id: defaultRadio?.value || defaultProfileId };
}

function effectiveConfidenceRules(raw) {
  let rules = (raw || "").trim() || promptDefaults.confidence_match_prompt || "";
  if (rules.includes("{top_k}")) {
    rules = rules.replaceAll("{top_k}", String(promptPreviewTopK));
  }
  return rules;
}

function updatePromptPreviews() {
  const confRules = effectiveConfidenceRules($("#settingsConfPrompt")?.value || "");
  const confPreview = $("#settingsConfPreview");
  if (confPreview) {
    const built = confidenceQuestionsSection ? `${confRules}\n\n${confidenceQuestionsSection}` : confRules;
    if (built.trim()) confPreview.value = built;
  }
  const faqRaw = ($("#settingsFaqPrompt")?.value || "").trim();
  const faqPreview = $("#settingsFaqPreview");
  if (faqPreview) {
    const built = faqRaw || promptDefaults.faq_generation_prompt || "";
    if (built) faqPreview.value = built;
  }
  const vlmRaw = ($("#settingsVlmPrompt")?.value || "").trim();
  const vlmPreview = $("#settingsVlmPreview");
  if (vlmPreview) {
    const built = vlmRaw || promptDefaults.pdf_vlm_prompt || "";
    if (built) vlmPreview.value = built;
  }
}

function applyPromptsData(data) {
  promptDefaults = data.defaults || {};
  promptPreviewTopK = data.preview_top_k ?? 5;
  confidenceQuestionsSection = data.confidence_questions_section || "";
  if ($("#settingsConfPrompt")) $("#settingsConfPrompt").value = data.confidence_match_prompt || "";
  if ($("#settingsFaqPrompt")) $("#settingsFaqPrompt").value = data.faq_generation_prompt || "";
  if ($("#settingsVlmPrompt")) $("#settingsVlmPrompt").value = data.pdf_vlm_prompt || "";

  // 优先使用服务端返回的完整预览（与运行时一致）
  if ($("#settingsConfPreview")) {
    $("#settingsConfPreview").value = data.confidence_system_preview || "";
  }
  if ($("#settingsFaqPreview")) {
    $("#settingsFaqPreview").value = data.faq_system_preview || promptDefaults.faq_generation_prompt || "";
  }
  if ($("#settingsVlmPreview")) {
    $("#settingsVlmPreview").value = data.pdf_vlm_system_preview || promptDefaults.pdf_vlm_prompt || "";
  }

  // 旧版 API 或未返回预览时，客户端拼装
  if (!$("#settingsConfPreview")?.value.trim() || !$("#settingsFaqPreview")?.value.trim() || !$("#settingsVlmPreview")?.value.trim()) {
    updatePromptPreviews();
  }
}

function restoreDefaultPrompt(kind) {
  const map = {
    conf: { field: "#settingsConfPrompt", key: "confidence_match_prompt", label: "回答模型" },
    faq: { field: "#settingsFaqPrompt", key: "faq_generation_prompt", label: "FAQ 生成" },
    vlm: { field: "#settingsVlmPrompt", key: "pdf_vlm_prompt", label: "文档提取" },
  };
  const cfg = map[kind];
  if (!cfg) return;
  const el = $(cfg.field);
  if (!el) return;
  el.value = promptDefaults[cfg.key] || "";
  updatePromptPreviews();
  showToast(`${cfg.label}提示词已恢复为默认`);
}

async function loadSettingsPrompts() {
  const data = await apiJson("/settings/prompts");
  applyPromptsData(data);
}

async function loadMatchProfiles() {
  const data = await apiJson("/settings/match-profiles");
  matchProfiles = data.profiles || [];
  defaultProfileId = data.default_id || matchProfiles[0]?.id || "default";
  renderMatchProfiles();
}

let settingsNavBound = false;

function bindSettingsNav() {
  const main = $("#settingsMain");
  const navItems = $$("#settingsSubNav .settingsNavItem");
  if (!main || !navItems.length) return;
  if (!settingsNavBound) {
    settingsNavBound = true;
    $("#settingsSubNav")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".settingsNavItem");
      if (!btn) return;
      document.getElementById(btn.dataset.settingsSec || "")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  if (settingsNavObserver) settingsNavObserver.disconnect();
  settingsNavObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible?.target?.id) return;
      navItems.forEach((btn) => btn.classList.toggle("active", btn.dataset.settingsSec === visible.target.id));
    },
    { root: main, rootMargin: "-20% 0px -60% 0px", threshold: [0, 0.25, 0.5] }
  );
  $$("#settingsMain .settingsSection[id]").forEach((sec) => settingsNavObserver.observe(sec));
}

function bindPromptEditors() {
  ["#settingsConfPrompt", "#settingsFaqPrompt", "#settingsVlmPrompt"].forEach((sel) => {
    $(sel)?.addEventListener("input", updatePromptPreviews);
  });
  $("#settingsConfResetBtn")?.addEventListener("click", () => restoreDefaultPrompt("conf"));
  $("#settingsFaqResetBtn")?.addEventListener("click", () => restoreDefaultPrompt("faq"));
  $("#settingsVlmResetBtn")?.addEventListener("click", () => restoreDefaultPrompt("vlm"));
}

async function settingsViewEnter() {
  const data = await apiJson("/settings/models");
  modelsConfig = data.slots || {};
  renderAllSlotForms(modelsConfig);
  await loadMatchProfiles();
  await loadSettingsPrompts();
  bindSettingsNav();
}

async function saveAllSettings() {
  const slots = collectModelsPatch();
  await apiJson("/settings/models", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slots }),
  });
  const profPayload = collectProfilesPayload();
  await apiJson("/settings/match-profiles", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profPayload),
  });
  const putData = await apiJson("/settings/prompts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confidence_match_prompt: $("#settingsConfPrompt").value || "",
      faq_generation_prompt: $("#settingsFaqPrompt")?.value || "",
      pdf_vlm_prompt: $("#settingsVlmPrompt")?.value || "",
    }),
  });
  applyPromptsData(putData);
  if (typeof refreshMatchProfileSelects === "function") await refreshMatchProfileSelects();
  showToast("全部设置已保存");
}

document.addEventListener("DOMContentLoaded", () => {
  bindPromptEditors();
  $("#settingsSaveAllBtn")?.addEventListener("click", () =>
    withButtonRunning($("#settingsSaveAllBtn"), "运行中…", () => saveAllSettings()).catch((e) => showToast(e.message, "error"))
  );
  $("#settingsAddProfileBtn")?.addEventListener("click", () => {
    const id = `p_${Date.now().toString(36)}`;
    matchProfiles.push({
      id,
      name: `配置 ${matchProfiles.length + 1}`,
      api_base_url: "",
      api_key: "",
      model: "",
      max_tokens: 4096,
      temperature: 0,
      enable_thinking: null,
    });
    renderMatchProfiles();
  });
});
