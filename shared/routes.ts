import { z } from "zod";

export const errorSchemas = {
  validation: z.object({ message: z.string(), field: z.string().optional() }),
  notFound: z.object({ message: z.string() }),
  internal: z.object({ message: z.string() }),
};

export const api = {
  status: {
    get: {
      method: "GET" as const,
      path: "/api/bot/status" as const,
      responses: {
        200: z.any(),
      }
    }
  },
  trades: {
    list: {
      method: "GET" as const,
      path: "/api/bot/trades" as const,
      responses: {
        200: z.array(z.any()),
      }
    }
  },
  candidates: {
    list: {
      method: "GET" as const,
      path: "/api/bot/candidates" as const,
      responses: {
        200: z.array(z.any()),
      }
    }
  }
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}

export type BotStatusResponse = z.infer<typeof api.status.get.responses[200]>;
export type TradesListResponse = z.infer<typeof api.trades.list.responses[200]>;
export type CandidatesListResponse = z.infer<typeof api.candidates.list.responses[200]>;
