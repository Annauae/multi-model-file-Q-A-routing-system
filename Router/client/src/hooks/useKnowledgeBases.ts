import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../api/client";
import type { KnowledgeBase } from "../types";

export function useRagKnowledgeBases() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["rag-knowledge-bases"],
    queryFn: async () => {
      const data = await apiJson<{ items: KnowledgeBase[] }>("/rag/knowledge-bases");
      const map: Record<string, KnowledgeBase> = {};
      for (const item of data.items || []) map[item.kb_id] = item;
      return { items: data.items || [], map };
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["rag-knowledge-bases"] });

  const kbDisplayName = (kbId: string) => {
    const cfg = query.data?.map[kbId];
    return (cfg?.name || "").trim() || `rag_kb_${kbId}`;
  };

  return { ...query, refresh, kbDisplayName, kbMap: query.data?.map ?? {} };
}

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

export function useMatchProfiles() {
  const query = useQuery({
    queryKey: ["match-profiles"],
    queryFn: () => apiJson<{ profiles: { id: string; name: string; model: string }[]; default_id: string }>("/settings/match-profiles"),
  });
  return query;
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => apiJson<{ status: string }>("/health"),
    refetchInterval: 7000,
    retry: false,
  });
}
