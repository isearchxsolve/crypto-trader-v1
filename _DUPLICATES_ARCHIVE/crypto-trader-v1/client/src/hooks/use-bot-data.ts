import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";

export function useBotStatus() {
  return useQuery({
    queryKey: [api.status.get.path],
    queryFn: async () => {
      const res = await fetch(api.status.get.path);
      if (!res.ok) throw new Error("Failed to fetch bot status");
      return await res.json();
    },
    refetchInterval: 2000,
  });
}

export function useTrades() {
  return useQuery({
    queryKey: [api.trades.list.path],
    queryFn: async () => {
      const res = await fetch(api.trades.list.path);
      if (!res.ok) throw new Error("Failed to fetch trades");
      return await res.json();
    },
    refetchInterval: 2000,
  });
}

export function useCandidates() {
  return useQuery({
    queryKey: [api.candidates.list.path],
    queryFn: async () => {
      const res = await fetch(api.candidates.list.path);
      if (!res.ok) throw new Error("Failed to fetch candidates");
      return await res.json();
    },
    refetchInterval: 3000,
  });
}

export function useLiveCandidates() {
  return useQuery({
    queryKey: ["/api/candidates/live"],
    queryFn: async () => {
      const res = await fetch("/api/candidates/live");
      if (!res.ok) throw new Error("Failed to fetch live candidates");
      return await res.json();
    },
    refetchInterval: 8000,
  });
}

export function useEngineStats() {
  return useQuery({
    queryKey: ["/api/engine/stats"],
    queryFn: async () => {
      const res = await fetch("/api/engine/stats");
      if (!res.ok) throw new Error("Failed to fetch engine stats");
      return await res.json();
    },
    refetchInterval: 5000,
  });
}
