/**
 * Wire shapes from @agent-workstation/protocol. Entities with an exported type are
 * re-exported; request/response bodies that only exist as zod schemas are
 * inferred here so that sync-core produces exactly what the hub sends.
 */
import type { z } from "zod";
import type {
  AcceptBody as AcceptBodySchema,
  AcceptResponse as AcceptResponseSchema,
  ManifestEntry as ManifestEntrySchema,
  ManifestResponse as ManifestResponseSchema,
  RejectBody as RejectBodySchema,
  RestoreBody as RestoreBodySchema,
  SyncOp as SyncOpSchema,
  SyncResult as SyncResultSchema,
} from "@agent-workstation/protocol";

export type { FileDiff, Hunk, Project, ReviewFile, Snapshot } from "@agent-workstation/protocol";

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
export type ManifestResponse = z.infer<typeof ManifestResponseSchema>;
export type SyncOp = z.infer<typeof SyncOpSchema>;
export type SyncResult = z.infer<typeof SyncResultSchema>;
export type SyncOpStatus = SyncResult["results"][number]["status"];
export type AcceptBody = z.infer<typeof AcceptBodySchema>;
export type AcceptResponse = z.infer<typeof AcceptResponseSchema>;
export type RejectBody = z.infer<typeof RejectBodySchema>;
export type RestoreBody = z.infer<typeof RestoreBodySchema>;
