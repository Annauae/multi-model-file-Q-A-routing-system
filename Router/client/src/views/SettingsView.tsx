import { useEffect, useState } from "react";
import { apiJson } from "../api/client";
import { useAppUi } from "../context/AppUiContext";
import { FadePanel } from "../components/FadePanel";
import { ModeSwitch } from "../components/ModeSwitch";
import { ProfileConfigModal } from "../components/ProfileConfigModal";
import { PromptConfigModal } from "../components/PromptConfigModal";
import { SlotConfigModal } from "../components/SlotConfigModal";
import { SettingsClickRow, SettingsModelDropdown } from "../components/SettingsRows";
import type { AskMode, MatchProfile, RagModelSlot } from "../types";

const SLOT_LABELS: Record<string, string> = { import: "FAQ 生成模型", pdf_vlm: "文档提取模型" };
const RAG_SLOT_ORDER = ["embedding", "rerank"] as const;
const RAG_SLOT_LABELS: Record<string, string> = {
  embedding: "Embedding 模型",
  rerank: "Rerank 模型",
};
const RAG_SLOT_DESCRIPTIONS: Record<string, string> = {
  embedding: "建索引与查询时的文本向量化；变更后需重建索引。",
  rerank: "检索候选结果的重排序。",
};

type SlotConfig = {
  api_base_url?: string;
  api_key?: string;
  model?: string;
  enable_thinking?: boolean | null;
  max_tokens?: number;
  temperature?: number;
};

const EMPTY_PROFILE: MatchProfile = {
  id: "",
  name: "",
  model: "",
  api_base_url: "",
  api_key: "",
};

type PromptKey = "confidence_match_prompt" | "faq_generation_prompt" | "pdf_vlm_prompt";

export function SettingsView() {
  const { showToast } = useAppUi();
  const [profiles, setProfiles] = useState<MatchProfile[]>([]);
  const [defaultId, setDefaultId] = useState("default");
  const [slots, setSlots] = useState<Record<string, SlotConfig>>({});
  const [prompts, setPrompts] = useState({ confidence_match_prompt: "", faq_generation_prompt: "", pdf_vlm_prompt: "" });
  const [promptDefaults, setPromptDefaults] = useState({ confidence_match_prompt: "", faq_generation_prompt: "", pdf_vlm_prompt: "" });
  const [promptPreview, setPromptPreview] = useState({ confidence_match_prompt: "", faq_generation_prompt: "", pdf_vlm_prompt: "" });
  const [settingsMode, setSettingsMode] = useState<AskMode>("llm");
  const [ragSlots, setRagSlots] = useState<Record<string, RagModelSlot>>({});
  const [profileModal, setProfileModal] = useState<{ open: boolean; id: string | null; isNew: boolean }>({ open: false, id: null, isNew: false });
  const [promptModal, setPromptModal] = useState<PromptKey | null>(null);
  const [slotModal, setSlotModal] = useState<string | null>(null);

  const load = async () => {
    const [models, mp, pr, ragModels] = await Promise.all([
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
  };

  useEffect(() => { void load(); }, []);

  const saveMatchProfiles = async (nextProfiles: MatchProfile[], nextDefaultId: string) => {
    await apiJson("/settings/match-profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profiles: nextProfiles, default_id: nextDefaultId }),
    });
    setProfiles(nextProfiles);
    setDefaultId(nextDefaultId);
    showToast("问答模型已保存");
    void load();
  };

  const saveLlmSlots = async (nextSlots: Record<string, SlotConfig>) => {
    await apiJson("/settings/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slots: nextSlots }),
    });
    setSlots(nextSlots);
    showToast("模型配置已保存");
    void load();
  };

  const saveLlmPrompts = async (nextPrompts: typeof prompts) => {
    await apiJson("/settings/prompts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextPrompts),
    });
    setPrompts(nextPrompts);
    showToast("提示词已保存");
    void load();
  };

  const saveRagSlots = async (nextSlots: Record<string, RagModelSlot>) => {
    await apiJson("/settings/rag-models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slots: nextSlots }),
    });
    setRagSlots(nextSlots);
    showToast("RAG 模型已保存");
    void load();
  };

  const defaultProfile = profiles.find((p) => p.id === defaultId) || profiles[0];
  const editingProfile = profileModal.id
    ? profiles.find((p) => p.id === profileModal.id) || null
    : profileModal.isNew ? { ...EMPTY_PROFILE } : null;
  const editingProfileIdx = editingProfile ? profiles.findIndex((p) => p.id === editingProfile.id) : -1;

  const promptMeta: Record<PromptKey, { title: string; description: string; label: string; preview?: string; defaultValue?: string }> = {
    confidence_match_prompt: {
      title: "问答模型提示词",
      description: "问答与召回度测试中的语义匹配规则；留空则使用内置默认。",
      label: "回答匹配规则",
      preview: promptPreview.confidence_match_prompt,
      defaultValue: promptDefaults.confidence_match_prompt,
    },
    faq_generation_prompt: {
      title: "FAQ 生成提示词",
      description: "问题生成弹窗中根据选中回答正文生成标准问题与其他问法；留空则使用内置默认。",
      label: "FAQ 问法生成规则",
      preview: promptPreview.faq_generation_prompt,
      defaultValue: promptDefaults.faq_generation_prompt,
    },
    pdf_vlm_prompt: {
      title: "文档提取提示词",
      description: "文件转 Markdown 弹窗中 PDF 整理规则；留空则使用内置默认。",
      label: "文档整理规则",
      preview: promptPreview.pdf_vlm_prompt,
      defaultValue: promptDefaults.pdf_vlm_prompt,
    },
  };

  return (
    <section className="viewPane active settingsPage ui-fade-in" id="viewSettings">
      <div className="settingsPageInner">
        <div className="settingsPageHead">
          <div>
            <h2 className="settingsPageTitle">模型设置</h2>
            <p className="settingsPageSub muted">配置问答、生成与文档处理所用模型及提示词</p>
          </div>
          <div className="settingsHeadActions">
            <ModeSwitch mode={settingsMode} onChange={setSettingsMode} />
          </div>
        </div>

        <FadePanel show key={settingsMode} className="settingsSections modePanelEnter">
          {settingsMode === "llm" ? (
            <>
              <div className="settingsBlock">
                <div className="settingsBlockLabel">首选模型</div>
                <div className="settingsGroupCard settingsGroupCard--solo">
                  <SettingsModelDropdown
                    label="问答模型"
                    valueLabel={defaultProfile?.name || defaultProfile?.model || "未配置"}
                    items={profiles.map((p) => ({ id: p.id, name: p.name || p.id, sub: p.model }))}
                    onPick={(id) => setProfileModal({ open: true, id, isNew: false })}
                    onAdd={() => setProfileModal({ open: true, id: null, isNew: true })}
                  />
                </div>
                <div className="settingsGroupCard">
                  <SettingsClickRow label="FAQ 生成模型" value={slots.import?.model || "未配置"} onClick={() => setSlotModal("import")} />
                  <SettingsClickRow label="文档提取模型" value={slots.pdf_vlm?.model || "未配置"} onClick={() => setSlotModal("pdf_vlm")} />
                </div>
              </div>
              <div className="settingsBlock">
                <div className="settingsBlockLabel">提示词设置</div>
                <div className="settingsGroupCard">
                  <SettingsClickRow label="问答模型提示词" value={prompts.confidence_match_prompt ? "已配置" : "使用默认"} onClick={() => setPromptModal("confidence_match_prompt")} />
                  <SettingsClickRow label="FAQ 生成提示词" value={prompts.faq_generation_prompt ? "已配置" : "使用默认"} onClick={() => setPromptModal("faq_generation_prompt")} />
                  <SettingsClickRow label="文档提取提示词" value={prompts.pdf_vlm_prompt ? "已配置" : "使用默认"} onClick={() => setPromptModal("pdf_vlm_prompt")} />
                </div>
              </div>
            </>
          ) : (
            <div className="settingsBlock">
              <div className="settingsBlockLabel">RAG 模型</div>
              <div className="settingsGroupCard">
                {RAG_SLOT_ORDER.map((slot) => (
                  <SettingsClickRow
                    key={slot}
                    label={RAG_SLOT_LABELS[slot]}
                    value={ragSlots[slot]?.model || "未配置"}
                    onClick={() => setSlotModal(`rag_${slot}`)}
                  />
                ))}
              </div>
            </div>
          )}
        </FadePanel>
      </div>

      <ProfileConfigModal
        open={profileModal.open}
        profile={editingProfile}
        isDefault={editingProfile?.id === defaultId}
        isNew={profileModal.isNew}
        canDelete={profiles.length > 1}
        onClose={() => setProfileModal({ open: false, id: null, isNew: false })}
        onSave={async (p) => {
          const nextProfiles = profileModal.isNew
            ? [...profiles, p]
            : editingProfileIdx >= 0
              ? profiles.map((x, i) => (i === editingProfileIdx ? p : x))
              : profiles;
          const nextDefaultId = profileModal.isNew && nextProfiles.length === 1 ? p.id : defaultId;
          await saveMatchProfiles(nextProfiles, nextDefaultId);
        }}
        onDelete={editingProfile && profiles.length > 1 ? async () => {
          const nextProfiles = profiles.filter((x) => x.id !== editingProfile.id);
          const nextDefaultId = defaultId === editingProfile.id ? (nextProfiles[0]?.id || "") : defaultId;
          await saveMatchProfiles(nextProfiles, nextDefaultId);
          setProfileModal({ open: false, id: null, isNew: false });
        } : undefined}
        onSetDefault={editingProfile ? () => setDefaultId(editingProfile.id) : undefined}
      />

      {promptModal && (
        <PromptConfigModal
          open
          title={promptMeta[promptModal].title}
          description={promptMeta[promptModal].description}
          label={promptMeta[promptModal].label}
          value={prompts[promptModal]}
          preview={promptMeta[promptModal].preview}
          defaultValue={promptMeta[promptModal].defaultValue}
          onClose={() => setPromptModal(null)}
          onSave={(v) => saveLlmPrompts({ ...prompts, [promptModal]: v }).catch((e) => showToast((e as Error).message, "error"))}
        />
      )}

      {slotModal && slotModal.startsWith("rag_") && (
        <SlotConfigModal
          open
          title={RAG_SLOT_LABELS[slotModal.replace("rag_", "")] || "模型配置"}
          description={RAG_SLOT_DESCRIPTIONS[slotModal.replace("rag_", "")] || "RAG 检索模型配置。"}
          slot={ragSlots[slotModal.replace("rag_", "")] || {}}
          showThinking={false}
          onClose={() => setSlotModal(null)}
          onSave={(draft) => {
            const slotKey = slotModal.replace("rag_", "");
            void saveRagSlots({ ...ragSlots, [slotKey]: draft }).catch((e) => showToast((e as Error).message, "error"));
          }}
        />
      )}

      {slotModal && !slotModal.startsWith("rag_") && (
        <SlotConfigModal
          open
          title={SLOT_LABELS[slotModal] || "模型配置"}
          description={slotModal === "import" ? "「文件管理」页问题生成弹窗所使用的 AI。" : "「文件管理」页文件转 Markdown 弹窗所使用的 AI。"}
          slot={slots[slotModal] || {}}
          onClose={() => setSlotModal(null)}
          onSave={(draft) => {
            void saveLlmSlots({ ...slots, [slotModal]: draft }).catch((e) => showToast((e as Error).message, "error"));
          }}
        />
      )}
    </section>
  );
}
