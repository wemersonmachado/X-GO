"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { AgentRow } from "./useAgent";

interface ListResponse {
  data: AgentRow[];
}

export const agentsListQueryKey = ["ai", "agents", "list"] as const;

export function useAgentsList(opts?: { initialData?: AgentRow[] }) {
  return useQuery({
    queryKey: agentsListQueryKey,
    queryFn: async () => {
      try {
        // A filtragem é feita na própria tela. Se este refetch não trouxer os
        // arquivados, ele substitui o initialData completo por uma lista parcial
        // e o filtro "Arquivado" fica vazio até um F5.
        const res = await apiClient.get<ListResponse>("/api/v1/ai/agents?include_archived=true");
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
    refetchOnMount: "always",
  });
}
