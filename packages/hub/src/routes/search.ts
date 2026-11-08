/** Search across the caller's sessions: keyword (FTS) and relevant (Claude Haiku). Incognito sessions never appear. */
import type { FastifyInstance } from "fastify";
import { SearchQuery, type RelevantSearchResponse, type SearchResponse } from "@agent-workstation/protocol";
import { parse, requireUser } from "../auth.js";
import type { Hub } from "../hub.js";
import { KEYWORD_DEFAULT_LIMIT, RELEVANT_DEFAULT_LIMIT } from "../search/service.js";

export function registerSearchRoutes(app: FastifyInstance, hub: Hub): void {
  /** Hits newest first (by the matched message's time), one per session, snippet with « » around the matches. */
  app.get("/api/search", async (req): Promise<SearchResponse> => {
    const u = requireUser(hub, req);
    const q = parse(SearchQuery, req.query, "query");
    return { hits: hub.search.keyword(u.name, q.q, q.limit ?? KEYWORD_DEFAULT_LIMIT) };
  });

  /** 503 api_unavailable without a key or budget; 502 search_failed when the model gave no usable answer. */
  app.get("/api/search/relevant", async (req): Promise<RelevantSearchResponse> => {
    const u = requireUser(hub, req);
    const q = parse(SearchQuery, req.query, "query");
    return hub.search.relevant(u.name, q.q, q.limit ?? RELEVANT_DEFAULT_LIMIT);
  });
}
