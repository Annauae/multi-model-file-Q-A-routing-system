/**
 * useKnowledgeBases.ts — 全局「只读」服务端数据 Hooks
 *
 * 基于 @tanstack/react-query 缓存 GET 请求，避免各页面重复拉取同一接口。
 * Provider 挂载于 App.tsx 根部的 QueryClientProvider。
 *
 * 导出四个 hook：
 * - useKnowledgeBases      → LLM 匹配知识库列表
 * - useRagKnowledgeBases   → RAG 向量知识库列表x
 * - useMatchProfiles       → 调试页「问答模型」下拉
 * - useHealth              → 顶栏后端连接状态（7s 轮询）
 *
 * 知识库类 hook 额外提供 kbMap（id → 配置）、kbDisplayName、refresh（失效缓存后重拉）。
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../api/client";
import type { KnowledgeBase } from "../types";

/**
 * RAG 知识库列表。
 * GET /rag/knowledge-bases → config/rag_knowledge_bases.json + enabled_count
 *
 * 用于：App 调试页 RAG 模式、ManageView/ManageFilesView RAG 分支、DebugRecallView
 */
export function useRagKnowledgeBases() {
  const qc = useQueryClient(); // 获取查询客户端
  const query = useQuery({
    queryKey: ["rag-knowledge-bases"], // 查询键（缓存key，全局唯一）
    queryFn: async () => {
      const data = await apiJson<{ items: KnowledgeBase[] }>("/rag/knowledge-bases"); // 获取知识库列表
      // map 便于 O(1) 按 kb_id 查名称、enabled_count 等，避免下拉/表格里反复 find
      const map: Record<string, KnowledgeBase> = {};
      for (const item of data.items || []) map[item.kb_id] = item;
      return { items: data.items || [], map };
    },
  });

  /** 创建/删除/重命名库后调用，触发 useQuery 重新请求 */
  const refresh = () => qc.invalidateQueries({ queryKey: ["rag-knowledge-bases"] });

  /** 展示名：优先配置 name，否则 fallback 为 rag_kb_{id} */
  const kbDisplayName = (kbId: string) => {
    const cfg = query.data?.map[kbId];
    return (cfg?.name || "").trim() || `rag_kb_${kbId}`;
  };

  // 展开 query（data/isLoading/error/refetch…）并附加业务便捷字段
  return { ...query, refresh, kbDisplayName, kbMap: query.data?.map ?? {} };
}

/**
 * LLM 匹配知识库列表。（结构与 RAG 知识库列表 几乎相同）
 * GET /knowledge-bases → config/knowledge_bases.json + enabled_count
 *
 * 用于：App 调试页 LLM 模式、ManageView、LogsView 筛选、ManageFilesView 导入目标
 */
export function useKnowledgeBases() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["knowledge-bases"],
    queryFn: async () => {
      const data = await apiJson<{ items: KnowledgeBase[] }>("/knowledge-bases");
      const map: Record<string, KnowledgeBase> = {};
      for (const item of data.items || []) map[item.kb_id] = item;
      return { items: data.items || [], map };
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["knowledge-bases"] });

  const kbDisplayName = (kbId: string) => {
    const cfg = query.data?.map[kbId];
    return (cfg?.name || "").trim() || `kb_${kbId}`;
  };

  return { ...query, refresh, kbDisplayName, kbMap: query.data?.map ?? {} };
}

/**
 * 问答模型 profile 列表（多模型配置）。
 * GET /settings/match-profiles → config/match_profiles.json
 *
 * 返回原生 useQuery 结果；App/DebugRecallView 使用 data.profiles、data.default_id
 */
export function useMatchProfiles() {
  const query = useQuery({
    queryKey: ["match-profiles"], // 查询键（缓存key，全局唯一）
    queryFn: () =>
      apiJson<{ profiles: { id: string; name: string; model: string }[]; default_id: string }>(
        "/settings/match-profiles", // 获取问答模型配置列表
      ),
  });
  return query;
}

/**
 * 后端存活探测。
 * GET /health → { status: "ok" }
 *
 * - refetchInterval: 7s 自动轮询，驱动 App 顶栏绿点/红点
 * - retry: false — 连不上时不反复重试，避免刷屏
 */
export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => apiJson<{ status: string }>("/health"),
    refetchInterval: 7000,
    retry: false,
  });
}
