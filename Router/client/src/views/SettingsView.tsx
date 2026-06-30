import { useEffect, useRef, useState } from "react";
import { apiJson } from "../api/client";
import { useAppUi } from "../context/AppUiContext";
import type { MatchProfile } from "../types";

const SLOT_ORDER = ["import", "pdf_vlm"] as const;
const SLOT_LABELS: Record<string, string> = { import: "FAQ 生成模型", pdf_vlm: "文档提取模型 (PDF/VLM)" };
const NAV_ITEMS = [
  { id: "secMatchProfiles", label: "回答模型" },
  { id: "secImportModel", label: "FAQ 生成模型" },
  { id: "secPdfVlmModel", label: "文档提取模型" },
  { id: "secConfPrompt", label: "回答模型提示词" },
  { id: "secFaqPrompt", label: "FAQ 生成提示词" },
  { id: "secVlmPrompt", label: "文档提取提示词" },
] as const;

type SlotConfig = {
  api_base_url?: string;
  api_key?: string;
  model?: string;
  enable_thinking?: boolean | null;
  max_tokens?: number;
  temperature?: number;
  label?: string;
};

function KeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [masked, setMasked] = useState(true);
  const realKey = value || "";
  return (
    <span className="keyInputWrap">
      <input
        className={`settingsInput keyInput${masked && realKey ? " keyMasked" : ""}`}
        type="text"
        data-field="api_key"
        value={masked && realKey ? "..." : realKey}
        placeholder="可留空（Ollama 无需 Key）"
        autoComplete="off"
        readOnly={masked && !!realKey}
        onChange={(e) => { if (!masked || !realKey) onChange(e.target.value); }}
        onFocus={() => { if (masked && realKey) { setMasked(false); } }}
      />
      <button type="button" className="btn btnXs ghost keyToggle" onClick={() => setMasked(!masked)}>{masked ? "显示" : "隐藏"}</button>
    </span>
  );
}

export function SettingsView() {
  const { showToast } = useAppUi();
  const mainRef = useRef<HTMLDivElement>(null);
  const [activeSec, setActiveSec] = useState("secMatchProfiles");
  const [profiles, setProfiles] = useState<MatchProfile[]>([]);
  const [defaultId, setDefaultId] = useState("default");
  const [slots, setSlots] = useState<Record<string, SlotConfig>>({});
  const [prompts, setPrompts] = useState({ confidence_match: "", faq_generation: "", pdf_vlm: "" });
  const [promptDefaults, setPromptDefaults] = useState({ confidence_match: "", faq_generation: "", pdf_vlm: "" });
  const [promptPreview, setPromptPreview] = useState({ confidence_match: "", faq_generation: "", pdf_vlm: "" });

  const load = async () => {
    const [models, mp, pr] = await Promise.all([
      apiJson<{ slots: Record<string, SlotConfig> }>("/settings/models"),
      apiJson<{ profiles: MatchProfile[]; default_id: string }>("/settings/match-profiles"),
      apiJson<{ confidence_match: string; faq_generation: string; pdf_vlm: string; defaults?: typeof prompts; previews?: typeof promptPreview }>("/settings/prompts"),
    ]);
    setSlots(models.slots || {});
    setProfiles(mp.profiles || []);
    setDefaultId(mp.default_id || "default");
    setPrompts({ confidence_match: pr.confidence_match || "", faq_generation: pr.faq_generation || "", pdf_vlm: pr.pdf_vlm || "" });
    if (pr.defaults) setPromptDefaults(pr.defaults);
    if (pr.previews) setPromptPreview(pr.previews);
    else {
      setPromptPreview({
        confidence_match: pr.confidence_match || promptDefaults.confidence_match,
        faq_generation: pr.faq_generation || promptDefaults.faq_generation,
        pdf_vlm: pr.pdf_vlm || promptDefaults.pdf_vlm,
      });
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const root = mainRef.current;
    if (!root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActiveSec(e.target.id);
        }
      },
      { root, rootMargin: "-20% 0px -60% 0px", threshold: 0 },
    );
    NAV_ITEMS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [profiles.length]);

  const saveAll = async () => {
    await apiJson("/settings/models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slots }) });
    await apiJson("/settings/match-profiles", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profiles, default_id: defaultId }) });
    await apiJson("/settings/prompts", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prompts) });
    showToast("全部设置已保存");
    void load();
  };

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSec(id);
  };

  const updateProfile = (idx: number, field: string, value: string | number | boolean | null) => {
    const next = [...profiles];
    next[idx] = { ...next[idx], [field]: value };
    setProfiles(next);
  };

  const updateSlot = (slot: string, field: string, value: string | number | boolean | null) => {
    setSlots({ ...slots, [slot]: { ...slots[slot], [field]: value } });
  };

  const thinkingSelect = (value: boolean | null | undefined, onChange: (v: boolean | null) => void) => (
    <label className="fieldLabel">思考模式
      <select className="settingsInput" value={value === true ? "true" : value === false ? "false" : ""} onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? null : v === "true");
      }}>
        <option value="">默认</option>
        <option value="false">关闭（Ollama 本地推荐）</option>
        <option value="true">开启</option>
      </select>
    </label>
  );

  return (
    <section className="viewPane active" id="viewSettings">
      <div className="settingsLayout">
        <nav className="settingsSubNav" id="settingsSubNav">
          {NAV_ITEMS.map(({ id, label }) => (
            <button key={id} type="button" className={`settingsNavItem ${activeSec === id ? "active" : ""}`} data-settings-sec={id} onClick={() => scrollTo(id)}>{label}</button>
          ))}
        </nav>
        <div className="settingsMain" id="settingsMain" ref={mainRef}>
          <button type="button" id="settingsSaveAllBtn" className="btn primary btnXs settingsSaveFloat" onClick={() => void saveAll()}>保存全部</button>

          <section id="secMatchProfiles" className="settingsSection">
            <h3>回答模型配置</h3>
            <p className="muted">可添加多套模型，在问答与召回度测试页切换使用。支持本机 Ollama。</p>
            <div id="matchProfilesList">
              {profiles.map((p, i) => (
                <div key={p.id} className="profileCard" data-profile-id={p.id}>
                  <div className="profileCardHead">
                    <label className="fieldLabel profileNameField">模型名称<input className="settingsInput profileName profile-field" value={p.name} onChange={(e) => updateProfile(i, "name", e.target.value)} placeholder="例如：Ollama qwen3:8b" /></label>
                    <label className="fieldCheck"><input type="radio" name="defaultProfile" className="profileDefault" checked={defaultId === p.id} onChange={() => setDefaultId(p.id)} /> 默认</label>
                    <button type="button" className="btn btnXs ghost profileDelBtn" onClick={() => {
                      if (profiles.length <= 1) return showToast("至少保留一个配置", "error");
                      setProfiles(profiles.filter((x) => x.id !== p.id));
                      if (defaultId === p.id) setDefaultId(profiles.find((x) => x.id !== p.id)?.id || "");
                    }}>删除</button>
                  </div>
                  <label className="fieldLabel">接口地址<input className="settingsInput profile-field" value={p.api_base_url} onChange={(e) => updateProfile(i, "api_base_url", e.target.value)} placeholder="云端或本机 Ollama 地址" /></label>
                  <label className="fieldLabel">密钥 <KeyInput value={p.api_key || ""} onChange={(v) => updateProfile(i, "api_key", v)} /></label>
                  <label className="fieldLabel">模型名称<input className="settingsInput profile-field" value={p.model} onChange={(e) => updateProfile(i, "model", e.target.value)} placeholder="填写模型名称" /></label>
                  {thinkingSelect(p.enable_thinking, (v) => updateProfile(i, "enable_thinking", v))}
                  <label className="fieldLabel">Max Tokens<input className="settingsInput profile-field" type="number" value={p.max_tokens ?? 4096} onChange={(e) => updateProfile(i, "max_tokens", parseInt(e.target.value, 10))} /></label>
                  <label className="fieldLabel">Temperature<input className="settingsInput profile-field" type="number" step={0.1} value={p.temperature ?? 0} onChange={(e) => updateProfile(i, "temperature", parseFloat(e.target.value))} /></label>
                </div>
              ))}
            </div>
            <button type="button" id="settingsAddProfileBtn" className="btn btnXs ghost" style={{ marginTop: 10 }} onClick={() => {
              const id = `p_${Date.now()}`;
              setProfiles([...profiles, { id, name: "新模型", model: "", api_base_url: "", api_key: "" }]);
            }}>+ 添加模型</button>
          </section>

          {SLOT_ORDER.map((slot) => (
            <section key={slot} id={slot === "import" ? "secImportModel" : "secPdfVlmModel"} className="settingsSection">
              <h3>{slot === "import" ? "FAQ 生成模型" : "文档提取模型"}</h3>
              <p className="muted">{slot === "import" ? "「文件管理」页问题生成弹窗所使用的 AI。" : "「文件管理」页文件转 Markdown 弹窗所使用的 AI。"}</p>
              <div className="slotFormInner" data-slot={slot}>
                <div className="slotCard">
                  <label className="fieldLabel">接口地址<input className="settingsInput slot-api" value={slots[slot]?.api_base_url || ""} onChange={(e) => updateSlot(slot, "api_base_url", e.target.value)} placeholder="云端或本机 Ollama 地址" /></label>
                  <label className="fieldLabel">密钥 <KeyInput value={slots[slot]?.api_key || ""} onChange={(v) => updateSlot(slot, "api_key", v)} /></label>
                  <label className="fieldLabel">模型名称<input className="settingsInput slot-api" value={slots[slot]?.model || ""} onChange={(e) => updateSlot(slot, "model", e.target.value)} placeholder="填写模型名称" /></label>
                  {thinkingSelect(slots[slot]?.enable_thinking, (v) => updateSlot(slot, "enable_thinking", v))}
                  <label className="fieldLabel">Max Tokens<input className="settingsInput slot-api" type="number" value={slots[slot]?.max_tokens ?? 4096} onChange={(e) => updateSlot(slot, "max_tokens", parseInt(e.target.value, 10))} /></label>
                  <label className="fieldLabel">Temperature<input className="settingsInput slot-api" type="number" step={0.1} value={slots[slot]?.temperature ?? 0} onChange={(e) => updateSlot(slot, "temperature", parseFloat(e.target.value))} /></label>
                  <p className="muted slotMeta">{SLOT_LABELS[slot]}</p>
                </div>
              </div>
            </section>
          ))}

          <section id="secConfPrompt" className="settingsSection">
            <h3>回答模型提示词</h3>
            <p className="muted">问答与召回度测试中的语义匹配规则；留空则使用内置默认。</p>
            <div className="settingsPromptActions">
              <button type="button" id="settingsConfResetBtn" className="btn btnXs ghost" onClick={() => setPrompts({ ...prompts, confidence_match: promptDefaults.confidence_match })}>恢复默认提示词</button>
            </div>
            <label className="fieldLabel">回答匹配规则<textarea id="settingsConfPrompt" rows={8} className="settingsTextarea" value={prompts.confidence_match} onChange={(e) => setPrompts({ ...prompts, confidence_match: e.target.value })} /></label>
            <label className="fieldLabel">规则预览（只读）<textarea id="settingsConfPreview" rows={8} readOnly className="settingsTextarea readonly" value={promptPreview.confidence_match || prompts.confidence_match || promptDefaults.confidence_match} /></label>
          </section>

          <section id="secFaqPrompt" className="settingsSection">
            <h3>FAQ 生成提示词</h3>
            <p className="muted">问题生成弹窗中根据选中回答正文生成标准问题与其他问法；留空则使用内置默认。</p>
            <div className="settingsPromptActions">
              <button type="button" id="settingsFaqResetBtn" className="btn btnXs ghost" onClick={() => setPrompts({ ...prompts, faq_generation: promptDefaults.faq_generation })}>恢复默认提示词</button>
            </div>
            <label className="fieldLabel">FAQ 问法生成规则<textarea id="settingsFaqPrompt" rows={12} className="settingsTextarea" value={prompts.faq_generation} onChange={(e) => setPrompts({ ...prompts, faq_generation: e.target.value })} /></label>
            <label className="fieldLabel">规则预览（只读）<textarea id="settingsFaqPreview" rows={12} readOnly className="settingsTextarea readonly" value={promptPreview.faq_generation || prompts.faq_generation || promptDefaults.faq_generation} /></label>
          </section>

          <section id="secVlmPrompt" className="settingsSection">
            <h3>文档提取提示词</h3>
            <p className="muted">文件转 Markdown 弹窗中 PDF 整理规则；留空则使用内置默认。</p>
            <div className="settingsPromptActions">
              <button type="button" id="settingsVlmResetBtn" className="btn btnXs ghost" onClick={() => setPrompts({ ...prompts, pdf_vlm: promptDefaults.pdf_vlm })}>恢复默认提示词</button>
            </div>
            <label className="fieldLabel">文档整理规则<textarea id="settingsVlmPrompt" rows={12} className="settingsTextarea" value={prompts.pdf_vlm} onChange={(e) => setPrompts({ ...prompts, pdf_vlm: e.target.value })} /></label>
            <label className="fieldLabel">规则预览（只读）<textarea id="settingsVlmPreview" rows={12} readOnly className="settingsTextarea readonly" value={promptPreview.pdf_vlm || prompts.pdf_vlm || promptDefaults.pdf_vlm} /></label>
          </section>
        </div>
      </div>
    </section>
  );
}
