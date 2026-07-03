import { useEffect, useRef, useState } from "react";
import { apiJson } from "../api/client";
import { useAppUi } from "../context/AppUiContext";
import { ModeBar } from "../components/ModeBar";
import { ModeSwitch } from "../components/ModeSwitch";
import type { AskMode, MatchProfile, RagModelSlot } from "../types";

const SLOT_LABELS: Record<string, string> = { import: "FAQ 生成模型", pdf_vlm: "文档提取 / 模型整理" };
const RAG_SLOT_ORDER = ["embedding", "rerank", "llm", "judge"] as const;
const RAG_SLOTS_WITH_PROMPTS = ["llm", "judge"] as const;
const RAG_SLOT_LABELS: Record<string, string> = {
  embedding: "Embedding 模型",
  rerank: "Rerank 模型",
  llm: "RAG 问答模型",
  judge: "评测裁判模型",
};
const RAG_PROMPT_KEYS: Record<(typeof RAG_SLOT_ORDER)[number], string> = {
  embedding: "embedding_prompt",
  rerank: "rerank_prompt",
  llm: "llm_prompt",
  judge: "judge_prompt",
};
const RAG_PROMPT_LABELS: Record<string, string> = {
  embedding: "Embedding 提示词",
  rerank: "Rerank 提示词",
  llm: "RAG 回答提示词",
  judge: "评测裁判提示词",
};
const RAG_PROMPT_NOTES: Record<string, string> = {
  llm: "RAG 问答合成回答时使用的模板；留空则使用内置默认。占位符：{query}、{context}",
  judge: "Recall@K 评测裁判规则；留空则使用内置默认。占位符：{query}、{expected}、{actual}、{sources}",
};
const NAV_ITEMS = [
  { id: "secMatchProfiles", label: "问答模型" },
  { id: "secConfPrompt", label: "问答模型提示词" },
  { id: "secImportModel", label: "FAQ 生成模型" },
  { id: "secFaqPrompt", label: "FAQ 生成提示词" },
  { id: "secPdfVlmModel", label: "文档提取模型" },
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
  const [prompts, setPrompts] = useState({ confidence_match_prompt: "", faq_generation_prompt: "", pdf_vlm_prompt: "" });
  const [promptDefaults, setPromptDefaults] = useState({ confidence_match_prompt: "", faq_generation_prompt: "", pdf_vlm_prompt: "" });
  const [promptPreview, setPromptPreview] = useState({ confidence_match_prompt: "", faq_generation_prompt: "", pdf_vlm_prompt: "" });
  const [settingsMode, setSettingsMode] = useState<AskMode>("llm");
  const [ragSlots, setRagSlots] = useState<Record<string, RagModelSlot>>({});
  const [ragPrompts, setRagPrompts] = useState({ embedding_prompt: "", rerank_prompt: "", llm_prompt: "", judge_prompt: "" });
  const [ragPromptDefaults, setRagPromptDefaults] = useState({ embedding_prompt: "", rerank_prompt: "", llm_prompt: "", judge_prompt: "" });
  const [ragPromptPreview, setRagPromptPreview] = useState({ llm_prompt: "", judge_prompt: "" });

  const load = async () => {
    const [models, mp, pr, ragModels, ragPr] = await Promise.all([
      apiJson<{ slots: Record<string, SlotConfig> }>("/settings/models"),
      apiJson<{ profiles: MatchProfile[]; default_id: string }>("/settings/match-profiles"),
      apiJson<{
        confidence_match_prompt: string;
        faq_generation_prompt: string;
        pdf_vlm_prompt: string;
        defaults?: typeof promptDefaults;
        confidence_system_preview?: string;
        faq_system_preview?: string;
        pdf_vlm_system_preview?: string;
      }>("/settings/prompts"),
      apiJson<{ slots: Record<string, RagModelSlot> }>("/settings/rag-models").catch(() => ({ slots: {} })),
      apiJson<{
        embedding_prompt: string;
        rerank_prompt: string;
        llm_prompt: string;
        judge_prompt: string;
        defaults?: typeof ragPromptDefaults;
        llm_system_preview?: string;
        judge_system_preview?: string;
      }>("/settings/rag-prompts").catch(() => ({
        embedding_prompt: "",
        rerank_prompt: "",
        llm_prompt: "",
        judge_prompt: "",
      })),
    ]);
    setSlots(models.slots || {});
    setProfiles(mp.profiles || []);
    setDefaultId(mp.default_id || "default");
    const defs = pr.defaults || { confidence_match_prompt: "", faq_generation_prompt: "", pdf_vlm_prompt: "" };
    setPromptDefaults(defs);
    setPrompts({
      confidence_match_prompt: pr.confidence_match_prompt || "",
      faq_generation_prompt: pr.faq_generation_prompt || "",
      pdf_vlm_prompt: pr.pdf_vlm_prompt || "",
    });
    setPromptPreview({
      confidence_match_prompt: pr.confidence_system_preview || defs.confidence_match_prompt || "",
      faq_generation_prompt: pr.faq_system_preview || defs.faq_generation_prompt || "",
      pdf_vlm_prompt: pr.pdf_vlm_system_preview || defs.pdf_vlm_prompt || "",
    });
    setRagSlots(ragModels.slots || {});
    const ragDefs = ragPr.defaults || { embedding_prompt: "", rerank_prompt: "", llm_prompt: "", judge_prompt: "" };
    setRagPromptDefaults(ragDefs);
    setRagPrompts({
      embedding_prompt: ragPr.embedding_prompt || "",
      rerank_prompt: ragPr.rerank_prompt || "",
      llm_prompt: ragPr.llm_prompt || "",
      judge_prompt: ragPr.judge_prompt || "",
    });
    setRagPromptPreview({
      llm_prompt: ragPr.llm_system_preview || ragDefs.llm_prompt || "",
      judge_prompt: ragPr.judge_system_preview || ragDefs.judge_prompt || "",
    });
  };

  useEffect(() => { void load(); }, []);

  const navItems = settingsMode === "llm"
    ? [...NAV_ITEMS]
    : RAG_SLOT_ORDER.flatMap((slot) => {
      const items = [{ id: `secRag_${slot}`, label: RAG_SLOT_LABELS[slot] }];
      if ((RAG_SLOTS_WITH_PROMPTS as readonly string[]).includes(slot))
        items.push({ id: `secRagPrompt_${slot}`, label: RAG_PROMPT_LABELS[slot] });
      return items;
    });

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
    navItems.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [profiles.length, settingsMode]);

  const saveAll = async () => {
    if (settingsMode === "llm") {
      await apiJson("/settings/models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slots }) });
      await apiJson("/settings/match-profiles", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profiles, default_id: defaultId }) });
      await apiJson("/settings/prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confidence_match_prompt: prompts.confidence_match_prompt,
          faq_generation_prompt: prompts.faq_generation_prompt,
          pdf_vlm_prompt: prompts.pdf_vlm_prompt,
        }),
      });
    } else {
      await apiJson("/settings/rag-models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slots: ragSlots }) });
      await apiJson("/settings/rag-prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ragPrompts),
      });
    }
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

  const updateRagSlot = (slot: string, field: string, value: string | number | boolean | null) => {
    setRagSlots({ ...ragSlots, [slot]: { ...ragSlots[slot], [field]: value } });
  };

  return (
    <section className="viewPane active" id="viewSettings">
      <div className="settingsLayout">
        <nav className="settingsSubNav" id="settingsSubNav">
          {navItems.map(({ id, label }) => (
            <button key={id} type="button" className={`settingsNavItem ${activeSec === id ? "active" : ""}`} data-settings-sec={id} onClick={() => scrollTo(id)}>{label}</button>
          ))}
        </nav>
        <div className="settingsMain" id="settingsMain" ref={mainRef}>
          <div className="settingsStickyHead">
            <ModeBar label="设置模式" mode={settingsMode} onChange={(m) => { setSettingsMode(m); setActiveSec(m === "llm" ? "secMatchProfiles" : "secRag_embedding"); }}>
              <div className="settingsHeadActions">
                <ModeSwitch mode={settingsMode} onChange={(m) => { setSettingsMode(m); setActiveSec(m === "llm" ? "secMatchProfiles" : "secRag_embedding"); }} />
                <button type="button" id="settingsSaveAllBtn" className="btn primary btnXs" onClick={() => void saveAll()}>保存全部</button>
              </div>
            </ModeBar>
          </div>

          {settingsMode === "llm" && (
          <div className="modePanelEnter">
          <section id="secMatchProfiles" className="settingsSection">
            <h3>问答模型配置</h3>
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

          <section id="secConfPrompt" className="settingsSection">
            <h3>问答模型提示词</h3>
            <p className="muted">问答与召回度测试中的语义匹配规则；留空则使用内置默认。</p>
            <div className="settingsPromptActions">
              <button type="button" id="settingsConfResetBtn" className="btn btnXs ghost" onClick={() => setPrompts({ ...prompts, confidence_match_prompt: promptDefaults.confidence_match_prompt })}>恢复默认提示词</button>
            </div>
            <label className="fieldLabel">回答匹配规则<textarea id="settingsConfPrompt" rows={8} className="settingsTextarea" value={prompts.confidence_match_prompt} onChange={(e) => setPrompts({ ...prompts, confidence_match_prompt: e.target.value })} /></label>
            <label className="fieldLabel">规则预览（只读）<textarea id="settingsConfPreview" rows={8} readOnly className="settingsTextarea readonly" value={promptPreview.confidence_match_prompt} /></label>
          </section>

          <section id="secImportModel" className="settingsSection">
            <h3>FAQ 生成模型</h3>
            <p className="muted">「文件管理」页问题生成弹窗所使用的 AI。</p>
            <div className="slotFormInner" data-slot="import">
              <div className="slotCard">
                <label className="fieldLabel">接口地址<input className="settingsInput slot-api" value={slots.import?.api_base_url || ""} onChange={(e) => updateSlot("import", "api_base_url", e.target.value)} placeholder="云端或本机 Ollama 地址" /></label>
                <label className="fieldLabel">密钥 <KeyInput value={slots.import?.api_key || ""} onChange={(v) => updateSlot("import", "api_key", v)} /></label>
                <label className="fieldLabel">模型名称<input className="settingsInput slot-api" value={slots.import?.model || ""} onChange={(e) => updateSlot("import", "model", e.target.value)} placeholder="填写模型名称" /></label>
                {thinkingSelect(slots.import?.enable_thinking, (v) => updateSlot("import", "enable_thinking", v))}
                <label className="fieldLabel">Max Tokens<input className="settingsInput slot-api" type="number" value={slots.import?.max_tokens ?? 4096} onChange={(e) => updateSlot("import", "max_tokens", parseInt(e.target.value, 10))} /></label>
                <label className="fieldLabel">Temperature<input className="settingsInput slot-api" type="number" step={0.1} value={slots.import?.temperature ?? 0} onChange={(e) => updateSlot("import", "temperature", parseFloat(e.target.value))} /></label>
                <p className="muted slotMeta">{SLOT_LABELS.import}</p>
              </div>
            </div>
          </section>

          <section id="secFaqPrompt" className="settingsSection">
            <h3>FAQ 生成提示词</h3>
            <p className="muted">问题生成弹窗中根据选中回答正文生成标准问题与其他问法；留空则使用内置默认。</p>
            <div className="settingsPromptActions">
              <button type="button" id="settingsFaqResetBtn" className="btn btnXs ghost" onClick={() => setPrompts({ ...prompts, faq_generation_prompt: promptDefaults.faq_generation_prompt })}>恢复默认提示词</button>
            </div>
            <label className="fieldLabel">FAQ 问法生成规则<textarea id="settingsFaqPrompt" rows={12} className="settingsTextarea" value={prompts.faq_generation_prompt} onChange={(e) => setPrompts({ ...prompts, faq_generation_prompt: e.target.value })} /></label>
            <label className="fieldLabel">规则预览（只读）<textarea id="settingsFaqPreview" rows={12} readOnly className="settingsTextarea readonly" value={promptPreview.faq_generation_prompt} /></label>
          </section>

          <section id="secPdfVlmModel" className="settingsSection">
            <h3>文档提取模型</h3>
            <p className="muted">「文件管理」页文件转 Markdown 弹窗所使用的 AI。</p>
            <div className="slotFormInner" data-slot="pdf_vlm">
              <div className="slotCard">
                <label className="fieldLabel">接口地址<input className="settingsInput slot-api" value={slots.pdf_vlm?.api_base_url || ""} onChange={(e) => updateSlot("pdf_vlm", "api_base_url", e.target.value)} placeholder="云端或本机 Ollama 地址" /></label>
                <label className="fieldLabel">密钥 <KeyInput value={slots.pdf_vlm?.api_key || ""} onChange={(v) => updateSlot("pdf_vlm", "api_key", v)} /></label>
                <label className="fieldLabel">模型名称<input className="settingsInput slot-api" value={slots.pdf_vlm?.model || ""} onChange={(e) => updateSlot("pdf_vlm", "model", e.target.value)} placeholder="填写模型名称" /></label>
                {thinkingSelect(slots.pdf_vlm?.enable_thinking, (v) => updateSlot("pdf_vlm", "enable_thinking", v))}
                <label className="fieldLabel">Max Tokens<input className="settingsInput slot-api" type="number" value={slots.pdf_vlm?.max_tokens ?? 4096} onChange={(e) => updateSlot("pdf_vlm", "max_tokens", parseInt(e.target.value, 10))} /></label>
                <label className="fieldLabel">Temperature<input className="settingsInput slot-api" type="number" step={0.1} value={slots.pdf_vlm?.temperature ?? 0} onChange={(e) => updateSlot("pdf_vlm", "temperature", parseFloat(e.target.value))} /></label>
                <p className="muted slotMeta">{SLOT_LABELS.pdf_vlm}</p>
              </div>
            </div>
          </section>

          <section id="secVlmPrompt" className="settingsSection">
            <h3>文档提取提示词</h3>
            <p className="muted">文件转 Markdown 弹窗中 PDF 整理规则；留空则使用内置默认。</p>
            <div className="settingsPromptActions">
              <button type="button" id="settingsVlmResetBtn" className="btn btnXs ghost" onClick={() => setPrompts({ ...prompts, pdf_vlm_prompt: promptDefaults.pdf_vlm_prompt })}>恢复默认提示词</button>
            </div>
            <label className="fieldLabel">文档整理规则<textarea id="settingsVlmPrompt" rows={12} className="settingsTextarea" value={prompts.pdf_vlm_prompt} onChange={(e) => setPrompts({ ...prompts, pdf_vlm_prompt: e.target.value })} /></label>
            <label className="fieldLabel">规则预览（只读）<textarea id="settingsVlmPreview" rows={12} readOnly className="settingsTextarea readonly" value={promptPreview.pdf_vlm_prompt} /></label>
          </section>
          </div>
          )}

          {settingsMode === "rag" && (
          <div className="modePanelEnter">
            {RAG_SLOT_ORDER.map((slot) => {
              const promptKey = RAG_PROMPT_KEYS[slot] as keyof typeof ragPrompts;
              const hasPrompt = (RAG_SLOTS_WITH_PROMPTS as readonly string[]).includes(slot);
              return (
                <div key={slot}>
                  <section id={`secRag_${slot}`} className="settingsSection">
                    <h3>{RAG_SLOT_LABELS[slot]}</h3>
                    <p className="muted">RAG 模式专用，与问答模型配置互不共享。</p>
                    <div className="slotCard">
                      <label className="fieldLabel">接口地址<input className="settingsInput" value={ragSlots[slot]?.api_base_url || ""} onChange={(e) => updateRagSlot(slot, "api_base_url", e.target.value)} /></label>
                      <label className="fieldLabel">密钥 <KeyInput value={ragSlots[slot]?.api_key || ""} onChange={(v) => updateRagSlot(slot, "api_key", v)} /></label>
                      <label className="fieldLabel">模型名称<input className="settingsInput" value={ragSlots[slot]?.model || ""} onChange={(e) => updateRagSlot(slot, "model", e.target.value)} /></label>
                      <label className="fieldLabel">Max Tokens<input className="settingsInput" type="number" value={ragSlots[slot]?.max_tokens ?? 0} onChange={(e) => updateRagSlot(slot, "max_tokens", parseInt(e.target.value, 10))} /></label>
                      <label className="fieldLabel">Temperature<input className="settingsInput" type="number" step={0.1} value={ragSlots[slot]?.temperature ?? 0} onChange={(e) => updateRagSlot(slot, "temperature", parseFloat(e.target.value))} /></label>
                    </div>
                  </section>
                  {hasPrompt && (
                  <section id={`secRagPrompt_${slot}`} className="settingsSection">
                    <h3>{RAG_PROMPT_LABELS[slot]}</h3>
                    <p className="muted">{RAG_PROMPT_NOTES[slot]}</p>
                    <div className="settingsPromptActions">
                      <button type="button" className="btn btnXs ghost" onClick={() => setRagPrompts({ ...ragPrompts, [promptKey]: ragPromptDefaults[promptKey] })}>恢复默认提示词</button>
                    </div>
                    <label className="fieldLabel">{RAG_PROMPT_LABELS[slot]}
                      <textarea rows={10} className="settingsTextarea" value={ragPrompts[promptKey]} onChange={(e) => setRagPrompts({ ...ragPrompts, [promptKey]: e.target.value })} />
                    </label>
                    <label className="fieldLabel">规则预览（只读）
                      <textarea rows={10} readOnly className="settingsTextarea readonly" value={slot === "llm" ? ragPromptPreview.llm_prompt : ragPromptPreview.judge_prompt} />
                    </label>
                  </section>
                  )}
                </div>
              );
            })}
          </div>
          )}
        </div>
      </div>
    </section>
  );
}
